import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { addMention, isComposing, mentionLimit, mentionMessage, mentionOptions, mentionToken, removeMentionToken } from '../client/mentions.js'
import { STUDIO } from '../client/en/studio.js'

test('提及：识别中英文边界，不把邮箱和网址当成候选，不接受选区', () => {
  assert.equal(mentionToken('user@example.com', 16), null)
  assert.equal(mentionToken('https://example.com', 19), null)
  assert.equal(mentionToken('@alpha', 6, 2), null)
  assert.equal(mentionToken('看看，@标题', 6).query, '标题')
  assert.equal(mentionToken('/复盘', 3).trigger, '/')
  assert.equal(mentionToken('@', 1).query, '')
})

test('提及：只移除固定 token 范围，保留后面的原稿；旧 token 不可用于新文本', () => {
  const text = '@alpha 保留这段原稿'
  const token = mentionToken(text, 6)
  assert.deepEqual(removeMentionToken(text, token), { text: ' 保留这段原稿', caret: 0 })
  assert.equal(removeMentionToken('@other 保留这段原稿', token), null)
  // 光标在 token 中间时也替换完整 token，不残留名称后半截。
  assert.deepEqual(removeMentionToken(text, mentionToken(text, 3)), { text: ' 保留这段原稿', caret: 0 })
})

test('提及：筛选完整清单后才取前 40 项，名称/提示/组别均可检索并排除已选项', () => {
  const contexts = Array.from({ length: 80 }, (_, index) => ({ id: `item:${index}`, name: `标题${index}` }))
  contexts[79].hint = 'needle'
  contexts[78].group = '我的风格'
  assert.equal(mentionOptions({ contexts }, mentionToken('@needle', 7))[0].id, 'item:79')
  assert.equal(mentionOptions({ contexts }, mentionToken('@风格', 3))[0].id, 'item:78')
  assert.equal(mentionOptions({ contexts }, mentionToken('@', 1)).length, 40)
  assert.equal(mentionOptions({ contexts }, mentionToken('@needle', 7), [{ id: 'item:79' }]).length, 0)
  assert.deepEqual(mentionOptions({ contexts, commands: [{ id: 'cmd:review', name: '复盘' }] }, mentionToken('/复盘', 3)).map(row => row.id), ['cmd:review'])
})

test('提及：去重且第九项被拒绝，既有引用不被静默截断', () => {
  const picked = Array.from({ length: 8 }, (_, index) => ({ id: `item:${index}`, label: `标题${index}`, trigger: '@' }))
  assert.equal(addMention(picked, { id: 'item:8', name: '第九项' }, '@').error, 'limit')
  assert.equal(addMention(picked, { id: 'item:0', name: '重复' }, '@').error, 'duplicate')
  assert.equal(picked.length, 8)
  assert.deepEqual(addMention([], { id: 'cmd:review', name: '复盘' }, '/').picked, [{ id: 'cmd:review', label: '复盘', trigger: '/' }])
  assert.equal(mentionLimit({ limits: { maxMentions: 3 } }), 3)
  assert.equal(mentionLimit({ limits: { maxMentions: -1 } }), 8)
})

test('提及：纯指令/引用也能生成消息，额外正文保持原意', () => {
  const picked = [{ id: 'cmd:review', label: '复盘', trigger: '/' }, { id: 'item:a', label: '原稿', trigger: '@' }]
  assert.equal(mentionMessage('', picked), '/复盘 @原稿')
  assert.equal(mentionMessage('  请分析这篇  ', picked), '请分析这篇')
  assert.equal(mentionMessage('  ', []), '')
})

test('提及：输入法 Enter 的 composing 和 keyCode 229 都不能触发候选或发送', () => {
  assert.equal(isComposing({ nativeEvent: { isComposing: true } }), true)
  assert.equal(isComposing({ nativeEvent: { keyCode: 229 } }), true)
  assert.equal(isComposing({ keyCode: 229 }), true)
  assert.equal(isComposing({}, true), true)
  assert.equal(Boolean(isComposing({ key: 'Enter', nativeEvent: {} })), false)
})

test('提及：帮助、错误、数量和移除引用的辅助标签均有英文翻译', () => {
  for (const key of ['消息引用', '输入 @ 引用资料，输入 / 选择指令或 DSH Skill。', '已选择的引用与指令', '移除引用 {name}', '最多选择 {max} 个引用或指令', '正在读取引用……', '读取引用失败，请重新输入 @ 或 / 重试', '↑↓ 选择，Enter 或 Tab 确认，Esc 关闭', '可引用的资料', '可用的指令', '没有匹配项', '已选择 {n}/{max} 个引用或指令']) {
    assert.equal(typeof STUDIO[key], 'string', key)
    assert.doesNotMatch(STUDIO[key], /[一-鿿]/u)
    assert.deepEqual(STUDIO[key].match(/\{\w+\}/g), key.match(/\{\w+\}/g))
  }
})

// 使用真实 desk.js 打包，React 由宿主提供；测试只替换宿主与网络，验证实际请求接线。
const deskBundle = await build({
  entryPoints: [fileURLToPath(new URL('../client/desk.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
})

function deskFixture(respond) {
  const requests = []
  const state = { chat: [], items: [] }
  const sandbox = {
    module: { exports: {} }, require: name => { assert.equal(name, 'react'); return {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined
      requests.push({ url, body })
      const response = respond?.(url, body) || { state }
      return { ok: response.httpOk !== false, status: 503, json: async () => response }
    },
  }
  vm.runInNewContext(deskBundle.outputFiles[0].text, sandbox)
  const desk = sandbox.module.exports
  desk.setDesk({ state })
  return { desk, requests, state }
}

test('客户端接线：纯 / 指令请求携带 descriptor，乐观消息也带引用且由服务端状态替换', async () => {
  const mentions = [{ id: 'cmd:review', label: '复盘', trigger: '/' }]
  const persisted = { chat: [{ id: 'server-message', role: 'user', text: '/复盘', mentions }], items: [] }
  const { desk, requests } = deskFixture(() => ({ state: persisted, modelOk: true }))
  const sending = desk.sendChat('', { mentions })
  assert.deepEqual(JSON.parse(JSON.stringify(desk.getDesk().state.chat[0].mentions)), mentions)
  assert.equal(await sending, true)
  assert.deepEqual(requests, [{ url: 'media-desk/chat', body: { message: '/复盘', mentions } }])
  assert.equal(desk.getDesk().state.chat[0].id, 'server-message')
  assert.equal(desk.getDesk().thinking, false)
})

test('客户端接线：发送空白消息不发请求，进行中不能重复提交', async () => {
  const { desk, requests } = deskFixture()
  assert.equal(await desk.sendChat(' '), false)
  desk.setDesk({ thinking: true })
  assert.equal(await desk.sendChat('重复'), false)
  assert.equal(requests.length, 0)
})

test('客户端接线：失败返回 false 并结束 thinking，相同引用可原样重试', async () => {
  let failed = true
  const mentions = [{ id: 'cmd:review', label: '复盘', trigger: '/' }]
  const { desk, requests } = deskFixture(url => url.endsWith('/chat') && failed ? { httpOk: false, error: 'offline' } : null)
  assert.equal(await desk.sendChat('', { mentions }), false)
  assert.equal(desk.getDesk().thinking, false)
  failed = false
  assert.equal(await desk.sendChat('', { mentions }), true)
  assert.equal(requests.filter(row => row.url.endsWith('/chat')).length, 2)
  assert.deepEqual(requests.filter(row => row.url.endsWith('/chat')).map(row => row.body), [{ message: '/复盘', mentions }, { message: '/复盘', mentions }])
})

test('客户端接线：成稿 action 保留服务端解析的 mentions，普通成稿不强加引用', async () => {
  const mentions = [{ id: 'style:own', label: '我的风格' }]
  const { desk, requests, state } = deskFixture(url => ({ state, actions: url.endsWith('/chat') ? [{ type: 'produce', id: 'a', mentions }] : [] }))
  await desk.sendChat('成稿', { mentions })
  assert.deepEqual(requests.find(row => row.url.endsWith('/produce')).body, { id: 'a', mentions })
  await desk.runProduce('b', { withImages: false })
  assert.deepEqual(requests.at(-1).body, { id: 'b', withImages: false })
})

test('客户端接线：每次读取引用都请求当前清单，不缓存过期内容', async () => {
  let version = 0
  const { desk } = deskFixture(() => ({ contexts: [{ id: String(++version) }], commands: [] }))
  assert.equal((await desk.fetchMentions()).contexts[0].id, '1')
  assert.equal((await desk.fetchMentions()).contexts[0].id, '2')
})

// 渲染真实 ChatPanel，替换宿主 hooks/网络；直接调用 JSX 上的事件处理器。
const chatBundle = await build({
  entryPoints: [fileURLToPath(new URL('../client/chat.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'chat-host', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'chat-host' }))
    builder.onResolve({ filter: /^\.\/desk\.js$/ }, () => ({ path: 'desk', namespace: 'chat-host' }))
    builder.onResolve({ filter: /^\.\/ui\.jsx$/ }, () => ({ path: 'ui', namespace: 'chat-host' }))
    builder.onLoad({ filter: /.*/, namespace: 'chat-host' }, ({ path }) => ({ contents: path === 'react'
      ? 'export default globalThis.fixture.React'
      : path === 'ui' ? 'export function Icon(){}; export function IconButton(){}'
        : `const f=globalThis.fixture; export const useDesk=s=>s(f.snapshot); export const fetchMentions=()=>f.fetchMentions(); export const sendChat=(...args)=>f.sendChat(...args); export function clearChat(){}; export function openItem(){}; export function setDesk(){}; export function undo(){}`, loader: 'js' }))
  } }],
})

function chatFixture() {
  const fixture = {
    snapshot: { state: { chat: [], items: [] }, thinking: false, chatQuote: null },
    catalog: { contexts: [{ id: 'item:a', name: 'alpha' }], commands: [{ id: 'cmd:insights', name: '复盘' }] },
    calls: [], reads: 0, sendResult: async () => true,
  }
  const slots = [], dependencies = new Map(), cleanups = new Map()
  let hook = 0, pending = [], dirty = true, tree
  const element = { value: '', selectionStart: 0, selectionEnd: 0, style: {}, scrollHeight: 32, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  const effect = (callback, deps) => {
    const index = hook++, before = dependencies.get(index)
    if (!deps || !before || deps.some((value, i) => !Object.is(value, before[i]))) {
      dependencies.set(index, deps)
      pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, callback()) })
    }
  }
  fixture.React = {
    useState(initial) { const index = hook++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true } }] },
    useRef(initial) { const index = hook++; return slots[index] ||= { current: initial } },
    useId() { const index = hook++; return `test-${index}` },
    useMemo: callback => callback(), useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore: (_, getter) => getter(),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  }
  fixture.fetchMentions = async () => { fixture.reads++; return fixture.catalog }
  fixture.sendChat = async (...args) => {
    fixture.calls.push(args)
    fixture.snapshot.thinking = true
    dirty = true
    try { return await fixture.sendResult(...args) } finally { fixture.snapshot.thinking = false; dirty = true }
  }
  const sandbox = { fixture, module: { exports: {} }, document: { documentElement: { lang: 'zh' }, getElementById: () => null }, navigator: { language: 'zh' } }
  vm.runInNewContext(chatBundle.outputFiles[0].text, sandbox)
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
  const nodes = predicate => walk(tree).filter(predicate)
  const input = () => nodes(node => node.type === 'textarea')[0]
  fixture.render = () => {
    dirty = true
    let rounds = 0
    while (dirty || pending.length) {
      if (++rounds > 30) throw new Error('ChatPanel did not settle')
      dirty = false
      hook = 0
      tree = sandbox.module.exports.ChatPanel({ head: 'Assistant' })
      input().props.ref.current = element
      element.value = input().props.value
      for (const run of pending.splice(0)) run()
    }
    return tree
  }
  fixture.settle = async () => { await new Promise(resolve => setImmediate(resolve)); fixture.render() }
  fixture.change = (value, caret = value.length) => { element.value = value; element.selectionStart = element.selectionEnd = caret; input().props.onChange({ target: element }); fixture.render() }
  fixture.press = key => { input().props.onKeyDown({ key, nativeEvent: {}, preventDefault() {} }); fixture.render() }
  fixture.input = input
  fixture.element = element
  fixture.nodes = nodes
  fixture.render()
  return fixture
}

test('ChatPanel：纯 / 指令可发送，失败保留引用并可重试；等待时禁止改动输入', async () => {
  const chat = chatFixture()
  chat.change('/复盘')
  await chat.settle()
  chat.press('Enter')
  assert.equal(chat.input().props.value, '')
  assert.equal(chat.nodes(node => node.props.className === 'md-mention-chip').length, 1)
  assert.equal(chat.nodes(node => node.props.className === 'md-send')[0].props.disabled, false)
  let finish
  chat.sendResult = () => new Promise(resolve => { finish = resolve })
  chat.press('Enter')
  assert.equal(chat.input().props.disabled, true)
  assert.equal(chat.calls[0][0], '/复盘')
  finish(false)
  await chat.settle()
  assert.equal(chat.nodes(node => node.props.className === 'md-mention-chip').length, 1)
  assert.equal(chat.input().props.disabled, false)
  chat.sendResult = async () => true
  chat.press('Enter')
  await chat.settle()
  assert.equal(chat.calls.length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(chat.calls[0])), JSON.parse(JSON.stringify(chat.calls[1])))
  assert.equal(chat.nodes(node => node.props.className === 'md-mention-chip').length, 0)
})

test('ChatPanel：移动光标关闭旧浮层，不能删除后面的原稿；重新打开读取新候选', async () => {
  const chat = chatFixture()
  chat.change('@alpha 保留这段原稿', 6)
  await chat.settle()
  const staleOption = chat.nodes(node => node.props.role === 'option')[0]
  chat.element.selectionStart = chat.element.selectionEnd = chat.element.value.length
  chat.input().props.onSelect({ target: chat.element })
  chat.render()
  staleOption.props.onClick()
  chat.render()
  assert.equal(chat.input().props.value, '@alpha 保留这段原稿')
  assert.equal(chat.nodes(node => node.props.role === 'listbox').length, 0)
  chat.catalog = { contexts: [{ id: 'item:new', name: 'new' }], commands: [] }
  chat.change('@new')
  await chat.settle()
  assert.equal(chat.reads, 2)
  assert.equal(chat.nodes(node => node.props.role === 'option').length, 1)
})

test('ChatPanel：正文与引用发送失败时同时保留，成功重试后一起清空', async () => {
  const chat = chatFixture()
  chat.change('@alpha')
  await chat.settle()
  chat.press('Enter')
  chat.change('请分析这篇原稿')
  chat.sendResult = async () => false
  chat.press('Enter')
  await chat.settle()
  assert.equal(chat.input().props.value, '请分析这篇原稿')
  assert.equal(chat.nodes(node => node.props.className === 'md-mention-chip').length, 1)
  chat.sendResult = async () => true
  chat.press('Enter')
  await chat.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(chat.calls[0])), JSON.parse(JSON.stringify(chat.calls[1])))
  assert.equal(chat.input().props.value, '')
  assert.equal(chat.nodes(node => node.props.className === 'md-mention-chip').length, 0)
})

test('ChatPanel：输入法 Enter 不选候选、不发送，组合结束后可鼠标选择', async () => {
  const chat = chatFixture()
  chat.input().props.onCompositionStart()
  chat.change('/复盘')
  chat.press('Enter')
  assert.equal(chat.calls.length, 0)
  assert.equal(chat.nodes(node => node.props.role === 'listbox').length, 0)
  chat.input().props.onCompositionEnd({ target: chat.element })
  chat.render()
  await chat.settle()
  const option = chat.nodes(node => node.props.role === 'option')[0]
  option.props.onMouseDown({ preventDefault() {} })
  option.props.onClick()
  chat.render()
  assert.equal(chat.nodes(node => node.props.className === 'md-mention-chip').length, 1)
  assert.equal(chat.calls.length, 0)
})
