import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const elements = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flat(Infinity).flatMap(elements)]
const textOf = tree => !tree || typeof tree !== 'object' ? String(tree ?? '') : (tree.children ?? []).flat(Infinity).map(textOf).join(' ')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(fetch) {
  const result = await build({ stdin: { contents: "export * from './client/content-lab.jsx';export * from './client/content-lab-state.js';export * from './client/desk.js';export {InsightsView} from './client/insights.jsx'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'] })
  const slots = new Map(); let slot = 0, current = '', effects = []
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment', useState: value => { const key = `${current}:${slot++}`; if (!slots.has(key)) slots.set(key, typeof value === 'function' ? value() : value); return [slots.get(key), next => slots.set(key, typeof next === 'function' ? next(slots.get(key)) : next)] }, useRef: value => { const key = `${current}:${slot++}`; if (!slots.has(key)) slots.set(key, { current: value }); return slots.get(key) }, useEffect: (fn, deps) => { const key = `${current}:${slot++}`, previous = slots.get(key); if (!previous || deps?.some((value, i) => value !== previous.deps?.[i])) { previous?.cleanup?.(); const row = { deps }; slots.set(key, row); effects.push(() => { row.cleanup = fn() }) } }, useLayoutEffect() {}, useSyncExternalStore: (_, read) => read(), useMemo: fn => fn(), useCallback: fn => fn }
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: () => react, fetch, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, crypto: { randomUUID: () => `request-${Math.random().toString(36).slice(2)}` } })
  const api = module.exports, state = { accounts: [{ id: 'a', platform: '快手' }, { id: 'b', platform: '快手' }], items: [{ id: 'work', accountId: 'a', platform: '快手', title: 'Work', status: 'draft', production: { status: 'done', format: 'script', article: 'saved text' }, contentVersions: [{ id: 'v1', number: 1, name: '初稿', createdAt: '2026-11-12T00:00:00Z', content: { production: { format: 'script', article: 'saved text' } } }] }], metrics: [], skills: [], chat: [], styles: [] }
  api.setDesk({ state }); api.selectAccount('a'); api.openItem('work')
  return { api, state, render(name, component, props = {}, runEffects = true) { current = name; slot = 0; const tree = component(props); if (runEffects) { const pending = effects; effects = []; pending.forEach(fn => fn()) } return tree } }
}
const response = result => ({ ok: true, json: async () => ({ ok: true, result }) })
const evaluation = { id: 'e1', requestId: 'original-eval', itemId: 'work', accountId: 'a', kind: 'evaluation', contentVersionId: 'v1', rubricId: 'general-script-v1', composite: 80, blindness: 'fresh-context-input-only', eligibleAtEvaluation: true, model: { model: 'chosen-model' }, rubric: { dimensions: [{ id: 'opening', name: 'Opening' }] }, dimensions: [{ id: 'opening', score: 4, confidence: .9, reason: 'clear opening', evidence: 'saved text' }] }

test('account studio loads scoped metadata without any model action and renders saved-version evaluation', async () => {
  const calls = []; const h = await fixture(async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body }); if (body.view === 'detail') return response({ record: evaluation, truncated: false, currentEligibility: { lockable: true } }); return response({ items: [evaluation], total: 1, nextOffset: null }) })
  h.render('lab', h.api.ContentLabStudio, { item: h.state.items[0] }); await tick()
  let tree = h.render('lab', h.api.ContentLabStudio, { item: h.state.items[0] });
  assert.match(textOf(tree), /内容评估/); assert.match(textOf(tree), /初稿/); assert.equal(calls.some(c => c.url.endsWith('/action')), false)
  await elements(tree).find(e => e.type === 'button' && /查看评估/.test(textOf(e))).props.onClick(); h.render('lab', h.api.ContentLabStudio, { item: h.state.items[0] }); await tick(); tree = h.render('lab', h.api.ContentLabStudio, { item: h.state.items[0] })
  const detail = elements(tree).find(e => e.type === h.api.ContentLabRecord)
  assert.ok(detail)
  const rendered = textOf(h.render('record', detail.type, detail.props))
  for (const text of ['80', '100', '4', '5', '未校准', '模型自评', 'chosen-model', 'clear opening', 'saved text']) assert.ok(rendered.includes(text), text)
})

test('envelope failures are errors even with HTTP200 and raw provider text is hidden', async () => {
  const h = await fixture(async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'PRIVATE_PROVIDER_DETAIL' } }) }))
  await assert.rejects(h.api.readContentLab({ accountId: 'a' }), error => error.code === 'MODEL_UNAVAILABLE' && !error.message.includes('PRIVATE_PROVIDER_DETAIL'))
})

test('pending registry blocks prepaint double clicks and survives close/reopen and account ABA', async () => {
  const calls = []; const h = await fixture((url, options) => new Promise(resolve => calls.push({ url, body: JSON.parse(options.body), resolve })))
  const intent = { action: 'evaluate', versionId: 'v1', rubricId: 'general-script-v1', format: 'script' }
  const first = h.api.runContentLabAction('work', 'a', intent), second = h.api.runContentLabAction('work', 'a', intent); await tick(); assert.equal(calls.length, 1)
  h.api.closeItem(); h.api.selectAccount('b'); h.api.selectAccount('a'); h.api.openItem('work')
  await h.api.runContentLabAction('work', 'a', intent); assert.equal(calls.length, 1)
  calls[0].resolve(response({ record: evaluation })); await Promise.all([first, second]); assert.equal(h.api.getDesk().state, h.state)
})

test('network uncertainty preserves exact request and requires read-only manual checking', async () => {
  const calls = []; const h = await fixture(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); if (url.endsWith('/action')) throw new Error('lost'); if (url.endsWith('/request-status')) return response({ status: 'unknown' }); return response({ items: [], total: 0 }) })
  const input = { action: 'retro', predictionId: 'p1', metricId: 'm1', notes: 'keep notes' }
  await h.api.runContentLabAction('work', 'a', input); const held = h.api.getContentLabOperation('a', 'work', 'retro'); assert.equal(held.status, 'unknown'); assert.equal(held.input.notes, 'keep notes')
  await h.api.runContentLabAction('work', 'a', input); assert.equal(calls.length, 1)
  await h.api.checkContentLabOperation('a', 'work', 'retro'); assert.equal(calls.filter(c => c.url.endsWith('/action')).length, 1); assert.equal(h.api.getContentLabOperation('a', 'work', 'retro').requestId, held.requestId)
})

test('successful manual recovery clears stale uncertainty notice while retaining exact intent and original record identity', async () => {
  const h = await fixture(async (url, options) => {
    const body = JSON.parse(options.body)
    if (url.endsWith('/action')) throw new Error('lost')
    if (url.endsWith('/request-status')) return response({ status: 'done', response: { ok: true, result: { record: evaluation } } })
    return response({ items: body.queryRequestId ? [evaluation] : [], total: body.queryRequestId ? 1 : 0 })
  })
  const intent = { action: 'evaluate', versionId: 'v1', rubricId: 'general-script-v1', format: 'script' }
  await h.api.runContentLabAction('work', 'a', intent)
  const entry = h.api.getContentLabOperation('a', 'work', 'evaluate'), requestId = entry.requestId, input = entry.input
  assert.equal(entry.status, 'unknown'); assert.match(entry.message, /待核对/)
  entry.evidence = [{ id: 'old-evidence' }]
  await h.api.checkContentLabOperation('a', 'work', 'evaluate')
  assert.equal(entry.status, 'done'); assert.equal(entry.message, undefined); assert.equal(entry.evidence, undefined)
  assert.equal(entry.requestId, requestId); assert.equal(entry.input, input); assert.equal(entry.originalRequestId, evaluation.requestId); assert.equal(entry.result.record.id, evaluation.id)
  const studio = h.render('recovered-studio', h.api.ContentLabStudio, { item: h.state.items[0] }, false)
  const notice = elements(studio).find(e => e.type?.name === 'OperationNotice' && e.props.action === 'evaluate')
  const rendered = h.render('recovered-notice', notice.type, notice.props)
  assert.match(textOf(rendered), /已找到原有记录/); assert.equal(textOf(rendered).includes('结果待核对'), false); assert.equal(elements(rendered).some(e => e.type === 'button' && textOf(e).includes('核对结果')), false)
})

test('creative guard blocks article editing and failed saves before any model dispatch', async () => {
  const calls = []; const h = await fixture(async (url, options) => { calls.push(url); return { ok: false, json: async () => ({ error: 'failed' }) } })
  h.api.setArticleEditing('work', true); await h.api.runContentLabAction('work', 'a', { action: 'evaluate', versionId: 'v1', rubricId: 'general-script-v1', format: 'script' }); assert.equal(calls.length, 0)
  h.api.cancelArticleEditing('work'); await h.api.dispatchOps([{ op: 'update_production', id: 'work', title: 'failed' }], { silent: true }); await h.api.runContentLabAction('work', 'a', { action: 'lock', forecastId: 'f1' }); assert.equal(calls.length, 1)
})

test('forecast display discloses qualitative basis, relative ties and exact approximate median', async () => {
  const h = await fixture(async () => response({ items: [], total: 0 }))
  const base = { kind: 'forecast', bet: 'testable bet', reason: 'basis', horizonDays: 3, baseline: { count: 2, totalEligibleCount: 2 }, probabilities: null }
  let tree = h.render('forecast', h.api.ContentLabRecord, { record: base }); assert.match(textOf(tree), /仅定性/); assert.match(textOf(tree), /testable bet/)
  tree = h.render('quant', h.api.ContentLabRecord, { record: { ...base, baseline: { count: 20, totalEligibleCount: 25, medianViews: 9007199254740990, medianViewsApproximate: true, medianViewsExact: { numerator: '18014398509481981', denominator: '2' } }, probabilities: [.1, .3, .3, .2, .1], topBuckets: [1, 2], predictedBucket: null } });
  for (const text of ['20', '25', '近似', '9007199254740990.5', '并列', '30', '0.3x..<1x · 1x..<3x']) assert.ok(textOf(tree).includes(text), text)
  assert.equal(textOf(tree).includes('18014398509481981 / 2'), false)
  tree = h.render('integer-median', h.api.ContentLabRecord, { record: { ...base, baseline: { medianViews: 100, medianViewsExact: { numerator: '100', denominator: '1' } }, probabilities: [.2,.2,.2,.2,.2] } })
  assert.equal(textOf(tree).includes('100 / 1'), false); assert.equal(textOf(tree).includes('精确值'), false)
})

test('queue is embedded in Insights even before chart data and preserves upcoming distinctions', async () => {
  const h = await fixture(async () => response({ items: [], total: 0 }))
  const tree = h.render('insights', h.api.InsightsView, {}, false); assert.ok(elements(tree).some(e => e.type === h.api.ContentLabQueue))
  assert.equal(h.api.metricReviewEligibility({ id: 'm', itemId: 'work', accountId: 'a', platform: '快手', collectedAt: null }, { itemId: 'work', accountId: 'a', platform: '快手', dueAt: '2026-11-12T00:00:00Z' }).eligible, false)
})

async function loadedStudio(record, extra = {}, stateUpdate) {
  const calls = [], h = await fixture(async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body }); if (url.endsWith('/action')) return extra.actionFailure ? { ok: true, json: async () => ({ ok: false, error: { code: extra.actionFailure } }) } : response({ record: { ...record, id: 'saved-result', requestId: body.requestId } }); if (body.view === 'detail') return response({ record, truncated: false, currentEligibility: { lockable: true }, ...(record.kind === 'prediction' ? { currentRelations: { predictionId: record.id, publication: extra.items?.find(row => row.kind === 'publication' && row.predictionId === record.id) ?? null, retrospectiveCount: 0, latestRetrospectiveId: null } } : {}), ...extra }); return response({ items: [record, ...(extra.items ?? [])], total: 1, nextOffset: null }) })
  stateUpdate?.(h.state)
  const render = () => h.render('loaded', h.api.ContentLabStudio, { item: h.state.items[0] })
  render(); await tick(); let tree = render(); await elements(tree).find(e => e.type === 'button' && e.props['aria-pressed'] !== undefined).props.onClick(); render(); await tick(); tree = render()
  return { h, calls, render, tree }
}

test('full forecast requires explicit preview acknowledgement before lock; truncated or stale details cannot lock', async () => {
  const forecast = { id: 'f1', kind: 'forecast', accountId: 'a', itemId: 'work', contentVersionId: 'v1', evaluationId: 'e1', horizonDays: 3, baseline: { count: 0 }, probabilities: null, bet: 'bet', reason: 'reason' }
  const loaded = await loadedStudio(forecast); let tree = loaded.tree
  let lock = elements(tree).find(e => e.type === 'button' && textOf(e) === '锁定发布前预测'); assert.equal(lock.props.disabled, true)
  assert.equal(loaded.calls.some(c => c.url.endsWith('/action')), false)
  elements(tree).find(e => e.type === 'input' && e.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = loaded.render(); lock = elements(tree).find(e => e.type === 'button' && textOf(e) === '锁定发布前预测'); assert.equal(lock.props.disabled, false); await lock.props.onClick()
  assert.equal(loaded.calls.filter(c => c.url.endsWith('/action')).length, 1); assert.equal(loaded.calls.find(c => c.url.endsWith('/action')).body.action, 'lock')
  const stale = await loadedStudio(forecast, { currentEligibility: { lockable: false } }); assert.equal(elements(stale.tree).find(e => e.type === 'button' && textOf(e) === '锁定发布前预测').props.disabled, true)
  const truncated = await loadedStudio(forecast, { truncated: true }); assert.match(textOf(truncated.tree), /仅返回部分预览/); assert.equal(elements(truncated.tree).some(e => e.type === 'button' && textOf(e) === '锁定发布前预测'), false)
})

test('actual publication has no scheduled default and supports an explicit current instant with URL', async () => {
  const prediction = { id: 'p1', kind: 'prediction', itemId: 'work', accountId: 'a', contentVersionId: 'v1', lockedAt: '2026-11-12T00:00:00.990Z', evaluation, forecast: { horizonDays: 3, baseline: { count: 0 }, probabilities: null, bet: 'bet', reason: 'reason' } }
  const { calls, render, tree: initial } = await loadedStudio(prediction, {}, state => { state.items[0].scheduledAt = '2099-01-01T00:00:00Z' })
  let tree = initial; const time = elements(tree).find(e => e.type === 'input' && e.props.type === 'datetime-local'); assert.equal(time.props.value, ''); assert.equal(time.props.step, '1')
  assert.equal(elements(tree).find(e => e.type === 'button' && textOf(e) === '登记实际发布（本人确认）').props.disabled, true)
  elements(tree).find(e => e.type === 'input' && e.props.type === 'checkbox').props.onChange({ target: { checked: true } }); elements(tree).find(e => e.type === 'input' && e.props.type === 'url').props.onChange({ target: { value: 'https://example.com/work' } }); tree = render()
  await elements(tree).find(e => e.type === 'button' && textOf(e) === '登记实际发布（本人确认）').props.onClick()
  const action = calls.find(c => c.url.endsWith('/action')).body; assert.equal(action.action, 'publish'); assert.equal(action.url, 'https://example.com/work'); assert.ok(action.publishedAt.endsWith('Z')); assert.notEqual(action.publishedAt, '2099-01-01T00:00:00Z')
})

test('retrospective exact observation picker rejects unknown/early times, preserves notes after failure, and displays mismatch', async () => {
  const prediction = { id: 'p1', kind: 'prediction', itemId: 'work', accountId: 'a', platform: '快手', contentVersionId: 'v1', horizonDays: 3, evaluation, forecast: { horizonDays: 3, probabilities: null, baseline: {}, bet: 'bet', reason: 'reason' } }
  const publication = { id: 'pub', kind: 'publication', predictionId: 'p1', dueAt: '2026-01-04T00:00:00Z', publishedAt: '2026-01-01T00:00:00Z', manuscriptMatch: 'mismatch' }
  const loaded = await loadedStudio(prediction, { items: [publication], actionFailure: 'READ_ONLY' }, state => { state.metrics = [{ id: 'unknown', itemId: 'work', accountId: 'a', platform: '快手' }, { id: 'early', itemId: 'work', accountId: 'a', platform: '快手', collectedAt: '2026-01-03T00:00:00Z' }, { id: 'late', itemId: 'work', accountId: 'a', platform: '快手', collectedAt: '2026-01-05T01:00:00Z' }] })
  let tree = loaded.tree; assert.match(textOf(tree), /登记时稿件与锁定版本不同/)
  const options = elements(tree).filter(e => e.type === 'option'); assert.equal(options.find(e => e.props.value === 'unknown').props.disabled, true); assert.equal(options.find(e => e.props.value === 'early').props.disabled, true); assert.equal(options.find(e => e.props.value === 'late').props.disabled, false)
  elements(tree).find(e => e.type === 'select' && e.props['aria-label'] === '选择实际观测记录').props.onChange({ target: { value: 'late' } }); elements(tree).find(e => e.type === 'textarea').props.onChange({ target: { value: 'original notes' } }); tree = loaded.render()
  await elements(tree).find(e => e.type === 'button' && textOf(e) === '保存到期复盘').props.onClick(); const action = loaded.calls.find(c => c.url.endsWith('/action')).body; assert.equal(action.metricId, 'late'); assert.equal(action.notes, 'original notes')
  tree = loaded.render(); assert.equal(elements(tree).find(e => e.type === 'textarea').props.value, 'original notes'); assert.equal(loaded.h.api.getContentLabOperation('a', 'work', 'retro').status, 'failed')
})

test('late model completion after version selection cannot change the selected view or editor state', async () => {
  let release; const h = await fixture(async (url, options) => url.endsWith('/action') ? new Promise(resolve => { release = () => resolve(response({ record: evaluation })) }) : response({ items: [], total: 0 }))
  h.state.items[0].contentVersions.push({ ...h.state.items[0].contentVersions[0], id: 'v2', number: 2 })
  const render = () => h.render('late-version', h.api.ContentLabStudio, { item: h.state.items[0] })
  let tree = render(); const pending = elements(tree).find(e => e.type === 'button' && textOf(e) === '评估所选版本').props.onClick(); await tick()
  elements(tree).find(e => e.type === 'select' && e.props['aria-label'] === '所选保存版本').props.onChange({ target: { value: 'v1' } }); render(); release(); await pending; tree = render()
  assert.equal(elements(tree).some(e => e.type === h.api.ContentLabRecord), false); assert.equal(h.api.getDesk().state, h.state)
})

test('retrospective readonly results show actual buckets, ties, late age and unknown counters without inventing a hit', async () => {
  const h = await fixture(async () => response({ items: [], total: 0 }))
  const tree = h.render('retro-detail', h.api.ContentLabRecord, { record: { kind: 'retrospective', actuals: { views: null, collectedAt: '2026-01-05T00:00:00Z' }, elapsedMs: 4 * 86400000, latenessMs: 86400000, timing: 'late', comparisonStatus: 'tied-top-probability', observedBucket: 0, assignedProbability: .2, bucketHit: null, narrative: { summary: 'Summary', learning: 'Learning' }, notes: 'Original' } })
  for (const text of ['96.00', '24.00', '不是精确', '未知', '<0.3x', '并列', '不适用', 'Original', '只读']) assert.ok(textOf(tree).includes(text), text)
  assert.equal(elements(tree).some(e => ['input', 'textarea', 'button'].includes(e.type)), false)
})

test('publication acknowledgement mirrors only status/time without replacing newer creative editor values', async () => {
  let release; const publication = { id: 'pub', kind: 'publication', itemId: 'work', accountId: 'a', publishedAt: '2026-01-01T00:00:00Z' }
  const h = await fixture(async (url, options) => new Promise(resolve => { const body = JSON.parse(options.body); release = () => resolve(response({ record: { ...publication, requestId: body.requestId }, state: { marker: 'must-not-apply' } })) }))
  const pending = h.api.runContentLabAction('work', 'a', { action: 'publish', predictionId: 'p1', publishedAt: publication.publishedAt }); await tick(); release(); await pending
  assert.equal(h.api.getDesk().state.items[0].status, 'published'); assert.equal(h.api.getDesk().state.items[0].publishedAt, publication.publishedAt); assert.equal(h.api.getDesk().state.marker, undefined); assert.equal(h.api.getDesk().state.items[0].production.article, 'saved text')
})

test('queue errors belong to their account scope and never appear under a newly chosen account', async () => {
  const h = await fixture(async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'UNAVAILABLE' } }) }))
  h.render('queue-error', h.api.ContentLabQueue); await tick(); let tree = h.render('queue-error', h.api.ContentLabQueue); assert.ok(elements(tree).some(e => e.props.role === 'alert'))
  h.api.selectAccount('b'); tree = h.render('queue-error', h.api.ContentLabQueue); assert.equal(elements(tree).some(e => e.props.role === 'alert'), false)
})

test('queue detail selection is scoped and is not re-read under a different account', async () => {
  const calls = []; const h = await fixture(async (url, options) => { const body = JSON.parse(options.body); calls.push(body); return response(body.view === 'detail' ? { record: evaluation, truncated: false } : { items: [{ id: 'p1', itemId: 'work', accountId: 'a', status: 'upcoming' }], total: 1 }) })
  const render = () => h.render('queue-selected', h.api.ContentLabQueue)
  render(); await tick(); let tree = render(); assert.match(textOf(tree), /尚未到期/)
  elements(tree).find(e => e.type === 'button' && textOf(e) === '查看记录').props.onClick(); render(); await tick(); h.api.selectAccount('b'); render(); await tick()
  assert.equal(calls.some(c => c.view === 'detail' && c.accountId === 'b'), false)
})

test('lab waits for pending blur saves and abandons a retired editor before model dispatch', async () => {
  const calls = []; let resolveSave; const h = await fixture((url, options) => { calls.push(url); if (url.endsWith('/ops')) return new Promise(resolve => { resolveSave = resolve }); return Promise.resolve(response({ record: evaluation })) })
  const save = h.api.dispatchOps([{ op: 'update_production', id: 'work', title: 'pending title' }], { silent: true })
  const review = h.api.runContentLabAction('work', 'a', { action: 'evaluate', versionId: 'v1', rubricId: 'general-script-v1', format: 'script' }); await tick(); assert.equal(calls.length, 1)
  h.api.closeItem(); h.api.openItem('work'); resolveSave({ ok: true, json: async () => ({ state: h.state, receipts: [{}], errors: [] }) }); await Promise.all([save, review]); assert.equal(calls.length, 1)
})

test('version ABA during evaluation cannot auto-open the earlier operation result', async () => {
  let release; const h = await fixture(async (url, options) => { const body = JSON.parse(options.body); if (url.endsWith('/action')) return new Promise(resolve => { release = () => resolve(response({ record: evaluation })) }); return response(body.view === 'detail' ? { record: evaluation, truncated: false } : { items: [], total: 0 }) })
  h.state.items[0].contentVersions.push({ ...h.state.items[0].contentVersions[0], id: 'v2', number: 2 })
  const render = () => h.render('version-aba', h.api.ContentLabStudio, { item: h.state.items[0] })
  let tree = render(); const pending = elements(tree).find(e => e.type === 'button' && textOf(e) === '评估所选版本').props.onClick(); await tick()
  const change = value => elements(tree).find(e => e.type === 'select' && e.props['aria-label'] === '所选保存版本').props.onChange({ target: { value } })
  change('v1'); change('v2'); render(); release(); await pending; render(); await tick(); tree = render()
  assert.equal(elements(tree).some(e => e.type === h.api.ContentLabRecord), false); assert.equal(h.api.getContentLabOperation('a', 'work', 'evaluate').result.record.id, 'e1')
})

test('manual recovery cannot steal a later chosen history record, including selection ABA', async () => {
  let resolveStatus; const e2 = { ...evaluation, id: 'e2' }
  const h = await fixture(async (url, options) => { const body = JSON.parse(options.body); if (url.endsWith('/action')) throw new Error('lost'); if (url.endsWith('/request-status')) return new Promise(resolve => { resolveStatus = () => resolve(response({ status: 'done', response: { ok: true, result: { record: evaluation } } })) }); return response(body.view === 'detail' ? { record: body.recordId === 'e2' ? e2 : evaluation, truncated: false } : { items: [evaluation, e2], total: 2 }) })
  await h.api.runContentLabAction('work', 'a', { action: 'evaluate', versionId: 'v1', rubricId: 'general-script-v1', format: 'script' })
  const render = () => h.render('recover-selection', h.api.ContentLabStudio, { item: h.state.items[0] })
  render(); await tick(); let tree = render()
  elements(tree).find(e => e.type === 'button' && e.props.key === 'e2').props.onClick(); render(); await tick(); tree = render()
  const notice = elements(tree).find(e => e.type?.name === 'OperationNotice' && e.props.action === 'evaluate')
  const noticeTree = h.render('recover-notice', notice.type, notice.props)
  const checking = elements(noticeTree).find(e => e.type === 'button' && textOf(e).includes('核对结果')).props.onClick(); await tick()
  elements(tree).find(e => e.type === 'button' && e.props.key === 'e1').props.onClick(); elements(tree).find(e => e.type === 'button' && e.props.key === 'e2').props.onClick(); render(); await tick(); resolveStatus(); await checking; render(); await tick(); tree = render()
  assert.equal(elements(tree).find(e => e.type === h.api.ContentLabRecord)?.props.record.id, 'e2'); assert.equal(h.api.getContentLabOperation('a', 'work', 'evaluate').result.record.id, 'e1')
})

test('prediction relations beyond history pagination determine publication and completed stages', async () => {
  const prediction = { id: 'p1', kind: 'prediction', itemId: 'work', accountId: 'a', platform: '快手', evaluation, forecast: { probabilities: null, baseline: {} } }
  const publication = { id: 'pub', kind: 'publication', predictionId: 'p1', publishedAt: '2026-01-01T00:00:00Z', dueAt: '2026-01-04T00:00:00Z' }
  const loaded = await loadedStudio(prediction, { currentRelations: { predictionId: 'p1', publication, retrospectiveCount: 1, latestRetrospectiveId: 'r-hidden' }, nextOffset: 100 })
  assert.equal(elements(loaded.tree).some(e => e.type === 'input' && e.props.type === 'datetime-local'), false); assert.match(textOf(loaded.tree), /已有复盘/); assert.equal(elements(loaded.tree).some(e => e.type === 'textarea'), false)
  await elements(loaded.tree).find(e => e.type === 'button' && textOf(e) === '查看已保存复盘').props.onClick(); loaded.render(); await tick(); assert.ok(loaded.calls.some(c => c.body.view === 'detail' && c.body.recordId === 'r-hidden'))
})

test('unconfirmed prediction relations withhold phase actions and offer an explicit reload', async () => {
  const loaded = await loadedStudio({ id: 'p1', kind: 'prediction', accountId: 'a', itemId: 'work', evaluation, forecast: { probabilities: null, baseline: {} } }, { currentRelations: null })
  assert.equal(elements(loaded.tree).some(e => e.type === 'input' && e.props.type === 'datetime-local'), false); assert.ok(elements(loaded.tree).find(e => e.type === 'button' && textOf(e) === '重新读取'))
})

test('metric picker resolves only unambiguous external identity and exact unique IDs, and preserves unknown legacy zero', async () => {
  const prediction = { id: 'p1', kind: 'prediction', itemId: 'work', accountId: 'a', platform: '快手', evaluation, forecast: { probabilities: null, baseline: {} } }
  const publication = { id: 'pub', kind: 'publication', predictionId: 'p1', publishedAt: '2026-01-01T00:00:00Z', dueAt: '2026-01-04T00:00:00Z' }
  const loaded = await loadedStudio(prediction, { items: [publication], currentRelations: { predictionId: 'p1', publication, retrospectiveCount: 0 } }, state => {
    state.items[0].externalId = 'external-work'
    const base = { accountId: 'a', platform: '快手', collectedAt: '2026-01-05T00:00:00Z', externalId: 'external-work' }
    state.metrics = [{ ...base, id: 'external', views: 0 }, { ...base, id: 'measured', views: 0, source: 'manual' }, { ...base, id: 'invalid', views: -1 }, { ...base, id: 'wrong-platform', platform: '抖音', views: 10 }, { ...base, id: 'duplicate', views: 1 }, { ...base, id: 'duplicate', views: 2 }]
  })
  let options = elements(loaded.tree).filter(e => e.type === 'option'); assert.ok(options.find(e => e.props.value === 'external')); assert.match(textOf(options.find(e => e.props.value === 'external')), /播放.*未知/); assert.match(textOf(options.find(e => e.props.value === 'measured')), /播放.*0/); assert.match(textOf(options.find(e => e.props.value === 'invalid')), /播放.*未知/); assert.equal(options.some(e => e.props.value === 'wrong-platform'), false); assert.equal(options.filter(e => e.props.value === 'duplicate').some(e => !e.props.disabled), false)
  loaded.h.state.items.push({ id: 'ambiguous', accountId: 'a', platform: '快手', externalId: 'external-work' }); loaded.h.api.setDesk({ state: { ...loaded.h.state } }); options = elements(loaded.render()).filter(e => e.type === 'option'); assert.equal(options.some(e => e.props.value === 'external'), false)
})
