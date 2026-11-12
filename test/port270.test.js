import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, revertChange } from '../src/store.js'
import { applyOps } from '../src/ops.js'
import { migrateAccounts, scopeState } from '../src/accounts.js'
import { Producer } from '../src/produce.js'
import { articlePrompts } from '../src/ai.js'
import { createAutomationService } from '../src/automation/service.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-port270-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('setup', s => {
    s.accounts = [{ id: 'a', platform: '快手', handle: 'A', draftFormat: 'article' }, { id: 'b', platform: '抖音', handle: 'B' }]
    s.items = [{ id: 'a-item', title: 'A idea', accountId: 'a', status: 'idea' }, { id: 'b-item', title: 'B idea', accountId: 'b', status: 'idea' }, { id: 'legacy', title: 'Legacy', accountId: null, status: 'idea' }]
    s.metrics = []; s.chat = []; s.skills = []; s.styles = []; s.draftFormat = 'script'
  })
  return { root, store }
}
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error('Synthetic job did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const settingsValue = { generateImages: false, imageCount: 1, shotCount: 1, image: {} }
const fakeText = async ({ system }) => system.includes('策划案')
  ? { text: JSON.stringify({ title: 'Synthetic', cover: 'cover', images: [{ prompt: 'image' }], shots: [{ prompt: 'shot', visual: 'scene' }] }), model: 'fake' }
  : { text: '# Synthetic\nExisting article text', model: 'fake' }
const call = (service, suffix, input, requestId) => service.call({ tool: `media_desk_${suffix}`, input, requestId })

test('account draft format is additive, scoped and independently resettable to inherited global format', async t => {
  const { store } = await fixture(t)
  const s = migrateAccounts(await store.read())
  assert.equal(s.accounts.find(a => a.id === 'b').draftFormat, null)
  assert.equal(scopeState(s, 'a').draftFormat, 'article')
  assert.equal(scopeState(s, 'b').draftFormat, 'script')
  assert.equal(scopeState(s, null).draftFormat, 'script')
  assert.deepEqual(applyOps(s, [{ op: 'set_format', format: 'article' }], { accountId: 'b' }).errors, [])
  assert.equal(s.accounts.find(a => a.id === 'b').draftFormat, 'article')
  assert.equal(s.draftFormat, 'script')
  assert.ok(applyOps(s, [{ op: 'set_format', accountId: 'a', format: 'script' }], { accountId: 'b' }).errors.length)
  assert.equal(s.accounts.find(a => a.id === 'a').draftFormat, 'article')
  assert.deepEqual(applyOps(s, [{ op: 'update_account', id: 'b', draftFormat: null }]).errors, [])
  assert.equal(scopeState(s, 'b').draftFormat, 'script')
  const text = 'Preserve production body verbatim'
  s.items[0].production = { article: text, format: 'script' }
  migrateAccounts(s)
  assert.equal(s.items[0].production.article, text)
  assert.equal(s.items[0].production.format, 'script')
})

test('scoped production snapshots format before settings await, respects false default and permits isolated late drawing', async t => {
  const { store } = await fixture(t)
  let releaseSettings, enteredSettings
  const entered = new Promise(resolve => { enteredSettings = resolve })
  let reads = 0, generated = 0
  const systems = []
  const producer = new Producer({ store, settings: { read: async () => {
    if (++reads === 1) { enteredSettings(); await new Promise(resolve => { releaseSettings = resolve }) }
    return settingsValue
  } }, ready: () => true, callText: async request => { systems.push(request.system); return fakeText(request) }, generate: async () => { generated++; return { buffer: Buffer.from('synthetic image'), ext: '.png' } } })
  const pending = producer.start('a-item', { accountId: 'a' })
  await entered
  await store.mutate('preference change', s => applyOps(s, [{ op: 'update_account', id: 'a', draftFormat: 'script' }]))
  releaseSettings()
  assert.equal(await pending, true)
  await until(() => !producer.isRunning('a-item'))
  let item = (await store.read()).items.find(i => i.id === 'a-item')
  assert.equal(item.production.format, 'article')
  assert.equal(item.production.withImages, false)
  assert.equal(item.production.cover.status, 'skipped')
  assert.equal(item.production.article, 'Existing article text')
  assert.ok(systems.some(system => system.includes('正文按自然段写')))
  assert.equal(generated, 0)
  await assert.rejects(producer.regenerate('a-item', 'cover', 'b'), /another account/)
  await producer.regenerate('a-item', 'cover', 'a')
  await until(() => !producer.anyAssetActive('a-item'))
  item = (await store.read()).items.find(i => i.id === 'a-item')
  assert.equal(item.production.cover.status, 'done')
  assert.equal(item.production.article, 'Existing article text')
  assert.equal(generated, 1)
  await producer.start('b-item', { accountId: 'b', withImages: true })
  await until(() => !producer.isRunning('b-item'))
  assert.equal((await store.read()).items.find(i => i.id === 'b-item').production.withImages, true)
  assert.equal(generated, 4)
})

test('concurrent scoped starts reserve one job while settings are pending', async t => {
  const { store } = await fixture(t)
  let release, entered
  const pause = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let reads = 0, calls = 0
  const producer = new Producer({ store, settings: { read: async () => { reads++; entered(); await gate; return settingsValue } }, ready: () => false, callText: async request => { calls++; return fakeText(request) } })
  const first = producer.start('a-item', { accountId: 'a', withImages: false })
  await pause
  const second = producer.start('a-item', { accountId: 'a', withImages: true })
  await new Promise(resolve => setImmediate(resolve))
  release()
  const results = await Promise.all([first, second])
  await until(() => !producer.isRunning('a-item'))
  assert.deepEqual(results, [true, false])
  assert.equal(calls, 2)
})

test('explicit and legacy account mismatch fail before settings or model calls', async t => {
  const { store } = await fixture(t)
  let reads = 0, calls = 0
  const producer = new Producer({ store, settings: { read: async () => { reads++; return settingsValue } }, ready: () => false, callText: async request => { calls++; return fakeText(request) } })
  await assert.rejects(producer.start('a-item', { accountId: 'b' }), /another account/)
  try { await assert.rejects(producer.start('a-item', 'b'), /another account/) }
  finally { await until(() => !producer.isRunning('a-item')) }
  assert.equal(reads, 0)
  assert.equal(calls, 0)
})

test('CLI/MCP schemas support strict account formats, produce image option and bounded 2.7 style fields', async t => {
  const { store } = await fixture(t)
  const starts = []
  const producer = { start: async (...args) => { starts.push(args); return true }, isRunning: () => false, anyAssetActive: () => false, status: () => ({ running: false }) }
  const service = createAutomationService({ store, settings: {}, producer })
  assert.equal((await call(service, 'apply_ops', { accountId: 'b', ops: [{ op: 'set_format', format: 'article' }] }, 'format-b')).ok, true)
  assert.equal((await store.read()).draftFormat, 'script')
  assert.equal((await call(service, 'apply_ops', { accountId: 'b', ops: [{ op: 'set_format', format: 'invalid' }] }, 'invalid-format')).error.code, 'INVALID_ARGUMENT')
  assert.equal((await call(service, 'produce', { id: 'b-item', accountId: 'b', withImages: false }, 'text-only')).ok, true)
  assert.deepEqual(starts, [['b-item', { accountId: 'b', withImages: false }]])
  assert.equal((await call(service, 'produce', { id: 'b-item', accountId: 'b', withImages: 'false' }, 'bad-image')).error.code, 'INVALID_ARGUMENT')
  assert.equal((await call(service, 'write_draft', { id: 'b-item', accountId: 'b', format: 'article', article: 'External text' }, 'external')).ok, true)
  const item = (await store.read()).items.find(i => i.id === 'b-item')
  assert.equal(item.production.format, 'article')
  const status = await call(service, 'production_status', { id: 'b-item', accountId: 'b' })
  assert.equal(status.result.production.format, 'article')
  const unsupported = await call(service, 'apply_ops', { ops: [{ op: 'update_production', id: 'b-item', format: 'script' }] }, 'unsupported-production-format')
  assert.equal(unsupported.error?.code, 'INVALID_ARGUMENT')
  const added = await call(service, 'apply_ops', { ops: [{ op: 'add_style', name: '2.7 style', logic: 'reasoning', story: 'stories', flow: 'transitions' }] }, 'style-fields')
  assert.equal(added.ok, true)
  await store.mutate('reference', s => { s.styles[0].reference = 'PRIVATE RAW REFERENCE'.repeat(1000) })
  const styles = await call(service, 'list_styles', { accountId: 'b' })
  assert.equal(styles.result.styles[0].logic, 'reasoning')
  assert.equal(styles.result.styles[0].story, 'stories')
  assert.equal(styles.result.styles[0].flow, 'transitions')
  assert.doesNotMatch(JSON.stringify(styles), /PRIVATE RAW REFERENCE/)
})

test('article prompt uses scoped account format and preserves production format over changed preference', async t => {
  const { store } = await fixture(t)
  const state = await store.read()
  assert.match(articlePrompts(state, state.items[0], '').system, /正文按自然段写/)
  assert.match(articlePrompts(state, { ...state.items[0], production: { format: 'script' } }, '').system, /一句话占一行/)
})

test('Host style extraction validates scope before model work and retains bounded reference plus account activation', async t => {
  const { Readable } = await import('node:stream')
  const { default: host } = await import('../src/host.js')
  const home = await mkdtemp(join(tmpdir(), 'md-port270-host-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
  const store = new Store(join(home, 'media-desk'))
  await store.mutate('setup', s => { s.accounts = [{ id: 'a', platform: '快手', handle: 'A', defaultStyleId: null }]; s.activeStyleId = null })
  let route, modelCalls = 0
  const effects = []
  const ctx = { effect: fn => effects.push(fn), webServer: { register: options => { route = options.handler; return () => {} } }, get: name => {
    if (name === 'connection') return { requestRejection: () => undefined }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }
    if (name === 'llm') return { prepareCall: async () => ({ config: {}, stream: async function* () { modelCalls++; yield { type: 'text-delta', text: JSON.stringify({ name: 'Extracted', logic: 'reasoning', story: 'story', flow: 'flow' }) } } }) }
  } }
  host.apply(ctx)
  const dispose = effects[1]()
  t.after(() => dispose?.())
  async function extract(accountId) {
    const req = Readable.from([Buffer.from(JSON.stringify({ accountId, text: 'Synthetic private reference text. '.repeat(300) }))])
    Object.assign(req, { method: 'POST', url: '/media-desk/style/extract', headers: {} })
    let result
    const res = { setHeader() {}, end(body) { result = { status: this.statusCode, body: JSON.parse(body) } } }
    await route(req, res)
    return result
  }
  assert.equal((await extract('missing')).status, 400)
  assert.equal(modelCalls, 0)
  const result = await extract('a')
  assert.equal(result.status, 200)
  const state = await store.read()
  const style = state.styles.find(s => s.id === result.body.id)
  assert.equal(style.reference.length, 6000)
  assert.equal(style.accountId, 'a')
  assert.equal(style.logic, 'reasoning')
  assert.equal(style.story, 'story')
  assert.equal(style.flow, 'flow')
  assert.equal(state.accounts[0].defaultStyleId, style.id)
  assert.equal(state.activeStyleId, null)
})

test('Host cancellation validates explicit account before reaching Producer while matching and All scopes work', async t => {
  const { Readable } = await import('node:stream')
  const { default: host } = await import('../src/host.js')
  const home = await mkdtemp(join(tmpdir(), 'md-port270-cancel-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome })
  const store = new Store(join(home, 'media-desk'))
  await store.mutate('setup', s => {
    s.accounts = [{ id: 'a', platform: '快手', handle: 'A' }, { id: 'b', platform: '抖音', handle: 'B' }]
    s.items = [{ id: 'a-item', title: 'A idea', accountId: 'a' }, { id: 'legacy', title: 'Unassigned', accountId: null }]
  })
  const calls = []
  const originalCancel = Producer.prototype.cancel
  Producer.prototype.cancel = async function (id) { calls.push(id); return originalCancel.call(this, id) }
  t.after(() => { Producer.prototype.cancel = originalCancel })
  let route
  const effects = []
  host.apply({ effect: fn => effects.push(fn), webServer: { register: options => { route = options.handler; return () => {} } }, get: name => name === 'connection' ? { requestRejection: () => undefined } : undefined })
  const dispose = effects[1]()
  t.after(() => dispose?.())
  async function cancel(input) {
    const req = Readable.from([Buffer.from(JSON.stringify(input))])
    Object.assign(req, { method: 'POST', url: '/media-desk/produce/cancel', headers: {} })
    let result
    const res = { setHeader() {}, end(body) { result = { status: this.statusCode, body: JSON.parse(body) } } }
    await route(req, res)
    return result
  }
  const refused = await cancel({ id: 'a-item', accountId: 'b' })
  assert.deepEqual(calls, [], 'Foreign account cancellation must not reach the Producer')
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /another account/)
  assert.equal((await cancel({ id: 'a-item', accountId: null })).status, 400)
  assert.deepEqual(calls, [])
  assert.equal((await cancel({ id: 'a-item', accountId: 'a' })).status, 200)
  assert.equal((await cancel({ id: 'a-item' })).status, 200)
  assert.equal((await cancel({ id: 'legacy', accountId: null })).status, 200)
  assert.deepEqual(calls, ['a-item', 'a-item', 'legacy'])
})

test('Undo of an older import preserves the newer production both during generation and after completion', async t => {
  for (const phase of ['active', 'completed']) await t.test(phase, async t => {
    const { store, root } = await fixture(t)
    await store.mutate('existing script', s => {
      s.items.find(item => item.id === 'a-item').production = { status: 'done', format: 'script', article: 'Original script', images: [], shots: [] }
    }, { undoable: false })
    let releasePlan, enteredPlan
    const entered = new Promise(resolve => { enteredPlan = resolve })
    const gate = new Promise(resolve => { releasePlan = resolve })
    const articleSystems = []
    const producer = new Producer({ store, settings: { read: async () => settingsValue }, ready: () => false, callText: async request => {
      if (request.system.includes('策划案')) { enteredPlan(); await gate }
      else articleSystems.push(request.system)
      return fakeText(request)
    } })
    const service = createAutomationService({ store, settings: {}, producer })
    assert.equal((await call(service, 'write_draft', { id: 'a-item', accountId: 'a', format: 'article', article: 'Imported article' }, 'undo-import-format')).ok, true)
    await producer.start('a-item', { accountId: 'a', withImages: false })
    await entered
    try {
      await store.mutate('unrelated edit', s => applyOps(s, [{ op: 'update_item', id: 'b-item', body: 'Temporary unrelated edit' }]))
      assert.equal(await store.undoLast(), 'unrelated edit')
      assert.equal((await store.read()).items.find(item => item.id === 'b-item').body, undefined)
      await store.mutate('account preference', s => applyOps(s, [{ op: 'set_format', format: 'script' }], { accountId: 'a' }))
      assert.equal(await store.undoLast(), 'account preference')
      assert.equal((await store.read()).accounts.find(account => account.id === 'a').draftFormat, 'article')
      if (phase === 'completed') { releasePlan(); await until(() => !producer.isRunning('a-item')) }
      const beforeUndo = structuredClone((await store.read()).items.find(item => item.id === 'a-item').production)
      assert.equal(await store.undoLast(), '保存外部草稿')
      assert.deepEqual((await store.read()).items.find(item => item.id === 'a-item').production, beforeUndo)
    } finally {
      releasePlan()
      await until(() => !producer.isRunning('a-item'))
    }
    const production = (await store.read()).items.find(item => item.id === 'a-item').production
    assert.equal(production.status, 'done')
    assert.equal(production.format, 'article')
    assert.equal(production.article, 'Existing article text')
    assert.match(production.generationId, /^[0-9a-f-]{36}$/)
    assert.equal((await new Store(root).read()).items.find(item => item.id === 'a-item').production.generationId, production.generationId)
    assert.equal(articleSystems.length, 1)
    assert.match(articleSystems[0], /正文按自然段写/)
  })
})

test('generation-aware Undo keeps legacy later runs and still reverts edits within the same generation', () => {
  const oldTime = '2026-11-12T00:00:00.000Z'
  const newTime = '2026-11-12T00:01:00.000Z'
  const original = { startedAt: oldTime, format: 'script', article: 'Original script' }
  const imported = { ...original, format: 'article', article: 'Imported article' }
  const newer = { startedAt: newTime, format: 'article', article: 'Generated article', cover: { src: 'new.png' } }
  assert.deepEqual(revertChange({ production: original }, { production: imported }, { production: newer }).production, newer)
  assert.deepEqual(revertChange({ production: original }, { production: imported }, { production: imported }).production, original)
  const oldRun = { ...original, generationId: 'old-run' }
  const edited = { ...imported, generationId: 'old-run' }
  const newRun = { ...newer, startedAt: oldTime, generationId: 'new-run' }
  assert.deepEqual(revertChange({ production: oldRun }, { production: edited }, { production: newRun }).production, newRun)
  assert.deepEqual(revertChange({ production: oldRun }, { production: edited }, { production: edited }).production, oldRun)
})
