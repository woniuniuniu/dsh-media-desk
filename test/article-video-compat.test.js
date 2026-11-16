import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { saveProduction } from '../src/export.js'
import { withLang } from '../src/i18n.js'
import { applyOps } from '../src/ops.js'
import { Producer } from '../src/produce.js'
import { buildSeed } from '../src/seed.js'
import { creationFormat, productionFor } from '../src/workflow.js'

function fixture(production) {
  const state = buildSeed(new Date('2026-11-16T00:00:00Z'))
  state.items = [{ id: 'target', title: 'An idea', kind: 'note', status: 'idea', tags: [], drafts: {}, ...(production ? { production } : {}) }]
  return state
}

function memoryStore(state, filesDir) {
  return {
    filesDir,
    read: async () => structuredClone(state),
    mutate: async (_label, mutate) => mutate(state),
  }
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Background operation did not finish')
}

test('article/video switching preserves both products, old assets, save paths, and legacy script interpretation', () => {
  const video = { status: 'done', title: 'Video title', article: 'Video script', savedPath: '/exports/video', savedHashes: { 'script.md': 'video-hash' }, cover: { status: 'done', src: 'media-desk/files/video.png' }, images: [], shots: [{ status: 'done', voice: 'Keep this', src: 'media-desk/files/shot.png' }] }
  const state = fixture(structuredClone(video)), item = state.items[0]
  state.draftFormat = 'article'
  const beforeRead = JSON.stringify(item)
  assert.equal(creationFormat(item, state.draftFormat), 'script', 'a legacy product without format remains a video')
  assert.deepEqual(productionFor(item, 'script'), video)
  assert.equal(JSON.stringify(item), beforeRead, 'reading must not migrate or rewrite legacy products')
  assert.equal(applyOps(state, [{ op: 'set_creation_format', id: item.id, format: 'article' }]).errors.length, 0)
  assert.equal(item.production, undefined)
  assert.deepEqual(item.productions.script, video)
  const article = { format: 'article', status: 'done', title: 'Article title', article: 'Article paragraphs', savedPath: '/exports/article', savedHashes: { 'article.md': 'article-hash' }, cover: { status: 'done', src: 'media-desk/files/article.png' }, images: [{ status: 'done', src: 'media-desk/files/figure.png' }], shots: [] }
  item.production = structuredClone(article)
  applyOps(state, [{ op: 'set_creation_format', id: item.id, format: 'script' }])
  assert.deepEqual(item.production, video)
  assert.deepEqual(item.productions.article, article)
  applyOps(state, [{ op: 'set_creation_format', id: item.id, format: 'article' }])
  assert.deepEqual(item.production, article)
  assert.deepEqual(item.productions.script, video)
  item.production.article = 'Edited article'
  assert.equal(item.productions.article.article, 'Article paragraphs', 'archived snapshots must not share mutable objects')
})

test('format switching rejects unknown formats and active generation without touching the current product', () => {
  for (const production of [
    { status: 'running', article: 'Keep me' },
    { status: 'done', article: 'Keep me', cover: { status: 'running' } },
    { status: 'done', article: 'Keep me', images: [{ status: 'running' }] },
    { status: 'done', article: 'Keep me', shots: [{ status: 'running' }] },
  ]) {
    const state = fixture(production), before = JSON.stringify(state)
    assert.equal(applyOps(state, [{ op: 'set_creation_format', id: 'target', format: 'article' }]).errors.length, 1)
    assert.equal(JSON.stringify(state), before)
  }
  const state = fixture({ status: 'done', article: 'Original' }), before = JSON.stringify(state)
  for (const format of ['video', '__proto__', null, {}]) assert.equal(applyOps(state, [{ op: 'set_creation_format', id: 'target', format }]).errors.length, 1)
  assert.equal(JSON.stringify(state), before)
  applyOps(state, [{ op: 'set_format', format: 'article' }])
  assert.equal(state.draftFormat, 'article', 'the older global preference remains available')
  assert.equal(state.items[0].creationFormat, undefined, 'changing the default must not switch existing products')
})

test('editing an article revokes finalization/image readiness without deleting its existing text or illustrations', () => {
  const state = fixture({ format: 'article', status: 'done', title: 'Title', article: 'Original', cover: { status: 'done', src: 'media-desk/files/cover.png' }, images: [{ src: 'media-desk/files/image.png', status: 'done' }], shots: [{ src: 'media-desk/files/legacy.png' }] })
  const item = state.items[0]
  item.articleWorkflow = { revision: 3, stage: 'images', draftFinalized: true, imagesPlanned: true, imagesStale: false }
  const images = JSON.stringify({ cover: item.production.cover, images: item.production.images, shots: item.production.shots })
  applyOps(state, [{ op: 'update_production', id: item.id, article: 'Revised paragraphs' }])
  assert.equal(item.production.article, 'Revised paragraphs')
  assert.equal(item.articleWorkflow.revision, 4)
  assert.equal(item.articleWorkflow.draftFinalized, false)
  assert.equal(item.articleWorkflow.imagesPlanned, false)
  assert.equal(item.articleWorkflow.imagesStale, true)
  assert.equal(JSON.stringify({ cover: item.production.cover, images: item.production.images, shots: item.production.shots }), images)
  applyOps(state, [{ op: 'update_production', id: item.id, article: 'Revised paragraphs' }])
  assert.equal(item.articleWorkflow.revision, 4, 'a no-op edit must not invalidate again')
  applyOps(state, [{ op: 'update_production', id: item.id, title: 'Revised title' }])
  assert.equal(item.articleWorkflow.revision, 5)
})

test('legacy production edits cannot change an article while its text or images are actively generating', () => {
  for (const running of [
    { status: 'running' },
    { cover: { status: 'running', prompt: 'For the old text' } },
    { images: [{ status: 'running', prompt: 'For the old text' }] },
    { shots: [{ status: 'running', prompt: 'An old asset is still in progress' }] },
  ]) {
    const state = fixture({ format: 'article', status: 'done', title: 'Original title', article: 'Original article', ...running })
    state.items[0].articleWorkflow = { revision: 2, draftFinalized: true, imagesPlanned: true }
    const before = JSON.stringify(state)
    assert.equal(applyOps(state, [{ op: 'update_production', id: 'target', title: 'Changed', article: 'Changed' }]).errors.length, 1)
    assert.equal(JSON.stringify(state), before, 'failed edits must leave the version and its generating assets intact')
  }
  // A suggested article/text job is held in memory and does not set production
  // or assets running: explicit edits are still allowed and stale AI results
  // are handled by ArticleWorkflow's revision/candidate mechanism.
  const state = fixture({ format: 'article', status: 'done', title: 'Title', article: 'Old', cover: { status: 'idle' } })
  assert.equal(applyOps(state, [{ op: 'update_production', id: 'target', article: 'Manual edit during a suggestion' }]).errors.length, 0)
  assert.equal(state.items[0].production.article, 'Manual edit during a suggestion')
})

test('legacy save_draft updates the active article, preserves its previous version, and invalidates finalization', () => {
  const state = fixture({ format: 'article', status: 'done', title: 'Title', article: 'Original article', aiArticle: 'Original AI version', savedPath: '/article', cover: { status: 'done', src: 'media-desk/files/cover.png' }, images: [{ status: 'done', src: 'media-desk/files/figure.png' }] })
  const item = state.items[0]
  item.drafts.article = { text: 'An older shadow', aiText: 'The original draft source' }
  item.articleWorkflow = { revision: 2, draftFinalized: true, imagesPlanned: true, sourcesConfirmed: true, pointConfirmed: true, outlineConfirmed: true }
  assert.equal(applyOps(state, [{ op: 'save_draft', id: 'target', format: 'article', text: 'Current manual article' }]).errors.length, 0)
  assert.equal(item.production.article, 'Current manual article')
  assert.equal(item.drafts.article.text, 'Current manual article')
  assert.equal(item.drafts.article.aiText, 'The original draft source')
  assert.equal(item.production.aiArticle, 'Original AI version')
  assert.equal(item.production.savedPath, '/article')
  assert.equal(item.production.cover.src, 'media-desk/files/cover.png')
  assert.equal(item.articleWorkflow.draftHistory.at(-1).text, 'Original article')
  assert.equal(item.articleWorkflow.revision, 3)
  assert.equal(item.articleWorkflow.draftFinalized, false)
  assert.equal(item.articleWorkflow.imagesPlanned, false)
  assert.equal(item.articleWorkflow.imagesStale, true)
  const revision = item.articleWorkflow.revision
  applyOps(state, [{ op: 'save_draft', id: 'target', format: 'article', text: 'Current manual article' }])
  assert.equal(item.articleWorkflow.revision, revision, 'saving identical text does not add a revision or backup')
})

test('saving an inactive article changes its archive and workflow while leaving the active video byte-identical', () => {
  const state = fixture({ format: 'script', status: 'running', title: 'Video', article: 'Keep the video', savedPath: '/video', cover: { status: 'running', src: 'media-desk/files/video.png' }, shots: [{ voice: 'Keep this line' }] })
  const item = state.items[0]
  item.creationFormat = 'script'
  item.productions = { article: { format: 'article', status: 'done', title: 'Article', article: 'Archived old article', savedPath: '/article', images: [{ src: 'media-desk/files/article.png', status: 'done' }] } }
  item.articleWorkflow = { revision: 4, draftFinalized: true, imagesPlanned: true }
  const videoBefore = JSON.stringify(item.production)
  assert.equal(applyOps(state, [{ op: 'save_draft', id: 'target', format: 'article', text: 'Revised inactive article' }]).errors.length, 0)
  assert.equal(JSON.stringify(item.production), videoBefore)
  assert.equal(item.productions.article.article, 'Revised inactive article')
  assert.equal(item.productions.article.savedPath, '/article')
  assert.equal(item.productions.article.images[0].src, 'media-desk/files/article.png')
  assert.equal(item.articleWorkflow.draftHistory.at(-1).text, 'Archived old article')
  assert.equal(item.articleWorkflow.draftFinalized, false)
  assert.equal(item.articleWorkflow.imagesStale, true)
  // Once the video job is idle, switching back reveals the actual saved article.
  item.production.status = 'done'
  item.production.cover.status = 'done'
  assert.equal(applyOps(state, [{ op: 'set_creation_format', id: 'target', format: 'article' }]).errors.length, 0)
  assert.equal(item.production.article, 'Revised inactive article')
  assert.equal(item.productions.script.article, 'Keep the video')
})

test('saving a drafts-only legacy article retains the old text as history before materializing a current product', () => {
  const state = fixture(), item = state.items[0]
  item.drafts.article = { text: 'Drafts-only old article', aiText: 'Old AI baseline', by: 'user' }
  assert.equal(applyOps(state, [{ op: 'save_draft', id: 'target', format: 'article', text: 'New manual article' }]).errors.length, 0)
  assert.equal(item.production.article, 'New manual article')
  assert.equal(item.production.aiArticle, 'Old AI baseline')
  assert.equal(item.articleWorkflow.draftHistory.at(-1).text, 'Drafts-only old article')
  assert.equal(item.articleWorkflow.sourcesConfirmed, false)
  assert.equal(item.articleWorkflow.pointConfirmed, false)
  assert.equal(item.articleWorkflow.outlineConfirmed, false)
  item.production.images = [{ status: 'running' }]
  const before = JSON.stringify(state)
  assert.equal(applyOps(state, [{ op: 'save_draft', id: 'target', format: 'article', text: 'Must not overwrite' }]).errors.length, 1)
  assert.equal(JSON.stringify(state), before)
})

test('one-click video Producer rejects article mode before any model call or mutation', async () => {
  const state = fixture({ format: 'article', status: 'done', title: 'Keep', article: 'Original article' }), before = JSON.stringify(state)
  let calls = 0, writes = 0
  const producer = new Producer({
    store: { read: async () => structuredClone(state), mutate: async () => { writes++ } },
    settings: { read: async () => { throw new Error('must not read settings') } },
    callText: async () => { calls++ }, generate: async () => { calls++ },
  })
  await assert.rejects(producer.start('target'), error => error.status === 409)
  assert.equal(calls, 0)
  assert.equal(writes, 0)
  assert.equal(JSON.stringify(state), before)
})

test('video production keeps the original pipeline even when the global default is article', async () => {
  const state = fixture({ status: 'done', article: 'An old script', savedPath: '/exports/video', savedHashes: { '脚本.md': 'old' } })
  state.draftFormat = 'article'
  let calls = 0
  const producer = new Producer({
    store: memoryStore(state), settings: { read: async () => ({ image: {}, voice: '', imageCount: 0, shotCount: 1, generateImages: false }) },
    ready: () => false, generate: () => { throw new Error('No image generation expected') },
    callText: async () => ({ model: 'mock', text: ++calls === 1 ? JSON.stringify({ title: 'Video', shots: [{ prompt: 'A real shot', visual: 'A person', voice: 'A line' }] }) : '# Video\n\nA spoken script.' }),
  })
  assert.equal(await producer.start('target'), true)
  await until(() => !producer.isRunning('target'))
  const production = state.items[0].production
  assert.equal(production.format, 'script')
  assert.equal(production.status, 'done')
  assert.equal(production.shots.length, 1)
  assert.equal(production.savedPath, '/exports/video')
  assert.deepEqual(production.savedHashes, { '脚本.md': 'old' })
  assert.equal(calls, 2)
})

test('article illustration generation uses the article plan and is not mistaken for an interrupted video job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-article-assets-'))
  try {
    const state = fixture({ format: 'article', status: 'done', title: 'Article', article: 'Text', cover: { prompt: 'A symbolic bridge', status: 'idle' }, images: [{ prompt: 'A simple comparison diagram', status: 'idle' }], shots: [] })
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const prompts = []
    const producer = new Producer({ store: memoryStore(state, dir), settings: { read: async () => ({ image: {} }) }, callText: () => { throw new Error('Do not replan') }, ready: () => true, generate: async (_image, prompt) => { prompts.push(prompt); await pending; return { buffer: Buffer.from('fake-image'), ext: '.png' } } })
    const rendering = producer.renderAsset('target', 'cover', { image: {} })
    await until(() => state.items[0].production.cover.status === 'running')
    assert.equal(producer.anyAssetActive('target'), true)
    await producer.settle('target')
    assert.equal(state.items[0].production.cover.status, 'running')
    assert.equal(applyOps(state, [{ op: 'set_creation_format', id: 'target', format: 'script' }]).errors.length, 1)
    finish()
    await rendering
    await producer.renderAsset('target', 'image:0', { image: {} })
    assert.equal(producer.anyAssetActive('target'), false)
    assert.ok(prompts.every(prompt => /Editorial illustration/.test(prompt)))
    assert.ok(prompts.every(prompt => !/video|storyboard|black and white|lower third/i.test(prompt)))
    assert.match(prompts[0], /A symbolic bridge/)
    assert.match(prompts[1], /A simple comparison diagram/)
    assert.equal(state.items[0].production.cover.status, 'done')
    assert.equal(state.items[0].production.images[0].status, 'done')
    assert.equal((await readdir(dir)).length, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('article export uses article filenames and cover, preserves external edits, and emits no empty storyboard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-article-export-'))
  try {
    const filesDir = join(dir, 'files')
    await mkdir(filesDir)
    await writeFile(join(filesDir, 'cover.png'), 'cover')
    await writeFile(join(filesDir, 'figure.png'), 'figure')
    const production = { format: 'article', title: 'An article', article: '## A section\n\nParagraphs.', cover: { src: 'media-desk/files/cover.png', alt: 'Article cover' }, images: [{ src: 'media-desk/files/figure.png', anchor: 'A section', caption: 'Evidence' }], shots: [] }
    const options = { filesDir, exportDir: join(dir, 'export'), videoCover: Buffer.from('must-not-write') }
    const first = await saveProduction(production, options)
    assert.deepEqual(first.files.sort(), ['文章.md', '文章封面.png', '配图1.png'].sort())
    assert.match(await readFile(join(first.path, '文章.md'), 'utf8'), /!\[Article cover\]\(文章封面\.png\)/)
    Object.assign(production, { savedPath: first.path, savedHashes: first.hashes })
    await writeFile(join(first.path, '文章.md'), 'Edited outside the app')
    const again = await saveProduction(production, options)
    assert.equal(again.backups.length, 1)
    assert.equal(await readFile(join(first.path, again.backups[0]), 'utf8'), 'Edited outside the app')
    const english = await withLang('en', () => saveProduction({ ...production, savedPath: undefined }, options))
    assert.deepEqual(english.files.sort(), ['article.md', 'article-cover.png', 'figure-1.png'].sort())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('old article storyboard assets are retained as legacy materials instead of disappearing on export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-article-legacy-export-'))
  try {
    const filesDir = join(dir, 'files')
    await mkdir(filesDir)
    await writeFile(join(filesDir, 'old.png'), 'old-shot')
    const production = { format: 'article', title: 'Legacy article', article: 'Keep the old article', shots: [{ shot: 'Wide', visual: 'Keep this frame', voice: 'Keep this voice', src: 'media-desk/files/old.png' }] }
    const before = JSON.stringify(production)
    const saved = await saveProduction(production, { filesDir, exportDir: join(dir, 'out') })
    assert.deepEqual(saved.files.sort(), ['文章.md', '旧分镜01.png', '旧分镜素材.md'].sort())
    assert.match(await readFile(join(saved.path, '旧分镜素材.md'), 'utf8'), /保留旧版文章附带的分镜素材/)
    assert.equal(await readFile(join(saved.path, '旧分镜01.png'), 'utf8'), 'old-shot')
    assert.equal(JSON.stringify(production), before)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
