import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../client/card.jsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'media-host', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'media-host' }))
    builder.onResolve({ filter: /^\.\/desk\.js$/ }, () => ({ path: 'desk', namespace: 'media-host' }))
    builder.onResolve({ filter: /^\.\/ui\.jsx$/ }, () => ({ path: 'ui', namespace: 'media-host' }))
    builder.onLoad({ filter: /.*/, namespace: 'media-host' }, ({ path }) => ({ contents: path === 'react' ? 'export default globalThis.fixture.React' : path === 'ui' ? 'export function Icon(){}' : 'const f=globalThis.fixture;export const useDesk=s=>s(f.snapshot);export function setDesk(){}' }))
  } }],
})

function mediaNode() {
  const attributes = new Map(), calls = []
  return { attributes, calls, play: () => { calls.push('play'); return Promise.resolve() }, pause: () => calls.push('pause'), load: () => calls.push('load'), getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => { attributes.set(key, value); calls.push(`set:${key}`) }, removeAttribute: key => { attributes.delete(key); calls.push(`remove:${key}`) } }
}

function fixture(component, initialProps) {
  const f = { snapshot: { focusId: null }, props: initialProps, dom: mediaNode() }
  const slots = [], deps = new Map(), cleanups = new Map(), setups = new Map()
  let hook = 0, dirty = true, pending = [], tree
  f.React = {
    useState(initial) { const index = hook++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true } }] },
    useRef(initial) { const index = hook++; return slots[index] ||= { current: initial } },
    useEffect(setup, next) { const index = hook++, previous = deps.get(index); setups.set(index, setup); if (!previous || next.some((value, at) => !Object.is(value, previous[at]))) { deps.set(index, next); pending.push(() => { cleanups.get(index)?.(); cleanups.set(index, setup()) }) } },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  }
  const sandbox = { fixture: f, module: { exports: {} } }
  vm.runInNewContext(bundle.outputFiles[0].text, sandbox)
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []
  f.nodes = predicate => walk(tree).filter(predicate)
  f.render = () => {
    dirty = true
    while (dirty || pending.length) {
      dirty = false; hook = 0
      tree = sandbox.module.exports[component](f.props)
      if (tree.props.ref) {
        tree.props.ref.current = f.dom
        if (tree.props.src === undefined) f.dom.attributes.delete('src')
        else f.dom.attributes.set('src', tree.props.src)
      }
      for (const run of pending.splice(0)) run()
    }
    return tree
  }
  f.unmount = () => { for (const cleanup of cleanups.values()) cleanup?.() }
  f.replay = () => { f.unmount(); for (const [index, setup] of setups) cleanups.set(index, setup()) }
  f.render()
  return f
}

const video = { id: 'video-a', title: '视频素材', kind: 'video', status: 'idea', media: { src: '/media-desk/files/a.mp4', poster: '/media-desk/files/a.jpg' } }

test('后台卡片：编辑器打开时卸载 Media、保留卡片外壳，关闭后恢复且不残留 hover 自动播放', () => {
  const f = fixture('Card', { item: video })
  const card = f.render()
  card.props.onPointerEnter(); f.render()
  assert.equal(f.nodes(node => node.type?.name === 'Media')[0].props.autoPlay, true)
  f.snapshot.focusId = 'editing-another-item'
  const focused = f.render()
  assert.equal(f.nodes(node => node.type?.name === 'Media').length, 0)
  assert.equal(focused.type, 'article')
  assert.equal(focused.props['data-card'], video.id)
  f.snapshot.focusId = null
  f.render()
  assert.equal(f.nodes(node => node.type?.name === 'Media')[0].props.autoPlay, false)
})

test('后台视频：idle 不绑定 mp4 src，hover 才播放；卸载主动 pause/remove src/load 取消加载', () => {
  const f = fixture('Media', { item: video })
  assert.equal(f.render().props.src, undefined)
  assert.equal(f.render().props.preload, 'none')
  f.props = { item: video, autoPlay: true }
  assert.equal(f.render().props.src, video.media.src)
  assert.ok(f.dom.calls.includes('play'))
  const old = f.dom
  f.render().props.ref.current = mediaNode()
  f.unmount()
  assert.deepEqual(old.calls.slice(-4), ['pause', 'remove:srcset', 'remove:src', 'load'])
  assert.equal(old.getAttribute('src'), null)
})

test('后台图片：cleanup 清 captured 节点 src/srcset，StrictMode 重放恢复展示，不修改素材数据', () => {
  const item = { ...video, kind: 'image', media: { src: '/media-desk/files/a.jpg' } }
  const before = JSON.stringify(item)
  const f = fixture('Media', { item })
  f.dom.attributes.set('srcset', 'example.jpg 2x')
  f.replay()
  assert.equal(f.dom.getAttribute('src'), item.media.src)
  assert.equal(f.dom.getAttribute('srcset'), null)
  f.unmount()
  assert.equal(f.dom.getAttribute('src'), null)
  assert.equal(JSON.stringify(item), before)
})
