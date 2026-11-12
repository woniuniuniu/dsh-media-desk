import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

async function client(entry, fetch = async () => { throw Error('Unexpected request') }, hooks = {}) {
  const source = typeof entry === 'string' ? { entryPoints: [entry] } : { stdin: { contents: entry.contents, resolveDir: process.cwd(), sourcefile: 'client-test.js' } }
  const result = await build({ ...source, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'], loader: { '.css': 'text' } })
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment', useState: initial => [initial, () => {}], useRef: () => ({ current: null }),
    useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (subscribe, read) => read(),
    useMemo: fn => fn(), useCallback: fn => fn, ...hooks,
  }
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: name => { assert.equal(name, 'react'); return react }, fetch, URLSearchParams, setTimeout: () => 0, clearTimeout: () => {} })
  return module.exports
}
const elements = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(elements)]
const textOf = tree => !tree || typeof tree !== 'object' ? String(tree ?? '') : tree.children.flat(Infinity).map(textOf).join(' ')

test('rendered navigation is account list → content → selected profile → account list', async () => {
  const api = await client({ contents: "export * from './client/index.jsx'; export * from './client/desk.js'" })
  let Desk
  api.apply({ slots: { inject: (name, fn) => fn(), register: (options, component) => { Desk = component } }, effect: () => {} })
  api.setDesk({ state: { accounts: [{ id: 'a', platform: '快手', handle: 'A profile', positioning: 'Only A' }, { id: 'b', platform: '抖音', handle: 'SECRET B' }], items: [{ id: 'legacy', accountId: null }, { id: 'mine', accountId: 'a' }], metrics: [], skills: [], chat: [], styles: [] } })
  let tree = Desk()
  assert.equal(elements(tree).some(node => node.type === 'nav'), false)
  assert.equal(elements(tree).some(node => node.type?.name === 'ChatDock'), false)
  const hub = elements(tree).find(node => node.type?.name === 'RootAccountsView').type()
  for (const label of ['全部账号', '未归属']) assert.ok(textOf(hub).includes(label))
  const account = elements(hub).find(node => node.type === 'button' && textOf(node) === 'A profile')
  account.props.onClick({ stopPropagation() {} })
  assert.equal(api.getDesk().view, 'content')
  tree = Desk()
  const nav = elements(tree).find(node => node.type === 'nav')
  assert.equal(elements(nav).filter(node => node.type === 'button').length, 6)
  assert.ok(textOf(tree).includes('A profile'))
  elements(nav).find(node => node.type === 'button' && textOf(node) === '账号').props.onClick()
  const profile = elements(Desk()).find(node => node.type?.name === 'AccountProfileView').type()
  assert.match(textOf(profile), /A profile/)
  assert.match(textOf(profile), /Only A/)
  assert.doesNotMatch(textOf(profile), /SECRET B/)
  elements(Desk()).find(node => node.type === 'button' && textOf(node) === '账号列表').props.onClick()
  assert.equal(api.getDesk().workspaceEntered, false)
  assert.equal(elements(Desk()).some(node => node.type === 'nav'), false)
})

test('insights filter stays visible without metrics and ignores a late response from a previous filter', async () => {
  const slots = [], effects = [], requests = []
  let slot = 0, effect = 0
  const api = await client({ contents: "export * from './client/insights.jsx'; export * from './client/desk.js'" }, url => new Promise(resolve => requests.push({ url, resolve })), {
    useState: initial => { const at = slot++; if (!(at in slots)) slots[at] = initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
    useEffect: (fn, deps) => { const at = effect++; const old = effects[at]; if (!old || deps.some((dep, i) => dep !== old.deps[i])) { old?.cleanup?.(); effects[at] = { deps, pending: fn } } },
  })
  api.setDesk({ state: { accounts: [], items: [], metrics: [], skills: [], chat: [] } })
  api.selectAccount(undefined)
  const render = () => { slot = 0; effect = 0; return api.InsightsView() }
  const flush = () => { for (const row of effects) if (row.pending) { row.cleanup = row.pending(); delete row.pending } }
  let tree = render(); flush()
  const filter = elements(tree).find(node => node.type === 'select')
  assert.ok(elements(filter).some(node => node.type === 'option' && node.props.value === '快手'))
  filter.props.onChange({ target: { value: '快手' } })
  tree = render(); flush()
  assert.match(textOf(tree), /快手支持手动录入、CSV 和 API/)
  requests[0].resolve({ ok: true, json: async () => ({ views: 999, daily: [] }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotMatch(textOf(render()), /999/)
  requests[1].resolve({ ok: true, json: async () => ({ views: 0, daily: [], platforms: [], top: [], engagementRate: 0 }) })
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.ok(elements(tree).some(node => node.type === 'select'))
  assert.match(textOf(tree), /录入数据/)
  assert.doesNotMatch(textOf(tree), /导入账号数据/)
})

test('actual client starts in the account hub and stale All-scope assistant navigation cannot reopen it', async () => {
  let resolveChat
  const desk = await client('client/desk.js', async () => new Promise(resolve => { resolveChat = resolve }))
  assert.equal(desk.getDesk().workspaceEntered, false)
  assert.equal(desk.getDesk().view, 'accounts')
  const state = { accounts: [{ id: 'a' }], items: [], metrics: [], skills: [], chat: [] }
  desk.setDesk({ state })
  desk.selectAccount(undefined)
  const pending = desk.sendChat('show insights')
  desk.leaveAccounts()
  resolveChat({ ok: true, json: async () => ({ state, actions: [{ type: 'nav', view: 'insights' }] }) })
  await pending
  assert.equal(desk.getDesk().workspaceEntered, false)
  assert.equal(desk.getDesk().view, 'accounts')
})

test('assistant response from a previous entry cannot navigate a newly reentered workspace', async () => {
  let resolveChat
  const desk = await client('client/desk.js', async () => new Promise(resolve => { resolveChat = resolve }))
  const state = { accounts: [{ id: 'a' }], items: [], metrics: [], skills: [], chat: [] }
  desk.setDesk({ state })
  desk.selectAccount('a')
  const pending = desk.sendChat('show insights')
  desk.leaveAccounts()
  desk.selectAccount('a')
  resolveChat({ ok: true, json: async () => ({ state, actions: [{ type: 'nav', view: 'insights' }] }) })
  await pending
  assert.equal(desk.getDesk().view, 'content')
  assert.equal(desk.getDesk().workspaceEntered, true)
  desk.setDesk({ state: { ...state, accounts: [] } })
  assert.equal(desk.getDesk().view, 'accounts')
  assert.equal(desk.getDesk().workspaceEntered, false)
})

test('insights request carries explicit account and Kuaishou platform; CSV accepts Kuaishou and Kwai', async () => {
  let path
  const desk = await client('client/desk.js', async url => { path = url; return { ok: true, json: async () => ({ views: 0 }) } })
  await desk.fetchInsights('快手', null)
  const url = new URL(path, 'http://localhost/')
  assert.equal(url.searchParams.get('accountId'), 'null')
  assert.equal(url.searchParams.get('platform'), '快手')
  const { parseCsv } = await client('client/insights.jsx')
  for (const alias of ['Kuaishou', 'Kwai', '快手']) {
    const result = parseCsv(`2026-11-12,${alias},100,5,2,1,3`)
    assert.equal(result.errors.length, 0)
    assert.equal(result.ops[0].platform, '快手')
    assert.equal(result.ops[0].views, 100)
  }
})

test('metrics CSV preserves blanks, rejects invalid counters and accepts explicit work and collection columns', async () => {
  const { parseCsv } = await client('client/insights.jsx')
  const parsed = parseCsv('date,platform,views,likes,comments,shares,saves,itemId,collectedAt\n2026-01-01,Douyin,0,,,,,a,2026-01-01T08:00:00Z')
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.ops[0].views, 0)
  assert.equal(parsed.ops[0].likes, undefined)
  assert.equal(parsed.ops[0].itemId, 'a')
  assert.equal(parsed.ops[0].collectedAt, '2026-01-01T08:00:00Z')
  assert.equal(parsed.ops[0].source, undefined)
  for (const value of ['-1', '1.5', 'oops', '9007199254740992']) assert.equal(parseCsv(`2026-01-01,Douyin,${value}`).errors.length, 1)
  assert.equal(parseCsv('2026-01-01,Douyin,1,,,,,a,2026-01-01T08:00:00').errors.length, 1)
  assert.equal(parseCsv('2026-01-01,Douyin,1').ops[0].collectedAt, undefined)
})

test('rendered insights show nullable totals, factual coverage and provenance even without a daily timeline', async () => {
  const data = { published: 2, views: 1063, engaged: null, engagementRate: null, daily: [], platforms: [], top: [], coverage: { published: 2, withData: 1, withViews: 1, complete: 0, rawRecords: 2, uniqueWorks: 1, missingWorksCount: 1, unknownTimeRecords: 2, unknownTimeWorks: 1, unknownSourceRecords: 2, legacyZeroRecords: 2, latestCollectedAt: null, latestCollectedAtScope: 'known subset', fieldCounts: { views: 1, likes: 0, comments: 0, shares: 0, saves: 0 }, excludedRecords: 0, missingWorks: [{ id: 'missing', title: 'Missing piece', platform: '抖音', reason: 'no linked snapshot', missingFields: ['views', 'likes'], source: null, latestCollectedAt: null }] }, timeline: { reasons: { 'unknown-timestamp': 2 }, explanation: 'Only adjacent reliable collection instants.' } }
  data.top = [{ id: 'legacy', title: 'Legacy piece', platform: '抖音', views: 1063, likes: null, comments: null, shares: null, saves: null, warnings: ['legacy-import-time-only'], provenance: { views: { collectedAt: null, ordering: 'legacy-import-time' } } }]
  const requests = []
  const slots = [], effects = []; let slot = 0
  const api = await client({ contents: "export * from './client/insights.jsx'; export * from './client/desk.js'; export * from './client/i18n.js'" }, async (url, options) => { requests.push({ url, body: options?.body ? JSON.parse(options.body) : null }); return { ok: true, json: async () => options?.body ? { state: api.getDesk().state, receipts: [] } : data } }, {
    useState: initial => { const at = slot++; if (!(at in slots)) slots[at] = initial; return [slots[at], v => { slots[at] = v }] },
    useEffect: fn => { effects.push(fn) },
  })
  api.setDesk({ state: { accounts: [], items: [], metrics: [], skills: [], chat: [] } }); api.selectAccount(undefined)
  const render = () => { slot = 0; return api.InsightsView() }
  render(); for (const fn of effects.splice(0)) fn()
  await new Promise(resolve => setImmediate(resolve))
  const tree = render()
  const expand = node => !node || typeof node !== 'object' ? node : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, children: node.children.flat(Infinity).map(expand) }
  const text = textOf(expand(tree))
  assert.match(text, /1,063|1063/)
  assert.match(text, /1\s+\/\s+2/)
  assert.match(text, /Missing piece/)
  assert.match(text, /有数据的作品 \/ 已发布作品/)
  assert.match(text, /没有关联的数据记录/)
  assert.match(text, /未知/)
  assert.match(text, /采集时间/)
  assert.match(text, /导入完成时间/)
  assert.match(text, /五项数值（历史零值待核实）/)
  assert.doesNotMatch(text, /unknown-timestamp|no linked snapshot|Legacy zero/)
  api.setLanguagePreference('en')
  const english = textOf(expand(render()))
  assert.match(english, /Unknown/)
  assert.match(english, /no linked snapshot/)
  assert.match(english, /Legacy zero/)
  assert.match(english, /five numeric fields in the latest snapshot \(legacy zeros need verification\)/)
  assert.doesNotMatch(english, /five known counters/)
  assert.doesNotMatch(english, /[一-鿿]/)
  api.setLanguagePreference('zh')
  elements(tree).find(node => node.type === 'button' && textOf(node).trim() === '录入数据').props.onClick()
  const dialog = api.getDesk().dialog
  assert.ok(dialog.fields.some(field => field.name === 'collectedAt' && !field.required))
  dialog.onSubmit({ platform: '抖音', date: '2026-01-01', views: '0', likes: '' })
  await new Promise(resolve => setImmediate(resolve))
  const saved = requests.find(row => row.body?.ops)?.body.ops[0]
  assert.equal(saved.source, 'manual')
  assert.equal(saved.views, 0)
  assert.equal(saved.likes, undefined)
  assert.equal(saved.collectedAt, undefined)
})

test('rendered growth chart breaks paths at null values and unobserved calendar gaps', async () => {
  const data = { published: 0, views: 1, engaged: null, engagementRate: null, platforms: [], top: [], daily: [{ date: '2026-01-01', views: 0 }, { date: '2026-01-02', views: null }, { date: '2026-01-03', views: 2 }, { date: '2026-01-06', views: 3 }, { date: '2026-01-07', views: 4 }] }
  const slots = [], effects = []; let slot = 0
  const api = await client({ contents: "export * from './client/insights.jsx'; export * from './client/desk.js'" }, async () => ({ ok: true, json: async () => data }), {
    useState: initial => { const at = slot++; if (!(at in slots)) slots[at] = initial; return [slots[at], v => { slots[at] = v }] }, useEffect: fn => effects.push(fn),
  })
  api.setDesk({ state: { accounts: [], items: [], metrics: [], skills: [], chat: [] } }); api.selectAccount(undefined)
  api.InsightsView(); for (const fn of effects.splice(0)) fn(); await new Promise(resolve => setImmediate(resolve))
  slot = 0
  const tree = api.InsightsView(), chart = elements(tree).find(node => node.type?.name === 'TrendChart')
  const rendered = chart.type(chart.props), path = elements(rendered).find(node => node.type === 'path' && node.props.className === 'md-chart-line')
  assert.equal((path.props.d.match(/M /g) ?? []).length, 3)
  assert.equal((path.props.d.match(/L /g) ?? []).length, 1)
  assert.doesNotMatch(path.props.d, /NaN/)
  assert.match(elements(rendered).find(node => node.type === 'svg').props['aria-label'], /部分/)
})

test('studio opened from All reads the item account format and changes only that account', async () => {
  const requests = []
  const state = { accounts: [{ id: 'a', draftFormat: 'article' }, { id: 'b', draftFormat: 'script' }], draftFormat: 'script', items: [{ id: 'mine', title: 'A idea', accountId: 'a' }], metrics: [], skills: [], chat: [], styles: [] }
  const api = await client({ contents: "export * from './client/studio.jsx'; export * from './client/desk.js'" }, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ state, receipts: [] }) }
  })
  api.setDesk({ state })
  api.selectAccount(undefined)
  api.openItem('mine')
  const top = elements(api.Studio()).find(node => node.type?.name === 'ChatPanel').props.top
  const card = top.type(top.props)
  const radios = elements(card).filter(node => node.props.role === 'radio')
  assert.equal(radios.find(node => textOf(node) === '文章').props['aria-checked'], true)
  radios.find(node => textOf(node) === '脚本').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests[0].body.accountId, 'a')
  assert.deepEqual(requests[0].body.ops[0], { op: 'set_format', format: 'script', accountId: 'a' })
  await api.runProduce('mine', { withImages: false })
  assert.equal(requests[1].body.accountId, 'a')
  assert.equal(requests[1].body.withImages, false)
})

test('client accepts explicit legacy Unassigned production origin together with image options', async () => {
  let payload
  const state = { accounts: [{ id: 'a' }], items: [{ id: 'legacy', accountId: null }], metrics: [], skills: [], chat: [] }
  const api = await client('client/desk.js', async (url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ state }) } })
  api.setDesk({ state })
  await api.runProduce('legacy', null)
  assert.equal(payload.accountId, null)
})
