import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Store } from '../src/store.js'
import { name } from '../src/host.js'

test('数据目录是 x-desk，不是 media-desk', () => {
  const store = new Store()
  assert.match(store.root, /[\\/]x-desk$/)
})
test('包名和插件名都是 dsh-x-desk', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-x-desk')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(name, 'dsh-x-desk')
})
test('源码里不再出现 media-desk', async () => {
  for (const file of ['src/host.js', 'src/store.js', 'src/ai.js', 'client/desk.js', 'client/index.jsx', 'cordis.patch.yml', 'scripts/dev-sandbox.sh']) {
    assert.doesNotMatch(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /media-desk/, file)
  }
})
