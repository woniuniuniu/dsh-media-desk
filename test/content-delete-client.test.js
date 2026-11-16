import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { EN } from '../client/en/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: `export {DeleteContentButton} from './client/item-actions.jsx'; export {Studio} from './client/studio.jsx'; export {BoardCard,Table} from './client/content.jsx'`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'delete-host', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'delete-host' }))
    builder.onResolve({ filter: /^\.\/desk\.js$/ }, () => ({ path: 'desk', namespace: 'delete-host' }))
    builder.onResolve({ filter: /^\.\/chat\.jsx$/ }, () => ({ path: 'chat', namespace: 'delete-host' }))
    builder.onResolve({ filter: /^\.\/ui\.jsx$/ }, () => ({ path: 'ui', namespace: 'delete-host' }))
    builder.onLoad({ filter: /client\/content\.jsx$/ }, ({ path }) => ({ contents: readFileSync(path, 'utf8') + '\nexport {BoardCard,Table}\n', loader: 'jsx' }))
    builder.onLoad({ filter: /.*/, namespace: 'delete-host' }, ({ path }) => ({ contents: path === 'react' ? 'export default globalThis.fixture.React'
      : path === 'ui' ? 'export function Icon(){}; export function IconButton(){}; export function Segmented(){};export function Empty(){}'
        : path === 'chat' ? 'export function ChatPanel(){}'
          : `const f=globalThis.fixture;export const useDesk=s=>s(f.snapshot);export const dispatchOps=(...args)=>f.dispatchOps(...args);export const setDesk=p=>f.setDesk(p);export const openItem=(...args)=>f.opened.push(args);export const closeItem=()=>f.closed++;export function toast(){};export function articleAction(){};export const fetchArticleWorkflow=async()=>({busy:false});export async function loadDesk(){};export async function saveProduced(){};export async function sendChat(){};export const watchProduction=()=>()=>{};export function cancelProduce(){};export function regenAsset(){};export function revealSaved(){};export function runProduce(){}` }))
  } }],
})

const item = () => ({ id: 'content-a', title: '可删除的文章', kind: 'note', body: '原始资料', status: 'idea', createdAt: '2026-11-16T00:00:00Z', creationFormat: 'article', production: { format: 'article', article: '保留的正文', title: '正文标题', status: 'done' } })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(component = 'DeleteContentButton', props = {}) {
  const row = props.item || item()
  const f = { props: { item: row, items: [row], ...props }, snapshot: { state: { items: [row], chat: [], styles: [], draftFormat: 'script' }, focusId: row.id, articleBusy: {}, deletingItems: {}, live: {}, settings: {} }, calls: [], opened: [], closed: 0 }
  const slots = [], deps = new Map(), cleanups = new Map()
  let hook = 0, pending = [], dirty = true, tree
  f.React = {
    useState(initial) { const index = hook++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true } }] },
    useRef(initial) { const index = hook++; return slots[index] ||= { current: initial } },
    useMemo: fn => fn(), useCallback: fn => fn(), useSyncExternalStore: (_, getter) => getter(),
    useEffect(fn, next) { const index = hook++, before = deps.get(index); if (!before || next.some((value, at) => !Object.is(value, before[at]))) { deps.set(index, next); pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, fn()) }) } },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  }
  f.React.useLayoutEffect = f.React.useEffect
  f.setDesk = patch => { f.snapshot = { ...f.snapshot, ...(typeof patch === 'function' ? patch(f.snapshot) : patch) }; dirty = true }
  f.response = async () => ({ state: { ...f.snapshot.state, items: [] }, receipts: [{ text: '已删除' }] })
  f.dispatchOps = async (...args) => { f.calls.push(plain(args)); const result = await f.response(...args); if (result?.state) f.setDesk({ state: result.state, canUndo: true }); return result }
  const sandbox = { fixture: f, module: { exports: {} }, structuredClone, window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) }, document: { documentElement: { lang: 'zh' }, querySelector: () => null }, navigator: { language: 'zh' } }
  vm.runInNewContext(bundle.outputFiles[0].text, sandbox)
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []
  f.nodes = predicate => walk(tree).filter(predicate)
  f.render = () => {
    dirty = true
    while (dirty || pending.length) {
      dirty = false; hook = 0
      tree = sandbox.module.exports[component](f.props)
      for (const run of pending.splice(0)) run()
    }
    return tree
  }
  f.render()
  return f
}

test('删除入口：文章和视频的 Studio 共用顶部按钮；看板和表格各有入口', () => {
  for (const format of ['article', 'script']) {
    const f = fixture('Studio', { item: { ...item(), creationFormat: format, production: { ...item().production, format } } })
    const top = f.nodes(node => node.props.className === 'md-studio-actions')[0]
    assert.ok(top)
    assert.equal(top.children.filter(node => node.type?.name === 'DeleteContentButton').length, 1)
  }
  const board = fixture('BoardCard')
  const wrapper = board.render()
  assert.equal(wrapper.type, 'div')
  assert.equal(board.nodes(node => node.type?.name === 'DeleteContentButton').length, 1)
  const open = board.nodes(node => node.type === 'button')[0]
  assert.equal(open.props.className, 'md-board-card-open')
  assert.equal(open.children.some(node => node?.type?.name === 'DeleteContentButton'), false, '没有在 open button 中嵌套删除按钮')
  const table = fixture('Table')
  assert.equal(table.nodes(node => node.type === 'td' && node.props.className === 'md-table-actions').length, 1)
  assert.equal(table.nodes(node => node.type?.name === 'DeleteContentButton').length, 1)
})

test('删除成功：复用默认 undoable 的 delete_item，单飞防重复，不手动关闭编辑器', async () => {
  const f = fixture()
  const response = deferred()
  f.response = () => response.promise
  const button = f.render()
  let stopped = 0
  const event = { stopPropagation: () => stopped++, preventDefault() {} }
  const first = button.props.onClick(event)
  assert.equal(await button.props.onClick(event), false)
  assert.equal(f.render().props.disabled, true)
  response.resolve({ state: { ...f.snapshot.state, items: [] } })
  assert.equal(await first, true)
  assert.deepEqual(f.calls[0][0], [{ op: 'delete_item', id: 'content-a' }])
  assert.equal(f.calls[0][1].undoable, undefined, '沿用 dispatchOps 默认可撤销')
  assert.equal(f.calls[0][1].silent, undefined, '沿用成功 Toast')
  assert.equal(f.closed, 0, '只由 Studio 的 item 消失 effect 关闭')
  assert.equal(stopped, 2)
  assert.equal(f.snapshot.deletingItems['content-a'], false)
})

test('删除失败：保留原内容和当前界面，错误回执也不能当成成功', async () => {
  for (const response of [null, { errors: ['正在生成'], state: { items: [item()] } }]) {
    const f = fixture()
    f.response = async () => response
    assert.equal(await f.render().props.onClick({ stopPropagation() {}, preventDefault() {} }), false)
    assert.equal(f.snapshot.state.items[0].production.article, '保留的正文')
    assert.equal(f.closed, 0)
    assert.equal(f.render().props.disabled, false)
  }
})

test('生成中禁删：显式 busy、文章任务、正文或资产运行均阻止请求并说明原因', async () => {
  const rows = [
    { props: { busy: true } },
    { article: true },
    { production: { status: 'running' } },
    { production: { images: [{ status: 'pending' }] } },
    { production: { cover: { status: 'running' } } },
    { production: { shots: [{ status: 'pending' }] } },
  ]
  for (const row of rows) {
    const f = fixture('DeleteContentButton', { ...row.props, item: { ...item(), production: { ...item().production, ...row.production } } })
    if (row.article) f.snapshot.articleBusy['content-a'] = 'generate_draft'
    const button = f.render()
    assert.equal(button.props.disabled, true)
    assert.match(button.props.title, /正在生成/)
    assert.equal(await button.props.onClick({ stopPropagation() {}, preventDefault() {} }), false)
    assert.equal(f.calls.length, 0)
  }
})

test('未保存修改禁删：提示先保存，不发 ops；保存后恢复删除', async () => {
  const f = fixture('DeleteContentButton', { dirty: true })
  const dirtyButton = f.render()
  assert.equal(dirtyButton.props.disabled, true)
  assert.equal(dirtyButton.props.title, '请先保存修改，再删除内容。')
  assert.equal(await dirtyButton.props.onClick({ stopPropagation() {}, preventDefault() {} }), false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot.state.items[0].production.article, '保留的正文')
  f.props = { ...f.props, dirty: false }
  const savedButton = f.render()
  assert.equal(savedButton.props.disabled, false)
  assert.equal(await savedButton.props.onClick({ stopPropagation() {}, preventDefault() {} }), true)
  assert.equal(f.calls.length, 1)
  const studio = fixture('Studio')
  const editor = studio.nodes(node => node.type?.name === 'ArticleWorkflow')[0]
  editor.props.onDirty(true)
  studio.render()
  assert.equal(studio.nodes(node => node.type?.name === 'DeleteContentButton')[0].props.dirty, true)
  editor.props.onDirty(false)
  studio.render()
  assert.equal(studio.nodes(node => node.type?.name === 'DeleteContentButton')[0].props.dirty, false)
})

test('列表事件：删除 click/Enter 不打开内容；行本身 Enter 和看板 open button 仍可打开', () => {
  const table = fixture('Table')
  const cell = table.nodes(node => node.props.className === 'md-table-actions')[0]
  let stopped = 0
  cell.props.onClick({ stopPropagation: () => stopped++ })
  cell.props.onKeyDown({ stopPropagation: () => stopped++ })
  const row = table.nodes(node => node.type === 'tr' && node.props.tabIndex === 0)[0]
  row.props.onKeyDown({ key: 'Enter', target: cell, currentTarget: row })
  assert.equal(table.opened.length, 0)
  row.props.onKeyDown({ key: 'Enter', target: row, currentTarget: row })
  assert.equal(table.opened.length, 1)
  const remove = fixture()
  remove.render().props.onKeyDown({ stopPropagation: () => stopped++ })
  assert.equal(stopped, 3)
  const board = fixture('BoardCard')
  board.nodes(node => node.type === 'button')[0].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) } })
  assert.equal(board.opened.length, 1)
})

test('现有 dispatchOps：删除请求默认 undoable=true，成功显示带撤销能力的 Toast', async () => {
  const desk = await build({ entryPoints: [root + 'client/desk.js'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'] })
  let payload
  const sandbox = { module: { exports: {} }, require: () => ({}), structuredClone, setTimeout: () => 1, clearTimeout() {}, fetch: async (_, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ state: { items: [] }, receipts: [{ text: '已删除' }] }) } } }
  vm.runInNewContext(desk.outputFiles[0].text, sandbox)
  const api = sandbox.module.exports
  api.setDesk({ state: { items: [item()] } })
  await api.dispatchOps([{ op: 'delete_item', id: 'content-a' }], { label: '删除内容' })
  assert.equal(payload.undoable, true)
  assert.equal(api.getDesk().canUndo, true)
  assert.equal(api.getDesk().toast.text, '已删除')
  assert.equal(api.getDesk().toast.undo, true)
})

test('删除文案英文、上下文辅助标签和可见按钮文字齐全', () => {
  for (const key of ['删除内容', '删除内容：{title}', '内容正在生成，完成后才能删除', '请先保存修改，再删除内容。', '正在删除……', '无标题', '删除', '操作']) { assert.equal(typeof EN[key], 'string', key); assert.doesNotMatch(EN[key], /[一-鿿]/u) }
  const button = fixture().render()
  assert.equal(button.props['aria-label'], '删除内容：正文标题')
  assert.equal(button.children.find(node => node?.type === 'span').children[0], '删除内容')
})
