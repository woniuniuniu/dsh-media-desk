import http from 'node:http'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer } from './mcp.js'

const MAX_BODY = 262144
const MAX_CONCURRENT = 16

async function readToken(tokenFile) {
  let file
  try {
    if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile)) throw new Error()
    const before = await lstat(tokenFile)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error()
    file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size < 32 || info.size > 256) throw new Error()
    const bytes = Buffer.alloc(257)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const token = bytes.subarray(0, bytesRead).toString('utf8')
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || new Set(token).size < 8) throw new Error()
    return token
  } catch { throw new Error('HTTP token file must be an absolute, existing, caller-owned private regular file containing a strong random token.') }
  finally { await file?.close() }
}
function publicHostnames(options) {
  const names = [...(options.publicHosts ?? []), ...(options.publicHost ? [options.publicHost] : [])]
  if (names.some(name => typeof name !== 'string' || name.length > 253 || !name.includes('.') || !name.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))) throw new Error('Public host must be an exact DNS hostname, without URL, port or wildcard.')
  return new Set(names.map(name => name.toLowerCase()))
}
function trustedHost(host, port, publicHosts) {
  if (typeof host !== 'string') return false
  const match = /^([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(host)
  if (!match) return false
  const name = match[1].toLowerCase(); const suppliedPort = match[2] === undefined ? undefined : Number(match[2])
  if (suppliedPort !== undefined && (suppliedPort < 1 || suppliedPort > 65535)) return false
  return ['localhost', '127.0.0.1'].includes(name) ? suppliedPort === undefined || suppliedPort === port : publicHosts.has(name) && (suppliedPort === undefined || suppliedPort === 443)
}
function reject(req, res, status, message) {
  req.resume()
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close', ...(status === 405 ? { allow: 'POST' } : {}) })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }))
}

// HTTP is an explicitly started adapter; the Host continues to own its private socket.
export async function startMcpHttp(options = {}) {
  const port = options.port ?? 41419
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port.')
  const hosts = publicHostnames(options)
  const token = await readToken(options.tokenFile)
  const expected = Buffer.from(`Bearer ${token}`)
  // Validate profile/runtime configuration before exposing a listener.
  await createMcpServer(options).close()
  let closing = false; let disposal
  const requests = new Set()
  async function handle(req, res) {
    const received = Buffer.from(String(req.headers.authorization ?? ''))
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return reject(req, res, 401, 'Authentication required.')
    if (Object.keys(req.headers).some(name => name === 'origin' || name.startsWith('sec-fetch-') && (name !== 'sec-fetch-mode' || req.headers[name] !== 'cors'))) return reject(req, res, 403, 'Browser requests are refused.')
    if (!trustedHost(req.headers.host, server.address()?.port, hosts)) return reject(req, res, 403, 'Host is not allowed.')
    if (req.url !== '/mcp') return reject(req, res, 404, 'Unknown endpoint.')
    if (req.method !== 'POST') return reject(req, res, 405, 'Method is not supported.')
    const protocol = req.headers['mcp-protocol-version']
    if (protocol !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)) return reject(req, res, 400, 'Unsupported protocol version.')
    if (closing || requests.size >= MAX_CONCURRENT) return reject(req, res, 503, 'Service is unavailable.')
    // Reserve capacity synchronously, including body reads, until SDK work finishes.
    let finish
    const done = new Promise(resolve => { finish = resolve }); requests.add(done)
    let mcp
    try {
      let size = 0; const chunks = []
      const declared = req.headers['content-length']
      if (declared !== undefined && Number(declared) > MAX_BODY) return reject(req, res, 413, 'Request exceeds size limit.')
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) return reject(req, res, 413, 'Request exceeds size limit.')
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(req, res, 400, 'Malformed JSON.') }
      if (Array.isArray(body)) return reject(req, res, 400, 'Batch requests are not supported.')
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      mcp = createMcpServer(options)
      await mcp.connect(transport)
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff')
      // Do not close on response disconnect: accepted Host calls must settle first.
      await transport.handleRequest(req, res, body)
    } catch { reject(req, res, 500, 'Request could not complete.') }
    finally {
      try { await mcp?.close() } finally { requests.delete(done); finish() }
    }
  }
  const server = http.createServer((req, res) => { void handle(req, res).catch(() => reject(req, res, 500, 'Request could not complete.')) })
  server.requestTimeout = 30000; server.headersTimeout = 10000
  await new Promise((resolve, rejectStartup) => {
    server.once('error', rejectStartup)
    server.listen(port, '127.0.0.1', () => { server.off('error', rejectStartup); resolve() })
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    dispose() {
      if (disposal) return disposal
      closing = true
      disposal = (async () => {
        const closed = new Promise(resolve => server.close(resolve))
        server.closeIdleConnections()
        await Promise.allSettled([...requests])
        server.closeIdleConnections()
        await closed
      })()
      return disposal
    }
  }
}
