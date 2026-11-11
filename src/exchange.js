import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIRS = ['posts', 'decisions', 'drafts', 'voice', 'replies', 'mine']
const MAX_FILE_BYTES = 65536
const MAX_SEEN = 5000
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
  return Number.isInteger(v) && v > 0 ? v : 0
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

const PARSERS = { posts: parsePost, decisions: parseDecision }

async function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, path)
}

export class Exchange {
  constructor(root) {
    this.root = root
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

  async readNew(kind) {
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
    for (const name of names) {
      const skip = why => skipped.push({ file: name, why })
      if (!FILE_NAME.test(name)) { skip('文件名不合规'); continue }
      let parsed
      try {
        const path = join(dir, name)
        if ((await stat(path)).size > MAX_FILE_BYTES) { skip('文件太大'); continue }
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        skip('不是有效的 JSON')
        continue
      }
      const item = parse(parsed)
      if (item) items.push(item)
      else skip('内容不符合格式')
    }
    if (names.length) {
      const next = [...seen, ...names].slice(-MAX_SEEN)
      await writeAtomic(join(this.root, `.seen-${kind}.json`), JSON.stringify(next))
    }
    return { items, skipped }
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
