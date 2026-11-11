// 后台处理：每分钟读入素材和处理结果，每天定时成稿，并把候选稿写回交换文件夹。
// 交换文件夹里的内容是不可信数据，这里只做合并和状态迁移；模型调用都在 store.mutate 之外。
import { isAbsolute, join } from 'node:path'
import { applyDecision, expire, intentUrl } from './inbox.js'
import { newId } from './ops.js'
import { exportSkillMarkdown, watchlistJson } from './voice.js'

const TICK_MS = 60_000
const RETRY_MS = 30 * 60_000
const KEEP_POSTS_MS = 14 * 24 * 3600e3
const MAX_NOTICES = 50
const TAKEN_NOTICE = '后台处理被另一个进程接管，本轮已停止'

const pad = n => String(n).padStart(2, '0')
export const localDay = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

/** 在 state.runs.notices 末尾追加一条提示；与上一条相同则不重复，最多留 50 条。 */
export function addNotice(state, text, now) {
  const notices = state.runs.notices
  if (notices.at(-1)?.text === text) return
  notices.push({ id: newId('n'), at: now.toISOString(), text })
  if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES)
}

export class Worker {
  constructor({ store, settings, composer, lock, exchangeFor, now = () => new Date() }) {
    this.store = store
    this.settings = settings
    this.composer = composer
    this.lock = lock
    this.exchangeFor = exchangeFor
    this.now = now
    this.lastAttemptAt = null
    this.voiceMemo = null
    this.inflight = null
  }

  /** 记下一次成稿尝试（手动成稿也算），30 分钟内后台不再重试。 */
  noteAttempt() {
    this.lastAttemptAt = this.now().getTime()
  }

  async tick() {
    if (!(await this.lock.acquire())) return { ran: false }
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
      expire(s, now)
    }, { undoable: false })
    // 落库之后才算处理过；改稿失败只记提示，不会反复重试
    await posts.commit()
    await decisions.commit()

    for (const decision of pendingModel) {
      if (!(await this.lock.acquire())) return abort()
      try {
        if (!decision.text) throw new Error('没有附带文字')
        const input = decision.action === 'view' ? { view: decision.text } : { instruction: decision.text }
        await this.composer.revise(decision.candidateId, input, { undoable: false })
      } catch (err) {
        await this.#notice(`手机端对候选稿 ${decision.candidateId} 的${decision.action === 'view' ? '看法' : '修改要求'}没能处理：${err.message}`)
      }
    }

    if (!(await this.lock.acquire())) return abort()
    try {
      await this.#composeIfDue(settings, now)
    } catch (err) {
      await this.#notice(`每日成稿出错：${err.message}`)
    }
    if (!(await this.lock.acquire())) return abort()
    await this.#exportAll(exchange)
    return { ran: true }
  }

  async #notice(text) {
    await this.store.mutate('提示', s => addNotice(s, text, this.now()), { undoable: false })
  }

  async #composeIfDue(settings, now) {
    const state = await this.store.read()
    if (state.runs.lastComposeDay === localDay(now) || localTime(now) < settings.composeAt) return
    if (this.lastAttemptAt !== null && now.getTime() - this.lastAttemptAt < RETRY_MS) return
    this.lastAttemptAt = now.getTime()
    await this.composer.composeDaily({ undoable: false, beforeCall: () => this.lock.acquire() })
  }

  async #exportAll(exchange) {
    const state = await this.store.read()
    const typeName = id => state.voice.types.find(t => t.id === id)?.name ?? ''
    for (const c of state.candidates) {
      if (c.status !== 'pending' && c.status !== 'approved') continue
      await exchange.writeDraft(c, typeName(c.typeId), { intentUrl: intentUrl(c) })
    }
    const watchlist = watchlistJson(state)
    const skillMarkdown = exportSkillMarkdown(state)
    const memo = JSON.stringify(watchlist) + skillMarkdown
    if (memo !== this.voiceMemo) {
      await exchange.writeVoice({ watchlist, skillMarkdown })
      this.voiceMemo = memo
    }
  }

  /** 立即执行一次，之后每 60 秒一次。返回的函数停止定时器并释放锁。 */
  start() {
    const run = () => {
      if (this.inflight) return
      this.inflight = this.tick()
        .catch(err => this.#notice(`后台处理出错：${err.message}`).catch(() => {}))
        .finally(() => { this.inflight = null })
    }
    run()
    const timer = setInterval(run, TICK_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      return Promise.resolve(this.inflight).catch(() => {}).then(() => this.lock.release()).catch(() => {})
    }
  }
}
