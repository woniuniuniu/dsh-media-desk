import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { articleWorkspace } from '../src/workflow.js'
import { EN } from '../client/en/index.js'

const entry = name => fileURLToPath(new URL(`../client/${name}`, import.meta.url))
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const baseItem = () => ({ id: 'article-a', title: '测试文章', body: '可核对的资料原文', creationFormat: 'article', createdAt: '2026-11-16T00:00:00Z' })

const uiBundles = await Promise.all(['article-workflow.jsx', 'studio.jsx'].map(file => build({
  entryPoints: [entry(file)], bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'article-host', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'article-host' }))
    builder.onResolve({ filter: /^\.\/desk\.js$/ }, () => ({ path: 'desk', namespace: 'article-host' }))
    builder.onResolve({ filter: /^\.\/chat\.jsx$/ }, () => ({ path: 'chat', namespace: 'article-host' }))
    builder.onResolve({ filter: /^\.\/ui\.jsx$/ }, () => ({ path: 'ui', namespace: 'article-host' }))
    builder.onLoad({ filter: /.*/, namespace: 'article-host' }, ({ path }) => ({ contents: path === 'react' ? 'export default globalThis.fixture.React'
      : path === 'ui' ? 'export function Icon(){}; export function IconButton(){}'
        : path === 'chat' ? 'export function ChatPanel(){}'
          : `const f=globalThis.fixture; export const useDesk=s=>s(f.snapshot); export const articleAction=(...args)=>f.articleAction(...args); export const fetchArticleWorkflow=(...args)=>f.fetchStatus(...args); export const loadDesk=()=>f.loadDesk(); export const dispatchOps=(...args)=>f.dispatchOps(...args); export const toast=(...args)=>f.notices.push(args); export const setDesk=p=>f.setDesk(p); export const saveProduced=(...args)=>f.exports.push(args); export const watchProduction=(...args)=>{f.watches.push(args);return()=>{}}; export function cancelProduce(){};export function closeItem(){};export function regenAsset(){};export function revealSaved(){};export function runProduce(){}`, loader: 'js' }))
  } }],
})))

function uiFixture({ item = baseItem(), component = 'ArticleWorkflow', props = {}, statusResult } = {}) {
  const fixture = {
    snapshot: { state: { items: [item], chat: [], draftFormat: 'script', styles: [] }, focusId: item.id, settings: { imageReady: false }, live: {}, articleBusy: {} },
    actions: [], ops: [], notices: [], copies: [], exports: [], watches: [], statusReads: 0, loads: 0, statusResult,
  }
  const slots = [], dependencies = new Map(), cleanups = new Map(), timers = new Map()
  let hook = 0, pending = [], dirty = true, tree, timerId = 0
  const effect = (callback, deps) => {
    const index = hook++, before = dependencies.get(index)
    if (!deps || !before || deps.some((value, i) => !Object.is(value, before[i]))) {
      dependencies.set(index, deps)
      pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, callback()) })
    }
  }
  fixture.React = {
    useState(initial) { const index = hook++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true } }] },
    useRef(initial) { const index = hook++; return slots[index] ||= { current: initial } },
    useMemo: callback => callback(), useCallback: callback => callback(), useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore: (_, getter) => getter(),
    createElement(type, props, ...children) { const node = { type, props: props || {}, children: children.flat(Infinity) }; return typeof type === 'function' && ['Field', 'ImageList', 'VersionHistory'].includes(type.name) ? type(node.props) : node },
  }
  fixture.setDesk = patch => { fixture.snapshot = { ...fixture.snapshot, ...(typeof patch === 'function' ? patch(fixture.snapshot) : patch) }; dirty = true }
  fixture.actionResult = async () => {
    const row = fixture.snapshot.state.items[0]
    const workflow = { ...articleWorkspace(row), revision: articleWorkspace(row).revision + 1 }
    return { state: { ...fixture.snapshot.state, items: [{ ...row, articleWorkflow: workflow }] }, workflow }
  }
  fixture.articleAction = async (...args) => {
    fixture.actions.push(plain(args))
    const result = await fixture.actionResult(...args)
    if (result?.state) fixture.setDesk({ state: result.state })
    return result
  }
  fixture.dispatchOps = async (...args) => { fixture.ops.push(plain(args)); return { state: fixture.snapshot.state } }
  fixture.fetchStatus = async () => { fixture.statusReads++; return fixture.statusResult?.() || { busy: false, workflow: articleWorkspace(fixture.snapshot.state.items[0]) } }
  fixture.loadDesk = async () => { fixture.loads++ }
  const window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) }
  const sandbox = {
    fixture, module: { exports: {} }, structuredClone, window,
    document: { documentElement: { lang: 'zh' }, querySelector: () => null }, navigator: { language: 'zh', clipboard: { writeText: async value => fixture.copies.push(value) } },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
  }
  vm.runInNewContext(uiBundles[component === 'ArticleWorkflow' ? 0 : 1].outputFiles[0].text, sandbox)
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.children || []).map(text).join('')
  const callbacks = { onDirty: value => { fixture.isDirty = value }, onBusy: value => { fixture.isBusy = value } }
  fixture.nodes = predicate => walk(tree).filter(predicate)
  fixture.button = label => fixture.nodes(node => node.type === 'button' && text(node) === label)[0]
  fixture.field = label => {
    const wrapper = fixture.nodes(node => node.type === 'label' && node.children.some(child => child?.type === 'span' && text(child) === label))[0]
    return wrapper?.children.find(child => ['input', 'textarea', 'select'].includes(child?.type))
  }
  fixture.text = () => text(tree)
  fixture.render = () => {
    dirty = true
    let rounds = 0
    while (dirty || pending.length) {
      if (++rounds > 35) throw new Error('Article UI did not settle')
      dirty = false; hook = 0
      const current = fixture.snapshot.state.items.find(row => row.id === fixture.snapshot.focusId) || fixture.snapshot.state.items[0]
      tree = sandbox.module.exports[component]({ item: current, ...callbacks, ...props })
      for (const run of pending.splice(0)) run()
    }
    return tree
  }
  fixture.settle = async () => { await new Promise(resolve => setImmediate(resolve)); fixture.render() }
  fixture.click = label => { const button = fixture.button(label); assert.ok(button, label); assert.equal(Boolean(button.props.disabled), false, `${label} disabled`); button.props.onClick(); fixture.render() }
  fixture.change = (label, value) => { const field = fixture.field(label); assert.ok(field, label); field.props.onChange({ target: { value } }); fixture.render() }
  fixture.tick = () => { for (const [id, callback] of timers) { timers.delete(id); callback() } }
  fixture.render()
  return fixture
}

test('文章界面：新文章从来源开始，不能直接进入提纲、全文或生图', async () => {
  const ui = uiFixture()
  await ui.settle()
  assert.equal(ui.button('2明确观点').props.disabled, true)
  assert.equal(ui.button('3确认提纲').props.disabled, true)
  assert.equal(ui.button('4写作修改').props.disabled, true)
  assert.equal(ui.button('5配图').props.disabled, true)
  assert.equal(ui.field('原文或经验记录').props.value, '可核对的资料原文')
  assert.equal(ui.nodes(node => node.type === 'input' && node.props.type === 'checkbox')[0].props.checked, false)
  assert.doesNotMatch(ui.text(), /视频封面|分镜|角色/)
})

test('文章界面：确认资料先保存再确认，并使用每次回执的新 revision', async () => {
  const ui = uiFixture()
  ui.change('原文或经验记录', '我核对过的原文')
  ui.click('确认资料，进入观点')
  await ui.settle()
  assert.deepEqual(ui.actions.map(row => [row[1], row[3]]), [['save_sources', 0], ['confirm_sources', 1]])
  assert.equal(ui.actions[0][2].sources[0].text, '我核对过的原文')
  assert.equal(ui.actions[0][2].sources[0].verified, false)
})

test('文章界面：保存失败保留输入、确认不继续，忙时禁止重复提交', async () => {
  const ui = uiFixture()
  const response = deferred()
  ui.actionResult = () => response.promise
  ui.change('原文或经验记录', '不能丢的修改')
  const save = ui.button('保存资料').props.onClick
  save(); save(); ui.render()
  assert.equal(ui.actions.length, 1)
  assert.equal(ui.button('保存资料').props.disabled, true)
  response.resolve(false)
  await ui.settle()
  assert.equal(ui.field('原文或经验记录').props.value, '不能丢的修改')
  assert.match(ui.text(), /输入已保留/)
  assert.equal(ui.button('保存资料').props.disabled, false)
})

test('文章界面：背景刷新不能覆盖正在编辑的旧文章，新全文仍受确认关卡限制', async () => {
  const item = { ...baseItem(), production: { format: 'article', title: '旧标题', article: '旧正文', status: 'done', cover: { src: 'media-desk/files/cover.png' }, shots: [{ visual: '旧分镜不在文章页面显示' }] } }
  const original = plain(item)
  const ui = uiFixture({ item })
  await ui.settle()
  assert.equal(ui.field('文章正文').props.value, '旧正文')
  assert.match(ui.text(), /旧文章已保留/)
  assert.equal(ui.button('按确认提纲重新写作').props.disabled, true)
  assert.equal(ui.button('保存正文').props.disabled, false)
  ui.change('文章正文', '我正在修改的正文')
  ui.snapshot.state = { ...ui.snapshot.state, items: [{ ...item, production: { ...item.production, article: '后台旧正文' } }] }
  ui.render()
  assert.equal(ui.field('文章正文').props.value, '我正在修改的正文')
  assert.doesNotMatch(ui.text(), /旧分镜不在文章页面显示|视频封面|角色/)
  assert.deepEqual(item, original, '纯读旧稿不补确认或修改原数据')
})

test('文章界面：drafts-only 旧文章可直接读取编辑，不误用另一流程的 active 正文', async () => {
  const item = { ...baseItem(), drafts: { article: { text: '旧版 drafts 中的文章', by: 'user' } }, production: { format: 'script', article: '另一流程的口播不能冒充文章', cover: { src: 'video-cover.png' } } }
  const original = plain(item)
  const ui = uiFixture({ item })
  await ui.settle()
  assert.equal(ui.field('文章正文').props.value, '旧版 drafts 中的文章')
  assert.equal(ui.button('保存正文').props.disabled, false)
  assert.equal(ui.nodes(node => node.type === 'img').length, 0)
  assert.deepEqual(item, original)
})

test('文章界面：保存资料时保留其他分支未保存的正文，切回后继续编辑', async () => {
  const item = { ...baseItem(), production: { format: 'article', title: '旧标题', article: '原正文', status: 'done' } }
  const ui = uiFixture({ item })
  await ui.settle()
  ui.change('文章正文', '尚未保存但不能丢的正文')
  ui.click('1资料与出处')
  ui.change('原文或经验记录', '更新后的参考原文')
  ui.actionResult = async (id, action, data, revision) => {
    const row = ui.snapshot.state.items[0]
    const workflow = { ...articleWorkspace(row), revision: revision + 1, sources: data.sources, stage: 'sources' }
    return { state: { ...ui.snapshot.state, items: [{ ...row, articleWorkflow: workflow }] }, workflow }
  }
  ui.click('保存资料')
  await ui.settle()
  assert.equal(ui.field('原文或经验记录').props.value, '更新后的参考原文')
  ui.click('4写作修改')
  assert.equal(ui.field('文章正文').props.value, '尚未保存但不能丢的正文')
  assert.equal(ui.isDirty, true)
})

test('文章版本记录：旧稿和 point/outline/text 候选可读复制，不覆盖当前正文', async () => {
  const item = { ...baseItem(), production: { format: 'article', title: '当前文章', article: '当前正文', status: 'done' } }
  item.articleWorkflow = { ...articleWorkspace(item), stage: 'writing', draftHistory: [{ id: 'old', title: '旧稿标题', text: '旧稿原文' }], candidateHistory: [
    { id: 'point', data: { point: { thesis: '候选观点', audience: '候选读者', boundary: '候选边界' } } },
    { id: 'outline', data: { outline: { title: '候选标题', text: '候选提纲' } } },
    { id: 'draft', data: { title: '候选正文标题', text: '候选正文' } },
  ] }
  const ui = uiFixture({ item })
  await ui.settle()
  assert.match(ui.text(), /以前的稿件（1）|尚未采用的生成候选（3）/)
  const saved = ui.nodes(node => node.type === 'textarea' && node.props.readOnly).map(node => node.props.value)
  assert.ok(saved.includes('旧稿原文'))
  assert.ok(saved.some(value => value.includes('候选观点') && value.includes('候选边界')))
  assert.ok(saved.some(value => value.includes('候选提纲')))
  assert.ok(saved.some(value => value.includes('候选正文')))
  ui.click('复制这个版本')
  await ui.settle()
  assert.match(ui.copies[0], /旧稿原文/)
  assert.equal(ui.field('文章正文').props.value, '当前正文')
  assert.equal(ui.actions.length, 0)
})

test('文章版本记录：旧配图在配图阶段可见，原始图片地址保留', async () => {
  const item = { ...baseItem(), production: { format: 'article', article: '定稿', title: '标题', cover: { src: 'current.png' }, status: 'done' } }
  item.articleWorkflow = { ...articleWorkspace(item), stage: 'images', draftFinalized: true, imageHistory: [{ id: 'old-images', cover: { src: 'old-cover.png' }, images: [{ src: 'old-figure.png', caption: '以前的配图原件' }] }] }
  const ui = uiFixture({ item })
  await ui.settle()
  assert.match(ui.text(), /以前的配图（1）/)
  const pictures = ui.nodes(node => node.type === 'img').map(node => node.props.src)
  assert.ok(pictures.includes('current.png'))
  assert.ok(pictures.includes('old-cover.png'))
  assert.ok(pictures.includes('old-figure.png'))
})

test('文章界面：只有三项确认齐全且未编辑的提纲能触发 AI 全文', async () => {
  const item = baseItem()
  item.articleWorkflow = { ...articleWorkspace(item), stage: 'writing', revision: 8, sourcesConfirmed: true, pointConfirmed: true, outlineConfirmed: true, outline: { title: '已确认标题', text: '一、证据\n二、结论' } }
  const ui = uiFixture({ item })
  await ui.settle()
  assert.equal(ui.button('按确认提纲生成初稿').props.disabled, false)
  ui.click('按确认提纲生成初稿')
  await ui.settle()
  assert.deepEqual(ui.actions[0], [item.id, 'write', {}, 8])
})

test('文章界面：旧文章定稿仅保存正文并 finalize，不把历史资料和提纲标成确认', async () => {
  const item = { ...baseItem(), production: { format: 'article', article: '已完成旧正文', title: '旧标题', status: 'done' } }
  const ui = uiFixture({ item })
  await ui.settle()
  ui.click('确认正文，进入配图')
  await ui.settle()
  assert.deepEqual(ui.actions.map(row => row[1]), ['save_draft', 'finalize'])
  assert.deepEqual(ui.actions[0][2], { title: '旧标题', text: '已完成旧正文' })
  assert.equal(articleWorkspace(item).sourcesConfirmed, false)
  assert.equal(articleWorkspace(item).outlineConfirmed, false)
})

test('文章界面：规划与生图分成两个显式动作，未配置生图仍可完成文字稿', async () => {
  const item = { ...baseItem(), production: { format: 'article', title: '文章', article: '定稿正文', status: 'done' } }
  item.articleWorkflow = { ...articleWorkspace(item), stage: 'images', revision: 7, legacy: false, draftFinalized: true }
  const ui = uiFixture({ item })
  await ui.settle()
  assert.equal(ui.button('按定稿规划配图').props.disabled, false)
  assert.equal(ui.button('生成文章配图').props.disabled, true)
  assert.equal(ui.button('完成文字稿').props.disabled, false)
  ui.click('按定稿规划配图')
  await ui.settle()
  assert.deepEqual(ui.actions.map(row => row[1]), ['plan_images'])
  ui.click('完成文字稿')
  await ui.settle()
  assert.match(ui.copies[0], /定稿正文/)
})

test('文章界面：图片失败后正文与原有图仍可读，操作可以重试', async () => {
  const item = { ...baseItem(), production: { format: 'article', title: '文章', article: '不能丢的定稿', status: 'done', cover: { src: 'media-desk/files/kept.png', prompt: '配图方案', status: 'done' }, images: [] } }
  item.articleWorkflow = { ...articleWorkspace(item), stage: 'images', draftFinalized: true, imagesPlanned: true }
  const ui = uiFixture({ item })
  ui.snapshot.settings.imageReady = true
  ui.actionResult = async () => false
  ui.render()
  await ui.settle()
  ui.click('生成文章配图')
  await ui.settle()
  assert.equal(ui.nodes(node => node.type === 'img')[0].props.src, 'media-desk/files/kept.png')
  assert.equal(ui.snapshot.state.items[0].production.article, '不能丢的定稿')
  assert.equal(ui.button('生成文章配图').props.disabled, false)
})

test('文章界面：刷新后恢复服务端 busy，完成时重读正文；生图资产运行时禁止重复操作', async () => {
  let first = true
  const ui = uiFixture({ statusResult: () => { const busy = first; first = false; return { busy } } })
  await ui.settle()
  assert.equal(ui.isBusy, true)
  assert.equal(ui.button('保存资料').props.disabled, true)
  ui.tick()
  await ui.settle()
  assert.equal(ui.isBusy, false)
  assert.equal(ui.loads, 1)
  const item = { ...baseItem(), production: { format: 'article', article: '正文', images: [{ status: 'pending' }] } }
  const assets = uiFixture({ item, component: 'Studio' })
  assert.equal(assets.watches.length, 1, '文章配图异步任务沿用生产状态轮询')
})

test('文章界面：每条灵感的双入口发送 item 级切换，忙或未保存时不能切换', async () => {
  const item = baseItem()
  const ui = uiFixture({ item, component: 'WorkflowSwitch', props: { format: 'script' } })
  ui.click('文章流程')
  await ui.settle()
  assert.deepEqual(ui.ops[0][0], [{ op: 'set_creation_format', id: item.id, format: 'article' }])
  const blocked = uiFixture({ component: 'WorkflowSwitch', props: { format: 'article', dirty: true } })
  assert.equal(blocked.button('视频流程').props.disabled, true)
  assert.match(blocked.text(), /请先保存修改/)
})

test('Studio真实路由：文章挂独立工作区，视频仍挂完整 Sheet，选择按 item 而非全局体裁', () => {
  const article = uiFixture({ component: 'Studio' })
  assert.equal(article.nodes(node => node.type?.name === 'ArticleWorkflow').length, 1)
  assert.equal(article.nodes(node => node.type?.name === 'Sheet').length, 0)
  const video = uiFixture({ component: 'Studio', item: { ...baseItem(), creationFormat: 'script', production: { format: 'script', article: '口播', status: 'done', shots: [{ no: 1 }] } } })
  assert.equal(video.nodes(node => node.type?.name === 'Sheet').length, 1)
  assert.equal(video.nodes(node => node.type?.name === 'ArticleWorkflow').length, 0)
  const chat = video.nodes(node => node.type?.name === 'ChatPanel')[0]
  assert.equal(chat.props.top.type.name, 'IdeaCard')
})

const deskBundle = await build({ entryPoints: [entry('desk.js')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'] })
function deskFixture(respond) {
  const requests = []
  const state = { items: [baseItem()], chat: [], draftFormat: 'script' }
  const sandbox = { module: { exports: {} }, require: () => ({}), structuredClone, setTimeout: () => 1, clearTimeout() {}, fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ url, body })
    const data = await respond?.(url, body) || { state, workflow: articleWorkspace(state.items[0]) }
    return { ok: data.httpOk !== false, status: 409, json: async () => data }
  } }
  vm.runInNewContext(deskBundle.outputFiles[0].text, sandbox)
  const desk = sandbox.module.exports
  desk.setDesk({ state })
  return { desk, requests, state }
}

test('文章请求契约：POST含 id/action/data/revision，成功更新state且单飞，失败不改变内容', async () => {
  const response = deferred()
  const { desk, requests, state } = deskFixture(() => response.promise)
  const sending = desk.articleAction('article-a', 'save_draft', { title: '标题', text: '正文' }, 3)
  assert.equal(await desk.articleAction('article-a', 'write', {}, 3), false)
  assert.equal(requests.length, 1)
  response.resolve({ state: { ...state, marker: 'saved' }, workflow: { revision: 4 } })
  assert.equal((await sending).workflow.revision, 4)
  assert.deepEqual(requests[0], { url: 'media-desk/article-workflow', body: { id: 'article-a', action: 'save_draft', data: { title: '标题', text: '正文' }, revision: 3 } })
  assert.equal(desk.getDesk().state.marker, 'saved')
  const failed = deskFixture(() => ({ httpOk: false, error: 'stale' }))
  assert.equal(await failed.desk.articleAction('article-a', 'write', {}, 0), false)
  assert.equal(failed.desk.getDesk().state, failed.state)
  assert.equal(failed.desk.getDesk().articleBusy['article-a'], false)
})

test('文章请求契约：GET恢复busy；文章导出不合成或提交 videoCover', async () => {
  const { desk, requests, state } = deskFixture(url => url.includes('?') ? { workflow: {}, busy: true } : { state, path: '/example/article' })
  assert.equal((await desk.fetchArticleWorkflow('id with space')).busy, true)
  assert.equal(requests[0].url, 'media-desk/article-workflow?id=id%20with%20space')
  await desk.saveProduced('article-a')
  assert.deepEqual(requests.at(-1), { url: 'media-desk/produce/save', body: { id: 'article-a' } })
})

test('文章请求契约：旧聊天 produce action 对文章只打开流程，视频仍走原成稿入口', async () => {
  const article = deskFixture((url) => ({ state: article.state, actions: url.endsWith('/chat') ? [{ type: 'produce', id: 'article-a' }] : [] }))
  await article.desk.sendChat('成稿')
  assert.equal(article.desk.getDesk().focusId, 'article-a')
  assert.equal(article.requests.some(row => row.url.endsWith('/produce')), false)
  const video = deskFixture(url => ({ state: video.state, actions: url.endsWith('/chat') ? [{ type: 'produce', id: 'article-a' }] : [] }))
  video.state.items[0].creationFormat = 'script'
  await video.desk.sendChat('成稿')
  assert.equal(video.requests.some(row => row.url.endsWith('/produce')), true)
})

test('文章界面新增文案均有英文翻译，避免英文流程回退为中文', () => {
  const source = readFileSync(entry('article-workflow.jsx'), 'utf8')
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  keys.push(...[...source.matchAll(/\blabel[:=](?:'|")([^'"]+)(?:'|")/g)].map(match => match[1]))
  for (const key of new Set(keys)) { assert.equal(typeof EN[key], 'string', key); assert.doesNotMatch(EN[key], /[一-鿿]/u, key) }
})
