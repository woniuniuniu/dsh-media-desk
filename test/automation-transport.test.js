import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, stat, writeFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { Store } from '../src/store.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'md-sock-')); t.after(() => rm(home, { recursive: true, force: true }))
  const { startAutomationServer } = await import('../src/automation/server.js')
  const { createAutomationService } = await import('../src/automation/service.js')
  const store = new Store(join(home, 'media-desk')); await store.mutate('empty', s => { s.items = [] })
  const starts = []
  const service = createAutomationService({ store, producer: { isRunning: () => false, anyAssetActive: () => false, start: async (...args) => { starts.push(args); return true } }, settings: {}, assist: async body => ({ answer: { text: `assisted: ${body.message}`, engine: 'synthetic-selected-model' }, actions: [] }) })
  const server = await startAutomationServer({ home, service })
  t.after(() => server.dispose())
  const { AutomationClient } = await import('../src/automation/client.js')
  return { home, server, service, store, starts, client: new AutomationClient({ home }) }
}
function raw(socketPath, headers = {}, body = '{}') {
  return new Promise((resolve, reject) => { const req = http.request({ socketPath, method: 'POST', path: '/rpc', headers }, res => { let data = ''; res.on('data', b => { data += b }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) })) }); req.on('error', reject); req.end(body) })
}
function cli(args) {
  return new Promise(resolve => { const p = spawn(process.execPath, ['bin/media-desk.js', ...args], { cwd: process.cwd() }); let stdout = '', stderr = ''; p.stdout.on('data', b => { stdout += b }); p.stderr.on('data', b => { stderr += b }); p.on('close', code => resolve({ code, stdout, stderr })) })
}
test('private authenticated socket refuses bad requests and live owners; disposal permits restart', async t => {
  const { home, server, service, client } = await fixture(t)
  const { startAutomationServer } = await import('../src/automation/server.js')
  assert.equal((await client.call('media_desk_status', {})).ok, true)
  for (const file of [server.paths.token, server.paths.socket]) assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(server.paths.dir)).mode & 0o777, 0o700)
  const token = await readFile(server.paths.token, 'utf8'); const auth = { authorization: `Bearer ${token}` }
  assert.equal((await raw(server.paths.socket)).status, 401)
  assert.equal((await raw(server.paths.socket, { ...auth, origin: 'http://localhost' })).status, 403)
  assert.equal((await raw(server.paths.socket, auth, '{')).status, 400)
  assert.equal((await raw(server.paths.socket, auth, 'x'.repeat(300000))).status, 413)
  assert.equal((await raw(server.paths.socket, auth, JSON.stringify({ tool: 'media_desk_nope' }))).body.error.code, 'UNKNOWN_TOOL')
  await assert.rejects(startAutomationServer({ home, service }), /already|owner/i)
  await server.dispose()
  const replacement = await startAutomationServer({ home, service }); await replacement.dispose()
})
test('CLI emits one compact JSON response and stable error status, convenience and read-only work', async t => {
  const { home } = await fixture(t)
  const good = await cli(['--home', home, 'doctor'])
  assert.equal(good.code, 0); assert.equal(JSON.parse(good.stdout).result.available, true)
  const add = await cli(['--home', home, 'idea', 'add', 'CLI idea'])
  assert.equal(add.code, 0); assert.ok(JSON.parse(add.stdout).requestId)
  const list = await cli(['--home', home, 'items', 'list']); assert.equal(JSON.parse(list.stdout).result.items[0].title, 'CLI idea')
  const denied = await cli(['--home', home, '--read-only', 'idea', 'add', 'denied']); assert.notEqual(denied.code, 0); assert.equal(JSON.parse(denied.stdout).error.code, 'READ_ONLY')
  const assisted = await cli(['--home', home, 'write', 'create article'])
  assert.equal(assisted.code, 0); assert.equal(JSON.parse(assisted.stdout).result.modelUsed, true); assert.ok(JSON.parse(assisted.stdout).requestId)
  const imported = await cli(['--home', home, 'write-draft', JSON.parse(add.stdout).result.receipts[0].target, '--input', JSON.stringify({ article: 'finished draft' })])
  assert.equal(imported.code, 0); assert.equal(JSON.parse(imported.stdout).result.modelCalls, 0)
  const profile = await cli(['--home', home, 'accounts', 'add', 'CLI account', '--input', JSON.stringify({platform:'抖音'})])
  assert.equal(profile.code,0); const accountId=JSON.parse(profile.stdout).result.receipts[0].target
  const profiles=await cli(['--home',home,'accounts','list']); assert.ok(JSON.parse(profiles.stdout).result.accounts.some(a=>a.id===accountId))
  const account=await cli(['--home',home,'accounts','get',accountId]); assert.equal(JSON.parse(account.stdout).result.handle,'CLI account')
  const scopedIdea=await cli(['--home',home,'idea','add','Account idea','--input',JSON.stringify({accountId})]);assert.equal(scopedIdea.code,0)
  const scopedId=JSON.parse(scopedIdea.stdout).result.receipts[0].target
  const scopedSchedule=await cli(['--home',home,'schedule',scopedId,'2026-11-13T12:00:00+08:00','--input',JSON.stringify({accountId})]);assert.equal(scopedSchedule.code,0,scopedSchedule.stdout)
  const bad = await cli(['--home', home, 'call', 'media_desk_status', '--input', '{']); assert.notEqual(bad.code, 0); assert.equal(JSON.parse(bad.stdout).error.code, 'INVALID_ARGUMENT')
})
test('official SDK stdio client discovers tools and makes reads/mutations without stdout pollution', async t => {
  const { home } = await fixture(t)
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'bin/media-desk.js'), '--home', home, 'mcp'], stderr: 'pipe' })
  const client = new Client({ name: 'automation-test', version: '1' }); t.after(() => client.close())
  await client.connect(transport)
  const tools = await client.listTools(); assert.ok(tools.tools.some(t => t.name === 'media_desk_write_draft')); assert.equal(tools.tools.find(t => t.name === 'media_desk_status').annotations.readOnlyHint, true)
  assert.equal((await client.callTool({ name: 'media_desk_status', arguments: {} })).structuredContent.ok, true)
  const created = await client.callTool({ name: 'media_desk_apply_ops', arguments: { requestId: 'mcp-add', ops: [{ op: 'add_item', title: 'MCP idea' }] } })
  assert.equal(created.structuredContent.ok, true)
  const assisted = await client.callTool({ name: 'media_desk_assist', arguments: { message: 'write my idea', requestId: 'mcp-assist' } }); assert.equal(assisted.structuredContent.result.modelUsed, true)
  const profiles = await client.callTool({name:'media_desk_list_accounts',arguments:{limit:1}});assert.equal(profiles.structuredContent.ok,true);assert.equal(profiles.structuredContent.result.accounts.length,1)
  assert.ok(tools.tools.some(t=>t.name==='media_desk_get_account'))
  const missing = await client.callTool({ name: 'media_desk_apply_ops', arguments: { ops: [] } }); assert.equal(missing.isError, true)
  const readonly = new Client({ name: 'read-only-test', version: '1' }); t.after(() => readonly.close())
  await readonly.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'bin/media-desk.js'), '--home', home, '--read-only', 'mcp'] }))
  assert.ok((await readonly.listTools()).tools.every(t => t.annotations.readOnlyHint))
})

test('Host lifecycle owns the bridge and shares the UI Store', async t => {
  const host = (await import('../src/host.js')).default
  const home = await mkdtemp(join(tmpdir(), 'md-host-')); t.after(() => rm(home, { recursive: true, force: true }))
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home; t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
  let route; const effects = []
  host.apply({ effect: fn => effects.push(fn), get: name => name === 'connection' ? { requestRejection: () => undefined } : null, webServer: { register: opts => { route = opts.handler; return () => {} } } })
  assert.equal(effects.length, 2)
  const disposers = effects.map(fn => fn()); t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.() })
  const { AutomationClient } = await import('../src/automation/client.js'); const client = new AutomationClient({ home })
  let ready
  for (let i = 0; i < 100; i++) { ready = await client.call('media_desk_status'); if (ready.ok) break; await new Promise(r => setTimeout(r, 10)) }
  assert.equal(ready.ok, true)
  const add = await client.call('media_desk_apply_ops', { ops: [{ op: 'add_item', title: 'shared-with-ui' }] }, 'host-add'); assert.equal(add.ok, true)
  let response
  const res = { setHeader() {}, end(body) { response = JSON.parse(body) } }
  await route({ method: 'GET', url: '/media-desk/state', headers: {} }, res)
  assert.ok(response.state.items.some(i => i.title === 'shared-with-ui'))
})

test('stale ownership is recovered only after death proof; uncertain and unrelated endpoint files survive', async t => {
  const { startAutomationServer } = await import('../src/automation/server.js')
  const { automationPaths } = await import('../src/automation/paths.js')
  const home = await mkdtemp(join(tmpdir(), 'md-own-')); t.after(() => rm(home, { recursive: true, force: true }))
  const paths = automationPaths({ home }); await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await writeFile(paths.token, 'unrelated-token', { mode: 0o600 })
  const service = { call: async () => ({ ok: true, result: {} }) }
  await assert.rejects(startAutomationServer({ home, service }), /exist|endpoint/i)
  assert.equal(await readFile(paths.token, 'utf8'), 'unrelated-token')
  await rm(paths.token)
  await writeFile(paths.lock, '{', { mode: 0o600 })
  await assert.rejects(startAutomationServer({ home, service }), /uncertain/i)
  assert.equal(await readFile(paths.lock, 'utf8'), '{')
  await rm(paths.lock)
  // An actual exited subprocess PID provides reliable process-death evidence.
  const pid = await new Promise(resolve => { const child = spawn(process.execPath, ['-e', '']); child.on('close', () => resolve(child.pid)) })
  await writeFile(paths.lock, JSON.stringify({ pid, nonce: 'old' }), { mode: 0o600 })
  await writeFile(paths.token, 'old-token', { mode: 0o600 })
  const server = await startAutomationServer({ home, service }); await server.dispose()
})

test('transport timeout reports outcome unknown with durable ID and never retries a mutation', async t => {
  const { home, server, service, store } = await fixture(t)
  await server.dispose()
  const { startAutomationServer } = await import('../src/automation/server.js')
  let completed
  const dispatchCompleted = new Promise(resolve => { completed = resolve })
  const delayed = await startAutomationServer({ home, service: { call: async env => { const result = await service.call(env); if (env.tool === 'media_desk_apply_ops') { completed(); await new Promise(r => setTimeout(r, 100)) } return result } } })
  t.after(() => delayed.dispose())
  const { AutomationClient } = await import('../src/automation/client.js')
  const response = await new AutomationClient({ home, timeout: 15 }).call('media_desk_apply_ops', { ops: [{ op: 'add_item', title: 'timeout-once' }] }, 'timeout-id')
  assert.equal(response.error.code, 'OUTCOME_UNKNOWN'); assert.equal(response.requestId, 'timeout-id')
  await dispatchCompleted
  const status = await new AutomationClient({ home }).call('media_desk_request_status', { requestId: 'timeout-id' })
  assert.equal(status.result.status, 'done'); assert.equal((await store.read()).items.length, 1)
})

test('live orphan socket and dead-owner records never authorize unlinking a connectable endpoint', async t => {
  const net = await import('node:net')
  const { startAutomationServer } = await import('../src/automation/server.js')
  const { automationPaths } = await import('../src/automation/paths.js')
  const home = await mkdtemp(join(tmpdir(), 'md-live-')); t.after(() => rm(home, { recursive: true, force: true }))
  const paths = automationPaths({ home }); await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  const live = net.createServer(socket => socket.end())
  await new Promise((resolve, reject) => { live.once('error', reject); live.listen(paths.socket, resolve) }); t.after(() => new Promise(resolve => live.close(resolve)))
  const service = { call: async () => ({ ok: true, result: {} }) }
  await assert.rejects(startAutomationServer({ home, service }), /address|use|exist|endpoint/i)
  assert.equal((await stat(paths.socket)).isSocket(), true)
  const deadPid = await new Promise(resolve => { const child = spawn(process.execPath, ['-e', '']); child.on('close', () => resolve(child.pid)) })
  await writeFile(paths.lock, JSON.stringify({ pid: deadPid, nonce: 'stale-but-live-socket' }), { mode: 0o600 })
  let unexpected
  try { await assert.rejects(async () => { unexpected = await startAutomationServer({ home, service }) }, /live|uncertain/i) } finally { await unexpected?.dispose() }
})


test('disposal preserves files atomically replaced by another owner', async t => {
  const { server } = await fixture(t)
  await writeFile(server.paths.token + '.replacement', 'replacement', { mode: 0o600 })
  await rename(server.paths.token + '.replacement', server.paths.token)
  await server.dispose()
  assert.equal(await readFile(server.paths.token, 'utf8'), 'replacement')
})

test('client keeps mutation IDs even when transport rejects a body before decoding the envelope', async t => {
  const { client } = await fixture(t)
  const response = await client.call('media_desk_apply_ops', { ops: [{ op: 'add_item', title: 'x'.repeat(300000) }] }, 'oversized-id')
  assert.equal(response.ok, false)
  assert.equal(response.requestId, 'oversized-id')
})

test('disposal never unlinks a live socket atomically replacing its public endpoint', async t => {
  const { server } = await fixture(t)
  const net = await import('node:net')
  await rm(server.paths.socket)
  const replacement = net.createServer(socket => socket.end())
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(server.paths.socket, resolve) })
  t.after(() => new Promise(resolve => replacement.close(resolve)))
  const before = await stat(server.paths.socket)
  await server.dispose()
  const after = await stat(server.paths.socket)
  assert.equal(after.ino, before.ino)
})

test('Host assist uses the selected model and original chat revision path exactly once', async t => {
  const host = (await import('../src/host.js')).default
  const { setAssistantModel } = await import('../src/ai.js'); setAssistantModel(null)
  const home = await mkdtemp(join(tmpdir(), 'md-model-'))
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = home
  const disposers = []; let calls = 0; let focusedId
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); setAssistantModel(null) })
  const llm = { prepareCall: async config => {
    calls++; assert.equal(config.provider, 'selected-provider'); assert.equal(config.model, 'selected-model')
    return { config, async *stream() { yield { type: 'text-delta', text: JSON.stringify({ reply: '模型改好了', ops: [], revise: { article: '## 模型修改\n正文' }, actions: [{ type: 'produce', id: focusedId }] }) } } }
  } }
  host.apply({ effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) }, get: name => name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'selected-provider', model: 'selected-model' }) } : name === 'connection' ? { requestRejection: () => undefined } : null, webServer: { register: () => () => {} } })
  const { AutomationClient } = await import('../src/automation/client.js'); const client = new AutomationClient({ home })
  for (let i = 0; i < 100; i++) { if ((await client.call('media_desk_status')).ok) break; await new Promise(r => setTimeout(r, 10)) }
  const added = await client.call('media_desk_apply_ops', { ops: [{ op: 'add_item', title: '用于改稿' }] }, 'assist-host-add')
  const id = added.result.receipts[0].target; focusedId = id
  assert.equal((await client.call('media_desk_write_draft', { id, article: '原稿' }, 'assist-host-import')).ok, true)
  const input = { message: '改写正文', focusId: id }
  const revised = await client.call('media_desk_assist', input, 'assist-host-revise')
  assert.equal(revised.ok, true, JSON.stringify(revised)); assert.equal(revised.result.modelUsed, true); assert.equal(revised.result.reply, '模型改好了')
  assert.match((await client.call('media_desk_get_item', { id, fields: ['article'] })).result.article, /模型修改/)
  assert.equal((await client.call('media_desk_assist', input, 'assist-host-revise')).cached, true)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(revised).includes('state'), false)
})


test('MCP startup diagnostics never pollute protocol stdout', async () => {
  const response = await cli(['--profile', '../invalid', 'mcp'])
  assert.notEqual(response.code, 0)
  assert.equal(response.stdout, '')
  assert.match(response.stderr, /startup|configuration|profile/i)
})

test('disposal drains dispatched mutations before releasing ownership to a replacement Host', async t => {
  const { home, server, store, client } = await fixture(t)
  await server.dispose()
  const { startAutomationServer } = await import('../src/automation/server.js')
  const { createAutomationService } = await import('../src/automation/service.js')
  let entered; let release
  const enteredCallback = new Promise(resolve => { entered = resolve })
  const releaseCallback = new Promise(resolve => { release = resolve })
  const oldService = createAutomationService({ store, settings: {}, producer: {}, assist: async () => { entered(); await releaseCallback; return { answer: { text: 'old completed', engine: 'synthetic-model' }, actions: [] } } })
  const old = await startAutomationServer({ home, service: oldService })
  t.after(async () => { release(); await old.dispose() })
  const oldCall = client.call('media_desk_assist', { message: 'hold this turn' }, 'draining-old')
  await enteredCallback
  let disposed = false
  const disposal = old.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(disposed, false, 'disposal must remain pending while authenticated mutation is active')
  const make = () => createAutomationService({ store, settings: {}, producer: {} })
  await assert.rejects(startAutomationServer({ home, service: make() }), /live|owner|already/i)
  release(); await disposal
  assert.equal((await oldCall).error.code, 'OUTCOME_UNKNOWN')
  const replacement = await startAutomationServer({ home, service: make() }); t.after(() => replacement.dispose())
  const added = await client.call('media_desk_apply_ops', { ops: [{ op: 'add_item', title: 'replacement item' }] }, 'draining-new')
  assert.equal(added.ok, true)
  const recovered = await make().call({ tool: 'media_desk_request_status', input: { requestId: 'draining-new' } })
  assert.equal(recovered.result.status, 'done', 'old journal must never overwrite replacement results')
})

test('assist client timeout exceeds Host editing window and explicit timeouts override it', async () => {
  const { AutomationClient } = await import('../src/automation/client.js')
  const normal = new AutomationClient()
  assert.equal(normal.timeoutFor('media_desk_assist'), 300000)
  assert.equal(normal.timeoutFor('media_desk_list_items'), 30000)
  const custom = new AutomationClient({ timeout: 25 })
  assert.equal(custom.timeoutFor('media_desk_assist'), 25)
  assert.equal(custom.timeoutFor('media_desk_list_items'), 25)
})


test('CLI and official MCP transport preserve scoped 2.7 format and image options with 17 tools', async t => {
  const { home, store, starts } = await fixture(t)
  const { applyOps } = await import('../src/ops.js')
  let accountId, id
  await store.mutate('setup account', s => {
    accountId = applyOps(s, [{ op: 'add_account', platform: '快手', handle: 'Transport account' }]).receipts[0].target
    id = applyOps(s, [{ op: 'add_item', accountId, title: 'Transport idea' }]).receipts[0].target
  })
  const preference = await cli(['--home', home, 'call', 'media_desk_apply_ops', '--request-id', 'cli-format', '--input', JSON.stringify({ accountId, ops: [{ op: 'set_format', format: 'article' }] })])
  assert.equal(preference.code, 0, preference.stdout)
  const production = await cli(['--home', home, 'produce', id, '--request-id', 'cli-text-only', '--input', JSON.stringify({ accountId, withImages: false })])
  assert.equal(production.code, 0, production.stdout)
  assert.deepEqual(starts, [[id, { accountId, withImages: false }]])
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'port270-test', version: '1' })
  t.after(() => client.close())
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'bin/media-desk.js'), '--home', home, 'mcp'], stderr: 'pipe' }))
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 17)
  assert.equal(tools.tools.find(t => t.name === 'media_desk_produce').inputSchema.properties.withImages.type, 'boolean')
  const imported = await client.callTool({ name: 'media_desk_write_draft', arguments: { requestId: 'mcp-article', id, accountId, format: 'article', article: 'Transport body stays intact' } })
  assert.equal(imported.structuredContent.ok, true)
  const item = (await store.read()).items.find(row => row.id === id)
  assert.equal(item.production.format, 'article')
  assert.equal(item.production.article, 'Transport body stays intact')
  const drawn = await client.callTool({ name: 'media_desk_produce', arguments: { requestId: 'mcp-images', id, accountId, withImages: true } })
  assert.equal(drawn.structuredContent.ok, true)
  assert.deepEqual(starts[1], [id, { accountId, withImages: true }])
  const bad = await client.callTool({ name: 'media_desk_apply_ops', arguments: { requestId: 'mcp-bad-format', accountId, ops: [{ op: 'set_format', format: 'ebook' }] } })
  assert.equal(bad.isError, true)
  assert.equal((await store.read()).draftFormat, undefined)
  assert.equal((await store.read()).accounts.find(a => a.id === accountId).draftFormat, 'article')
})
