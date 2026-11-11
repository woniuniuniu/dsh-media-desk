import http from 'node:http'
import net from 'node:net'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { automationPaths } from './paths.js'
import { failure } from './errors.js'
export const MAX_BODY = 262144
export const MAX_RESPONSE = 1048576
function alive(pid) { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; return true } }
async function proveSocketInactive(path) {
  try { const info = await lstat(path); if (!info.isSocket() || info.isSymbolicLink()) throw new Error('Unsafe or uncertain socket endpoint.') } catch (e) { if (e.code === 'ENOENT') return; throw e }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    const finish = error => { socket.destroy(); error ? reject(error) : resolve() }
    socket.once('connect', () => finish(new Error('A live socket endpoint exists; refusing stale owner cleanup.')))
    socket.once('error', e => finish(['ENOENT', 'ECONNREFUSED'].includes(e.code) ? null : new Error('Socket liveness is uncertain; refusing cleanup.')))
    socket.setTimeout(1000, () => finish(new Error('Socket liveness is uncertain; refusing cleanup.')))
  })
}
async function sameFile(path, expected) {
  if (!expected) return false
  try { const info = await lstat(path); return info.dev === expected.dev && info.ino === expected.ino && !info.isSymbolicLink() } catch { return false }
}
async function removeOwn(path, expected) { if (await sameFile(path, expected)) await rm(path, { force: true }) }
async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const s = await lstat(dir)
  if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== process.getuid?.()) throw new Error('Automation directory must be a private directory owned by this user.')
  await chmod(dir, 0o700)
}
export async function startAutomationServer({ home, profile, service }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Automation Unix sockets require macOS or Linux.')
  const paths = automationPaths({ home, profile })
  if (Buffer.byteLength(paths.socket) > (process.platform === 'darwin' ? 103 : 107)) throw new Error('Automation socket path is too long. Use a shorter DSH_HOME.')
  await privateDir(paths.dir)
  const nonce = randomUUID(); let lock
  for (let attempt = 0; attempt < 3; attempt++) {
    try { lock = await open(paths.lock, 'wx', 0o600); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let old, info
      try { info = await lstat(paths.lock); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('Unsafe owner file.'); old = JSON.parse(await readFile(paths.lock, 'utf8')) } catch { throw new Error('Automation owner is uncertain; refusing cleanup.') }
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || alive(old.pid)) throw new Error('Automation already has a live or uncertain owner.')
      // Rename-free compare-and-unlink with exclusive competing recovery lock.
      let recovery
      try { recovery = await open(`${paths.lock}.recover`, 'wx', 0o600) } catch { throw new Error('Automation ownership recovery is already in progress.') }
      try {
        if (await readFile(paths.lock, 'utf8') !== JSON.stringify(old) || alive(old.pid)) throw new Error('Automation owner changed during recovery.')
        await proveSocketInactive(paths.socket)
        await rm(paths.socket, { force: true }); await rm(paths.token, { force: true }); await rm(paths.lock)
      } finally { await recovery.close(); await rm(`${paths.lock}.recover`, { force: true }) }
    }
  }
  if (!lock) throw new Error('Unable to acquire automation ownership.')
  const owner = JSON.stringify({ pid: process.pid, nonce })
  const lockIdentity = await lock.stat()
  await lock.writeFile(owner); await lock.sync(); await lock.close()
  let server; let disposed = false; let disposal; const dispatches = new Set(); let tokenIdentity; let socketIdentity; let boundIdentity
  const bindPath = join(paths.dir, `s${randomBytes(3).toString('hex')}`)
  const own = async () => { try { return await sameFile(paths.lock, lockIdentity) && await readFile(paths.lock, 'utf8') === owner } catch { return false } }
  async function cleanup() { if (await own()) { await removeOwn(paths.socket, socketIdentity); await removeOwn(paths.token, tokenIdentity); await removeOwn(paths.lock, lockIdentity) } }
  try {
    const token = randomBytes(32).toString('hex')
    const fd = await open(paths.token, 'wx', 0o600); tokenIdentity = await fd.stat(); try { await fd.writeFile(token); await fd.sync() } finally { await fd.close() }
    server = http.createServer(async (req, res) => {
      const send = (status, value) => {
        let body = JSON.stringify(value)
        if (Buffer.byteLength(body) > MAX_RESPONSE) { status = 500; body = JSON.stringify(failure('RESPONSE_TOO_LARGE', 'Response exceeds limit; request fewer fields.', undefined, value.requestId)) }
        if (res.destroyed) return
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body)
      }
      if (disposed) { req.resume(); return send(503, failure('UNAVAILABLE', 'Workbench automation is shutting down.')) }
      if (req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode']) { req.resume(); return send(403, failure('ORIGIN_REJECTED', 'Browser-origin requests are refused.')) }
      const received = Buffer.from(String(req.headers.authorization ?? '')); const expected = Buffer.from(`Bearer ${token}`)
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) { req.resume(); return send(401, failure('UNAUTHORIZED', 'Local authentication failed.')) }
      if (req.method !== 'POST' || req.url !== '/rpc') { req.resume(); return send(404, failure('NOT_FOUND', 'Unknown endpoint.')) }
      let size = 0; const chunks = []
      try {
        for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { req.resume(); send(413, failure('BODY_TOO_LARGE', 'Request exceeds size limit.')); return } chunks.push(chunk) }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, failure('BAD_JSON', 'Malformed JSON.')) }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['tool', 'input', 'requestId'].includes(k)) || typeof body.tool !== 'string' || body.input !== undefined && (!body.input || typeof body.input !== 'object' || Array.isArray(body.input))) return send(400, failure('INVALID_ARGUMENT', 'Invalid RPC envelope.'))
        if (disposed) return send(503, failure('UNAVAILABLE', 'Workbench automation is shutting down.', undefined, typeof body.requestId === 'string' ? body.requestId : undefined))
        const dispatched = Promise.resolve().then(() => service.call(body))
        dispatches.add(dispatched)
        try { send(200, await dispatched) } finally { dispatches.delete(dispatched) }
      } catch { send(500, failure('INTERNAL_ERROR', 'Local dispatch could not complete.')) }
    })
    server.requestTimeout = 30000; server.headersTimeout = 10000
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(bindPath, () => { server.off('error', reject); resolve() }) })
    boundIdentity = await lstat(bindPath)
    await chmod(bindPath, 0o600)
    // Publish without overwriting. libuv owns only bindPath, so close() cannot
    // unlink a replacement socket at the public name.
    await link(bindPath, paths.socket)
    socketIdentity = boundIdentity
    await removeOwn(bindPath, boundIdentity)
    return { paths, dispose() {
      if (disposal) return disposal
      disposed = true
      disposal = (async () => {
        // Reject new dispatches and stop accepts first. Keep the live owner until
        // all accepted service calls finish their journal/Store writes.
        const closed = new Promise(resolve => server.close(resolve))
        server.closeAllConnections()
        await Promise.allSettled([...dispatches])
        await closed
        await cleanup()
      })()
      return disposal
    } }
  } catch (e) { if (server?.listening) await new Promise(r => server.close(r)); await removeOwn(bindPath, boundIdentity); await cleanup(); throw e }
}
