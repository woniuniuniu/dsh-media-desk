import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, chmod, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Store } from '../src/store.js'
import { PLUGIN_VERSION } from '../src/automation/catalog.js'

async function httpModule() {
  const mod = await import('../src/automation/http.js').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error })
  assert.equal(typeof mod.startMcpHttp, 'function', 'HTTP MCP entry point must be implemented')
  return mod
}
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'md-http-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const token = randomBytes(32).toString('hex'); const tokenFile = join(home, 'http-token')
  await writeFile(tokenFile, token, { mode: 0o600 })
  const store = new Store(join(home, 'media-desk')); await store.mutate('empty', s => { s.items = [] })
  const { createAutomationService } = await import('../src/automation/service.js')
  const { startAutomationServer } = await import('../src/automation/server.js')
  const service = createAutomationService({ store, settings: {}, producer: { isRunning: () => false, anyAssetActive: () => false } })
  const host = await startAutomationServer({ home, profile: 'desktop', service: options.wrap ? options.wrap(service) : service })
  t.after(() => host.dispose())
  const { startMcpHttp } = await httpModule()
  const bridge = await startMcpHttp({ home, profile: 'desktop', tokenFile, port: 0, ...options.http })
  t.after(() => bridge.dispose())
  return { home, store, host, bridge, tokenFile, token }
}
async function sdk(t, bridge, token) {
  const client = new Client({ name: 'http-test', version: '1' })
  t.after(() => client.close())
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  assert.equal(transport.sessionId, undefined, 'HTTP transport must be stateless')
  return client
}
function raw(url, { headers = {}, method = 'POST', path, body = '{}', chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path ?? url, url), { method, headers }, res => {
      let data = ''; res.on('data', b => { data += b }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, body: data ? JSON.parse(data) : undefined }))
    })
    req.on('error', reject); if (chunked) req.write(body); req.end(chunked ? undefined : body)
  })
}
const rpc = (method, params = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
const auth = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' })

test('MCP server factory shares catalog without connecting a transport', async () => {
  const { createMcpServer } = await import('../src/automation/mcp.js')
  assert.equal(typeof createMcpServer, 'function')
  const server = createMcpServer({ readOnly: true }); await server.close()
})

test('official HTTP SDK initializes, lists, reads and deduplicates a real Host mutation', async t => {
  const { bridge, token, store } = await fixture(t)
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const client = await sdk(t, bridge, token)
  assert.equal(client.getServerVersion().version, PLUGIN_VERSION)
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'media_desk_write_draft'))
  assert.equal((await client.callTool({ name: 'media_desk_status', arguments: {} })).structuredContent.ok, true)
  const args = { requestId: 'http-once', ops: [{ op: 'add_item', title: 'HTTP idea' }] }
  const first = await client.callTool({ name: 'media_desk_apply_ops', arguments: args })
  const second = await client.callTool({ name: 'media_desk_apply_ops', arguments: args })
  assert.equal(first.structuredContent.ok, true); assert.equal(second.structuredContent.cached, true)
  assert.equal((await store.read()).items.length, 1)
})

test('HTTP authenticates before JSON and rejects browser headers, other paths/methods and untrusted Hosts', async t => {
  const { bridge, token } = await fixture(t, { http: { publicHosts: ['bridge.example.test'] } })
  const headers = auth(token)
  for (const authorization of [undefined, 'Bearer wrong']) {
    const result = await raw(bridge.url, { headers: authorization ? { authorization } : {}, body: '{' })
    assert.equal(result.status, 401); assert.equal(result.text.includes(token), false)
  }
  for (const browser of [{ origin: 'https://example.test' }, { origin: '' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': '' }]) assert.equal((await raw(bridge.url, { headers: { ...headers, ...browser } })).status, 403)
  assert.equal((await raw(bridge.url, { headers: { ...headers, 'sec-fetch-mode': 'cors' }, body: rpc('tools/list') })).status, 200)
  assert.equal((await raw(bridge.url, { headers: { ...headers, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'none' } })).status, 403)
  assert.equal((await raw(bridge.url, { headers: { ...headers, host: 'attacker.test' } })).status, 403)
  assert.equal((await raw(bridge.url, { headers: { ...headers, host: 'attacker.test', 'x-forwarded-host': 'localhost' } })).status, 403)
  for (const host of ['bridge.example.test', 'bridge.example.test:443', 'localhost']) assert.equal((await raw(bridge.url, { headers: { ...headers, host }, body: rpc('tools/list') })).status, 200)
  assert.equal((await raw(bridge.url, { headers, path: '/other' })).status, 404)
  for (const method of ['PUT', 'DELETE', 'GET']) assert.equal((await raw(bridge.url, { headers, method })).status, 405)
  assert.equal((await raw(bridge.url, { headers, body: '{' })).status, 400)
  assert.equal((await raw(bridge.url, { headers, body: 'x'.repeat(262145) })).status, 413)
  assert.equal((await raw(bridge.url, { headers, body: 'x'.repeat(262145), chunked: true })).status, 413)
  assert.equal((await raw(bridge.url, { headers, body: rpc('tools/list') })).headers['content-type'], 'application/json')
})

test('HTTP rejects JSON-RPC batches before any Host dispatch so concurrency cannot be bypassed', async t => {
  let dispatched = 0
  const { bridge, token } = await fixture(t, { wrap: service => ({ call: env => { dispatched++; return service.call(env) } }) })
  const batch = Array.from({ length: 17 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'media_desk_status', arguments: {} } }))
  const response = await raw(bridge.url, { headers: auth(token), body: JSON.stringify(batch) })
  assert.equal(response.status, 400); assert.equal(dispatched, 0)
})

test('HTTP protocol errors do not reflect submitted secrets', async t => {
  const { bridge, token } = await fixture(t)
  const secret = 'synthetic-private-protocol-value'
  const response = await raw(bridge.url, { headers: { ...auth(token), 'mcp-protocol-version': secret }, body: rpc('tools/list') })
  assert.equal(response.status, 400); assert.equal(response.text.includes(secret), false)
})

test('read-only HTTP omits mutations and rejects direct write calls', async t => {
  const { bridge, token, store } = await fixture(t, { http: { readOnly: true } })
  const client = await sdk(t, bridge, token)
  assert.ok((await client.listTools()).tools.every(tool => tool.annotations.readOnlyHint))
  const result = await client.callTool({ name: 'media_desk_apply_ops', arguments: { requestId: 'denied', ops: [{ op: 'add_item', title: 'denied' }] } })
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'READ_ONLY')
  assert.equal((await store.read()).items.length, 0)
})

test('HTTP refuses missing, relative, weak, symlink, directory and permissive token files', async t => {
  const { startMcpHttp } = await httpModule()
  const home = await mkdtemp(join(tmpdir(), 'md-token-')); t.after(() => rm(home, { recursive: true, force: true }))
  const file = join(home, 'token'); const token = randomBytes(32).toString('hex')
  await assert.rejects(startMcpHttp({ tokenFile: join(home, 'missing'), port: 0 }), /token/i)
  await assert.rejects(startMcpHttp({ tokenFile: 'relative', port: 0 }), /token/i)
  await writeFile(file, 'x'.repeat(64), { mode: 0o600 })
  await assert.rejects(startMcpHttp({ tokenFile: file, port: 0 }), /token/i)
  await writeFile(file, token); await chmod(file, 0o644)
  await assert.rejects(startMcpHttp({ tokenFile: file, port: 0 }), /token/i)
  await chmod(file, 0o600); await symlink(file, file + '.link')
  await assert.rejects(startMcpHttp({ tokenFile: file + '.link', port: 0 }), /token/i)
  await mkdir(file + '.dir', { mode: 0o700 })
  await assert.rejects(startMcpHttp({ tokenFile: file + '.dir', port: 0 }), /token/i)
  for (const publicHosts of [['*'], ['https://bridge.test'], ['bridge.test/path'], ['bridge.test:443']]) await assert.rejects(startMcpHttp({ tokenFile: file, port: 0, publicHosts }), /host/i)
})

test('HTTP bounds concurrent requests and drains accepted mutations before disposal', async t => {
  let entered; let release
  const started = new Promise(resolve => { entered = resolve }); const blocked = new Promise(resolve => { release = resolve })
  let count = 0
  const { bridge, token, store } = await fixture(t, { wrap: service => ({ call: async env => { if (env.tool === 'media_desk_apply_ops') { if (++count === 16) entered(); await blocked }; return service.call(env) } }) })
  t.after(release)
  const headers = auth(token)
  const calls = Array.from({ length: 16 }, (_, i) => raw(bridge.url, { headers, body: rpc('tools/call', { name: 'media_desk_apply_ops', arguments: { requestId: `drain-${i}`, ops: [{ op: 'add_item', title: `accepted ${i}` }] } }) }))
  await started
  assert.equal((await raw(bridge.url, { headers, body: rpc('tools/list') })).status, 503)
  let disposed = false; const disposal = bridge.dispose().then(() => { disposed = true })
  assert.equal(bridge.dispose(), bridge.dispose(), 'disposal must be idempotent')
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(disposed, false)
  release()
  for (const response of await Promise.all(calls)) { assert.equal(response.status, 200); assert.equal(response.body.result.structuredContent.ok, true) }
  await disposal; assert.equal((await store.read()).items.length, 16)
})

test('HTTP disconnect and shutdown preserve an accepted mutation until its Host result settles', async t => {
  let entered; let release
  const started = new Promise(resolve => { entered = resolve }); const blocked = new Promise(resolve => { release = resolve })
  t.after(() => release())
  const { bridge, token, store } = await fixture(t, { wrap: service => ({ call: async env => { if (env.tool === 'media_desk_apply_ops') { entered(); await blocked }; return service.call(env) } }) })
  const req = http.request(bridge.url, { method: 'POST', headers: auth(token) })
  req.on('error', () => {})
  req.end(rpc('tools/call', { name: 'media_desk_apply_ops', arguments: { requestId: 'disconnected-once', ops: [{ op: 'add_item', title: 'must finish' }] } }))
  await started; req.destroy()
  let disposed = false; const disposal = bridge.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(disposed, false)
  release(); await disposal
  assert.equal((await store.read()).items.length, 1)
})

function cli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['bin/media-desk.js', ...args]); let stdout = ''; let stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b }); child.on('close', code => resolve({ code, stdout, stderr }))
  })
}
test('HTTP CLI startup failures use only stderr and never echo secrets', async () => {
  const secret = 'synthetic-sensitive-token'
  const result = await cli(['mcp-http', '--token-file', secret, '--port', 'invalid'])
  assert.equal(result.code, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /MCP HTTP startup failed/); assert.equal(result.stderr.includes(secret), false)
})

test('HTTP CLI announces only endpoint/version and SIGTERM drains cleanly', async t => {
  const { home, tokenFile, token } = await fixture(t)
  const child = spawn(process.execPath, ['bin/media-desk.js', '--home', home, '--profile', 'desktop', '--read-only', 'mcp-http', '--port', '0', '--token-file', tokenFile])
  let stdout = ''; let stderr = ''; child.stdout.on('data', b => { stdout += b })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const endpoint = await new Promise((resolve, reject) => {
    child.stderr.on('data', b => { stderr += b; const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/); if (match) resolve(match[0]) })
    child.once('exit', () => reject(new Error('HTTP CLI exited before readiness')))
  })
  const response = await raw(endpoint, { headers: auth(token), body: rpc('tools/list') })
  assert.ok(response.body.result.tools.every(tool => tool.annotations.readOnlyHint))
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  child.kill('SIGTERM'); assert.deepEqual(await exited, { code: 0, signal: null })
  assert.equal(stdout, ''); assert.ok(stderr.includes(PLUGIN_VERSION)); assert.equal(stderr.includes(token), false); assert.equal(stderr.includes(tokenFile), false)
})
