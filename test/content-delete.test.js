import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyOps } from '../src/ops.js'
import { buildSeed } from '../src/seed.js'
import { Store } from '../src/store.js'

function stateFixture(exportDir) {
  const state = buildSeed(new Date('2026-11-16T00:00:00Z'))
  state.items = [
    { id: 'ancestor', title: 'Ancestor', kind: 'note', status: 'idea', drafts: {} },
    {
      id: 'target', parentId: 'ancestor', title: 'A whole content record', kind: 'note', status: 'draft', creationFormat: 'article',
      body: 'Source notes', tags: ['source'], articleReferences: [{ id: 'item:ancestor', label: 'Source', trigger: '@' }],
      drafts: { article: { text: 'Old compatibility article', by: 'user' }, script: { text: 'Old compatibility script', by: 'user' } },
      production: { format: 'article', status: 'done', title: 'Current article', article: 'Current article body', savedPath: exportDir, savedHashes: { 'article.md': 'saved-hash' }, cover: { src: 'media-desk/files/cover.png', status: 'done' }, images: [{ src: 'media-desk/files/figure.png', status: 'done' }], mentions: [{ id: 'item:ancestor', label: 'Source' }] },
      productions: { script: { format: 'script', status: 'done', article: 'Archived video script', cover: { src: 'media-desk/files/video.png', status: 'done' }, shots: [{ src: 'media-desk/files/shot.png', voice: 'Keep this line', status: 'done' }] } },
      articleWorkflow: { revision: 7, draftHistory: [{ id: 'version', text: 'A previous article', title: 'Previous title', revision: 6 }], editCandidates: [{ id: 'candidate', kind: 'selection', status: 'pending', text: 'A suggested edit', baseRevision: 7, selection: { start: 0, end: 7, text: 'Current' } }], imageHistory: [{ id: 'images', cover: { src: 'media-desk/files/previous.png' }, images: [] }] },
    },
    { id: 'child', parentId: 'target', title: 'Child', kind: 'note', status: 'idea', drafts: {} },
    { id: 'child-reparented', parentId: 'target', title: 'Another child', kind: 'note', status: 'idea', drafts: {} },
    { id: 'grandchild', parentId: 'child', title: 'Grandchild', kind: 'note', status: 'idea', drafts: {} },
    { id: 'independent', title: 'Independent item', body: 'Original independent notes', kind: 'note', status: 'draft', drafts: {} },
  ]
  state.metrics = [{ id: 'target-metric', itemId: 'target', views: 42, likes: 3 }, { id: 'other-metric', itemId: 'independent', views: 12, likes: 1 }]
  state.chat = [{ id: 'chat', role: 'user', itemId: 'target', text: 'A saved conversation', mentions: [{ id: 'item:ancestor' }] }]
  return state
}

async function sandbox(run) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-content-delete-'))
  try {
    const filesDir = join(root, 'files'), exportDir = join(root, 'exported-article')
    await mkdir(filesDir)
    await mkdir(exportDir)
    for (const name of ['cover.png', 'figure.png', 'video.png', 'shot.png', 'previous.png']) await writeFile(join(filesDir, name), `Untouched fixture asset: ${name}`)
    await writeFile(join(exportDir, 'article.md'), '# Exported article\n\nA separately saved copy.\n')
    await writeFile(join(root, 'state.json'), JSON.stringify(stateFixture(exportDir)))
    const store = new Store(root)
    await run({ root, filesDir, exportDir, store })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('deleting a complete item removes its metrics but retains descendants, then undo restores all products, histories and relations', async () => {
  await sandbox(async ({ store }) => {
    const before = structuredClone(await store.read())
    const result = await store.mutate('Delete the content record', state => applyOps(state, [{ op: 'delete_item', id: 'target' }]))
    assert.equal(result.errors.length, 0)
    const deleted = await store.read()
    assert.ok(!deleted.items.some(item => item.id === 'target'))
    assert.ok(!deleted.metrics.some(metric => metric.itemId === 'target'))
    assert.equal(deleted.metrics.find(metric => metric.id === 'other-metric').views, 12)
    assert.equal(deleted.items.find(item => item.id === 'child').parentId, 'ancestor')
    assert.equal(deleted.items.find(item => item.id === 'child-reparented').parentId, 'ancestor')
    assert.equal(deleted.items.find(item => item.id === 'grandchild').parentId, 'child')
    assert.deepEqual(deleted.chat, before.chat, 'existing conversation records are retained')
    assert.equal(await store.undoLast(), 'Delete the content record')
    assert.deepEqual(await store.read(), before)
  })
})

test('undo restores the removed record and metrics without overwriting later independent edits or new records', async () => {
  await sandbox(async ({ store }) => {
    const before = structuredClone(await store.read()), original = before.items.find(item => item.id === 'target')
    await store.mutate('Delete the content record', state => applyOps(state, [{ op: 'delete_item', id: 'target' }]))
    await store.mutate('Independent changes after deletion', state => {
      state.items.find(item => item.id === 'independent').body = 'New independent notes'
      state.items.find(item => item.id === 'child').title = 'Child edited later'
      state.items.find(item => item.id === 'child-reparented').parentId = 'independent'
      state.items.find(item => item.id === 'grandchild').body = 'A later grandchild edit'
      state.items.push({ id: 'new-later', title: 'New content after deletion', kind: 'note', status: 'idea' })
      state.metrics.find(metric => metric.id === 'other-metric').views = 99
      state.metrics.push({ id: 'later-metric', itemId: 'independent', views: 7 })
    }, { undoable: false })
    await store.undoLast()
    const restored = await store.read()
    assert.deepEqual(restored.items.find(item => item.id === 'target'), original)
    assert.equal(restored.items.find(item => item.id === 'independent').body, 'New independent notes')
    assert.equal(restored.items.find(item => item.id === 'child').title, 'Child edited later')
    assert.equal(restored.items.find(item => item.id === 'child').parentId, 'target', 'unchanged reparenting is undone')
    assert.equal(restored.items.find(item => item.id === 'child-reparented').parentId, 'independent', 'an explicit later parent change is retained')
    assert.equal(restored.items.find(item => item.id === 'grandchild').body, 'A later grandchild edit')
    assert.ok(restored.items.some(item => item.id === 'new-later'))
    assert.equal(restored.metrics.find(metric => metric.id === 'other-metric').views, 99)
    assert.ok(restored.metrics.some(metric => metric.id === 'later-metric'))
    assert.deepEqual(restored.metrics.find(metric => metric.id === 'target-metric'), before.metrics.find(metric => metric.id === 'target-metric'))
  })
})

test('deleting a root content item retains its children as roots and undo restores their original parent', async () => {
  await sandbox(async ({ store }) => {
    await store.mutate('Prepare a root item', state => { delete state.items.find(item => item.id === 'target').parentId }, { undoable: false })
    const before = structuredClone(await store.read())
    const result = await store.mutate('Delete root item', state => applyOps(state, [{ op: 'delete_item', id: 'target' }]))
    assert.equal(result.errors.length, 0)
    const deleted = await store.read()
    assert.equal(deleted.items.find(item => item.id === 'child').parentId, null)
    assert.equal(deleted.items.find(item => item.id === 'grandchild').parentId, 'child')
    await store.undoLast()
    assert.deepEqual(await store.read(), before)
  })
})

test('delete and undo preserve actual uploaded/generated files and separately exported article copies byte-for-byte', async () => {
  await sandbox(async ({ store, filesDir, exportDir }) => {
    const names = await readdir(filesDir), paths = [...names.map(name => join(filesDir, name)), join(exportDir, 'article.md')]
    const contents = await Promise.all(paths.map(path => readFile(path)))
    await store.mutate('Delete the content record', state => applyOps(state, [{ op: 'delete_item', id: 'target' }]))
    assert.deepEqual(await readdir(filesDir), names)
    for (let index = 0; index < paths.length; index++) assert.deepEqual(await readFile(paths[index]), contents[index])
    await store.undoLast()
    for (let index = 0; index < paths.length; index++) assert.deepEqual(await readFile(paths[index]), contents[index])
  })
})

test('a running production or asset cannot be deleted and a rejected deletion leaves the whole state intact', async () => {
  for (const format of ['article', 'script']) for (const running of [
    { status: 'running' },
    { cover: { prompt: 'Pending cover', status: 'running' } },
    { images: [{ prompt: 'Pending figure', status: 'running' }] },
    { shots: [{ prompt: 'Pending shot', status: 'running' }] },
  ]) {
    const state = stateFixture('/unused-export-path'), item = state.items.find(row => row.id === 'target')
    item.creationFormat = format
    item.production = { ...item.production, format, ...running }
    const before = structuredClone(state)
    const result = applyOps(state, [{ op: 'delete_item', id: item.id }])
    assert.equal(result.errors.length, 1, `${format}: ${JSON.stringify(running)}`)
    assert.equal(result.receipts.length, 0)
    assert.deepEqual(state, before)
  }
})

test('deleting a missing item reports an error without touching related state', () => {
  const state = stateFixture('/unused-export-path'), before = structuredClone(state)
  const result = applyOps(state, [{ op: 'delete_item', id: 'already-deleted' }])
  assert.equal(result.errors.length, 1)
  assert.equal(result.receipts.length, 0)
  assert.deepEqual(state, before)
})
