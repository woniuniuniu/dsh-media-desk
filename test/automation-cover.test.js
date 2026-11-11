import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'

test('shared cover painter renders Chinese/English JPEG 1920x1080 and actual article/storyboard export', async t => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const { renderProductionCover } = await import('../src/automation/cover.js')
  const { createAutomationService } = await import('../src/automation/service.js')
  const root = await mkdtemp(join(tmpdir(), 'md-cover-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root); await store.read()
  const sample = createCanvas(10, 10); sample.getContext('2d').fillRect(0, 0, 10, 10)
  await writeFile(join(store.filesDir, 'cover.png'), sample.toBuffer('image/png'))
  const production = { status: 'done', title: '中文 English', article: '## 外部稿\nbody', coverText: '中文知识卡片 English', cover: { src: 'media-desk/files/cover.png' }, images: [], shots: [{ visual: '画面', voice: '旁白', seconds: 5 }] }
  const jpeg = await renderProductionCover(production, { filesDir: store.filesDir })
  assert.equal(jpeg[0], 255); assert.equal(jpeg[1], 216)
  const img = await loadImage(jpeg); assert.equal(img.width, 1920); assert.equal(img.height, 1080)
  await store.mutate('draft', s => { s.items = [{ id: 'test', title: 'draft', status: 'draft', production }] })
  const service = createAutomationService({ store, producer: { isRunning: () => false, anyAssetActive: () => false }, settings: { read: async () => ({ exportDir: join(root, 'exports') }) } })
  const result = await service.call({ tool: 'media_desk_export', input: { id: 'test' }, requestId: 'export-one' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.result.files.some(f => f.endsWith('.jpg')))
  assert.ok(result.result.files.filter(f => f.endsWith('.md')).length === 2)
  assert.match(await readFile(join(result.result.path, result.result.files.find(f => f.endsWith('.md'))), 'utf8'), /外部稿/)
  assert.equal((await store.read()).items[0].production.savedPath, result.result.path)
})
test('headless renderer refuses arbitrary URLs, paths, symlinks and unreadable images', async t => {
  const { renderProductionCover, validateProductionAssets } = await import('../src/automation/cover.js')
  const root = await mkdtemp(join(tmpdir(), 'md-asset-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const src of ['https://example.com/secret.png', '/etc/passwd', 'media-desk/files/../secret.png', 'media-desk/files/missing.png']) {
    await assert.rejects(renderProductionCover({ title: 'x', cover: { src } }, { filesDir: root }), /asset|image|cover/i)
  }
  await symlink('/etc/hosts', join(root, 'link.png'))
  await assert.rejects(validateProductionAssets({ cover: { src: 'media-desk/files/link.png' } }, root), /asset/i)
  await writeFile(join(root, 'bad.png'), 'not an image')
  await assert.rejects(renderProductionCover({ title: 'x', cover: { src: 'media-desk/files/bad.png' } }, { filesDir: root }), /image|cover/i)
})
