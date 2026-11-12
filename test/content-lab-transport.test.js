import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import host from '../src/host.js'
import { Store } from '../src/store.js'
import { saveVersion } from '../src/versions.js'
import { AutomationClient } from '../src/automation/client.js'
import { createAutomationService } from '../src/automation/service.js'
import { startAutomationServer } from '../src/automation/server.js'
import { catalog } from '../src/automation/catalog.js'
const exec = promisify(execFile)
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'lab-wire-')); t.after(() => rm(home, { recursive: true, force: true }))
  const store = new Store(join(home, 'media-desk')); let version
  await store.mutate('fixture', s => { s.accounts = [{ id: 'a', platform: '快手', handle: 'A' }]; s.metrics = []; s.items = [{ id: 'work', accountId: 'a', platform: '快手', title: 'Title', status: 'draft', drafts: { script: { text: 'PRIVATE_MANUSCRIPT_TEXT', by: 'user' } } }]; version = saveVersion(s.items[0]) })
  const score = request => JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 3, reason: 'Concrete', evidence: '', confidence: 1 })) })
  const input = { accountId: 'a', action: 'evaluate', itemId: 'work', versionId: version.id, rubricId: 'general-script-v1', format: 'script' }
  return { home, store, score, input }
}

test('authenticated Host lab endpoints and private socket share one journal; generic state/ops/Undo omit internal lab records', async t => {
  const f = await fixture(t), old = process.env.DSH_HOME; process.env.DSH_HOME = f.home; t.after(() => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old })
  let handler; let authorized = true; let calls = 0; const effects = []
  const llm = { async prepareCall() { return { config: {}, async *stream(request) { calls++; yield { type: 'text-delta', text: f.score({ user: request.messages[0].content[0].text }) } } } } }
  host.apply({ effect: fn => effects.push(fn), webServer: { register: options => { handler = options.handler; return () => {} } }, get: name => name === 'connection' ? { requestRejection: () => authorized ? undefined : 401 } : name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake-selected' }) } : undefined })
  const disposeBridge = effects[0](); const disposeRoutes = effects[1](); t.after(async () => { disposeRoutes?.(); await disposeBridge?.() })
  async function request(path, body, method = 'POST', headers = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); Object.assign(req, { method, url: `/media-desk/${path}`, headers })
    let result; await handler(req, { setHeader() {}, end(value) { result = { status: this.statusCode, body: JSON.parse(value) } } }); return result
  }
  authorized = false; assert.equal((await request('content-lab/read', {})).status, 401); authorized = true
  assert.equal((await request('content-lab/action', { ...f.input, requestId: 'cross-site' }, 'POST', { 'sec-fetch-site': 'cross-site' })).status, 403)
  const saved = await request('content-lab/action', { ...f.input, requestId: 'same-shared-request' }); assert.equal(saved.body.ok, true, JSON.stringify(saved)); assert.equal(calls, 1)
  const client = new AutomationClient({ home: f.home }); let cached
  for (let i = 0; i < 100; i++) { cached = await client.call('media_desk_content_lab_action', f.input, 'same-shared-request'); if (cached.error?.code !== 'UNAVAILABLE') break; await new Promise(r => setTimeout(r, 5)) }
  assert.equal(cached.ok, true, JSON.stringify(cached)); assert.equal(cached.cached, true); assert.equal(calls, 1)
  const journal = JSON.parse(await readFile(join(f.store.root, 'automation', 'journal.json'), 'utf8')); assert.equal(Object.keys(journal).length, 1)
  const list = await request('content-lab/read', { accountId: 'a' }); assert.equal(list.body.result.total, 1); assert.equal(list.body.state, undefined)
  const detail = await request('content-lab/read', { accountId: 'a', recordId: saved.body.result.record.id, includeManuscript: true, maxChars: 100000 }); assert.equal(detail.body.result.record.manuscript.text, 'PRIVATE_MANUSCRIPT_TEXT')
  for (const result of [await request('state', undefined, 'GET'), await request('ops', { ops: [{ op: 'update_item', id: 'work', pinned: true }] }), await request('undo', {})]) {
    assert.equal(result.body.state.contentLab, undefined); assert.doesNotMatch(JSON.stringify(result.body.state), /fresh-context-input-only|targetEpoch/)
  }
  assert.equal((await new Store(f.store.root).read()).contentLab.records.length, 1)
})

test('CLI lab commands and official SDK expose exactly twenty tools and share schema/read-only behavior', async t => {
  const f = await fixture(t); const producer = { isRunning: () => false, anyAssetActive: () => false }
  const service = createAutomationService({ store: f.store, settings: {}, producer, callText: async request => ({ text: f.score(request), model: 'fake' }) })
  const server = await startAutomationServer({ home: f.home, service }); t.after(() => server.dispose())
  const cli = async args => { try { return JSON.parse((await exec(process.execPath, ['bin/media-desk.js', '--home', f.home, ...args], { cwd: process.cwd() })).stdout) } catch (error) { return JSON.parse(error.stdout) } }
  assert.equal(catalog.length, 20)
  const list = await cli(['lab', 'list', '--input', '{"accountId":"a"}']); assert.equal(list.ok, true, JSON.stringify(list)); assert.equal(list.result.total, 0)
  const rubrics = await cli(['lab', 'rubrics']); assert.equal(rubrics.result.rubrics.length, 3)
  const evaluated = await cli(['lab', 'evaluate', 'work', '--request-id', 'cli-lab-review', '--input', JSON.stringify({ accountId: 'a', versionId: f.input.versionId, rubricId: 'general-script-v1', format: 'script' })]); assert.equal(evaluated.ok, true, JSON.stringify(evaluated))
  const detail = await cli(['lab', 'get', evaluated.result.record.id, '--input', '{"accountId":"a","maxChars":10}']); assert.equal(detail.result.truncated, true); assert.equal(detail.result.record.preview.length, 10)
  const readonly = await cli(['--read-only', 'lab', 'evaluate', 'work', '--input', JSON.stringify({ accountId: 'a', versionId: f.input.versionId, rubricId: 'general-script-v1', format: 'script' })]); assert.equal(readonly.error.code, 'READ_ONLY')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js'); const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const sdk = new Client({ name: 'lab-test', version: '1' }); t.after(() => sdk.close())
  await sdk.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/media-desk.js', '--home', f.home, 'mcp'], stderr: 'pipe' }))
  const tools = (await sdk.listTools()).tools; assert.equal(tools.length, 20); assert.ok(tools.some(t => t.name === 'media_desk_get_content_lab')); assert.ok(tools.find(t => t.name === 'media_desk_content_lab_action').inputSchema.oneOf.length === 5)
  const replay = (await sdk.callTool({ name: 'media_desk_content_lab_action', arguments: { ...f.input, requestId: 'cli-lab-review' } })).structuredContent; assert.equal(replay.cached, true)
  const ro = new Client({ name: 'lab-readonly-test', version: '1' }); t.after(() => ro.close()); await ro.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/media-desk.js', '--home', f.home, '--read-only', 'mcp'], stderr: 'pipe' }))
  const roTools = (await ro.listTools()).tools; assert.ok(roTools.some(t => t.name === 'media_desk_get_content_lab')); assert.ok(!roTools.some(t => t.name === 'media_desk_content_lab_action'))
  assert.equal((await ro.callTool({ name: 'media_desk_content_lab_action', arguments: { ...f.input, requestId: 'blocked' } })).structuredContent.error.code, 'READ_ONLY')
  assert.equal(new AutomationClient().timeoutFor('media_desk_content_lab_action'), 300000)
})

for (const errorCode of [undefined, 'MODEL_TIMEOUT', 'INVALID_MODEL_RESULT']) test(`Host lab provider failure ${errorCode ?? 'untagged'} sanitizes action, journal and public status while preserving ordinary debugging`, async t => {
  const f = await fixture(t), old = process.env.DSH_HOME; process.env.DSH_HOME = f.home; t.after(() => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old })
  const { callModel, modelStatus, setAssistantModel } = await import('../src/ai.js'); const previousStatus = { ...modelStatus }; t.after(() => Object.assign(modelStatus, previousStatus)); setAssistantModel(null)
  const marker = 'PRIVATE_LAB_PROVIDER_MARKER /private/provider/settings.json'; let calls = 0, handler; const effects = []
  const ctx = { effect: fn => effects.push(fn), webServer: { register: options => { handler = options.handler; return () => {} } }, get: name => name === 'connection' ? { requestRejection: () => undefined } : name === 'llm' ? { prepareCall: async () => { calls++; throw Object.assign(new Error(marker), errorCode ? { code: errorCode } : {}) } } : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : undefined }
  await assert.rejects(callModel(ctx, { system: 'normal debug', user: 'test' }), /PRIVATE_LAB_PROVIDER_MARKER/); assert.equal(modelStatus.error, marker)
  host.apply(ctx); effects[1]();
  async function request(path, body, method = 'POST') {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); Object.assign(req, { method, url: `/media-desk/${path}`, headers: {} }); let result
    await handler(req, { setHeader() {}, end(value) { result = JSON.parse(value) } }); return result
  }
  const lab = await request('content-lab/action', { ...f.input, requestId: 'private-error-review' }); assert.equal(lab.ok, false); assert.doesNotMatch(JSON.stringify(lab), /PRIVATE_LAB_PROVIDER_MARKER|private\/provider/)
  assert.doesNotMatch(await readFile(join(f.store.root, 'automation', 'journal.json'), 'utf8'), /PRIVATE_LAB_PROVIDER_MARKER|private\/provider/)
  const state = await request('state', undefined, 'GET'); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_LAB_PROVIDER_MARKER|private\/provider/); assert.equal(calls, 2)
})
