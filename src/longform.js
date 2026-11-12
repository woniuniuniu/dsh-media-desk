// 长文：每周从自己最好的帖子和看法里建议选题，一键出初稿，说一句话就能改。程序不发布任何东西。
// 读一次状态，模型调用在任何写入之外，最后只写一次；模型输出是不可信数据。
import { extractJson, longformDraftPrompts, longformIdeaPrompts, longformRevisePrompts } from './ai.js'
import { tr } from './i18n.js'
import { safeText } from './inbox.js'
import { newId, oneLine } from './ops.js'
import { engagement } from './score.js'
import { voiceFor } from './voice.js'

const DAY = 86400e3
const MAX_BODY = 20000
const MAX_ERROR = 200
const MAX_IDEAS = 6
export const MAX_LONGFORMS = 30
const fail = (message, status = 400) => Object.assign(new Error(message), { status })

/** 本地日期所在的 ISO 8601 周，形如 '2026-W46'。 */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 去掉整段外面包着的代码围栏并去掉首尾空白，其余 Markdown 原样保留。 */
export function cleanBody(text) {
  let s = String(text ?? '').trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(s)
  if (fenced) s = fenced[1].trim()
  return s
}

/** 近 14 天自己发的帖子里互动最高的 8 条，加上最近 10 条写过的看法。 */
function materialsOf(state, now) {
  const since = now.getTime() - 14 * DAY
  const bestPosts = (state.mine ?? [])
    .filter(p => (p.kind === 'post' || p.kind === 'quote') && Date.parse(p.postedAt) >= since && String(p.text ?? '').trim())
    .sort((a, b) => engagement(b) - engagement(a) || (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0))
    .slice(0, 8)
    .map(p => p.text)
  const views = state.candidates
    .filter(c => typeof c.view === 'string' && c.view.trim())
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, 10)
    .map(c => c.view.trim())
  return { bestPosts, views }
}

const reason = err => safeText(String(err?.message ?? err ?? '').trim() || tr('模型调用失败'), MAX_ERROR)

export class Longform {
  constructor({ store, callText, now = () => new Date() }) {
    this.store = store
    this.callText = callText
    this.now = now
    this.inflight = null
  }

  get busy() {
    return this.inflight !== null
  }

  /** 建议 2 到 3 个选题。不碰 runs.lastLongformWeek（那是后台的事）。 */
  async suggest(options) {
    if (this.inflight) return { created: 0, error: tr('正在想选题，请稍等'), busy: true }
    this.inflight = this.#suggest(options)
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  async #suggest({ undoable = true } = {}) {
    const now = this.now()
    const state = await this.store.read()
    if (state.longforms.length >= MAX_LONGFORMS) return { created: 0, error: tr('长文已经 30 篇，先删掉不要的') }
    if (state.longforms.filter(l => l.status === 'idea').length >= MAX_IDEAS) return { created: 0, error: tr('还有没处理的选题，先看看已有的') }
    const { bestPosts, views } = materialsOf(state, now)
    if (!bestPosts.length && !views.length) return { created: 0, error: tr('还没有足够的内容来建议长文选题') }
    const typeIds = state.voice.types.map(t => t.id)
    let items
    try {
      const { system, user } = longformIdeaPrompts({ bestPosts, views, types: state.voice.types })
      const { text } = await this.callText({ system, user, maxTokens: 1500, light: true })
      const raw = extractJson(text)
      if (!Array.isArray(raw)) throw new Error(tr('模型返回的格式不对'))
      items = []
      for (const item of raw.slice(0, 3)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const title = oneLine(item.title, 60)
        if (!title) continue
        items.push({ title, angle: oneLine(item.angle, 200), typeId: typeIds.includes(item.typeId) ? item.typeId : typeIds[0] ?? null })
      }
    } catch (err) {
      return { created: 0, error: reason(err) }
    }
    const created = await this.store.mutate('长文选题', s => {
      const titles = new Set(s.longforms.map(l => l.title.trim()))
      let n = 0
      for (const { title, angle, typeId } of items) {
        if (titles.has(title) || s.longforms.length >= MAX_LONGFORMS) continue
        titles.add(title)
        s.longforms.push({ id: newId('l'), title, angle, typeId, body: '', aiBody: '', status: 'idea', createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 0, error: null })
        n += 1
      }
      return n
    }, { undoable })
    return { created, error: null }
  }

  /** 选题出初稿：成功 idea → draft；失败时仍是 idea，原因记在 error，返回这一行供界面重试。 */
  async draft(id, { undoable = true } = {}) {
    const state = await this.store.read()
    const row = state.longforms.find(l => l.id === id)
    if (!row) throw fail(tr('找不到这个选题'), 404)
    if (row.status !== 'idea') throw fail(tr('这个选题已经有稿子了'), 409)
    const { revision, status } = row
    const { bestPosts, views } = materialsOf(state, this.now())
    return this.#run('长文初稿', id, { revision, status }, undoable, () => longformDraftPrompts({
      title: row.title, angle: row.angle, materials: [...bestPosts, ...views], voice: voiceFor(state, state.voice.types.length ? row.typeId : null, { long: true }),
    }), (r, body) => {
      r.body = body
      // aiBody 始终保留模型的第一版初稿，供负责人的最终文字与它比较，后续改稿不覆盖。
      r.aiBody = body
      r.status = 'draft'
      r.revision = 1
    })
  }

  /** 对草稿说一句话来改：成功正文被替换、revision 加一；失败正文不变。 */
  async revise(id, instruction, { undoable = true } = {}) {
    const wish = typeof instruction === 'string' ? instruction.trim() : ''
    if (!wish || wish.length > 1000) throw fail(tr('修改要求要在 1 到 1000 字之间'))
    const state = await this.store.read()
    const row = state.longforms.find(l => l.id === id)
    if (!row) throw fail(tr('找不到这个选题'), 404)
    if (row.status !== 'draft') throw fail(tr('只有草稿才能改'), 409)
    const { revision, status } = row
    return this.#run('长文改稿', id, { revision, status }, undoable, () => longformRevisePrompts({
      body: row.body, instruction: wish, voice: voiceFor(state, state.voice.types.length ? row.typeId : null, { long: true }),
    }), (r, body) => {
      r.body = body
      r.revision += 1
    })
  }

  async #run(label, id, { revision, status }, undoable, prompts, apply) {
    let body = null
    let error = null
    try {
      const { text } = await this.callText({ ...prompts(), maxTokens: 6000 })
      body = safeText(cleanBody(text), MAX_BODY)
      if (!body.trim()) throw new Error(tr('模型返回的正文是空的'))
    } catch (err) {
      body = null
      error = reason(err)
    }
    return this.store.mutate(label, s => {
      const row = s.longforms.find(l => l.id === id)
      if (!row) throw fail(tr('找不到这个选题'), 404)
      if (row.revision !== revision || row.status !== status) throw fail(tr('稿子刚被改动过，请再试一次'), 409)
      if (body === null) {
        row.error = error
      } else {
        apply(row, body)
        row.error = null
      }
      row.updatedAt = this.now().toISOString()
      return row
    }, { undoable })
  }
}
