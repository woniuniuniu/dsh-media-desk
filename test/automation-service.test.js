import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'md-auto-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('empty', s => { s.items = []; s.chat = [{ text: 'private' }] })
  const { createAutomationService } = await import('../src/automation/service.js')
  let calls = 0
  const producer = { start: async () => { calls++; return true }, status: () => ({ running: false }), isRunning: () => false, anyAssetActive: () => false, cancel: async () => {}, regenerate: async () => {} }
  const service = createAutomationService({ store, producer, settings: { read: async () => ({ exportDir: join(root, 'exports') }) }, models: async () => ({ providers: [] }) })
  return { root, store, service, calls: () => calls }
}
const call = (service, tool, input = {}, requestId) => service.call({ tool: `media_desk_${tool}`, input, requestId })

test('cumulative metrics API validates counters and collection times and bounds coverage with truncation metadata', async t => {
  const { service, store } = await fixture(t)
  await store.mutate('coverage', s => { s.items = Array.from({ length: 35 }, (_, i) => ({ id: `work${i}`, title: `Work ${i}`, platform: '抖音', status: 'published' })); s.metrics = []; s.accounts = [] })
  const saved = await call(service, 'apply_ops', { ops: [{ op: 'add_metric', itemId: 'work0', platform: '抖音', views: 0, likes: null, source: 'manual', collectedAt: '2026-01-01T08:00:00+08:00' }] }, 'metric')
  assert.equal(saved.ok, true)
  assert.equal((await store.read()).metrics[0].likes, null)
  for (const [i, op] of [{ views: -1 }, { views: 1.5 }, { views: 9007199254740992 }, { collectedAt: '2026-01-01T08:00:00' }].entries()) {
    const result = await call(service, 'apply_ops', { ops: [{ op: 'add_metric', platform: '抖音', ...op }] }, `invalid-metric-${i}`)
    assert.equal(result.ok, false)
  }
  const { result } = await call(service, 'get_insights')
  assert.equal(result.coverage.rawRecords, 1)
  assert.equal(result.coverage.withData, 1)
  assert.equal(result.coverage.missingWorksCount, 35)
  assert.equal(result.coverage.missingWorks.length, 30)
  assert.equal(result.collections['coverage.missingWorks'].total, 35)
  assert.equal(result.collections['coverage.missingWorks'].truncated, true)
  assert.equal(result.collections['coverage.missingWorks'].limit, 30)
})

test('compact list pagination and explicit bounded item fields never return chat/settings', async t => {
  const { service, store } = await fixture(t)
  const add = await call(service, 'apply_ops', { ops: Array.from({ length: 4 }, (_, i) => ({ op: 'add_item', title: `Title ${i}`, body: 'x'.repeat(1000) })) }, 'add')
  assert.equal(add.ok, true)
  const list = await call(service, 'list_items', { limit: 2, offset: 1 })
  assert.equal(list.result.items.length, 2)
  assert.equal(list.result.total, 4)
  assert.equal(list.result.nextOffset, 3)
  assert.equal(list.result.items[0].body, undefined)
  const item = await call(service, 'get_item', { id: (await store.read()).items[0].id, fields: ['body'], maxChars: 100 })
  assert.equal(item.result.body.length, 100)
  assert.equal(item.result.truncated.body, true)
  assert.equal(item.result.chat, undefined)
})

test('write_draft uses Store without LLM, preserves assets and published status', async t => {
  const { service, store, calls } = await fixture(t)
  const added = await call(service, 'apply_ops', { ops: [{ op: 'add_item', title: 'idea' }] }, 'add')
  const id = added.result.receipts[0].target
  await store.mutate('asset', s => { s.items[0].production = { cover: { src: 'media-desk/files/a.jpg' }, images: [{ src: 'media-desk/files/b.png' }], shots: [{ src: 'media-desk/files/c.png', visual: 'old' }] } })
  const draft = await call(service, 'write_draft', { id, title: '中文 English', article: '## 外部稿\n无需模型', coverText: '知识卡片', shots: [{ visual: 'new', voice: 'voice', seconds: 5 }] }, 'draft')
  assert.equal(draft.ok, true)
  const row = (await store.read()).items[0]
  assert.equal(row.status, 'draft')
  assert.equal(row.production.status, 'done')
  assert.equal(row.production.cover.src, 'media-desk/files/a.jpg')
  assert.equal(row.production.shots[0].src, 'media-desk/files/c.png')
  assert.equal(calls(), 0)
  await store.mutate('published', s => { s.items[0].status = 'published' })
  await call(service, 'write_draft', { id, article: 'revised' }, 'draft2')
  assert.equal((await store.read()).items[0].status, 'published')
})

test('timezone validation, unsafe/unknown fields reject before mutation; partial receipts survive', async t => {
  const { service, store } = await fixture(t)
  for (const op of [{ op: 'add_item', title: 'bad', scheduledAt: '2026-11-12T10:00:00' }, { op: 'update_production', id: 'x', savedPath: '/tmp/evil' }, { op: 'constructor' }]) {
    assert.equal((await call(service, 'apply_ops', { ops: [op] }, 'bad' + JSON.stringify(op))).ok, false)
  }
  assert.equal((await store.read()).items.length, 0)
  const result = await call(service, 'apply_ops', { ops: [{ op: 'add_item', title: 'ok', scheduledAt: '2026-11-12T10:00:00+08:00' }, { op: 'delete_item', id: 'missing' }] }, 'partial')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PARTIAL_FAILURE')
  assert.equal(result.error.details.receipts.length, 1)
  assert.equal((await store.read()).items.length, 1)
})

test('durable IDs deduplicate concurrently, conflict, cache partial failures and protect pending restart', async t => {
  const { service, store, root } = await fixture(t)
  const args = { ops: [{ op: 'add_item', title: 'once' }] }
  const results = await Promise.all(Array.from({ length: 8 }, () => call(service, 'apply_ops', args, 'once')))
  assert.ok(results.every(r => r.ok))
  assert.equal((await store.read()).items.length, 1)
  assert.equal((await call(service, 'apply_ops', { ops: [{ op: 'add_item', title: 'twice' }] }, 'once')).error.code, 'REQUEST_ID_CONFLICT')
  const { MutationJournal } = await import('../src/automation/journal.js')
  const journal = new MutationJournal(join(root, 'pending'))
  let unblock
  const pending = journal.execute('pending-id', 'tool', { text: 'not stored' }, () => new Promise(resolve => { unblock = resolve }))
  while (!unblock) await new Promise(r => setImmediate(r))
  const recovered = new MutationJournal(join(root, 'pending'))
  let replayed = false
  const unknown = await recovered.execute('pending-id', 'tool', { text: 'not stored' }, () => { replayed = true })
  assert.equal(unknown.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(replayed, false)
  assert.equal((await recovered.status('pending-id')).status, 'unknown')
  assert.equal((await readFile(join(root, 'pending', 'journal.json'), 'utf8')).includes('not stored'), false)
  unblock({ ok: true, result: {} }); await pending
})

test('catalog schemas and read-only gate are shared and strict', async t => {
  const { service } = await fixture(t)
  const { catalog } = await import('../src/automation/catalog.js')
  assert.ok(catalog.length >= 14)
  assert.ok(catalog.every(t => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false))
  assert.equal((await service.call({ tool: 'no_such_tool', input: {} })).error.code, 'UNKNOWN_TOOL')
  assert.equal((await call(service, 'list_items', { limit: 101 })).error.code, 'INVALID_ARGUMENT')
  assert.equal((await call(service, 'apply_ops', { ops: [] })).error.code, 'REQUEST_ID_REQUIRED')
})

test('invalid calendar dates and conflicting envelope IDs reject before intent is recorded', async t => {
  const { service } = await fixture(t)
  const invalidDate = await call(service, 'apply_ops', { ops: [{ op: 'add_item', title: 'bad date', scheduledAt: '2026-02-31T10:00:00Z' }] }, 'bad-date')
  assert.equal(invalidDate.ok, false)
  assert.equal(invalidDate.error.code, 'INVALID_ARGUMENT')
  const conflict = await service.call({ tool: 'media_desk_apply_ops', input: { requestId: 'input-id', ops: [{ op: 'add_item', title: 'bad' }] }, requestId: 'envelope-id' })
  assert.equal(conflict.error.code, 'INVALID_ARGUMENT')
})

test('partial mutation results are cached and request status retains receipts without re-execution', async t => {
  const { service, store } = await fixture(t)
  const input = { ops: [{ op: 'add_item', title: 'once' }, { op: 'delete_item', id: 'missing' }] }
  const first = await call(service, 'apply_ops', input, 'partial-once')
  const second = await call(service, 'apply_ops', input, 'partial-once')
  assert.equal(second.cached, true); assert.deepEqual(first.error.details, second.error.details)
  assert.equal((await store.read()).items.length, 1)
  const status = await call(service, 'request_status', { requestId: 'partial-once' })
  assert.equal(status.result.status, 'done'); assert.equal(status.result.response.error.code, 'PARTIAL_FAILURE')
})

test('Host profile resolution honors explicit profile and profile directory with desktop fallback', async () => {
  const { hostProfile } = await import('../src/automation/paths.js')
  assert.equal(hostProfile({}), 'desktop')
  assert.equal(hostProfile({ DSH_PROFILE: 'grok' }), 'grok')
  assert.equal(hostProfile({ DSH_PROFILE_DIR: '/tmp/profiles/research' }), 'research')
  assert.equal(hostProfile({ DSH_PROFILE: 'main', DSH_PROFILE_DIR: '/tmp/profiles/other' }), 'main')
})

test('assist forwards authoring to the configured Host callback once and executes each produce action once', async t => {
  const { store, root } = await fixture(t)
  const { createAutomationService } = await import('../src/automation/service.js')
  let assisted = 0; const started = []
  const service = createAutomationService({ store, settings: {}, producer: { start: async id => { started.push(id); return true } }, assist: async body => {
    assisted++; assert.deepEqual(body, { message: '请写这篇', focusId: 'seed' })
    return { answer: { text: '已写好', engine: 'selected-model', receipts: [{ text: '保存稿件', target: 'seed' }], errors: [] }, actions: [{ type: 'produce', id: 'seed' }, { type: 'produce', id: 'seed' }, { type: 'open', id: 'seed' }, { type: 'nav', view: 'studio' }], state: { secret: true } }
  } })
  const first = await service.call({ tool: 'media_desk_assist', input: { message: '请写这篇', focusId: 'seed' }, requestId: 'assist-once' })
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.result.reply, '已写好'); assert.equal(first.result.modelUsed, true)
  assert.deepEqual(started, ['seed']); assert.equal(first.result.jobs.length, 1); assert.equal(first.result.uiHints.length, 2); assert.equal(first.result.state, undefined)
  const cached = await service.call({ tool: 'media_desk_assist', input: { focusId: 'seed', message: '请写这篇' }, requestId: 'assist-once' })
  assert.equal(cached.cached, true); assert.equal(assisted, 1); assert.deepEqual(started, ['seed'])
})

test('assist surfaces partial action failures without replaying completed model turns or revisions', async t => {
  const { store } = await fixture(t)
  const { createAutomationService } = await import('../src/automation/service.js')
  let turns = 0
  const service = createAutomationService({ store, settings: {}, producer: { start: async () => { throw new Error('private-provider-error') } }, assist: async () => { turns++; return { answer: { text: '改好了', receipts: [{ text: 'revision' }], errors: [] }, targets: ['cover'], actions: [{ type: 'produce', id: 'missing' }] } } })
  const result = await service.call({ tool: 'media_desk_assist', input: { message: '修改' }, requestId: 'assist-partial' })
  assert.equal(result.error.code, 'PARTIAL_FAILURE'); assert.equal(result.error.details.receipts.length, 1)
  assert.equal(JSON.stringify(result).includes('private-provider-error'), false)
  const cached = await service.call({ tool: 'media_desk_assist', input: { message: '修改' }, requestId: 'assist-partial' })
  assert.equal(cached.cached, true); assert.equal(turns, 1)
})

test('production status never exposes raw persisted provider errors or credentials', async t => {
  const { service, store } = await fixture(t)
  await store.mutate('failed', s => { s.items = [{ id: 'failed', status: 'draft', production: { status: 'failed', error: 'Bearer synthetic-test-secret', cover: { status: 'failed', error: 'upstream authentication failed: synthetic-test-secret' } } }] })
  const result = await call(service, 'production_status', { id: 'failed' })
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result).includes('synthetic-test-secret'), false)
})

test('failed final journal persistence leaves every observer unknown and never replays the dispatch', async t => {
  const { root } = await fixture(t)
  const { MutationJournal } = await import('../src/automation/journal.js')
  const journal = new MutationJournal(join(root, 'faulted'))
  const persist = journal.persist.bind(journal); let persists = 0; let dispatches = 0
  journal.persist = async () => { if (++persists === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return persist() }
  const execute = () => journal.execute('persist-failure', 'tool', { n: 1 }, async () => { dispatches++; return { ok: true, result: { saved: true } } })
  assert.equal((await execute()).error.code, 'OUTCOME_UNKNOWN')
  assert.equal((await execute()).error?.code, 'OUTCOME_UNKNOWN')
  assert.equal((await journal.status('persist-failure')).status, 'unknown')
  assert.equal(dispatches, 1)
})

test('named profile journals isolate request IDs and never overwrite another profile snapshot', async t => {
  const { store, root } = await fixture(t)
  const { createAutomationService } = await import('../src/automation/service.js')
  const make = profile => createAutomationService({ store, profile, settings: {}, producer: {}, assist: async body => ({ answer: { text: profile + ': ' + body.message, engine: 'synthetic-model' }, actions: [] }) })
  const a = make('alpha'); const b = make('beta')
  const first = await call(a, 'assist', { message: 'first profile' }, 'same-local-id')
  const second = await call(b, 'assist', { message: 'second profile' }, 'same-local-id')
  assert.equal(first.ok, true); assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal((await call(a, 'request_status', { requestId: 'same-local-id' })).result.response.result.reply, 'alpha: first profile')
  assert.equal((await call(b, 'request_status', { requestId: 'same-local-id' })).result.response.result.reply, 'beta: second profile')
  for (const profile of ['alpha', 'beta']) {
    const journal = JSON.parse(await readFile(join(root, 'automation', 'profiles', profile, 'journal.json'), 'utf8'))
    assert.equal(journal['same-local-id'].status, 'done')
  }
})

test('a concurrently persisted second intent cannot turn an uncertain first result into durable success', async t => {
  const { root } = await fixture(t)
  const { MutationJournal } = await import('../src/automation/journal.js')
  const path = join(root, 'concurrent-fault'); const journal = new MutationJournal(path)
  const persist = journal.persist.bind(journal); let calls = 0; let releaseFailure; let failureEntered
  const entered = new Promise(resolve => { failureEntered = resolve })
  journal.persist = async () => { if (++calls === 2) { failureEntered(); await new Promise(resolve => { releaseFailure = resolve }); throw new Error('disk fault') } return persist() }
  const first = journal.execute('first', 'tool', {}, async () => ({ ok: true, result: {} }))
  await entered
  let finishSecond
  const second = journal.execute('second', 'tool', {}, () => new Promise(resolve => { finishSecond = resolve }))
  releaseFailure()
  assert.equal((await first).error.code, 'OUTCOME_UNKNOWN')
  while (!finishSecond) await new Promise(resolve => setImmediate(resolve))
  const recovered = new MutationJournal(path)
  const recoveredFirst = await recovered.status('first')
  finishSecond({ ok: true, result: {} }); await second
  assert.equal(recoveredFirst.status, 'unknown')
})

test('read-only production status observes an orphan job without settling or writing Store bytes', async t => {
  const { store } = await fixture(t)
  const { Producer } = await import('../src/produce.js')
  const { createAutomationService } = await import('../src/automation/service.js')
  await store.mutate('orphan', s => { s.items = [{ id: 'orphan', status: 'draft', production: { status: 'running', stage: 'brief', article: 'unfinished' } }] })
  const before = await readFile(store.file, 'utf8')
  const producer = new Producer({ store, settings: { read: async () => ({}) } })
  const service = createAutomationService({ store, producer, settings: {}, readOnly: true })
  const response = await call(service, 'production_status', { id: 'orphan' })
  assert.equal(response.ok, true)
  assert.equal(response.result.production.status, 'running')
  assert.equal(response.result.live.running, false)
  assert.equal(await readFile(store.file, 'utf8'), before)
})
