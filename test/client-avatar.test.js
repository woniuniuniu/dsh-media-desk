import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const elements = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(elements)]
const textOf = tree => !tree || typeof tree !== 'object' ? String(tree ?? '') : tree.children.flat(Infinity).map(textOf).join(' ')
async function browser(entry, { fetch = async () => { throw Error('Unexpected request') }, globals = {} } = {}) {
  const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'avatar-test.js' }, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'], loader: { '.css': 'text' } })
  let slots = [], effects = [], refs = []
  const componentStates = new Map()
  let stateIndex = 0, effectIndex = 0, refIndex = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment',
    useState: initial => { const at = stateIndex++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
    useRef: value => { const at = refIndex++; return refs[at] ??= { current: value } },
    useEffect: (fn, deps) => { const at = effectIndex++, old = effects[at]; if (!old || !deps || deps.some((dep, i) => dep !== old.deps[i])) { old?.cleanup?.(); effects[at] = { deps, pending: fn } } },
    useSyncExternalStore: (subscribe, read) => read(), useMemo: fn => fn(), useCallback: fn => fn,
  }
  react.useLayoutEffect = react.useEffect
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: name => { assert.equal(name, 'react'); return react }, fetch, window: { addEventListener() {}, removeEventListener() {} }, URL, Blob, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, ...globals })
  return { api: module.exports, render: (Component, props = {}) => { if (!componentStates.has(Component)) componentStates.set(Component, [[], [], []]); [slots, effects, refs] = componentStates.get(Component); stateIndex = effectIndex = refIndex = 0; const tree = Component(props); for (const row of effects) if (row.pending) { row.cleanup = row.pending(); delete row.pending } return tree }, unmount: () => { for (const row of effects) row.cleanup?.() } }
}
const initial = () => ({ accounts: [{ id: 'a', platform: '快手', handle: 'A profile', avatar: 'media-desk/files/a.png' }], items: [], metrics: [], skills: [], chat: [], styles: [] })
const formEntry = "export { AccountForm } from './client/accounts.jsx'; export * from './client/desk.js'"
const button = (tree, label) => elements(tree).find(node => node.type === 'button' && textOf(node) === label)
const input = (tree, label) => elements(tree).find(node => node.type === 'label' && textOf(node).startsWith(label)).children.flat(Infinity).find(node => node?.type === 'input')
const fileInput = tree => elements(tree).find(node => node.type === 'input' && node.props.type === 'file')
const submit = tree => elements(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })

const imageEnvironment = () => {
  const draws = [], revoked = [], decoded = [], encoded = []
  let next = 0
  return { draws, revoked, decoded, encoded, globals: {
    URL: class extends URL { static createObjectURL() { return `blob:preview-${++next}` } static revokeObjectURL(src) { revoked.push(src) } },
    createImageBitmap: async file => { decoded.push(file); return { width: 800, height: 400, close() {} } },
    document: { documentElement: { lang: 'zh' }, createElement: tag => { assert.equal(tag, 'canvas'); return { width: 0, height: 0, getContext: () => ({ fillRect() { throw Error('Transparent logo backgrounds must be preserved') }, drawImage(...args) { draws.push(args) } }), toBlob: function(callback, type, quality) { assert.equal(this.width, 256); assert.equal(this.height, 256); encoded.push({ type, quality }); callback(new Blob(['small image'], { type })) } } } },
  } }
}

test('rendered account list, profile and workspace show avatars only for actual accounts', async () => {
  const h = await browser("export * from './client/accounts.jsx'; export * from './client/index.jsx'; export * from './client/desk.js'")
  h.api.setDesk({ state: initial() })
  let tree = h.render(h.api.RootAccountsView)
  assert.equal(elements(tree).filter(node => node.type?.name === 'AccountAvatar').length, 1)
  assert.ok(button(tree, 'A profile'))
  let Desk
  h.api.apply({ slots: { inject: (name, fn) => fn(), register: (options, component) => { Desk = component } }, effect() {} })
  h.api.selectAccount('a')
  assert.equal(elements(h.render(Desk)).find(node => node.type?.name === 'AccountAvatar').props.account.id, 'a')
  assert.equal(elements(h.render(h.api.AccountProfileView)).find(node => node.type?.name === 'AccountAvatar').props.account.id, 'a')
  for (const scope of [undefined, null]) {
    h.api.selectAccount(scope)
    assert.equal(elements(h.render(Desk)).some(node => node.type?.name === 'AccountAvatar'), false)
    assert.equal(elements(h.render(h.api.AccountProfileView)).some(node => node.type?.name === 'AccountAvatar'), false)
  }
})

test('avatar fallback is stable, rejects unsafe sources, recovers after URL change and ignores stale image failures', async () => {
  const h = await browser("export * from './client/account-avatar.jsx'")
  const account = { id: 'a', handle: 'Alice Brown', avatar: 'https://example.com/old.png' }
  let tree = h.render(h.api.AccountAvatar, { account })
  let img = elements(tree).find(node => node.type === 'img')
  assert.equal(img.props.loading, 'lazy')
  assert.equal(img.props.referrerPolicy, 'no-referrer')
  const oldError = img.props.onError
  oldError()
  tree = h.render(h.api.AccountAvatar, { account })
  assert.equal(elements(tree).some(node => node.type === 'img'), false)
  assert.match(textOf(tree), /AB/)
  const background = tree.props.style.backgroundColor
  account.avatar = 'https://example.com/new.png'
  tree = h.render(h.api.AccountAvatar, { account })
  assert.equal(elements(tree).find(node => node.type === 'img').props.src, account.avatar)
  oldError()
  tree = h.render(h.api.AccountAvatar, { account })
  assert.ok(elements(tree).some(node => node.type === 'img'))
  account.avatar = 'javascript:alert(1)'
  tree = h.render(h.api.AccountAvatar, { account })
  assert.equal(elements(tree).some(node => node.type === 'img'), false)
  assert.equal(tree.props.style.backgroundColor, background)
})

test('avatar image preparation rejects invalid files and center crops to a compressed 256 square', async () => {
  const env = imageEnvironment()
  const h = await browser("export * from './client/avatar-image.js'", { globals: env.globals })
  for (const file of [{ type: 'image/gif', size: 4 }, { type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }]) await assert.rejects(() => h.api.prepareAvatarImage(file))
  assert.equal(env.decoded.length, 0)
  const blob = await h.api.prepareAvatarImage({ type: 'image/png', size: 20 })
  assert.equal(blob.type, 'image/webp')
  assert.deepEqual(env.draws[0].slice(1), [200, 0, 400, 400, 0, 0, 256, 256])
  assert.equal(env.encoded[0].type, 'image/webp')
  assert.ok(env.encoded[0].quality < 1)
  const broken = await browser("export * from './client/avatar-image.js'", { globals: { ...env.globals, createImageBitmap: async () => { throw Error('decode') } } })
  await assert.rejects(() => broken.api.prepareAvatarImage({ type: 'image/jpeg', size: 20 }), /图片/)
})

test('account form defers avatar upload until Save, reuses successful upload on retry and persists original identity', async () => {
  const env = imageEnvironment(), requests = []
  let saves = 0, closed = 0
  const state = initial()
  const h = await browser(formEntry, { globals: env.globals, fetch: async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('upload')) return { ok: true, json: async () => ({ src: 'media-desk/files/new.jpg', kind: 'image' }) }
    const body = JSON.parse(options.body)
    assert.equal(body.ops[0].id, 'a')
    assert.equal(body.ops[0].avatar, 'media-desk/files/new.jpg')
    if (++saves === 1) return { ok: false, json: async () => ({ error: 'Save unavailable' }) }
    return { ok: true, json: async () => ({ state, receipts: [], errors: [] }) }
  } })
  h.api.setDesk({ state })
  const props = { account: state.accounts[0], styles: [], onClose: () => closed++ }
  let tree = h.render(h.api.AccountForm, props)
  assert.equal(fileInput(tree).props.accept, 'image/jpeg,image/png,image/webp')
  await fileInput(tree).props.onChange({ target: { files: [{ type: 'image/png', size: 30 }], value: 'chosen' } })
  tree = h.render(h.api.AccountForm, props)
  assert.equal(requests.length, 0)
  assert.match(textOf(tree), /5 MB/)
  const first = submit(tree)
  await submit(tree)
  await first
  assert.equal(requests.filter(r => r.url.endsWith('upload')).length, 1)
  assert.equal(closed, 0)
  tree = h.render(h.api.AccountForm, props)
  assert.match(textOf(tree), /保存失败/)
  h.api.selectAccount(null)
  await submit(tree)
  assert.equal(requests.filter(r => r.url.endsWith('upload')).length, 1)
  assert.equal(closed, 1)
  h.unmount()
  assert.deepEqual(env.revoked, ['blob:preview-1'])
})

test('account form removal and URL edits supersede pending processing; cancel never uploads', async () => {
  const env = imageEnvironment(), requests = []
  let finishDecode, closed = 0
  const state = initial()
  const h = await browser(formEntry, { globals: { ...env.globals, createImageBitmap: () => new Promise(resolve => { finishDecode = resolve }) }, fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ state, receipts: [], errors: requests.length === 1 ? ['Try again'] : [] }) } } })
  h.api.setDesk({ state })
  const props = { account: state.accounts[0], styles: [], onClose: () => closed++ }
  let tree = h.render(h.api.AccountForm, props)
  const processing = fileInput(tree).props.onChange({ target: { files: [{ type: 'image/jpeg', size: 30 }], value: 'chosen' } })
  tree = h.render(h.api.AccountForm, props)
  assert.equal(button(tree, '保存账号').props.disabled, true)
  input(tree, '头像链接').props.onChange({ target: { value: 'https://example.com/final.png' } })
  finishDecode({ width: 400, height: 800, close() {} })
  await processing
  tree = h.render(h.api.AccountForm, props)
  await submit(tree)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.ops[0].avatar, 'https://example.com/final.png')
  assert.equal(requests[0].body.ops[0].id, 'a')
  tree = h.render(h.api.AccountForm, props)
  button(tree, '移除头像').props.onClick()
  tree = h.render(h.api.AccountForm, props)
  await submit(tree)
  assert.equal(requests[1].body.ops[0].avatar, null)
  const second = await browser(formEntry, { globals: env.globals, fetch: async () => { throw Error('Cancel must not upload') } })
  let cancelled = second.render(second.api.AccountForm, { ...props, onClose: () => closed++ })
  await fileInput(cancelled).props.onChange({ target: { files: [{ type: 'image/png', size: 30 }] } })
  cancelled = second.render(second.api.AccountForm, { ...props, onClose: () => closed++ })
  button(cancelled, '取消').props.onClick()
  second.unmount()
  assert.ok(env.revoked.length)
})

test('editing ordinary fields preserves concurrent avatars and rejects explicitly invalid links or files before requests', async () => {
  const env = imageEnvironment(), requests = [], state = initial()
  const h = await browser(formEntry, { globals: env.globals, fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ state, receipts: [], errors: ['Keep form open'] }) } } })
  h.api.setDesk({ state })
  const props = { account: state.accounts[0], styles: [], onClose() {} }
  let tree = h.render(h.api.AccountForm, props)
  assert.equal(input(tree, '头像链接').props.type, 'text')
  assert.equal(input(tree, '头像链接').props.value, '', 'Internal image paths stay out of the URL field')
  assert.equal(elements(tree).find(node => node.type?.name === 'AccountAvatar').props.account.avatar, 'media-desk/files/a.png')
  input(tree, '分组').props.onChange({ target: { value: 'ordinary edit' } })
  tree = h.render(h.api.AccountForm, props)
  await submit(tree)
  assert.equal(Object.hasOwn(requests[0].ops[0], 'avatar'), false, 'An untouched avatar must not overwrite a concurrent robot update')
  assert.equal(requests[0].ops[0].group, 'ordinary edit')
  tree = h.render(h.api.AccountForm, props)
  input(tree, '头像链接').props.onChange({ target: { value: 'data:image/png;base64,AAAA' } })
  tree = h.render(h.api.AccountForm, props)
  await submit(tree)
  assert.equal(requests.length, 1)
  assert.match(textOf(h.render(h.api.AccountForm, props)), /头像链接无效/)
  tree = h.render(h.api.AccountForm, props)
  await fileInput(tree).props.onChange({ target: { files: [{ type: 'image/gif', size: 30 }] } })
  assert.match(textOf(h.render(h.api.AccountForm, props)), /请选择 JPEG/)
  assert.equal(requests.length, 1)
})

test('unmounting during avatar upload never saves an account and cleans its preview', async () => {
  const env = imageEnvironment(), requests = [], state = initial()
  let finishUpload
  const h = await browser(formEntry, { globals: env.globals, fetch: (url, options) => { requests.push({ url, options }); return new Promise(resolve => { finishUpload = resolve }) } })
  h.api.setDesk({ state })
  const props = { account: state.accounts[0], styles: [], onClose() {} }
  let tree = h.render(h.api.AccountForm, props)
  await fileInput(tree).props.onChange({ target: { files: [{ type: 'image/png', size: 30 }] } })
  tree = h.render(h.api.AccountForm, props)
  const pending = submit(tree)
  h.unmount()
  finishUpload({ ok: true, json: async () => ({ src: 'media-desk/files/orphan.webp' }) })
  await pending
  assert.equal(requests.length, 1)
  assert.ok(requests[0].url.endsWith('upload'))
  assert.deepEqual(env.revoked, ['blob:preview-1'])
})

test('late image processing cannot replace a newer choice and upload errors keep the form retryable', async () => {
  const env = imageEnvironment(), decodes = [], state = initial(), requests = []
  const h = await browser(formEntry, { globals: { ...env.globals, createImageBitmap: () => new Promise(resolve => decodes.push(resolve)) }, fetch: async (url, options) => {
    requests.push({ url, options })
    if (requests.length === 1) return { ok: false, json: async () => ({ error: 'Upload offline' }) }
    if (url.endsWith('upload')) return { ok: true, json: async () => ({ src: 'media-desk/files/second.webp' }) }
    return { ok: true, json: async () => ({ state, receipts: [], errors: [] }) }
  } })
  h.api.setDesk({ state })
  const props = { account: state.accounts[0], styles: [], onClose() {} }
  let tree = h.render(h.api.AccountForm, props)
  const first = fileInput(tree).props.onChange({ target: { files: [{ type: 'image/png', size: 20 }] } })
  const second = fileInput(tree).props.onChange({ target: { files: [{ type: 'image/jpeg', size: 30 }] } })
  decodes[1]({ width: 400, height: 800, close() {} })
  await second
  const preview = elements(h.render(h.api.AccountForm, props)).find(node => node.type === 'img').props.src
  decodes[0]({ width: 800, height: 400, close() {} })
  await first
  tree = h.render(h.api.AccountForm, props)
  assert.equal(elements(tree).find(node => node.type === 'img').props.src, preview)
  await submit(tree)
  tree = h.render(h.api.AccountForm, props)
  assert.match(textOf(tree), /Upload offline/)
  assert.equal(button(tree, '保存账号').props.disabled, false)
  assert.equal(requests.length, 1)
  await submit(tree)
  assert.equal(requests.length, 3)
  assert.equal(JSON.parse(requests[2].options.body).ops[0].avatar, 'media-desk/files/second.webp')
  assert.deepEqual(env.revoked, ['blob:preview-1'])
})


test('choosing a local avatar hides the old remote link and typing a new URL replaces the preview', async () => {
  const env = imageEnvironment(), requests = [], state = initial()
  state.accounts[0].avatar = 'https://example.com/original.png'
  let finishDecode
  const h = await browser(formEntry, { globals: { ...env.globals, createImageBitmap: () => new Promise(resolve => { finishDecode = resolve }) }, fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ state, receipts: [], errors: [] }) } } })
  h.api.setDesk({ state })
  const props = { account: state.accounts[0], styles: [], onClose() {} }
  let tree = h.render(h.api.AccountForm, props)
  assert.equal(input(tree, '头像链接').props.value, state.accounts[0].avatar)
  const pending = fileInput(tree).props.onChange({ target: { files: [{ type: 'image/png', size: 30 }] } })
  tree = h.render(h.api.AccountForm, props)
  assert.equal(input(tree, '头像链接').props.value, '', 'Pending local selection must hide the old remote URL')
  finishDecode({ width: 800, height: 400, close() {} })
  await pending
  tree = h.render(h.api.AccountForm, props)
  assert.ok(elements(tree).some(node => node.type === 'img' && node.props.src.startsWith('blob:')))
  assert.equal(input(tree, '头像链接').props.value, '')
  input(tree, '头像链接').props.onChange({ target: { value: 'h' } })
  tree = h.render(h.api.AccountForm, props)
  assert.equal(input(tree, '头像链接').props.value, 'h', 'Partial typing remains visible')
  assert.equal(elements(tree).some(node => node.type === 'img'), false)
  input(tree, '头像链接').props.onChange({ target: { value: 'https://example.com/replacement.png' } })
  tree = h.render(h.api.AccountForm, props)
  assert.equal(input(tree, '头像链接').props.value, 'https://example.com/replacement.png')
  await submit(tree)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.ops[0].avatar, 'https://example.com/replacement.png')
  assert.deepEqual(env.revoked, ['blob:preview-1'])
})
