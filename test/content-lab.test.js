import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, revertChange } from '../src/store.js'
import { saveVersion, restoreVersion } from '../src/versions.js'
import { applyOps } from '../src/ops.js'
import { createAutomationService } from '../src/automation/service.js'

const initialTime = Date.parse('2026-11-12T00:00:00Z')
const producer = { isRunning: () => false, anyAssetActive: () => false }
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'md-lab-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root); let version; let now = initialTime
  await store.mutate('fixture', s => {
    s.accounts = [{ id: 'a', platform: '抖音', handle: 'A', audience: 'PRIVATE_ACTUALS_MARKER' }, { id: 'b', platform: '抖音', handle: 'B' }]
    s.items = [{ id: 'work', accountId: 'a', platform: '抖音', title: 'Saved title', status: 'draft', drafts: { script: { text: 'Saved manuscript.', by: 'user' } }, production: null }]
    s.metrics = []; s.chat = [{ text: 'PRIVATE_ACTUALS_MARKER' }]; s.skills = [{ rule: 'PRIVATE_ACTUALS_MARKER' }]
    version = saveVersion(s.items[0])
  })
  const calls = []
  const callText = options.callText ?? (async request => {
    calls.push(request); const body = JSON.parse(request.user)
    if (body.script) return { text: JSON.stringify({ dimensions: body.rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'Clear and specific.', evidence: 'Saved manuscript.', confidence: 0.8 })) }), model: 'fake-actual-model', provider: 'fake-provider' }
    if (body.evaluation) return { text: JSON.stringify({ probabilities: body.baseline.usable ? [0.1, 0.2, 0.4, 0.2, 0.1] : null, bet: 'Readers may understand the main point.', reason: 'Concrete opening.' }), model: 'fake-forecast' }
    return { text: JSON.stringify({ summary: 'The observation is cumulative.', learning: 'Check the opening next time.' }), model: 'fake-retro' }
  })
  const service = createAutomationService({ store, settings: {}, producer, callText, now: () => now })
  const action = (action, fields = {}, requestId = `${action}-${Math.random()}`) => service.call({ tool: 'media_desk_content_lab_action', input: { accountId: 'a', action, ...fields }, requestId })
  const read = fields => service.call({ tool: 'media_desk_get_content_lab', input: fields ?? {} })
  const evaluate = () => action('evaluate', { itemId: 'work', versionId: version.id, format: 'script', rubricId: 'general-script-v1' })
  const lock = async () => { const e = await evaluate(); assert.equal(e.ok, true, JSON.stringify(e)); const f = await action('forecast', { evaluationId: e.result.record.id }); assert.equal(f.ok, true, JSON.stringify(f)); const p = await action('lock', { forecastId: f.result.record.id }); assert.equal(p.ok, true, JSON.stringify(p)); return p.result.record }
  return { root, store, service, action, read, evaluate, lock, calls, version, time: value => { now = Date.parse(value) } }
}

test('lab presets and evaluate saved manuscript in a fresh whitelisted context, durable records survive restart and every Undo shortcut', async t => {
  const f = await fixture(t)
  const rubrics = await f.read({ view: 'rubrics' }); assert.equal(rubrics.ok, true); assert.equal(rubrics.result.rubrics.length, 3); assert.ok(rubrics.result.rubrics.every(r => r.calibrated === false))
  await f.store.mutate('edit working', s => { s.items[0].drafts.script.text = 'Different current text' })
  const e = await f.evaluate(); assert.equal(e.ok, true, JSON.stringify(e)); const record = e.result.record
  assert.equal(record.kind, 'evaluation'); assert.equal(record.composite, 80); assert.equal(record.manuscript, undefined); assert.equal(record.model.model, 'fake-actual-model')
  const payload = JSON.parse(f.calls[0].user); assert.deepEqual(Object.keys(payload).sort(), ['rubric', 'script']); assert.equal(payload.script.text, 'Saved manuscript.'); assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE_ACTUALS_MARKER/)
  assert.match(f.calls[0].sessionId, /content-lab-/)
  await f.store.undoLast(); const restarted = new Store(f.root); assert.equal((await restarted.read()).contentLab.records.length, 1)
  const detail = await f.read({ recordId: record.id, includeManuscript: true, maxChars: 8000 }); assert.equal(detail.result.record.manuscript.text, 'Saved manuscript.')
  const before = { x: 1 }, after = { x: 2 }, current = { x: 2, contentLab: { records: [record] } }
  assert.deepEqual(revertChange(before, after, current).contentLab, current.contentLab)
  await f.store.mutate('add', s => { s.items.push({ id: 'late', accountId: 'a', title: 'new' }) }); await f.store.undoLast()
  assert.equal((await f.store.read()).contentLab.records.length, 1)
  assert.doesNotMatch(await readFile(join(f.root, 'automation', 'journal.json'), 'utf8'), /Saved manuscript|PRIVATE_ACTUALS_MARKER/)
})

test('strict action schemas, explicit scope and read-only reject before any model; generic ops cannot change lab', async t => {
  const f = await fixture(t)
  for (const input of [ { action: 'evaluate', itemId: 'work', versionId: f.version.id, format: 'script', rubricId: 'general-script-v1' }, { accountId: 'a', action: 'lock', forecastId: 'x', evaluationId: 'x' }, { accountId: 'a', action: 'forecast', evaluationId: 'x', horizonDays: 0 }, { accountId: 'a', action: 'delete', recordId: 'x' } ]) {
    const r = await f.service.call({ tool: 'media_desk_content_lab_action', input, requestId: 'invalid-' + Math.random() }); assert.equal(r.error.code, 'INVALID_ARGUMENT')
  }
  const readOnly = createAutomationService({ store: f.store, producer, settings: {}, readOnly: true, callText: () => assert.fail('model') })
  assert.equal((await readOnly.call({ tool: 'media_desk_content_lab_action', input: {}, requestId: 'no' })).error.code, 'READ_ONLY')
  const generic = await f.service.call({ tool: 'media_desk_apply_ops', input: { ops: [{ op: 'update_item', id: 'work', contentLab: {} }] }, requestId: 'generic' }); assert.equal(generic.error.code, 'INVALID_ARGUMENT')
  assert.equal(f.calls.length, 0)
})

test('evaluate rejects format fallback, empty/oversize text, busy work and tampered version before model', async t => {
  const f = await fixture(t)
  const args = { itemId: 'work', versionId: f.version.id, rubricId: 'general-article-v1', format: 'article' }
  assert.equal((await f.action('evaluate', args)).error.code, 'INVALID_ARGUMENT')
  for (const text of ['', 'x'.repeat(100001)]) {
    let v; await f.store.mutate('text', s => { s.items[0].drafts.script.text = text; v = saveVersion(s.items[0]) })
    assert.equal((await f.action('evaluate', { ...args, format: 'script', rubricId: 'general-script-v1', versionId: v.id })).error.code, 'INVALID_ARGUMENT')
  }
  await f.store.mutate('tamper', s => { s.items[0].contentVersions[0].content.title = 'tampered' })
  assert.equal((await f.evaluate()).error.code, 'INVALID_ARGUMENT'); assert.equal(f.calls.length, 0)
})

test('strict malformed and oversized scoring replies are sanitized and unavailable providers never create records', async t => {
  for (const reply of ['{}', JSON.stringify({ dimensions: [{ id: 'unknown', score: 6 }] }), 'x'.repeat(100001)]) {
    const f = await fixture(t, { callText: async () => ({ text: reply, model: 'fake' }) }); const r = await f.evaluate(); assert.equal(r.ok, false); assert.equal((await f.store.read()).contentLab?.records.length ?? 0, 0)
  }
  const f = await fixture(t, { callText: async () => { throw new Error('PRIVATE_ACTUALS_MARKER provider path /secret') } }); const r = await f.evaluate(); assert.equal(r.ok, false); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_ACTUALS_MARKER|secret/)
})

test('forecast preview is separate; locking is atomic, has no model and rejects stale edits even after restore identity', async t => {
  const f = await fixture(t); const e = await f.evaluate(); assert.equal(e.ok, true, JSON.stringify(e))
  const forecast = await f.action('forecast', { evaluationId: e.result.record.id }); assert.equal(forecast.ok, true, JSON.stringify(forecast)); assert.equal(forecast.result.record.probabilities, null); assert.equal(forecast.result.record.baseline.count, 0)
  assert.notEqual(f.calls[0].sessionId, f.calls[1].sessionId)
  const p = await f.action('lock', { forecastId: forecast.result.record.id }, 'lock-once'); assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(f.calls.length, 2)
  const duplicates = await Promise.all(['lock-once', 'lock-again'].map(id => f.action('lock', { forecastId: forecast.result.record.id }, id))); assert.ok(duplicates.every(r => r.ok && r.result.record.id === p.result.record.id))
  const g = await fixture(t); const ge = await g.evaluate(); const gf = await g.action('forecast', { evaluationId: ge.result.record.id })
  await g.store.mutate('edit', s => { s.items[0].drafts.script.text = 'edited' }); assert.equal((await g.action('lock', { forecastId: gf.result.record.id })).ok, false)
  await g.store.undoLast(); assert.equal((await g.action('lock', { forecastId: gf.result.record.id })).ok, false)
  await g.store.mutate('restore', s => restoreVersion(s.items[0], g.version.id)); assert.equal((await g.action('lock', { forecastId: gf.result.record.id })).ok, false)
})

test('data-known and published evaluation is historical; any associated external observation prevents fresh locking', async t => {
  const f = await fixture(t)
  await f.store.mutate('actuals', s => { s.items[0].externalId = '抖音:123'; s.metrics = [{ id: 'known', accountId: 'a', externalId: '抖音:123', platform: '抖音', views: 0 }] })
  const e = await f.evaluate(); assert.equal(e.result.record.eligibleAtEvaluation, false); assert.equal(e.result.record.blindness, 'historical-nonblind')
  const v = await f.action('forecast', { evaluationId: e.result.record.id }); assert.equal((await f.action('lock', { forecastId: v.result.record.id })).ok, false)
})

test('model in flight never holds Store lock; reassignment at commit rejects and old archives do not follow new scope', async t => {
  let release; const f = await fixture(t, { callText: request => new Promise(resolve => { release = () => resolve({ model: 'fake', text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 3, reason: 'Reason', evidence: 'text', confidence: 1 })) }) }) }) })
  const pending = f.evaluate(); for (let i = 0; i < 1000 && !release; i++) await new Promise(r => setTimeout(r, 1)); assert.ok(release, 'evaluation dispatched model')
  await f.store.mutate('move', s => applyOps(s, [{ op: 'assign_items', ids: ['work'], accountId: 'b' }]))
  release(); assert.equal((await pending).ok, false)
  const g = await fixture(t); const e = await g.evaluate(); await g.store.mutate('move', s => applyOps(s, [{ op: 'assign_items', ids: ['work'], accountId: 'b' }]))
  assert.equal((await g.read({ accountId: 'b' })).result.total, 0); assert.equal((await g.read({ accountId: 'b', recordId: e.result.record.id })).ok, false)
  assert.equal((await g.read({ accountId: 'a' })).result.total, 1)
  await g.store.mutate('delete', s => applyOps(s, [{ op: 'delete_item', id: 'work' }, { op: 'delete_account', id: 'a' }]))
  assert.equal((await g.read()).result.total, 1); assert.equal((await new Store(g.root).read()).contentLab.records.length, 1)
})

test('actual publication requires valid past zoned date after lock and is immutable, atomic and user-declared', async t => {
  const f = await fixture(t); const p = await f.lock()
  for (const publishedAt of ['2026-02-30T00:00:00Z', '2026-11-12T00:00:01Z', '2026-11-11T23:59:59Z', '2026-11-12T00:00:00']) assert.equal((await f.action('publish', { predictionId: p.id, publishedAt })).ok, false)
  const args = { predictionId: p.id, publishedAt: '2026-11-12T08:00:00+08:00', url: 'https://example.com/p/1' }
  const result = await f.action('publish', args); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.record.source, 'user-declared'); assert.equal((await f.store.read()).items[0].status, 'published')
  assert.equal((await f.action('publish', args)).result.record.id, result.result.record.id)
  assert.equal((await f.action('publish', { ...args, url: 'https://example.com/p/2' })).ok, false)
  await f.store.undoLast(); assert.equal((await f.store.read()).contentLab.records.length, 4)
})

test('retro selects reliable due observation, preserves missing/zero views, late ages and original raw metrics', async t => {
  const f = await fixture(t); const p = await f.lock(); await f.action('publish', { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' })
  await f.store.mutate('metrics', s => { s.metrics = [{ id: 'metric', itemId: 'work', accountId: 'a', platform: '抖音', collectedAt: '2026-11-15T00:00:00Z', views: null, source: 'manual' }] })
  assert.equal((await f.action('retro', { predictionId: p.id, metricId: 'metric' })).ok, false)
  f.time('2026-11-15T00:00:00Z'); const raw = structuredClone((await f.store.read()).metrics)
  const r = await f.action('retro', { predictionId: p.id, metricId: 'metric' }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.result.record.actuals.views, null); assert.equal(r.result.record.bucketHit, null); assert.equal(r.result.record.latenessMs, 0)
  const dup = await f.action('retro', { predictionId: p.id, metricId: 'metric' }); assert.equal(dup.result.record.id, r.result.record.id)
  assert.deepEqual((await f.store.read()).metrics, raw)
  await f.store.mutate('later', s => { s.metrics.push({ ...raw[0], id: 'late', collectedAt: '2026-11-16T00:00:00Z', views: 0 }) }); f.time('2026-11-16T00:00:00Z')
  const late = await f.action('retro', { predictionId: p.id, metricId: 'late' }); assert.equal(late.result.record.actuals.views, 0); assert.equal(late.result.record.timing, 'late'); assert.equal(late.result.record.latenessMs, 86400000)
  assert.equal((await f.read({ view: 'queue' })).result.items[0].status, 'late')
})

test('publication mismatch is recorded without blocking the actual claim and cannot calibrate a future forecast', async t => {
  const f = await fixture(t); const p = await f.lock()
  await f.store.mutate('changed after lock', s => { s.items[0].drafts.script.text = 'Changed published manuscript.' })
  const registered = await f.action('publish', { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' }); assert.equal(registered.ok, true, JSON.stringify(registered)); assert.equal(registered.result.record.manuscriptMatch, 'mismatch')
  await f.store.mutate('actuals', s => { s.metrics = [{ id: 'mismatch-data', itemId: 'work', accountId: 'a', platform: '抖音', collectedAt: '2026-11-15T00:00:00Z', views: 500, source: 'manual' }] }); f.time('2026-11-15T00:00:00Z')
  const retro = await f.action('retro', { predictionId: p.id, metricId: 'mismatch-data' }); assert.equal(retro.result.record.publicationManuscriptMatch, 'mismatch')
})

test('knowledge of target publication or data is sticky through Undo and deletion during a model operation', async t => {
  const f = await fixture(t); const e = await f.evaluate(); const forecast = await f.action('forecast', { evaluationId: e.result.record.id })
  await f.store.mutate('published', s => { s.items[0].status = 'published' }); await f.store.undoLast()
  assert.equal((await f.action('lock', { forecastId: forecast.result.record.id })).ok, false)
  const g = await fixture(t); const ge = await g.evaluate(); const gf = await g.action('forecast', { evaluationId: ge.result.record.id })
  await g.store.mutate('data', s => { s.metrics.push({ id: 'known', itemId: 'work', accountId: 'a', platform: '抖音', views: 0 }) }); await g.store.undoLast()
  assert.equal((await g.action('lock', { forecastId: gf.result.record.id })).ok, false)
})

test('frozen baseline uses median, distinct works and the exact six-hour boundary, isolated by account/platform/horizon/format', async t => {
  const { sealRecord, baselineFor, BASELINE_POLICY, relativeBucket } = await import('../src/content-lab/records.js')
  const f = await fixture(t); const e = await f.evaluate(); const evaluation = (await f.store.read()).contentLab.records[0]
  const due = '2026-11-11T00:00:00.000Z'
  const row = (itemId, views, lateHours = 0, fields = {}) => sealRecord({ id: `r-${itemId}-${lateHours}-${views}`, kind: 'retrospective', accountId: 'a', platform: '抖音', format: 'script', horizonDays: 3, itemId, metricId: `m-${itemId}-${views}`, actuals: { views, collectedAt: new Date(Date.parse(due) + lateHours * 3600000).toISOString() }, elapsedMs: 3 * 86400000 + lateHours * 3600000, latenessMs: lateHours * 3600000, publicationManuscriptMatch: 'matching', ...fields })
  await f.store.mutate('frozen retros', s => { s.contentLab.records.push(row('one', 100), row('one', 999, 1), row('two', 300, 6), row('three', 200, 6), row('over', 9999, 6 + 1 / 3600000), row('other-account', 9999, 0, { accountId: 'b' }), row('other-platform', 9999, 0, { platform: '快手' }), row('other-horizon', 9999, 0, { horizonDays: 4 }), row('other-format', 9999, 0, { format: 'article' }), row('wrong-manuscript', 9999, 0, { publicationManuscriptMatch: 'mismatch' })) })
  const baseline = baselineFor(await f.store.read(), evaluation, 3, initialTime); assert.equal(baseline.count, 3); assert.equal(baseline.medianViews, 200); assert.equal(baseline.usable, true); assert.equal(BASELINE_POLICY.maxLatenessHours, 6); assert.equal(baseline.sources.find(r => r.itemId === 'one').views, 100)
  const forecast = await f.action('forecast', { evaluationId: e.result.record.id }); assert.deepEqual(forecast.result.record.probabilities, [0.1, 0.2, 0.4, 0.2, 0.1])
  assert.deepEqual([0, 29, 30, 99, 100, 299, 300, 999, 1000].map(n => relativeBucket(n, 100)), [0, 0, 1, 1, 2, 2, 3, 3, 4])
  await f.store.mutate('zero', s => { s.contentLab.records = s.contentLab.records.filter(r => r.kind !== 'retrospective').concat([row('one', 0), row('two', 0), row('three', 10)]) })
  const zero = baselineFor(await f.store.read(), evaluation, 3, initialTime); assert.equal(zero.usable, false); assert.equal(zero.medianViews, null)
})

test('unknown journal outcomes recover scoped record evidence without a second model call', async t => {
  const { MutationJournal } = await import('../src/automation/journal.js')
  const f = await fixture(t); const journal = new MutationJournal(join(f.root, 'faulted')); const persist = journal.persist.bind(journal); let writes = 0
  journal.persist = () => ++writes === 2 ? Promise.reject(new Error('disk fault')) : persist()
  const callText = async request => ({ text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) }), model: 'fake' })
  const service = createAutomationService({ store: f.store, producer, settings: {}, journal, callText, now: () => initialTime })
  const input = { accountId: 'a', action: 'evaluate', itemId: 'work', versionId: f.version.id, format: 'script', rubricId: 'general-script-v1' }
  const failed = await service.call({ tool: 'media_desk_content_lab_action', input, requestId: 'saved-before-fault' }); assert.equal(failed.error.code, 'OUTCOME_UNKNOWN'); assert.equal(failed.error.details.contentLab.records.length, 1)
  const recovered = createAutomationService({ store: new Store(f.root), producer, settings: {}, journal: new MutationJournal(join(f.root, 'faulted')), callText: () => assert.fail('must not replay') })
  const retry = await recovered.call({ tool: 'media_desk_content_lab_action', input, requestId: 'saved-before-fault' }); assert.equal(retry.error.code, 'OUTCOME_UNKNOWN')
  const found = await recovered.call({ tool: 'media_desk_get_content_lab', input: { accountId: 'a', queryRequestId: 'saved-before-fault' } }); assert.equal(found.result.total, 1)
  assert.equal((await recovered.call({ tool: 'media_desk_get_content_lab', input: { accountId: 'b', queryRequestId: 'saved-before-fault' } })).result.total, 0)
})

test('selected text hash uses its exact UTF-8 bytes, independently of full creative snapshot hash', async t => {
  const { createHash } = await import('node:crypto'); const f = await fixture(t); const e = await f.evaluate()
  assert.equal(e.result.record.textSha256, createHash('sha256').update('Saved manuscript.').digest('hex'))
  assert.equal(e.result.record.creativeSha256, f.version.sha256)
})

test('legacy default zero stays unknown while a reliable cumulative zero is observed zero', async () => {
  const { viewCounter } = await import('../src/content-lab/records.js')
  assert.equal(viewCounter({ views: 0, source: 'monid' }), null)
  assert.equal(viewCounter({ views: null, semantics: 'cumulative' }), null)
  assert.equal(viewCounter({ views: 0, semantics: 'cumulative' }), 0)
  assert.equal(viewCounter({ views: 0, source: 'manual' }), 0)
})

test('retro rejects early, future, weak, malformed, ambiguous and other-account metric identities before narrative model', async t => {
  const f = await fixture(t); const p = await f.lock(); await f.action('publish', { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' }); f.time('2026-11-15T00:00:00Z')
  const metric = { id: 'selected', itemId: 'work', accountId: 'a', platform: '抖音', views: 1, collectedAt: '2026-11-15T00:00:00Z', source: 'manual' }
  const invalid = [{ collectedAt: '2026-11-14T23:59:59Z' }, { collectedAt: '2026-11-15T00:00:01Z' }, { collectedAt: '2026-02-30T00:00:00Z' }, { collectedAt: null }, { collectedAt: '2026-11-15T00:00:00' }, { collectionTimeBasis: 'legacy-date' }, { accountId: 'b' }, { platform: '快手' }, { itemId: 'missing' }]
  for (const change of invalid) {
    await f.store.mutate('observation', s => { s.metrics = [{ ...metric, ...change }] }); const r = await f.action('retro', { predictionId: p.id, metricId: metric.id }); assert.equal(r.ok, false, JSON.stringify(change))
  }
  await f.store.mutate('ambiguous id', s => { s.metrics = [metric, { ...metric }] }); assert.equal((await f.action('retro', { predictionId: p.id, metricId: metric.id })).ok, false)
  assert.equal(f.calls.length, 2)
})

test('strict probability validation rejects invented counts and malformed model distributions', async t => {
  const { validateModelReply } = await import('../src/content-lab/schemas.js')
  const reply = value => ({ text: JSON.stringify(value), model: 'fake' })
  for (const probabilities of [[0, 0, 0, 0, 0], [-0.1, 0.2, 0.4, 0.3, 0.2], [0.1, 0.2, 0.4, 0.2], [0.1, 0.2, 0.4, 0.2, 0.1001], null]) assert.throws(() => validateModelReply('forecast', reply({ probabilities, bet: 'b', reason: 'r' }), null, true))
  assert.throws(() => validateModelReply('forecast', reply({ probabilities: null, bet: 'b', reason: 'r', expectedViews: 100 })))
  assert.throws(() => validateModelReply('forecast', reply({ probabilities: [0.2, 0.2, 0.2, 0.2, 0.2], bet: 'b', reason: 'r' }), null, false))
  assert.doesNotThrow(() => validateModelReply('forecast', reply({ probabilities: [0, 0, 1, 0, 0], bet: 'b', reason: 'r' }), null, true))
  assert.throws(() => validateModelReply('retro', reply({ summary: 'x'.repeat(2001), learning: 'l' })))
})

test('same request races dispatch once and different model requests have a bounded shared concurrency limit', async t => {
  const f = await fixture(t); const input = { accountId: 'a', action: 'evaluate', itemId: 'work', versionId: f.version.id, format: 'script', rubricId: 'general-script-v1' }
  const results = await Promise.all(Array.from({ length: 8 }, () => f.service.call({ tool: 'media_desk_content_lab_action', input, requestId: 'race-same' }))); assert.ok(results.every(r => r.ok)); assert.equal(f.calls.length, 1)
  const releases = []; let modelCount = 0
  const g = await fixture(t, { callText: request => new Promise(resolve => { modelCount++; releases.push(() => resolve({ text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) }), model: 'fake' })) }) })
  const first = g.evaluate(), second = g.evaluate()
  for (let i = 0; i < 1000 && releases.length < 2; i++) await new Promise(r => setTimeout(r, 1))
  assert.equal(releases.length, 2); const third = await g.evaluate(); assert.equal(third.error.code, 'BUSY'); assert.equal(modelCount, 2)
  releases.forEach(release => release()); assert.ok((await Promise.all([first, second])).every(r => r.ok))
})

test('published/data-known state arriving and undone while scoring cannot create a fresh eligible evaluation', async t => {
  let release; const f = await fixture(t, { callText: request => new Promise(resolve => { release = () => resolve({ text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) }), model: 'fake' }) }) })
  const pending = f.evaluate(); for (let i = 0; i < 1000 && !release; i++) await new Promise(r => setTimeout(r, 1)); assert.ok(release)
  await f.store.mutate('actual arrives', s => { s.metrics.push({ id: 'arrived', accountId: 'a', itemId: 'work', platform: '抖音', views: 0 }) }); await f.store.undoLast(); release()
  const evaluated = await pending; assert.equal(evaluated.result.record.eligibleAtEvaluation, false); assert.equal(evaluated.result.record.blindness, 'historical-nonblind')
})

test('read detail is bounded, manuscript opt-in stays recursive and immutable records detect tampering', async t => {
  const f = await fixture(t); const p = await f.lock(); const compact = await f.read({ accountId: 'a', recordId: p.id, maxChars: 100000 })
  assert.equal(compact.result.record.evaluation.manuscript, undefined)
  const opted = await f.read({ accountId: 'a', recordId: p.id, includeManuscript: true, maxChars: 100000 }); assert.equal(opted.result.record.evaluation.manuscript.text, 'Saved manuscript.')
  const bounded = await f.read({ accountId: 'a', recordId: p.id, includeManuscript: true, maxChars: 12 }); assert.equal(bounded.result.record.preview.length, 12); assert.equal(bounded.result.truncated, true)
  await f.store.mutate('tamper', s => { s.contentLab.records[0].dimensions[0].score = 0 }); assert.equal((await f.read({ accountId: 'a' })).ok, false)
})

test('a timed-out provider that has not settled retains its concurrency slot and never commits late output', async t => {
  const releases = []; let count = 0
  const f = await fixture(t, { callText: request => new Promise(resolve => { count++; releases.push(() => resolve({ text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) }), model: 'fake' })) }) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = f.evaluate(), second = f.evaluate()
  for (let i = 0; i < 10000 && releases.length < 2; i++) await new Promise(r => setImmediate(r))
  assert.equal(releases.length, 2)
  t.mock.timers.tick(240000)
  const timed = await Promise.all([first, second]); assert.ok(timed.every(r => r.error.code === 'MODEL_TIMEOUT'))
  const third = f.evaluate()
  for (let i = 0; i < 10000 && count === 2; i++) await new Promise(r => setImmediate(r))
  const dispatched = count
  releases.forEach(release => release())
  const result = await third
  assert.equal(dispatched, 2, 'unsettled timed-out calls still consume their slots')
  assert.equal(result.error.code, 'BUSY')
  assert.equal((await f.store.read()).contentLab.records.length, 0)
})

test('failure to read recovery evidence never claims a completed model was not dispatched', async t => {
  const { MutationJournal } = await import('../src/automation/journal.js'); const f = await fixture(t); const journal = new MutationJournal(join(f.root, 'evidence-fault')); const persist = journal.persist.bind(journal); let writes = 0
  journal.persist = () => ++writes === 2 ? Promise.reject(new Error('receipt failure')) : persist()
  const service = createAutomationService({ store: f.store, producer, settings: {}, journal, callText: async request => ({ text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 3, reason: 'r', evidence: '', confidence: 1 })) }), model: 'fake' }) })
  f.store.read = async () => { throw new Error('recovery read failed') }
  const result = await service.call({ tool: 'media_desk_content_lab_action', input: { accountId: 'a', action: 'evaluate', itemId: 'work', versionId: f.version.id, format: 'script', rubricId: 'general-script-v1' }, requestId: 'evidence-read-fault' })
  assert.equal(result.error.code, 'OUTCOME_UNKNOWN'); assert.doesNotMatch(result.error.message, /no new dispatch/)
})

for (const actionName of ['evaluate', 'forecast', 'retro']) for (const drift of ['account-round-trip', 'platform-round-trip', 'delete-recreate']) test(`${actionName} rejects ${drift} during model await without committing a record`, async t => {
  let gated = false, release
  const f = await fixture(t, { callText: async request => {
    const body = JSON.parse(request.user)
    const result = body.script ? { dimensions: body.rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) } : body.evaluation ? { probabilities: null, bet: 'b', reason: 'r' } : { summary: 's', learning: 'l' }
    if (gated) await new Promise(resolve => { release = resolve })
    return { text: JSON.stringify(result), model: 'fake' }
  } })
  let fields = {}
  if (actionName === 'forecast') { const e = await f.evaluate(); fields = { evaluationId: e.result.record.id } }
  if (actionName === 'retro') {
    const p = await f.lock(); await f.action('publish', { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' }); f.time('2026-11-15T00:00:00Z')
    await f.store.mutate('metric', s => { s.metrics.push({ id: 'scope-metric', accountId: 'a', itemId: 'work', platform: '抖音', collectedAt: '2026-11-15T00:00:00Z', source: 'manual', views: 50 }) }); fields = { predictionId: p.id, metricId: 'scope-metric' }
  }
  const before = (await f.store.read()).contentLab?.records.length ?? 0, original = structuredClone((await f.store.read()).items[0])
  gated = true; const pending = actionName === 'evaluate' ? f.evaluate() : f.action(actionName, fields)
  for (let i = 0; i < 1000 && !release; i++) await new Promise(r => setTimeout(r, 1)); assert.ok(release)
  if (drift === 'account-round-trip') {
    await f.store.mutate('scope B', s => { s.items[0].accountId = 'b' }); await f.store.mutate('scope A', s => { s.items[0].accountId = 'a' })
  } else if (drift === 'platform-round-trip') {
    await f.store.mutate('platform B', s => { s.items[0].platform = '快手' }); await f.store.mutate('platform A', s => { s.items[0].platform = '抖音' })
  } else { await f.store.mutate('delete', s => { s.items = [] }); await f.store.mutate('recreate', s => { s.items = [original] }) }
  release(); const result = await pending
  assert.equal(result.error?.code, 'INVALID_ARGUMENT', JSON.stringify(result)); assert.equal((await f.store.read()).contentLab.records.length, before)
})

test('working-copy edits during evaluation preserve the useful saved-version score and only invalidate locking', async t => {
  let release; const f = await fixture(t, { callText: request => new Promise(resolve => { release = () => resolve({ text: JSON.stringify({ dimensions: JSON.parse(request.user).rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) }), model: 'fake' }) }) })
  const pending = f.evaluate(); for (let i = 0; i < 1000 && !release; i++) await new Promise(r => setTimeout(r, 1)); assert.ok(release)
  await f.store.mutate('working edit', s => { s.items[0].drafts.script.text = 'new working manuscript' }); release()
  const result = await pending; assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.result.record.eligibleAtEvaluation, false)
})

test('queue is upcoming before the exact due instant, awaiting-data at due without suitable data, due with suitable data', async t => {
  const f = await fixture(t), p = await f.lock(); await f.action('publish', { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' })
  const status = async () => (await f.read({ view: 'queue', accountId: 'a' })).result.items[0].status
  assert.equal(await status(), 'upcoming'); f.time('2026-11-14T23:59:59.999Z'); assert.equal(await status(), 'upcoming')
  f.time('2026-11-15T00:00:00Z'); assert.equal(await status(), 'awaiting-data')
  await f.store.mutate('early metric', s => { s.metrics.push({ id: 'early-queue', itemId: 'work', accountId: 'a', platform: '抖音', collectedAt: '2026-11-14T23:59:59Z', views: 10, source: 'manual' }) }); assert.equal(await status(), 'awaiting-data')
  await f.store.mutate('due metric', s => { s.metrics.push({ id: 'due-queue', itemId: 'work', accountId: 'a', platform: '抖音', collectedAt: '2026-11-15T00:00:00Z', views: 10, source: 'manual' }) }); assert.equal(await status(), 'due')
})

test('list/detail read aliases remain strict, detail requires recordId and records compatibility remains', async t => {
  const f = await fixture(t); const e = await f.evaluate()
  assert.equal((await f.read({ view: 'list', accountId: 'a' })).result.total, 1)
  assert.equal((await f.read({ view: 'records', accountId: 'a' })).result.total, 1)
  assert.equal((await f.read({ view: 'detail', accountId: 'a', recordId: e.result.record.id })).result.record.id, e.result.record.id)
  assert.equal((await f.read({ view: 'detail', accountId: 'a' })).error.code, 'INVALID_ARGUMENT')
  assert.equal((await f.read({ view: 'list', unexpected: true })).error.code, 'INVALID_ARGUMENT')
})

async function numericFixture(t, values, probabilities = [0.1, 0.2, 0.4, 0.2, 0.1]) {
  const { sealRecord } = await import('../src/content-lab/records.js')
  const f = await fixture(t, { callText: async request => {
    const body = JSON.parse(request.user), result = body.script ? { dimensions: body.rubric.dimensions.map(d => ({ id: d.id, score: 4, reason: 'r', evidence: '', confidence: 1 })) } : body.evaluation ? { probabilities, bet: 'b', reason: 'r' } : { summary: 's', learning: 'l' }
    return { text: JSON.stringify(result), model: 'fake' }
  } })
  const e = await f.evaluate()
  await f.store.mutate('accepted baseline fixtures', s => { s.contentLab.records.push(...values.map((views, i) => sealRecord({ id: `prior-${i}`, kind: 'retrospective', accountId: 'a', itemId: `prior-item-${i}`, platform: '抖音', format: 'script', horizonDays: 3, metricId: `prior-metric-${i}`, actuals: { views, collectedAt: '2026-11-11T00:00:00Z' }, elapsedMs: 3 * 86400000, latenessMs: 0, publicationManuscriptMatch: 'matching' }))) })
  const forecast = await f.action('forecast', { evaluationId: e.result.record.id }); assert.equal(forecast.ok, true, JSON.stringify(forecast))
  return { ...f, forecast: forecast.result.record }
}
async function numericRetro(f, views) {
  const p = await f.action('lock', { forecastId: f.forecast.id }); assert.equal(p.ok, true, JSON.stringify(p))
  await f.action('publish', { predictionId: p.result.record.id, publishedAt: '2026-11-12T00:00:00Z' }); f.time('2026-11-15T00:00:00Z')
  await f.store.mutate('selected numeric metric', s => { s.metrics.push({ id: 'numeric-metric', accountId: 'a', itemId: 'work', platform: '抖音', collectedAt: '2026-11-15T00:00:00Z', views, source: 'manual' }) })
  return f.action('retro', { predictionId: p.result.record.id, metricId: 'numeric-metric' })
}

test('forecast freezes exact rational comparison bounds, and large safe integers compare below 0.3x without floating rounding', async t => {
  const f = await numericFixture(t, [9007199254740987, 9007199254740987, 9007199254740987])
  assert.deepEqual(f.forecast.baseline.medianViewsExact, { numerator: '9007199254740987', denominator: '1' })
  assert.equal(f.forecast.comparisonPolicy.id, 'relative-five-bucket-rational-v1')
  const first = f.forecast.comparisonPolicy.intervals[0]; assert.deepEqual(first.upperRatio, { numerator: '3', denominator: '10' }); assert.equal(first.lowerInclusive, true); assert.equal(first.upperInclusive, false)
  const r = await numericRetro(f, 2702159776422296); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.result.record.observedBucket, 0); assert.equal(r.result.record.assignedProbability, 0.1)
})

test('even-pool large median retains an exact half and explicitly labels its displayed numeric approximation', async t => {
  const f = await numericFixture(t, [9007199254740987, 9007199254740987, 9007199254740988, 9007199254740988])
  assert.deepEqual(f.forecast.baseline.medianViewsExact, { numerator: '18014398509481975', denominator: '2' })
  assert.equal(f.forecast.baseline.medianViewsApproximate, true)
  assert.deepEqual(f.forecast.comparisonPolicy.baselineExact, f.forecast.baseline.medianViewsExact)
  const r = await numericRetro(f, 2702159776422296); assert.equal(r.result.record.observedBucket, 0)
})

test('retrospective consumes frozen forecast ratios rather than present-day default bucket thresholds', async t => {
  const { sealRecord } = await import('../src/content-lab/records.js'); const f = await numericFixture(t, [100, 100, 100])
  await f.store.mutate('restore historic comparison fixture', s => {
    const index = s.contentLab.records.findIndex(r => r.id === f.forecast.id), forecast = structuredClone(s.contentLab.records[index])
    // Model a valid prior policy snapshot with a different first threshold.
    forecast.comparisonPolicy.intervals[0].upperRatio = { numerator: '1', denominator: '2' }
    forecast.comparisonPolicy.intervals[1].lowerRatio = { numerator: '1', denominator: '2' }
    s.contentLab.records[index] = sealRecord(forecast)
  })
  const r = await numericRetro(f, 40); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.result.record.observedBucket, 0)
})

test('tied highest probabilities have no invented winner or hit while preserving observed bucket and assigned probability', async t => {
  const f = await numericFixture(t, [100, 100, 100], [0.5, 0.5, 0, 0, 0])
  assert.equal(f.forecast.predictedBucket, null); assert.deepEqual(f.forecast.topBuckets, [0, 1]); assert.equal(f.forecast.comparisonPolicy.tiePolicy, 'unique-maximum-or-unscored-v1')
  const r = await numericRetro(f, 50); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.result.record.observedBucket, 1); assert.equal(r.result.record.predictedBucket, null); assert.equal(r.result.record.bucketHit, null); assert.equal(r.result.record.assignedProbability, 0.5); assert.deepEqual(r.result.record.topBuckets, [0, 1])
})

test('record sealing hashes the exact persisted JSON projection, including nested optional values', async () => {
  const { sealRecord, verifyRecord } = await import('../src/content-lab/records.js')
  const input = { id: 'json-projection', kind: 'forecast', absent: undefined, nested: { absent: undefined, keep: false }, list: [undefined, 0], value: Infinity }
  const sealed = sealRecord(input), persisted = JSON.parse(JSON.stringify(sealed))
  assert.deepEqual(sealed, persisted); assert.equal(Object.hasOwn(sealed, 'absent'), false); assert.equal(Object.hasOwn(sealed.nested, 'absent'), false)
  assert.deepEqual(sealed.list, [null, 0]); assert.equal(sealed.value, null); assert.equal(Object.hasOwn(input, 'absent'), true)
  assert.doesNotThrow(() => verifyRecord(persisted))
})

for (const absentFields of [['scopeEpoch'], ['scopeEpoch', 'materialMode']]) test(`legacy ${absentFields.join('/')} omissions remain valid through forecast, lock, publish, retro and fresh Store reloads`, async t => {
  const { sealRecord, verifyRecord } = await import('../src/content-lab/records.js'), { creativeFingerprint } = await import('../src/versions.js')
  const f = await fixture(t), evaluated = await f.evaluate(), evaluationId = evaluated.result.record.id
  const creativeBefore = creativeFingerprint((await f.store.read()).items[0])
  let legacyJson
  await f.store.mutate('valid pre-scope-epoch archive fixture', s => {
    const index = s.contentLab.records.findIndex(r => r.id === evaluationId), legacy = structuredClone(s.contentLab.records[index])
    for (const field of absentFields) delete legacy[field]
    delete s.contentLab.targets.work.scopeEpoch
    s.contentLab.records[index] = sealRecord(legacy); legacyJson = JSON.stringify(s.contentLab.records[index])
  })
  async function assertFresh(expectedCount) {
    const freshStore = new Store(f.root), state = await freshStore.read()
    assert.equal(state.contentLab.records.length, expectedCount)
    state.contentLab.records.forEach(record => assert.doesNotThrow(() => verifyRecord(record), `${record.kind} must survive JSON persistence`))
    assert.equal(JSON.stringify(state.contentLab.records.find(r => r.id === evaluationId)), legacyJson, 'old archive is not rewritten')
    const reader = createAutomationService({ store: freshStore, settings: {}, producer, readOnly: true })
    const listed = await reader.call({ tool: 'media_desk_get_content_lab', input: { accountId: 'a', view: 'list' } }); assert.equal(listed.ok, true, JSON.stringify(listed)); assert.equal(listed.result.total, expectedCount)
  }
  await assertFresh(1)
  const forecast = await f.action('forecast', { evaluationId }); assert.equal(forecast.ok, true, JSON.stringify(forecast)); await assertFresh(2)
  const prediction = await f.action('lock', { forecastId: forecast.result.record.id }); assert.equal(prediction.ok, true, JSON.stringify(prediction)); await assertFresh(3)
  const published = await f.action('publish', { predictionId: prediction.result.record.id, publishedAt: '2026-11-12T00:00:00Z' }); assert.equal(published.ok, true, JSON.stringify(published)); await assertFresh(4)
  f.time('2026-11-15T00:00:00Z'); await f.store.mutate('metric', s => { s.metrics.push({ id: 'legacy-flow-metric', itemId: 'work', accountId: 'a', platform: '抖音', collectedAt: '2026-11-15T00:00:00Z', source: 'manual', views: 0 }) })
  const rawMetrics = structuredClone((await f.store.read()).metrics), input = { predictionId: prediction.result.record.id, metricId: 'legacy-flow-metric' }
  const retro = await f.action('retro', input, 'legacy-retro-once'); assert.equal(retro.ok, true, JSON.stringify(retro)); await assertFresh(5)
  const replay = await f.action('retro', input, 'legacy-retro-once'); assert.equal(replay.cached, true); assert.equal(f.calls.length, 3)
  const after = await f.store.read(); assert.deepEqual(after.metrics, rawMetrics); assert.equal(creativeFingerprint(after.items[0]), creativeBefore)
})

for (const available of [100, 1000, 1001]) test(`recent-20 basis remains quantitative and model/action sizes stay small with ${available} eligible works`, async t => {
  const { randomUUID } = await import('node:crypto'), { sealRecord } = await import('../src/content-lab/records.js')
  const f = await fixture(t), e = await f.evaluate()
  await f.store.mutate('large accepted retrospective cohort', s => {
    s.contentLab.records.push(...Array.from({ length: available }, (_, i) => sealRecord({ id: randomUUID(), kind: 'retrospective', accountId: 'a', itemId: randomUUID(), platform: '抖音', format: 'script', horizonDays: 3, metricId: randomUUID(), publicationManuscriptMatch: 'matching', actuals: { views: i < 20 ? 100 + i : 999999, collectedAt: new Date(initialTime - (i + 1) * 3600000).toISOString() }, elapsedMs: 3 * 86400000, latenessMs: 0 })))
  })
  const result = await f.action('forecast', { evaluationId: e.result.record.id }); assert.equal(result.ok, true, JSON.stringify(result))
  const summary = result.result.record.baseline; assert.equal(summary.count, 20); assert.equal(summary.totalEligibleCount, available); assert.equal(summary.policy.maxWorks, 20); assert.equal(summary.policy.selectionPolicyId, 'recent20-collected-desc-item-id-v1'); assert.equal(summary.usable, true); assert.deepEqual(summary.medianViewsExact, { numerator: '219', denominator: '2' }); assert.equal(summary.sources, undefined)
  const forecastPrompt = JSON.parse(f.calls.at(-1).user); assert.equal(forecastPrompt.baseline.sources, undefined); assert.ok(Buffer.byteLength(f.calls.at(-1).user) < 12000); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000)
  const full = await f.read({ view: 'detail', recordId: result.result.record.id, maxChars: 100000 }); assert.equal(full.result.record.baseline.sources.length, 20)
  const prediction = await f.action('lock', { forecastId: result.result.record.id }); await f.action('publish', { predictionId: prediction.result.record.id, publishedAt: '2026-11-12T00:00:00Z' }); f.time('2026-11-15T00:00:00Z')
  await f.store.mutate('actual metric', s => { s.metrics.push({ id: 'cohort-actual', itemId: 'work', accountId: 'a', platform: '抖音', views: 150, source: 'manual', collectedAt: '2026-11-15T00:00:00Z' }) })
  const retro = await f.action('retro', { predictionId: prediction.result.record.id, metricId: 'cohort-actual' }); assert.equal(retro.ok, true, JSON.stringify(retro))
  const retroPrompt = JSON.parse(f.calls.at(-1).user); assert.equal(retroPrompt.prediction.baseline.sources, undefined); assert.ok(Buffer.byteLength(f.calls.at(-1).user) < 12000); assert.ok(Buffer.byteLength(JSON.stringify(retro)) < 12000)
  t.diagnostic(`available=${available}, forecastPromptBytes=${Buffer.byteLength(f.calls[1].user)}, retroPromptBytes=${Buffer.byteLength(f.calls.at(-1).user)}, forecastActionBytes=${Buffer.byteLength(JSON.stringify(result))}`)
})

test('recent-20 selection is deterministic after earliest-per-work and timestamp/item/record ties', async t => {
  const { baselineFor, sealRecord } = await import('../src/content-lab/records.js'); const f = await fixture(t); await f.evaluate(); const state = await f.store.read(), evaluation = state.contentLab.records[0]
  const row = (itemId, id, views, collectedAt = '2026-11-11T00:00:00Z') => sealRecord({ id, kind: 'retrospective', accountId: 'a', itemId, platform: '抖音', format: 'script', horizonDays: 3, metricId: `metric-${id}`, publicationManuscriptMatch: 'matching', actuals: { views, collectedAt }, elapsedMs: 3 * 86400000, latenessMs: 0 })
  const rows = Array.from({ length: 22 }, (_, i) => row(`prior-${String(i).padStart(2, '0')}`, `record-${i}`, 100 + i, i === 21 ? '2026-11-11T00:00:00.001Z' : undefined))
  rows.push(row('prior-00', 'later-observation', 9999, '2026-11-11T01:00:00Z'), row('prior-01', 'a-tied-record', 50, '2026-11-11T08:00:00+08:00'))
  const a = baselineFor({ ...state, contentLab: { records: rows } }, evaluation, 3, initialTime), b = baselineFor({ ...state, contentLab: { records: [...rows].reverse() } }, evaluation, 3, initialTime)
  assert.deepEqual(a, b); assert.equal(a.totalEligibleCount, 22); assert.equal(a.count, 20); assert.deepEqual(a.sources.map(r => r.itemId), ['prior-21', ...Array.from({ length: 19 }, (_, i) => `prior-${String(i).padStart(2, '0')}`)])
  assert.equal(a.sources.find(r => r.itemId === 'prior-00').views, 100); assert.equal(a.sources.find(r => r.itemId === 'prior-01').retrospectiveId, 'a-tied-record')
})

test('legacy frozen huge source lists remain immutable and are summarized before retrospective model input', async t => {
  const { randomUUID } = await import('node:crypto'), { sealRecord, baselineSummary } = await import('../src/content-lab/records.js')
  const prompts = []; const f = await numericFixture(t, [100, 100, 100])
  await f.store.mutate('old large frozen baseline fixture', s => {
    const index = s.contentLab.records.findIndex(r => r.id === f.forecast.id), forecast = structuredClone(s.contentLab.records[index]); forecast.baseline.count = 1001; forecast.baseline.totalEligibleCount = 1001
    forecast.baseline.sources = Array.from({ length: 1001 }, () => ({ retrospectiveId: randomUUID(), itemId: randomUUID(), metricId: randomUUID(), views: 100, collectedAt: '2026-11-11T00:00:00Z', elapsedMs: 3 * 86400000, latenessMs: 0 })); s.contentLab.records[index] = sealRecord(forecast)
  })
  const old = structuredClone((await f.store.read()).contentLab.records.find(r => r.id === f.forecast.id))
  const compact = baselineSummary(old.baseline); assert.equal(compact.sources, undefined); assert.equal(compact.count, 1001); assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 2000)
  const { createContentLabService } = await import('../src/content-lab/service.js')
  const p = await f.action('lock', { forecastId: f.forecast.id }); await f.action('publish', { predictionId: p.result.record.id, publishedAt: '2026-11-12T00:00:00Z' }); await f.store.mutate('actual', s => { s.metrics.push({ id: 'old-basis-actual', accountId: 'a', itemId: 'work', platform: '抖音', source: 'manual', views: 120, collectedAt: '2026-11-15T00:00:00Z' }) })
  const lab = createContentLabService({ store: f.store, producer, now: () => Date.parse('2026-11-15T00:00:00Z'), callText: async request => { prompts.push(request); return { model: 'fake', text: JSON.stringify({ summary: 's', learning: 'l' }) } } })
  const result = await lab.action({ accountId: 'a', action: 'retro', predictionId: p.result.record.id, metricId: 'old-basis-actual' }, 'old-basis-retro')
  assert.equal(JSON.parse(prompts[0].user).prediction.baseline.sources, undefined); assert.ok(Buffer.byteLength(prompts[0].user) < 12000); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000)
  assert.deepEqual((await f.store.read()).contentLab.records.find(r => r.id === f.forecast.id), old)
})

for (const actionName of ['lock', 'publish', 'retro']) test(`logical duplicate ${actionName} preserves original record IDs through receipt failure, blocked replay and restart`, async t => {
  const { MutationJournal } = await import('../src/automation/journal.js'), f = await fixture(t), p = await f.lock(); let expected = p, fields = { forecastId: p.forecastId }
  if (actionName !== 'lock') { const publication = await f.action('publish', { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' }); expected = publication.result.record; fields = { predictionId: p.id, publishedAt: '2026-11-12T00:00:00Z' } }
  if (actionName === 'retro') {
    f.time('2026-11-15T00:00:00Z'); await f.store.mutate('actual', s => { s.metrics.push({ id: 'duplicate-actual', accountId: 'a', itemId: 'work', platform: '抖音', source: 'manual', views: 0, collectedAt: '2026-11-15T00:00:00Z' }) }); fields = { predictionId: p.id, metricId: 'duplicate-actual' }; expected = (await f.action('retro', fields)).result.record
  }
  const before = structuredClone((await f.store.read()).contentLab.records), calls = f.calls.length, journal = new MutationJournal(join(f.root, `duplicate-${actionName}`)), persist = journal.persist.bind(journal); let writes = 0
  journal.persist = async () => { if (++writes === 2) throw new Error('final receipt failure'); return persist() }
  const service = createAutomationService({ store: f.store, settings: {}, producer, journal, now: () => Date.parse('2026-11-15T00:00:00Z'), callText: () => assert.fail('duplicate action must not call model') }), requestId = `new-duplicate-${actionName}`, input = { accountId: 'a', action: actionName, ...fields }
  const call = () => service.call({ tool: 'media_desk_content_lab_action', input, requestId })
  const unknown = await call(); assert.equal(unknown.error.code, 'OUTCOME_UNKNOWN'); const evidence = unknown.error.details.contentLab.records[0]; assert.equal(evidence.id, expected.id); assert.equal(evidence.requestId, expected.requestId); assert.notEqual(evidence.requestId, requestId); assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 2000)
  assert.equal((await f.read({ accountId: 'a', queryRequestId: requestId })).result.total, 0)
  assert.equal((await call()).error.details.contentLab.records[0].id, expected.id); const viaTool = await service.call({ tool: 'media_desk_request_status', input: { requestId } }); assert.equal(viaTool.result.response.error.details.contentLab.records[0].id, expected.id); const status = await journal.status(requestId); assert.equal(status.status, 'unknown'); assert.equal(status.response.error.details.contentLab.records[0].id, expected.id)
  const fresh = new MutationJournal(journal.root), restarted = createAutomationService({ store: new Store(f.root), settings: {}, producer, journal: fresh, now: () => Date.parse('2026-11-15T00:00:00Z'), callText: () => assert.fail('must never replay after restart') })
  assert.equal((await fresh.status(requestId)).response.error.details.contentLab.records[0].id, expected.id)
  const replay = await restarted.call({ tool: 'media_desk_content_lab_action', input, requestId }); assert.equal(replay.error.code, 'OUTCOME_UNKNOWN'); assert.equal(replay.error.details.contentLab.records[0].id, expected.id)
  assert.deepEqual((await f.store.read()).contentLab.records, before); assert.equal(f.calls.length, calls); assert.equal(writes, 3)
})

test('lab receipt evidence accepts compact summaries without integrity and keeps only bounded identifiers', async () => {
  const { boundedLabEvidence } = await import('../src/content-lab/evidence.js')
  const row = { id: 'record', kind: 'prediction', itemId: 'work', accountId: null, requestId: 'original', forecastId: 'forecast', manuscript: 'PRIVATE_RECEIPT_TEXT', model: { raw: 'PRIVATE_PROVIDER' }, baseline: { sources: Array(1000).fill('PRIVATE_ACTUALS') } }
  const evidence = boundedLabEvidence({ records: Array(100).fill(row) }); assert.equal(evidence.records.length, 10); assert.deepEqual(evidence.records[0], { id: 'record', kind: 'prediction', itemId: 'work', accountId: null, forecastId: 'forecast', requestId: 'original' }); assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE/)
  assert.deepEqual(boundedLabEvidence({ record: row }), { records: [evidence.records[0]] }); assert.equal(boundedLabEvidence({ record: { ...row, id: 'x'.repeat(201) } }), null)
})

test('legacy cached forecast receipts and request-status responses omit huge source lists without rewriting journal archives', async t => {
  const { MutationJournal } = await import('../src/automation/journal.js'), { baselineSummary } = await import('../src/content-lab/records.js'); const f = await fixture(t)
  const journal = new MutationJournal(join(f.root, 'large-old-receipt')), input = { accountId: 'a', action: 'forecast', evaluationId: 'legacy-evaluation' }, requestId = 'legacy-large-receipt'
  const baseline = { policy: { id: 'earliest-per-work-within-6h-v1', maxLatenessHours: 6, minimumWorks: 3, exactHorizonMeasurement: false }, usable: true, count: 1001, medianViews: 100, medianViewsExact: { numerator: '100', denominator: '1' }, sources: Array.from({ length: 1001 }, (_, i) => ({ retrospectiveId: `r-${i}`, itemId: `work-${i}`, metricId: `metric-${i}`, views: 100, collectedAt: '2026-11-11T00:00:00Z', elapsedMs: 3 * 86400000, latenessMs: 0 })) }
  await journal.execute(requestId, 'media_desk_content_lab_action', input, async () => ({ ok: true, result: { record: { id: 'old-forecast', kind: 'forecast', itemId: 'work', accountId: 'a', requestId, baseline }, truncated: false } }))
  const archived = await readFile(journal.file, 'utf8'), service = createAutomationService({ store: f.store, producer, settings: {}, journal, callText: () => assert.fail('cached model must never dispatch') })
  const replay = await service.call({ tool: 'media_desk_content_lab_action', input, requestId }); assert.equal(replay.cached, true); assert.equal(replay.result.record.baseline.sources, undefined); assert.ok(Buffer.byteLength(JSON.stringify(replay)) < 4000)
  const status = await service.call({ tool: 'media_desk_request_status', input: { requestId } }); assert.equal(status.result.response.result.record.baseline.sources, undefined); assert.ok(Buffer.byteLength(JSON.stringify(status)) < 5000)
  assert.equal(await readFile(journal.file, 'utf8'), archived)
  const summary = baselineSummary(baseline); assert.deepEqual(baselineSummary(summary), summary, 'summary projection is idempotent')
})
