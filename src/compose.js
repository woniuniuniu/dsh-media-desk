// 选题与成稿：每天从素材里挑出最值得写的几个，写成推文草稿；也支持对单条候选稿说一句话来改。
// 模型输出是不可信数据：只取约定字段、限制长度，失败时不留半成品。
import { draftPrompts, extractJson, revisePrompts, topicPrompts } from './ai.js'
import { tr } from './i18n.js'
import { safeText } from './inbox.js'
import { newId } from './ops.js'
import { burst, eligible, qualityScore } from './score.js'
import { voiceFor } from './voice.js'

const MAX_TEXT = 4000
const MAX_INPUT = 1000
const fail = (message, status = 400) => Object.assign(new Error(message), { status })

const OPEN = new Set(['"', "'", '“', '‘', '「', '『'])
const CLOSE = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' }
const LABEL = /^(?:正文|文案|推文|草稿)\s*[：:]\s*/

/** 去掉首尾空白、成对引号和开头的“正文：”标签；结果为空时抛错。 */
export function cleanDraft(text) {
  let s = String(text ?? '').trim()
  for (;;) {
    const before = s
    if (s.length >= 2 && OPEN.has(s[0]) && s.at(-1) === CLOSE[s[0]]) s = s.slice(1, -1).trim()
    s = s.replace(LABEL, '').trim()
    if (s === before) break
  }
  if (!s) throw new Error(tr('模型返回的正文是空的'))
  return s
}

const dimension = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 只留合法选题：编造的帖子编号、非法类型和形式都会被修正或丢掉。 */
export function normalizeTopics(raw, { postIds, typeIds }) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const ids = [...new Set((Array.isArray(item.postIds) ? item.postIds : []).map(String).filter(id => postIds.has(id)))]
    if (!ids.length) continue
    const title = String(item.title ?? '').trim().slice(0, 60)
    if (!title) continue
    out.push({
      title,
      postIds: ids,
      fun: dimension(item.fun),
      info: dimension(item.info),
      resonance: dimension(item.resonance),
      typeId: typeIds.includes(item.typeId) ? item.typeId : typeIds[0],
      form: item.form === 'quote' ? 'quote' : 'post',
      reason: String(item.reason ?? '').trim().slice(0, 200),
    })
  }
  return out
}

function localDay(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

const noteLabel = tr('手动素材')
const LIVE = ['pending', 'approved']
const TAKEN = tr('已被另一个进程接管')
const MAX_ERROR = 200
const BUSY = tr('正在出稿，请稍等')

export class Composer {
  constructor({ store, settings, callText, now = () => new Date() }) {
    this.store = store
    this.settings = settings
    this.callText = callText
    this.now = now
    this.inflight = null
  }

  /** 本进程里是否正有一轮每日出稿在跑（手动和后台共用这一个）。 */
  get busy() {
    return this.inflight !== null
  }

  /**
   * 每日出稿。同一时间只跑一轮：已有一轮在跑时直接返回 busy，什么都不做。
   * @param {{undoable?: boolean, beforeCall?: () => Promise<boolean>}} [options] - beforeCall 在每次模型调用前执行，返回 false 就整体放弃、什么都不写。
   * @returns {Promise<{created: number, error: string|null, busy?: true}>}
   */
  async composeDaily(options) {
    if (this.inflight) return { created: 0, error: BUSY, busy: true }
    this.inflight = this.#composeDaily(options)
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  async #composeDaily({ undoable = true, beforeCall } = {}) {
    const now = this.now()
    const day = localDay(now)
    const state = await this.store.read()
    const { dailyCandidates } = await this.settings.read()
    const typeIds = state.voice.types.map(t => t.id)
    // outcome：'empty' 是当天的结果（记下当天，不再重试），'failed' 是失败（当天可重试）
    const note = (message, outcome) => this.store.mutate('选题', s => {
      s.runs.lastComposeAt = now.toISOString()
      s.runs.lastComposeOutcome = outcome
      s.runs.lastComposeError = message === null ? null : String(message).slice(0, MAX_ERROR)
      if (outcome === 'empty') s.runs.lastComposeDay = day
    }, { undoable })
    const callText = async req => {
      if (beforeCall && (await beforeCall()) === false) throw Object.assign(new Error(TAKEN), { taken: true })
      return this.callText(req)
    }
    const failWith = async message => {
      await note(message, 'failed')
      return { created: 0, error: message }
    }
    const emptyWith = async message => {
      await note(message, 'empty')
      return { created: 0, error: null }
    }

    const posts = eligible(state.posts, now)
    if (!posts.length) return emptyWith(tr('今天没有新素材'))

    let topics
    try {
      const { system, user } = topicPrompts(posts, state.voice.types)
      const { text } = await callText({ system, user, maxTokens: 3000, light: true })
      topics = normalizeTopics(extractJson(text), { postIds: new Set(posts.map(p => p.id)), typeIds })
    } catch (err) {
      if (err.taken) return { created: 0, error: TAKEN }
      return failWith(tr('选题失败：{reason}', { reason: err.message }))
    }

    const byId = new Map(posts.map(p => [p.id, p]))
    const rankedAll = topics
      .map(topic => {
        const sources = topic.postIds.map(id => byId.get(id))
        const top = sources.reduce((a, b) => (burst(b, state.posts) > burst(a, state.posts) ? b : a))
        return { topic, top, score: Math.max(...sources.map(p => burst(p, state.posts))) * qualityScore(topic) }
      })
      .filter(x => Number.isFinite(x.score) && x.score > 0)
      .sort((a, b) => b.score - a.score)
    // 一条帖子只属于排名最高的选题；被掏空的选题丢掉
    const claimed = new Set()
    const ranked = []
    for (const item of rankedAll) {
      const ids = item.topic.postIds.filter(id => !claimed.has(id))
      if (!ids.length) continue
      ids.forEach(id => claimed.add(id))
      const sources = ids.map(id => byId.get(id))
      const top = sources.reduce((a, b) => (burst(b, state.posts) > burst(a, state.posts) ? b : a))
      ranked.push({ ...item, topic: { ...item.topic, postIds: ids }, top })
    }
    const scored = ranked.slice(0, dailyCandidates)
    if (!scored.length) return emptyWith(tr('今天没有及格的选题'))

    const drafts = []
    let lastError = ''
    for (const { topic, top, score } of scored) {
      try {
        const { system, user } = draftPrompts({
          title: topic.title, form: topic.form, voice: voiceFor(state, topic.typeId),
          materials: topic.postIds.map(id => byId.get(id).text),
        })
        const { text } = await callText({ system, user, maxTokens: 1200 })
        drafts.push({ topic, score, text: safeText(cleanDraft(text), MAX_TEXT), quoteUrl: topic.form === 'quote' ? top.url ?? null : null })
      } catch (err) {
        if (err.taken) return { created: 0, error: TAKEN }
        lastError = err.message
      }
    }
    if (!drafts.length) return failWith(tr('成稿失败：{reason}', { reason: lastError }))

    const created = await this.store.mutate('每日选题', s => {
      const existing = new Map(s.posts.map(p => [p.id, p]))
      const written = []
      for (const { topic, score, text, quoteUrl } of drafts) {
        const live = topic.postIds.filter(id => existing.has(id) && !existing.get(id).used)
        if (!live.length) continue
        for (const id of live) existing.get(id).used = true
        written.push({
          id: newId('c'), form: topic.form, typeId: topic.typeId, text, aiText: text, title: topic.title,
          sourcePostIds: topic.postIds.filter(id => existing.has(id)), sourceNoteId: null, quoteUrl,
          reason: topic.reason, score, status: 'pending', createdAt: now.toISOString(), scheduledAt: null,
          decidedAt: null, discardReason: null, view: null, revision: 0, image: null,
        })
      }
      if (!written.length) {
        // 今天已经成功过（这次是强制重跑）：保留今天成功的状态
        if (s.runs.lastComposeDay === day) return 0
        s.runs.lastComposeAt = now.toISOString()
        s.runs.lastComposeOutcome = 'failed'
        s.runs.lastComposeError = tr('素材已被其他任务用掉')
        return 0
      }
      s.candidates.push(...written)
      s.runs.lastComposeAt = now.toISOString()
      s.runs.lastComposeOutcome = 'ok'
      s.runs.lastComposeDay = day
      s.runs.lastComposeError = null
      return written.length
    }, { undoable })
    return created ? { created, error: null } : { created: 0, error: tr('素材已被其他任务用掉') }
  }

  async composeFromNote(noteId, { undoable = true } = {}) {
    const state = await this.store.read()
    const note = state.notes.find(n => n.id === noteId)
    if (!note) throw fail(tr('找不到这条笔记'), 404)
    if (note.used) throw fail(tr('这条笔记已经成稿过了'))
    const typeIds = state.voice.types.map(t => t.id)
    let topic = { title: note.text.slice(0, 30), typeId: typeIds[0] }
    try {
      const { system, user } = topicPrompts([{ id: note.id, handle: noteLabel, text: note.text }], state.voice.types)
      const { text } = await this.callText({ system, user, maxTokens: 3000, light: true })
      const [first] = normalizeTopics(extractJson(text), { postIds: new Set([note.id]), typeIds })
      if (first) topic = first
    } catch {
      // 判断类型失败时取第一个类型
    }
    const { system, user } = draftPrompts({ title: topic.title, form: 'post', voice: voiceFor(state, topic.typeId), materials: [note.text] })
    const { text: raw } = await this.callText({ system, user, maxTokens: 1200 })
    const text = safeText(cleanDraft(raw), MAX_TEXT)
    return this.store.mutate('笔记成稿', s => {
      const row = s.notes.find(n => n.id === noteId)
      if (!row) throw fail(tr('找不到这条笔记'), 404)
      if (row.used) throw fail(tr('这条笔记已经成稿过了'))
      row.used = true
      const candidate = {
        id: newId('c'), form: 'post', typeId: topic.typeId, text, aiText: text, title: String(topic.title ?? '').slice(0, 60),
        sourcePostIds: [], sourceNoteId: noteId, quoteUrl: null, reason: noteLabel, score: 0, status: 'pending',
        createdAt: this.now().toISOString(), scheduledAt: null, decidedAt: null, discardReason: null, view: null, revision: 0, image: null,
      }
      s.candidates.push(candidate)
      return candidate
    }, { undoable })
  }

  async revise(candidateId, { view, instruction, typeId } = {}, { undoable = true } = {}) {
    const given = [['view', view], ['instruction', instruction], ['typeId', typeId]].filter(([, v]) => v !== undefined && v !== null)
    if (given.length !== 1) throw fail(tr('每次只能给一项：看法、修改要求或类型'))
    const [kind, value] = given[0]
    let input = null
    if (kind !== 'typeId') {
      input = typeof value === 'string' ? value.trim().slice(0, MAX_INPUT) : ''
      if (!input) throw fail(tr('内容不能为空'))
    }
    const state = await this.store.read()
    const c = state.candidates.find(row => row.id === candidateId)
    if (!c) throw fail(tr('找不到候选稿'), 404)
    if (!LIVE.includes(c.status)) throw fail(tr('这条候选稿已经处理过，不能再改'))
    if (kind === 'typeId' && !state.voice.types.some(t => t.id === value)) throw fail(tr('没有这个类型'))
    // 模型调用期间稿子可能被手改或通过；写回前对照，变了就放弃，不覆盖
    const { revision, status } = c

    const nextType = kind === 'typeId' ? value : c.typeId
    const voice = voiceFor(state, nextType)
    let prompt
    if (kind === 'instruction') {
      prompt = revisePrompts({ text: c.text, instruction: input, voice })
    } else {
      const materials = [
        ...c.sourcePostIds.map(id => state.posts.find(p => p.id === id)?.text),
        state.notes.find(n => n.id === c.sourceNoteId)?.text,
      ].filter(Boolean)
      prompt = draftPrompts({ title: c.title, form: c.form, voice, materials: materials.length ? materials : [c.aiText], view: kind === 'view' ? input : c.view })
    }
    const { text: raw } = await this.callText({ ...prompt, maxTokens: 1200 })
    const text = safeText(cleanDraft(raw), MAX_TEXT)
    return this.store.mutate('改稿', s => {
      const row = s.candidates.find(r => r.id === candidateId)
      if (!row) throw fail(tr('找不到候选稿'), 404)
      if (row.revision !== revision || row.status !== status) throw fail(tr('稿子刚被改动过，请再试一次'), 409)
      row.text = text
      if (kind === 'view') row.view = input
      if (kind === 'typeId') row.typeId = value
      row.revision += 1
      return row
    }, { undoable })
  }
}
