import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeText } from './inbox.js'

const DIRS = ['posts', 'decisions', 'drafts', 'voice', 'replies', 'mine']
const MAX_FILE_BYTES = 65536
const MAX_AGE_MS = 30 * 24 * 3600e3
const MAX_COUNT = 1e12
const FRESH_MS = 10_000
const FILE_NAME = /^[\w.-]{1,120}\.json$/
const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const POST_ID = /^\d{5,25}$/
const CANDIDATE_ID = /^c_[a-z0-9]{4,16}$/
const ACTIONS = new Set(['approve', 'discard', 'view', 'revise', 'sent'])
const REASONS = new Set(['not_interested', 'not_me', 'stale'])

function isoTime(v) {
  if (typeof v !== 'string') return null
  const t = new Date(v)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

function count(v) {
  return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_COUNT) : 0
}

export function parsePost(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) return null
  if (typeof raw.handle !== 'string' || !HANDLE.test(raw.handle)) return null
  if (typeof raw.postId !== 'string' || !POST_ID.test(raw.postId)) return null
  if (typeof raw.text !== 'string') return null
  const postedAt = isoTime(raw.postedAt)
  const fetchedAt = isoTime(raw.fetchedAt)
  if (!postedAt || !fetchedAt) return null
  const m = raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {}
  return {
    id: raw.postId,
    handle: raw.handle,
    text: raw.text.slice(0, 4000),
    url: `https://x.com/${raw.handle}/status/${raw.postId}`,
    postedAt,
    fetchedAt,
    likes: count(m.likes),
    replies: count(m.replies),
    reposts: count(m.reposts),
    quotes: count(m.quotes),
    views: count(m.views),
    isRepost: raw.isRepost === true,
    used: false,
  }
}

export function parseDecision(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) return null
  if (typeof raw.candidateId !== 'string' || !CANDIDATE_ID.test(raw.candidateId)) return null
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action)) return null
  const at = isoTime(raw.at)
  if (!at) return null
  return {
    candidateId: raw.candidateId,
    action: raw.action,
    text: typeof raw.text === 'string' ? raw.text.slice(0, 1000) : null,
    reason: typeof raw.reason === 'string' && REASONS.has(raw.reason) ? raw.reason : null,
    at,
  }
}

const MINE_KINDS = new Set(['post', 'reply', 'quote'])

/** 负责人自己账号发出的一条内容。返回 {mine, followers}：粉丝数由调用方记入序列，不属于 mine 本身。 */
export function parseMine(raw, { ownHandle } = {}) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) return null
  if (typeof raw.postId !== 'string' || !POST_ID.test(raw.postId)) return null
  const kind = raw.kind === undefined ? 'post' : raw.kind
  if (typeof kind !== 'string' || !MINE_KINDS.has(kind)) return null
  if (typeof raw.text !== 'string') return null
  const postedAt = isoTime(raw.postedAt)
  const fetchedAt = isoTime(raw.fetchedAt)
  if (!postedAt || !fetchedAt) return null
  const m = raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {}
  const r = raw.inReplyTo
  const inReplyTo =
    kind === 'reply' && r && typeof r === 'object' && typeof r.handle === 'string' && HANDLE.test(r.handle) && typeof r.postId === 'string' && POST_ID.test(r.postId)
      ? { handle: r.handle, postId: r.postId }
      : null
  const f = raw.followers
  const followers = Number.isInteger(f) && f >= 0 && f <= 1e9 ? f : null
  return {
    mine: {
      id: raw.postId,
      kind,
      text: safeText(raw.text, 4000),
      url: typeof ownHandle === 'string' && HANDLE.test(ownHandle) ? `https://x.com/${ownHandle}/status/${raw.postId}` : null,
      postedAt,
      fetchedAt,
      likes: count(m.likes),
      replies: count(m.replies),
      reposts: count(m.reposts),
      quotes: count(m.quotes),
      views: count(m.views),
      inReplyTo,
      candidateId: null,
      replyId: null,
    },
    followers,
  }
}

/** Grok Bot 起草并通知过的一次回复。id 由调用方分配。 */
export function parseReplyDraft(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) return null
  if (typeof raw.toHandle !== 'string' || !HANDLE.test(raw.toHandle)) return null
  if (typeof raw.toPostId !== 'string' || !POST_ID.test(raw.toPostId)) return null
  if (!Array.isArray(raw.drafts)) return null
  const drafts = raw.drafts
    .filter(d => typeof d === 'string' && d.trim())
    .slice(0, 3)
    .map(d => safeText(d.trim(), 1000))
  if (!drafts.length) return null
  const notifiedAt = isoTime(raw.notifiedAt)
  if (!notifiedAt) return null
  return { toHandle: raw.toHandle, toPostId: raw.toPostId, drafts, notifiedAt, sentText: null, sentAt: null }
}

const PARSERS = { posts: parsePost, decisions: parseDecision, mine: parseMine, replies: parseReplyDraft }

async function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, path)
}

export class Exchange {
  constructor(root, { now = Date.now } = {}) {
    this.root = root
    this.now = now
  }

  async ensure() {
    for (const d of DIRS) await mkdir(join(this.root, d), { recursive: true })
  }

  async #loadSeen(kind) {
    try {
      const list = JSON.parse(await readFile(join(this.root, `.seen-${kind}.json`), 'utf8'))
      return Array.isArray(list) ? list.filter(n => typeof n === 'string') : []
    } catch {
      return []
    }
  }

  async readNew(kind, opts = {}) {
    const parse = PARSERS[kind]
    if (!parse) throw new Error(`未知的交换目录：${kind}`)
    const dir = join(this.root, kind)
    const seen = await this.#loadSeen(kind)
    const seenSet = new Set(seen)
    const entries = await readdir(dir, { withFileTypes: true })
    const names = entries
      .filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.') && !seenSet.has(e.name))
      .map(e => e.name)
      .sort()
    const items = []
    const skipped = []
    const processed = []
    for (const name of names) {
      const path = join(dir, name)
      let info
      try {
        info = await stat(path)
      } catch (e) {
        if (e.code !== 'ENOENT') skipped.push({ file: name, why: '读取失败' })
        continue
      }
      // 超过 30 天的文件完全忽略：不读、不报、不记，已处理记录因此不会无限增长
      if (this.now() - info.mtimeMs > MAX_AGE_MS) continue
      if (!FILE_NAME.test(name)) {
        skipped.push({ file: name, why: '文件名不合规' })
        processed.push(name)
        continue
      }
      let buf
      try {
        if (info.size <= MAX_FILE_BYTES) buf = await readFile(path)
      } catch (e) {
        if (e.code !== 'ENOENT') skipped.push({ file: name, why: '读取失败' })
        continue
      }
      if (!buf || buf.length > MAX_FILE_BYTES) {
        skipped.push({ file: name, why: '文件太大' })
        processed.push(name)
        continue
      }
      let item = null
      let why = '不是有效的 JSON'
      try {
        const parsed = JSON.parse(buf.toString('utf8'))
        item = parse(parsed, opts)
        if (!item) why = '内容不符合格式'
      } catch {}
      if (item) {
        items.push(item)
        processed.push(name)
      } else if (this.now() - info.mtimeMs >= FRESH_MS) {
        skipped.push({ file: name, why })
        processed.push(name)
      }
    }
    // 调用方把这批内容落库之后再 commit；没 commit 的文件下次还会读到
    let done = false
    const commit = async () => {
      if (done || !processed.length) return
      done = true
      // 只留目录里还在、且 30 天内的文件名：记录的长度由目录内容决定，不设条数上限
      const next = []
      for (const name of new Set([...(await this.#loadSeen(kind)), ...processed])) {
        try {
          if (this.now() - (await stat(join(dir, name))).mtimeMs <= MAX_AGE_MS) next.push(name)
        } catch (e) {
          if (e.code !== 'ENOENT') next.push(name)
        }
      }
      await writeAtomic(join(this.root, `.seen-${kind}.json`), JSON.stringify(next))
    }
    return { items, skipped, commit }
  }

  async writeDraft(candidate, typeName, { intentUrl } = {}) {
    const name = `${candidate.id}-r${candidate.revision}.json`
    const body = {
      schema: 1,
      id: candidate.id,
      revision: candidate.revision,
      form: candidate.form,
      typeName,
      title: candidate.title,
      text: candidate.text,
      quoteUrl: candidate.quoteUrl ?? null,
      intentUrl: intentUrl ?? null,
      status: candidate.status,
      scheduledAt: candidate.scheduledAt ?? null,
      createdAt: candidate.createdAt,
    }
    try {
      await writeFile(join(this.root, 'drafts', name), JSON.stringify(body, null, 2), { flag: 'wx' })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    return name
  }

  async writeVoice({ watchlist, skillMarkdown }) {
    const dir = join(this.root, 'voice')
    const list = { schema: 1, engage: watchlist.engage, topic: watchlist.topic }
    await writeAtomic(join(dir, 'watchlist.json'), JSON.stringify(list, null, 2))
    await writeAtomic(join(dir, 'SKILL.md'), skillMarkdown)
  }
}
