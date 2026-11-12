// 后台处理：每分钟读入素材和处理结果，每天定时成稿，并把候选稿写回交换文件夹。
// 交换文件夹里的内容是不可信数据，这里只做合并和状态迁移；模型调用都在 store.mutate 之外。
import { isAbsolute, join } from 'node:path'
import { applyDecision, expire, intentUrl } from './inbox.js'
import { isoWeek, NO_MATERIAL } from './longform.js'
import { matchSent } from './match.js'
import { newId } from './ops.js'
import { addNotice, localDay, SKEW_MS } from './runs.js'
import { exportSkillMarkdown, watchlistJson } from './voice.js'

const TICK_MS = 60_000
const RETRY_MS = 30 * 60_000
const KEEP_POSTS_MS = 14 * 24 * 3600e3
const DAY_MS = 24 * 3600e3
const KEEP_MINE_MS = 180 * DAY_MS
const KEEP_REPLIES_MS = 90 * DAY_MS
const KEEP_FOLLOWERS_MS = 400 * DAY_MS
export const MAX_MINE = 5000
export const MAX_REPLY_DRAFTS = 2000
export const MAX_FOLLOWERS = 400
const METRICS = ['likes', 'replies', 'reposts', 'quotes', 'views']
const TAKEN_NOTICE = '后台处理被另一个进程接管，本轮已停止'

export { addNotice, localDay }

const pad = n => String(n).padStart(2, '0')
const localTime = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`

/** 交换文件夹的实际位置：设置里留空则用数据目录下的 exchange。 */
export function resolveExchangeDir(settings, storeRoot) {
  const dir = typeof settings.exchangeDir === 'string' ? settings.exchangeDir.trim() : ''
  return dir && isAbsolute(dir) ? dir : join(storeRoot, 'exchange')
}

/** 当天（本地日）已生成的图片张数。 */
export function imagesUsedToday(state, now) {
  return state.runs.imagesDay === localDay(now) ? state.runs.imagesCount : 0
}

/** 记一张新生成的图片；跨天自动归零。 */
export function countImage(state, now) {
  const used = imagesUsedToday(state, now)
  state.runs.imagesDay = localDay(now)
  state.runs.imagesCount = used + 1
}

/** 超过 cap 条时丢掉最旧的，其余保持原有顺序。 */
function capNewest(rows, cap, time) {
  if (rows.length <= cap) return rows
  const keep = new Set([...rows].sort((a, b) => time(b) - time(a)).slice(0, cap))
  return rows.filter(r => keep.has(r))
}

export class Worker {
  constructor({ store, settings, composer, lock, exchangeFor, now = () => new Date(), learn = { learnDaily: async () => ({ proposals: 0 }) }, longform = null }) {
    this.store = store
    this.settings = settings
    this.composer = composer
    this.lock = lock
    this.exchangeFor = exchangeFor
    this.now = now
    this.learn = learn
    this.longform = longform
    this.lastAttemptAt = null
    this.voiceMemo = null
    this.inflight = null
    // 停止后置为 true；热重载留下的旧实例在每一步之前看到它就不再写
    this.stopped = false
  }

  /** 记下一次成稿尝试（手动成稿也算），30 分钟内后台不再重试。 */
  noteAttempt() {
    this.lastAttemptAt = this.now().getTime()
  }

  async tick() {
    if (this.stopped || !(await this.lock.acquire())) return { ran: false }
    const now = this.now()
    const settings = await this.settings.read()
    const exchange = this.exchangeFor(settings)
    await exchange.ensure()

    const posts = await exchange.readNew('posts')
    const decisions = await exchange.readNew('decisions')
    const pendingModel = []
    const abort = async () => {
      await this.#notice(TAKEN_NOTICE)
      return { ran: true, aborted: true }
    }
    const halted = { ran: true, stopped: true }
    if (this.stopped) return halted

    await this.store.mutate('后台处理', s => {
      const notice = text => addNotice(s, text, now)
      for (const { file, why } of posts.skipped) notice(`交换文件夹里的 posts/${file} 无法读取：${why}`)
      for (const { file, why } of decisions.skipped) notice(`交换文件夹里的 decisions/${file} 无法读取：${why}`)

      const byId = new Map(s.posts.map(p => [p.id, p]))
      for (const item of posts.items) {
        const have = byId.get(item.id)
        if (!have) {
          s.posts.push(item)
          byId.set(item.id, item)
        } else if (Date.parse(item.fetchedAt) > Date.parse(have.fetchedAt)) {
          // used 标记保持不变
          Object.assign(have, { likes: item.likes, replies: item.replies, reposts: item.reposts, quotes: item.quotes, views: item.views, fetchedAt: item.fetchedAt })
        }
      }
      const cutoff = now.getTime() - KEEP_POSTS_MS
      s.posts = s.posts.filter(p => Date.parse(p.postedAt) >= cutoff)

      for (const decision of decisions.items) {
        const result = applyDecision(s, decision, { now, slots: settings.slots })
        if (result === 'ignored') notice(`处理结果（${decision.action}）指向的候选稿 ${decision.candidateId} 不存在或已处理，已忽略`)
        else if (result === 'needs_model') pendingModel.push(decision)
      }
    }, { undoable: false })
    // 落库之后才算处理过；改稿失败只记提示，不会反复重试
    await posts.commit()
    await decisions.commit()

    // 每个阶段之前都续锁并看一眼是否已停止
    const gate = async () => {
      if (this.stopped) return halted
      if (!(await this.lock.acquire())) return abort()
      return null
    }
    for (const stage of [() => this.#ingestMine(exchange, settings), () => this.#ingestReplies(exchange), () => this.#matchAndTrim(now)]) {
      const stop = await gate()
      if (stop) return stop
      await stage()
    }

    for (const decision of pendingModel) {
      if (this.stopped) return halted
      if (!(await this.lock.acquire())) return abort()
      try {
        if (!decision.text) throw new Error('没有附带文字')
        const input = decision.action === 'view' ? { view: decision.text } : { instruction: decision.text }
        await this.composer.revise(decision.candidateId, input, { undoable: false })
      } catch (err) {
        await this.#notice(`手机端对候选稿 ${decision.candidateId} 的${decision.action === 'view' ? '看法' : '修改要求'}没能处理：${err.message}`)
      }
    }

    if (this.stopped) return halted
    if (!(await this.lock.acquire())) return abort()
    try {
      await this.#composeIfDue(settings, now)
    } catch (err) {
      await this.#notice(`每日成稿出错：${err.message}`)
    }

    let stop = await gate()
    if (stop) return stop
    try {
      await this.learn.learnDaily()
    } catch (err) {
      await this.#notice(`每日学习出错：${err.message}`)
    }
    stop = await gate()
    if (stop) return stop
    await this.#guarded('每周长文选题', () => this.#longformIfDue(now))
    stop = await gate()
    if (stop) return stop
    await this.#exportAll(exchange)
    return { ran: true }
  }

  /** 某一步出错只记一条提示，不影响本轮其余步骤；没落库的交换文件下一轮还会读到。 */
  async #guarded(what, fn) {
    try {
      await fn()
    } catch (err) {
      await this.#notice(`${what}出错：${err.message}`)
    }
  }

  #ingestMine(exchange, settings) {
    return this.#guarded('读入自己发出的内容', async () => {
      const mine = await exchange.readNew('mine', { ownHandle: settings.ownHandle })
      const now = this.now()
      const limit = now.getTime() + SKEW_MS
      // 发出时间比现在还晚的先不收，文件也不算处理过：时钟快几分钟的机器之后会被正常收下
      const later = new Set()
      mine.items.forEach((x, i) => { if (Date.parse(x.mine.postedAt) > limit) later.add(i) })
      await this.store.mutate('读入自己发出的内容', s => {
        for (const { file, why } of mine.skipped) addNotice(s, `交换文件夹里的 mine/${file} 无法读取：${why}`, now)
        if (later.size) addNotice(s, `有 ${later.size} 条内容的时间比现在还晚，先不收`, now)
        const byId = new Map(s.mine.map(m => [m.id, m]))
        mine.items.forEach(({ mine: item, followers }, i) => {
          if (later.has(i)) return
          // 抓取时间不会晚于现在；否则一个未来时间会让这条的互动数永远不再更新
          if (Date.parse(item.fetchedAt) > now.getTime()) item.fetchedAt = now.toISOString()
          const have = byId.get(item.id)
          if (!have) {
            s.mine.push(item)
            byId.set(item.id, item)
          } else if (Date.parse(item.fetchedAt) > Date.parse(have.fetchedAt)) {
            // 只更新互动数；文字、配对和类型不变
            for (const key of METRICS) have[key] = item[key]
            have.fetchedAt = item.fetchedAt
          }
          if (followers !== null) this.#recordFollowers(s, followers, item.fetchedAt)
        })
      }, { undoable: false })
      await mine.commit([...later].map(i => mine.itemFiles[i]))
    })
  }

  /** 同一天只留一条：取该天 fetchedAt 最晚的值。 */
  #recordFollowers(s, count, fetchedAt) {
    const day = localDay(new Date(fetchedAt))
    const row = s.followers.find(f => f.day === day)
    if (!row) {
      s.followers.push({ day, count, at: fetchedAt })
      s.followers.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    } else if (!(Date.parse(row.at) >= Date.parse(fetchedAt))) {
      row.count = count
      row.at = fetchedAt
    }
  }

  #ingestReplies(exchange) {
    return this.#guarded('读入回复草稿', async () => {
      const replies = await exchange.readNew('replies')
      const now = this.now()
      const limit = now.getTime() + SKEW_MS
      const later = new Set()
      replies.items.forEach((x, i) => { if (Date.parse(x.notifiedAt) > limit) later.add(i) })
      await this.store.mutate('读入回复草稿', s => {
        for (const { file, why } of replies.skipped) addNotice(s, `交换文件夹里的 replies/${file} 无法读取：${why}`, now)
        if (later.size) addNotice(s, `有 ${later.size} 条回复草稿的时间比现在还晚，先不收`, now)
        const key = r => `${r.toPostId}|${r.notifiedAt}`
        const known = new Set(s.replyDrafts.map(key))
        replies.items.forEach((item, i) => {
          if (later.has(i) || known.has(key(item))) return
          known.add(key(item))
          s.replyDrafts.push({ id: newId('r'), ...item })
        })
      }, { undoable: false })
      await replies.commit([...later].map(i => replies.itemFiles[i]))
    })
  }

  /** 认出已发的候选稿和回复、让过期的候选稿过期、裁掉超过保留期的记录；三步各自出错各自记提示。 */
  async #matchAndTrim(now) {
    await this.#guarded('识别已发内容', () => this.store.mutate('识别已发内容', s => { matchSent(s, { now }) }, { undoable: false }))
    await this.#guarded('候选稿过期', () => this.store.mutate('候选稿过期', s => { expire(s, now) }, { undoable: false }))
    await this.#guarded('清理旧记录', () => this.store.mutate('清理旧记录', s => {
      // 保留期一律按时间裁剪：不为仍指向某条 mine 的候选稿特意多留，那样的候选稿早已过期。
      // 比现在还晚的（坏文件或时钟错乱）也丢掉；再按条数封顶，先丢最旧的。
      const t = now.getTime()
      const today = localDay(now)
      s.mine = capNewest(s.mine.filter(m => Date.parse(m.postedAt) >= t - KEEP_MINE_MS && Date.parse(m.postedAt) <= t + SKEW_MS), MAX_MINE, m => Date.parse(m.postedAt))
      s.replyDrafts = capNewest(s.replyDrafts.filter(r => Date.parse(r.notifiedAt) >= t - KEEP_REPLIES_MS && Date.parse(r.notifiedAt) <= t + SKEW_MS), MAX_REPLY_DRAFTS, r => Date.parse(r.notifiedAt))
      s.followers = capNewest(s.followers.filter(f => Date.parse(`${f.day}T00:00:00`) >= t - KEEP_FOLLOWERS_MS && f.day <= today), MAX_FOLLOWERS, f => Date.parse(`${f.day}T00:00:00`))
    }, { undoable: false }))
  }

  /** 每个 ISO 周里，当天成稿尝试之后的第一轮建议一次长文选题；无论结果如何本周都算过，不整天重试。 */
  async #longformIfDue(now) {
    if (!this.longform) return
    const week = isoWeek(now)
    const { runs } = await this.store.read()
    if (runs.lastComposeDay !== localDay(now) || runs.lastLongformWeek === week) return
    let result = null
    try {
      result = await this.longform.suggest({ undoable: false })
    } catch (err) {
      await this.#notice(`每周长文选题出错：${err.message}`)
    }
    // 没有素材是正常情况，不提示；正在手动建议（busy）也不提示
    if (result?.error && !result.busy && result.error !== NO_MATERIAL) await this.#notice(`长文选题这周没建议成：${result.error}`)
    await this.store.mutate('长文选题周记', s => { s.runs.lastLongformWeek = week }, { undoable: false })
  }

  async #notice(text) {
    await this.store.mutate('提示', s => addNotice(s, text, this.now()), { undoable: false })
  }

  async #composeIfDue(settings, now) {
    const state = await this.store.read()
    if (state.runs.lastComposeDay === localDay(now) || localTime(now) < settings.composeAt) return
    if (this.lastAttemptAt !== null && now.getTime() - this.lastAttemptAt < RETRY_MS) return
    this.lastAttemptAt = now.getTime()
    await this.composer.composeDaily({ undoable: false, beforeCall: async () => !this.stopped && this.lock.acquire() })
  }

  async #exportAll(exchange) {
    const state = await this.store.read()
    const typeName = id => state.voice.types.find(t => t.id === id)?.name ?? ''
    for (const c of state.candidates) {
      if (c.status !== 'pending' && c.status !== 'approved') continue
      // 一条写不出去只记提示，不拦住其他稿子
      try {
        await exchange.writeDraft(c, typeName(c.typeId), { intentUrl: intentUrl(c) })
      } catch (err) {
        await this.#notice(`候选稿 ${c.id} 没能写进交换文件夹：${err.message}`)
      }
    }
    const watchlist = watchlistJson(state)
    const skillMarkdown = exportSkillMarkdown(state)
    // 换了交换文件夹时新文件夹也要写一份
    const memo = JSON.stringify([exchange.root, watchlist, skillMarkdown])
    if (memo !== this.voiceMemo) {
      await exchange.writeVoice({ watchlist, skillMarkdown })
      this.voiceMemo = memo
    }
  }

  /** 立即执行一次，之后每 60 秒一次。返回的函数停止定时器并释放锁。 */
  start() {
    this.stopped = false
    const run = () => {
      if (this.stopped || this.inflight) return
      this.inflight = this.tick()
        .catch(err => this.#notice(`后台处理出错：${err.message}`).catch(() => {}))
        .finally(() => { this.inflight = null })
    }
    run()
    const timer = setInterval(run, TICK_MS)
    timer.unref?.()
    return () => {
      this.stopped = true
      clearInterval(timer)
      return Promise.resolve(this.inflight).catch(() => {}).then(() => this.lock.release()).catch(() => {})
    }
  }
}
