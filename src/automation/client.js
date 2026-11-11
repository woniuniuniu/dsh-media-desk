import http from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import { automationPaths } from './paths.js'
import { catalog } from './catalog.js'
import { failure } from './errors.js'
const MAX_RESPONSE = 1048576
export class AutomationClient {
  constructor(options = {}) { this.paths = automationPaths(options); this.readOnly = !!options.readOnly; this.timeout = options.timeout }
  timeoutFor(tool) { return this.timeout ?? (tool === 'media_desk_assist' ? 300000 : 30000) }
  async call(tool, input = {}, requestId = input.requestId) {
    const def = catalog.find(t => t.name === tool)
    if (!def) return failure('UNKNOWN_TOOL', 'Unknown tool.', undefined, requestId)
    if (this.readOnly && def.mutation) return failure('READ_ONLY', 'Mutations are disabled.', undefined, requestId)
    if (def.mutation && !requestId) return failure('REQUEST_ID_REQUIRED', 'Mutation requires requestId.')
    let token
    try {
      for (const [file, kind] of [[this.paths.dir, 'dir'], [this.paths.token, 'file'], [this.paths.socket, 'socket']]) {
        const info = await lstat(file)
        if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || (kind === 'dir' ? !info.isDirectory() : kind === 'file' ? !info.isFile() : !info.isSocket())) throw new Error('Unsafe endpoint permissions.')
      }
      token = await readFile(this.paths.token, 'utf8')
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid token.')
    } catch { return failure('UNAVAILABLE', 'Workbench automation is unavailable or endpoint permissions are unsafe. Start the desktop workbench.', undefined, requestId) }
    return new Promise(resolve => {
      let dispatched = false; let done = false
      const finish = value => { if (!done) { done = true; resolve(value) } }
      const uncertain = () => finish(failure(def.mutation && dispatched ? 'OUTCOME_UNKNOWN' : 'UNAVAILABLE', def.mutation && dispatched ? 'Transport ended after dispatch. Inspect request status and state; do not retry blindly.' : 'Unable to reach the local workbench.', undefined, requestId))
      const req = http.request({ socketPath: this.paths.socket, method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
        const chunks = []; let size = 0
        res.on('data', b => { size += b.length; if (size > MAX_RESPONSE) { req.destroy(); uncertain() } else chunks.push(b) })
        res.on('aborted', uncertain); res.on('error', uncertain)
        res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (typeof value.ok !== 'boolean') throw new Error(); finish(def.mutation && requestId && !value.requestId ? { ...value, requestId } : value) } catch { uncertain() } })
      })
      req.on('finish', () => { dispatched = true }); req.on('error', uncertain)
      req.setTimeout(this.timeoutFor(tool), () => { uncertain(); req.destroy() })
      req.end(JSON.stringify({ tool, input, ...(requestId ? { requestId } : {}) }))
    })
  }
}
