import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { failure } from './errors.js'
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
export class MutationJournal {
  constructor(root) { this.root = root; this.file = join(root, 'journal.json'); this.inflight = new Map(); this.queue = Promise.resolve(); this.rows = null }
  serial(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p }
  async load() {
    if (this.rows) return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try { this.rows = JSON.parse(await readFile(this.file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; this.rows = Object.create(null) }
    for (const row of Object.values(this.rows)) if (row.status === 'pending') row.status = 'unknown'
  }
  async persist() {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    const fd = await open(tmp, 'wx', 0o600)
    try { await fd.writeFile(JSON.stringify(this.rows)); await fd.sync() } finally { await fd.close() }
    await rename(tmp, this.file)
    const dir = await open(this.root, 'r'); try { await dir.sync() } finally { await dir.close() }
  }
  async status(id) { return this.serial(async () => { await this.load(); const row = Object.hasOwn(this.rows, id) ? this.rows[id] : undefined; return row ? { requestId: id, status: row.status, tool: row.tool, at: row.at, ...(row.response ? { response: row.response } : {}) } : { requestId: id, status: 'not_found' } }) }
  async execute(id, tool, input, invoke) {
    const hash = createHash('sha256').update(JSON.stringify(canonical({ tool, input }))).digest('hex')
    const decision = await this.serial(async () => {
      await this.load()
      const row = Object.hasOwn(this.rows, id) ? this.rows[id] : undefined
      if (row) {
        if (row.hash !== hash) return { response: failure('REQUEST_ID_CONFLICT', 'Request ID was already used with different arguments.', undefined, id) }
        if (this.inflight.has(id)) return { waiting: this.inflight.get(id).promise }
        if (row.status === 'done') return { response: { ...row.response, cached: true } }
        return { response: failure('OUTCOME_UNKNOWN', 'A previous dispatch has an uncertain outcome. Inspect state and request status; do not replay.', undefined, id) }
      }
      let resolve
      const promise = new Promise(r => { resolve = r })
      this.inflight.set(id, { promise, resolve })
      this.rows[id] = { hash, tool, status: 'pending', at: new Date().toISOString() }
      try { await this.persist() } catch (e) { this.inflight.delete(id); delete this.rows[id]; throw e }
      return { fresh: true }
    })
    if (decision.response) return decision.response
    if (decision.waiting) return { ...await decision.waiting, cached: true }
    let response
    try { response = { ...await invoke(), requestId: id } } catch { response = failure('OUTCOME_UNKNOWN', 'Dispatch failed after recording intent; inspect state before any new action.', undefined, id) }
    await this.serial(async () => {
      this.rows[id].status = response.error?.code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'done'
      this.rows[id].response = response
      try { await this.persist() } catch {
        response = failure('OUTCOME_UNKNOWN', 'Result could not be durably recorded; inspect state before any new action.', undefined, id)
        // Keep failure handling in the same serial section: another intent must
        // never persist an unconfirmed success while this row becomes unknown.
        this.rows[id].status = 'unknown'
        this.rows[id].response = response
      }
    })
    this.inflight.get(id)?.resolve(response); this.inflight.delete(id)
    return response
  }
}
