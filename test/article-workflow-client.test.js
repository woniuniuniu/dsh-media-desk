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
          : `const f=globalThis.fixture; export const useDesk=s=>s(f.snapshot); export const articleAction=(...args)=>f.articleAction(...args); export const fetchArticleWorkflow=(...args)=>f.fetchStatus(...args); export const loadDesk=()=>f.loadDesk(); export const dispatchOps=(...args)=>f.dispatchOps(...args); export const toast=(...args)=>f.notices.push(args); export const setDesk=p=>f.setDesk(p); export const saveProduced=(...args)=>f.exports.push(args); export const sendChat=(...args)=>f.chatSend(...args); export const watchProduction=(...args)=>{f.watches.push(args);return()=>{}}; export function cancelProduce(){};export function closeItem(){};export function regenAsset(){};export function revealSaved(){};export function runProduce(){}`, loader: 'js' }))
  } }],
})))

function uiFixture({ item = baseItem(), component = 'ArticleWorkflow', props = {}, statusResult } = {}) {
  const fixture = {
    snapshot: { state: { items: [item], chat: [], draftFormat: 'script', styles: [] }, focusId: item.id, settings: { imageReady: false }, live: {}, articleBusy: {} },
    actions: [], ops: [], notices: [], copies: [], exports: [], watches: [], chatCalls: [], asks: [], statusReads: 0, loads: 0, jumps: 0, statusResult, controller: { current: null },
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
  fixture.actionResult = async (id, action, data, revision) => {
    const row = fixture.snapshot.state.items[0]
    const workflow = { ...articleWorkspace(row) }
    let next = { ...row }
    let candidate
    if (action === 'save_draft') {
      next.production = { ...row.production, format: 'article', status: 'done', title: data.title, article: data.text }
      workflow.revision = revision + 1
    } else if (['generate_draft', 'rewrite_selection'].includes(action)) {
      candidate = { id: `candidate-${fixture.actions.length}`, kind: action === 'rewrite_selection' ? 'selection' : 'draft', text: 'AI 建议文本', title: '建议标题', instruction: data.instruction, baseRevision: revision, status: 'pending', ...(data.selection ? { selection: data.selection } : {}) }
      workflow.editCandidates = [...workflow.editCandidates || [], candidate]
    } else if (action === 'accept_candidate' || action === 'discard_candidate') {
      workflow.editCandidates = (workflow.editCandidates || []).map(value => value.id === data.candidateId ? { ...value, status: action === 'accept_candidate' ? 'accepted' : 'discarded' } : value)
      if (action === 'accept_candidate') { next.production = { ...row.production, article: '服务端接受后的正文' }; workflow.revision = revision + 1 }
    } else if (action === 'plan_images') { workflow.imagesPlanned = true; workflow.revision = revision + 1 }
    next.articleWorkflow = workflow
    return { state: { ...fixture.snapshot.state, items: [next] }, workflow, ...(candidate ? { candidate } : {}) }
  }
  fixture.articleAction = async (...args) => {
    fixture.actions.push(plain(args))
    const result = await fixture.actionResult(...args)
    if (result?.state) fixture.setDesk({ state: result.state })
    return result
  }
  fixture.chatSend = async (...args) => { fixture.chatCalls.push(plain(args)); return true }
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
  const callbacks = { onDirty: value => { fixture.isDirty = value }, onBusy: value => { fixture.isBusy = value }, onSelectionChange: value => { fixture.selection = value }, onAsk: value => fixture.asks.push(value), controllerRef: fixture.controller }
  fixture.nodes = predicate => walk(tree).filter(predicate)
  fixture.button = label => fixture.nodes(node => node.type === 'button' && text(node) === label)[0]
  fixture.field = label => {
    const wrapper = fixture.nodes(node => node.type === 'label' && node.children.some(child => child?.type === 'span' && text(child) === label))[0]
    return wrapper?.children.find(child => ['input', 'textarea', 'select'].includes(child?.type))
  }
  fixture.text = () => text(tree)
  fixture.bodyElement = { value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  fixture.render = () => {
    dirty = true
    let rounds = 0
    while (dirty || pending.length) {
      if (++rounds > 35) throw new Error('Article UI did not settle')
      dirty = false; hook = 0
      const current = fixture.snapshot.state.items.find(row => row.id === fixture.snapshot.focusId) || fixture.snapshot.state.items[0]
      tree = sandbox.module.exports[component]({ item: current, ...callbacks, ...props })
      const body = fixture.field('文章正文')
      if (body?.props.ref) { fixture.bodyElement.value = body.props.value; body.props.ref.current = fixture.bodyElement }
      const candidatePanel = fixture.nodes(node => node.props.className === 'md-ai-candidates')[0]
      if (candidatePanel?.props.ref) candidatePanel.props.ref.current = { scrollIntoView: () => fixture.jumps++ }
      for (const run of pending.splice(0)) run()
    }
    return tree
  }
  fixture.settle = async () => { await new Promise(resolve => setImmediate(resolve)); fixture.render() }
  fixture.click = label => { const button = fixture.button(label); assert.ok(button, label); assert.equal(Boolean(button.props.disabled), false, `${label} disabled`); button.props.onClick(); fixture.render() }
  fixture.change = (label, value) => { const field = fixture.field(label); assert.ok(field, label); field.props.onChange({ target: { value } }); fixture.render() }
  fixture.select = (start, end) => { const element = fixture.bodyElement; element.selectionStart = start; element.selectionEnd = end; fixture.field('文章正文').props.onSelect({ currentTarget: element }); fixture.render() }
  fixture.tick = () => { for (const [id, callback] of timers) { timers.delete(id); callback() } }
  fixture.render()
  return fixture
}

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

function existing(text = '原正文', revision = 4, candidates = []) {
  const item = { ...baseItem(), production: { format: 'article', title: '原标题', article: text, status: 'done' } }
  item.articleWorkflow = { ...articleWorkspace(item), revision, editCandidates: candidates }
  return item
}

test('编辑器：一份空白正文直接写或粘贴，没有五步、确认关卡或资料必填表', async () => {
  const ui = uiFixture()
  await ui.settle()
  assert.equal(ui.field('文章正文').props.value, '')
  assert.doesNotMatch(ui.text(), /确认资料|确认观点|确认提纲|进入配图/)
  assert.equal(ui.field('资料名称'), undefined)
  const text = '  原样粘贴\n\n重复段落\n重复段落  \n'
  ui.change('文章正文', text)
  ui.change('文章标题', '  标题也保留空格  ')
  ui.click('保存正文')
  await ui.settle()
  assert.deepEqual(ui.actions[0].slice(1, 4), ['save_draft', { title: '  标题也保留空格  ', text }, 0])
  assert.equal(ui.field('文章正文').props.value, text)
})

test('编辑器：无素材也能起稿，先保存当前文档，AI只返回候选，不自动替换正文', async () => {
  const ui = uiFixture()
  await ui.settle()
  assert.equal(await ui.controller.current.send('写一篇关于散步的文章'), true)
  await ui.settle()
  assert.deepEqual(ui.actions.map(action => action[1]), ['save_draft', 'generate_draft'])
  assert.equal(ui.actions[1][3], 1)
  assert.deepEqual(ui.actions[1][4], [])
  assert.equal(ui.field('文章正文').props.value, '')
  assert.match(ui.text(), /AI 建议文本/)
  assert.equal(ui.jumps, 1, '新建议出现后滚动到建议卡')
})

test('编辑器：第二处重复文字以精确 UTF16 选区发送，@ 素材确实传给改写请求', async () => {
  const text = '😀开头\n同样的一句话\n同样的一句话\n结尾'
  const ui = uiFixture({ item: existing(text) })
  await ui.settle()
  const selected = '同样的一句话', start = text.lastIndexOf(selected)
  ui.select(start, start + selected.length)
  const mentions = [{ id: 'item:reference', label: '参考资料', trigger: '@' }]
  assert.equal(await ui.controller.current.send('把第二处写得更具体', { mentions }), true)
  await ui.settle()
  assert.equal(ui.actions[0][1], 'rewrite_selection')
  assert.deepEqual(ui.actions[0][2].selection, { start, end: start + selected.length, text: selected })
  assert.deepEqual(ui.actions[0][4], mentions)
  assert.equal(ui.field('文章正文').props.value, text)
})

test('编辑器：未保存正文先 flush 原文获得新 revision，再提交选段候选', async () => {
  const ui = uiFixture({ item: existing() })
  await ui.settle()
  ui.change('文章正文', ' 新正文\n选择这里\n ')
  const text = ui.field('文章正文').props.value, start = text.indexOf('选择这里')
  ui.select(start, start + 4)
  await ui.controller.current.send('润色')
  await ui.settle()
  assert.deepEqual(ui.actions.map(value => [value[1], value[3]]), [['save_draft', 4], ['rewrite_selection', 5]])
  assert.equal(ui.actions[0][2].text, text)
})

test('编辑器：只在接受时提交 candidateId 并更新正文，放弃不修改正文', async () => {
  const candidate = { id: 'c1', kind: 'selection', selection: { start: 0, end: 3, text: '原正文' }, text: '建议正文', instruction: '润色', baseRevision: 4, status: 'pending' }
  const accepted = uiFixture({ item: existing('原正文', 4, [candidate]) })
  await accepted.settle()
  accepted.click('接受建议')
  await accepted.settle()
  assert.deepEqual(accepted.actions[0].slice(1, 4), ['accept_candidate', { candidateId: 'c1' }, 4])
  assert.equal(accepted.field('文章正文').props.value, '服务端接受后的正文')
  const discarded = uiFixture({ item: existing('原正文', 4, [candidate]) })
  await discarded.settle()
  discarded.click('放弃建议')
  await discarded.settle()
  assert.equal(discarded.actions[0][1], 'discard_candidate')
  assert.equal(discarded.field('文章正文').props.value, '原正文')
  assert.match(discarded.text(), /已放弃/)
})

test('编辑器：本地dirty或过期候选不可接受，也不按相同文字重定向替换', async () => {
  const candidate = { id: 'c1', kind: 'selection', selection: { start: 0, end: 3, text: '不同文' }, text: '建议', baseRevision: 4, status: 'pending' }
  const ui = uiFixture({ item: existing('原正文\n不同文', 4, [candidate]) })
  await ui.settle()
  assert.equal(ui.button('接受建议').props.disabled, true)
  ui.change('文章正文', '未保存的新文')
  assert.equal(ui.button('接受建议').props.disabled, true)
  ui.button('接受建议').props.onClick()
  assert.equal(ui.actions.length, 0)
  assert.equal(ui.field('文章正文').props.value, '未保存的新文')
})

test('编辑器：失败保留人工输入；生成期间继续键入不会被保存回执覆盖', async () => {
  const ui = uiFixture({ item: existing() })
  await ui.settle()
  ui.change('文章正文', '第一次修改')
  const response = deferred()
  ui.actionResult = () => response.promise
  const sending = ui.controller.current.send('给我建议')
  ui.render()
  ui.change('文章正文', '请求中继续写的文字')
  response.resolve(false)
  assert.equal(await sending, false)
  await ui.settle()
  assert.equal(ui.field('文章正文').props.value, '请求中继续写的文字')
  assert.match(ui.text(), /输入已保留/)
  assert.deepEqual(ui.actions.map(value => value[1]), ['save_draft'])
})

test('编辑器：删除 pending 禁止改标题、正文和发送；删除失败恢复后仍可编辑', async () => {
  const ui = uiFixture({ item: existing('不能丢的正文') })
  await ui.settle()
  ui.snapshot.deletingItems = { 'article-a': true }
  ui.render()
  assert.equal(ui.field('文章标题').props.disabled, true)
  assert.equal(ui.field('文章正文').props.disabled, true)
  assert.match(ui.text(), /正在删除……/)
  assert.doesNotMatch(ui.text(), /你可以继续编辑正文/)
  ui.change('文章标题', '删除途中输入的标题')
  ui.change('文章正文', '删除途中输入的正文')
  assert.equal(ui.field('文章标题').props.value, '原标题')
  assert.equal(ui.field('文章正文').props.value, '不能丢的正文')
  assert.equal(ui.isDirty, false)
  assert.equal(await ui.controller.current.send('生成文章'), false)
  assert.equal(await ui.controller.current.send('/复盘'), false)
  assert.equal(ui.actions.length, 0)
  assert.equal(ui.chatCalls.length, 0)
  ui.snapshot.deletingItems['article-a'] = false
  ui.render()
  assert.equal(ui.field('文章标题').props.disabled, false)
  assert.equal(ui.field('文章正文').props.disabled, false)
  ui.change('文章正文', '失败后继续编辑的正文')
  assert.equal(ui.field('文章正文').props.value, '失败后继续编辑的正文')
  assert.equal(ui.isDirty, true)
  const studio = uiFixture({ component: 'Studio' })
  studio.snapshot.deletingItems = { 'article-a': true }
  studio.render()
  assert.equal(studio.nodes(node => node.type?.name === 'ChatPanel')[0].props.disabled, true)
  assert.equal(studio.nodes(node => node.type?.name === 'WorkflowSwitch')[0].props.busy, true)
})

test('编辑器：dirty绑定开始编辑版本，远端改稿后保存和flush不能借新revision覆盖远端', async () => {
  const ui = uiFixture({ item: existing('原正文', 1) })
  await ui.settle()
  ui.change('文章正文', '本地未保存的修改')
  const remote = existing('另一窗口的新正文', 2)
  ui.snapshot.state = { ...ui.snapshot.state, items: [remote] }
  ui.render()
  assert.equal(ui.field('文章正文').props.value, '本地未保存的修改')
  assert.match(ui.text(), /其他窗口已修改正文/)
  ui.actionResult = async () => false
  ui.click('保存正文')
  await ui.settle()
  assert.equal(ui.actions[0][3], 1)
  await ui.controller.current.send('继续润色')
  await ui.settle()
  assert.equal(ui.actions.at(-1)[1], 'save_draft')
  assert.equal(ui.actions.at(-1)[3], 1)
  assert.equal(ui.snapshot.state.items[0].production.article, '另一窗口的新正文')
})

test('编辑器：保存 A 时继续写 AB，自身成功回执推进 base，第二次保存使用新 revision', async () => {
  const ui = uiFixture({ item: existing('原文', 0) })
  await ui.settle()
  const normal = ui.actionResult, response = deferred()
  ui.actionResult = () => response.promise
  ui.change('文章正文', 'A')
  ui.click('保存正文')
  ui.change('文章正文', 'AB')
  const saved = existing('A', 1)
  response.resolve({ state: { ...ui.snapshot.state, items: [saved] }, workflow: saved.articleWorkflow })
  await ui.settle()
  assert.equal(ui.field('文章正文').props.value, 'AB')
  assert.equal(ui.isDirty, true)
  assert.doesNotMatch(ui.text(), /其他窗口已修改正文/)
  ui.actionResult = normal
  ui.click('保存正文')
  await ui.settle()
  assert.deepEqual(ui.actions.map(value => value[3]), [0, 1])
  assert.equal(ui.field('文章正文').props.value, 'AB')
  assert.equal(ui.isDirty, false)
})

test('编辑器：取消选区会同步左侧引用并收起原生选区；快捷要求保留选区', async () => {
  const ui = uiFixture({ item: existing('选择这里，其他正文') })
  await ui.settle()
  ui.select(0, 4)
  assert.equal(ui.selection.text, '选择这里')
  ui.click('让 AI 修改')
  assert.equal(ui.selection.text, '选择这里', '转移到composer不清除选区')
  ui.click('简化')
  assert.equal(ui.asks.at(-1), '简化这段文字')
  ui.controller.current.clearSelection()
  ui.render()
  assert.equal(ui.selection, null)
  assert.equal(ui.bodyElement.selectionStart, ui.bodyElement.selectionEnd)
})

test('编辑器：非produce斜杠命令走原聊天，produce和引用素材走生成候选', async () => {
  const ui = uiFixture({ item: existing() })
  await ui.settle()
  await ui.controller.current.send('/复盘', { mentions: [{ id: 'cmd:insights', label: '复盘', trigger: '/' }] })
  assert.equal(ui.chatCalls.length, 1)
  assert.equal(ui.actions.length, 0)
  await ui.controller.current.send('/成稿', { mentions: [{ id: 'cmd:produce', label: '成稿', trigger: '/' }, { id: 'item:source', label: '素材', trigger: '@' }] })
  await ui.settle()
  assert.equal(ui.actions[0][1], 'generate_draft')
  assert.deepEqual(ui.actions[0][4], [{ id: 'item:source', label: '素材', trigger: '@' }])
})

test('编辑器：旧稿及drafts-only直接可写，历史、旧图和旧资料仅折叠只读', async () => {
  const item = { ...baseItem(), drafts: { article: { text: '旧 drafts 文章' } }, production: { format: 'script', article: '视频文字', cover: { src: 'video.png' } } }
  const original = plain(item)
  const ui = uiFixture({ item })
  await ui.settle()
  assert.equal(ui.field('文章正文').props.value, '旧 drafts 文章')
  assert.equal(ui.nodes(node => node.type === 'img').length, 0)
  assert.deepEqual(item, original)
  assert.doesNotMatch(ui.text(), /此前整理的资料与提纲/)
  const legacy = existing()
  legacy.articleWorkflow = { ...legacy.articleWorkflow, sources: [{ id: 'source', title: '旧来源', text: '旧原文', url: 'https://example.com' }], point: { thesis: '旧观点' }, outline: { title: '旧提纲', text: '旧结构' }, draftHistory: [{ id: 'old', text: '历史正文' }], imageHistory: [{ id: 'old-images', cover: { src: 'old.png' }, images: [] }] }
  const old = uiFixture({ item: legacy })
  await old.settle()
  assert.match(old.text(), /此前整理的资料与提纲|旧原文|旧观点|旧结构/)
  assert.equal(old.nodes(node => node.type === 'textarea' && node.props.readOnly)[0].props.value, '历史正文')
  assert.ok(old.nodes(node => node.type === 'img').some(node => node.props.src === 'old.png'))
})

test('编辑器：配图从保存后的正文独立规划，不调用定稿或五步确认', async () => {
  const ui = uiFixture({ item: existing() })
  await ui.settle()
  ui.change('文章正文', ' 新的配图依据 ')
  ui.click('按正文规划配图')
  await ui.settle()
  assert.deepEqual(ui.actions.map(value => value[1]), ['save_draft', 'plan_images'])
  assert.equal(ui.button('生成文章配图').props.disabled, true)
  assert.equal(ui.button('复制文章').props.disabled, false)
})

test('Studio：文章复用ChatPanel的@ composer/controller，取消引用同步清选区；视频保留原Sheet', () => {
  const article = uiFixture({ component: 'Studio' })
  const chat = article.nodes(node => node.type?.name === 'ChatPanel')[0]
  const editor = article.nodes(node => node.type?.name === 'ArticleWorkflow')[0]
  const calls = []
  editor.props.controllerRef.current = { send: (...args) => { calls.push(args); return true }, clearSelection: () => calls.push('clear') }
  assert.equal(chat.props.onSend('要求', { mentions: [] }), true)
  chat.props.onCancelQuote()
  assert.equal(calls[0][0], '要求')
  assert.equal(calls[1], 'clear')
  const video = uiFixture({ component: 'Studio', item: { ...baseItem(), creationFormat: 'script', production: { format: 'script', article: '口播', shots: [{ no: 1 }] } } })
  assert.equal(video.nodes(node => node.type?.name === 'Sheet').length, 1)
  assert.equal(video.nodes(node => node.type?.name === 'ChatPanel')[0].props.onSend, undefined)
})

test('双模式：按每item切换，未保存文字时不丢编辑', async () => {
  const ui = uiFixture({ component: 'WorkflowSwitch', props: { format: 'script' } })
  ui.click('文章流程'); await ui.settle()
  assert.deepEqual(ui.ops[0][0], [{ op: 'set_creation_format', id: 'article-a', format: 'article' }])
  assert.equal(uiFixture({ component: 'WorkflowSwitch', props: { format: 'article', dirty: true } }).button('视频流程').props.disabled, true)
})

test('请求契约：文章操作传revision/mentions；成功可撤销；409只刷新state且返回失败', async () => {
  const { desk, requests } = deskFixture((url, body) => url.endsWith('/state') ? { state: { items: [existing('远端正文', 2)], chat: [] }, canUndo: true } : body.action === 'save_draft' ? { httpOk: false, error: 'conflict' } : { state: { items: [existing()], chat: [] }, workflow: { revision: 4 } })
  const mentions = [{ id: 'item:ref', label: '资料' }]
  assert.equal((await desk.articleAction('article-a', 'generate_draft', { instruction: '写作' }, 4, mentions)).workflow.revision, 4)
  assert.equal(desk.getDesk().canUndo, true)
  assert.deepEqual(requests[0].body.mentions, mentions)
  assert.equal(await desk.articleAction('article-a', 'save_draft', { title: '', text: '' }, 1), false)
  assert.equal(requests.at(-1).url, 'media-desk/state')
  assert.equal(desk.getDesk().state.items[0].production.article, '远端正文')
  assert.equal(requests.some(request => request.url.endsWith('/settings')), false)
})

test('请求契约：旧聊天produce action文章只打开，视频仍成稿；文章导出不合成videoCover', async () => {
  const article = deskFixture(url => ({ state: article.state, actions: url.endsWith('/chat') ? [{ type: 'produce', id: 'article-a' }] : [] }))
  await article.desk.sendChat('成稿')
  assert.equal(article.requests.some(value => value.url.endsWith('/produce')), false)
  await article.desk.saveProduced('article-a')
  assert.deepEqual(article.requests.at(-1).body, { id: 'article-a' })
  const video = deskFixture(url => ({ state: video.state, actions: url.endsWith('/chat') ? [{ type: 'produce', id: 'article-a' }] : [] }))
  video.state.items[0].creationFormat = 'script'
  await video.desk.sendChat('成稿')
  assert.equal(video.requests.some(value => value.url.endsWith('/produce')), true)
})

test('编辑器新增文案与辅助标签均有英文', () => {
  const source = readFileSync(entry('article-workflow.jsx'), 'utf8')
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  keys.push(...[...source.matchAll(/\blabel[:=](?:'|")([^'"]+)(?:'|")/g)].map(match => match[1]))
  for (const key of new Set(keys)) { assert.equal(typeof EN[key], 'string', key); assert.doesNotMatch(EN[key], /[一-鿿]/u, key) }
})
