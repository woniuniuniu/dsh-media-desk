import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { applyOps } from '../src/ops.js'
import { createAutomationService } from '../src/automation/service.js'
import { chatPrompts } from '../src/ai.js'
import { saveProduction } from '../src/export.js'

const idle = { isRunning: () => false, anyAssetActive: () => false, status: () => ({ running: false }) }
const call = (service, suffix, input, requestId) => service.call({ tool: `media_desk_${suffix}`, input, requestId })
async function fixture(t, producer = idle, settings) {
  const root = await mkdtemp(join(tmpdir(), 'md-versions-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('setup', s => {
    s.accounts = [{ id: 'a', platform: '快手', handle: 'A' }, { id: 'b', platform: '抖音', handle: 'B' }]; s.metrics = []
    s.items = [{ id: 'work', accountId: 'a', platform: '快手', status: 'published', publishedAt: '2026-01-01', scheduledAt: '2026-02-01', title: 'idea', body: '原始正文', kind: 'web', url: 'https://example.com', tags: ['标签'], media: { src: 'media-desk/files/a.png' }, drafts: { article: { text: '手写正文', by: 'user', aiText: '原 AI 文本', at: '2026-01-01' } }, production: { generationId: 'original', status: 'done', title: '成稿', article: '第一稿\n' + '长'.repeat(210000), format: 'article', withImages: false, coverText: '封面字', cover: { prompt: '画面', src: 'media-desk/files/a.png', status: 'done', engine: 'PRIVATE_PROVIDER', savedPath: '/private/asset' }, images: [], shots: [{ visual: '视觉', voice: '旁白' }], savedPath: '/private/old', savedAt: 'old' } }]
  })
  const service = createAutomationService({ store, producer, settings: settings ?? { read: async () => ({ exportDir: join(root, 'exports') }) } })
  return { root, store, service }
}
const op = (service, ops, requestId = 'request') => call(service, 'apply_ops', { accountId: 'a', ops }, requestId)

test('named versions persist exact creative text and restore archives current content without changing publication metadata', async t => {
  const { store, service } = await fixture(t)
  const original = structuredClone((await store.read()).items[0])
  const saved = await op(service, [{ op: 'save_version', id: 'work', name: '初稿' }], 'save-1')
  assert.equal(saved.ok, true, JSON.stringify(saved))
  let item = (await store.read()).items[0]; const first = item.contentVersions[0]
  assert.match(first.id, /^[0-9a-f-]{36}$/); assert.equal(first.number, 1); assert.equal(first.name, '初稿'); assert.match(first.sha256, /^[a-f0-9]{64}$/)
  assert.equal(first.content.production.article, original.production.article)
  await op(service, [{ op: 'update_production', id: 'work', article: '第二稿' }, { op: 'save_version', id: 'work', name: '初稿' }], 'save-2')
  const fresh = new Store(store.root); item = (await fresh.read()).items[0]
  assert.deepEqual(item.contentVersions.map(v => v.number), [1, 2]); assert.notEqual(item.contentVersions[1].id, first.id)
  const restore = await op(service, [{ op: 'restore_version', id: 'work', versionId: first.id }], 'restore-1')
  assert.equal(restore.ok, true, JSON.stringify(restore))
  item = (await store.read()).items[0]
  assert.equal(item.production.article, original.production.article); assert.equal(item.contentVersions[2].content.production.article, '第二稿')
  assert.deepEqual(item.drafts, original.drafts); assert.equal(item.production.cover.src, original.production.cover.src)
  for (const key of ['id', 'accountId', 'platform', 'status', 'publishedAt', 'scheduledAt']) assert.equal(item[key], original[key])
  assert.notEqual(item.production.generationId, 'original'); assert.equal(item.production.savedPath, undefined)
  assert.equal(item.contentVersions[0].content.production.savedPath, undefined)
  assert.doesNotMatch(JSON.stringify(item.contentVersions), /PRIVATE_PROVIDER|\/private\//)
  await store.undoLast(); item = (await store.read()).items[0]
  assert.equal(item.contentVersions.length, 3); assert.equal(item.production.article, '第二稿')
  const replay = await op(service, [{ op: 'restore_version', id: 'work', versionId: first.id }], 'restore-1')
  assert.deepEqual(replay.result, restore.result); assert.equal(replay.cached, true); assert.equal((await store.read()).items[0].contentVersions.length, 3)
})

test('version catalog is strict, scoped, bounded, read only compatible and omitted from prompts/default metadata', async t => {
  const { store, service } = await fixture(t)
  await op(service, [{ op: 'save_version', id: 'work', name: '历史 SECRET_HISTORY' }], 'one')
  const item = (await store.read()).items[0]; const versionId = item.contentVersions[0].id
  await op(service, [{ op: 'update_production', id: 'work', article: 'current' }], 'edit')
  const list = await call(service, 'get_item', { id: 'work', accountId: 'a', fields: ['versions'], versionLimit: 1 })
  assert.equal(list.ok, true); assert.equal(list.result.versions.total, 1); assert.equal(list.result.versions.items[0].name, '历史 SECRET_HISTORY')
  assert.equal(JSON.stringify(list).includes('第一稿'), false)
  const historical = await call(service, 'get_item', { id: 'work', fields: ['versions'], versionId, maxChars: 50 })
  assert.equal(historical.ok, true); assert.equal(historical.result.truncated.version, true); assert.equal(historical.result.version.content.preview.length, 50)
  for (const input of [{ id: 'work', versionId }, { id: 'work', fields: ['versions'], versionLimit: 101 }, { id: 'work', accountId: 'b', fields: ['versions'] }]) assert.equal((await call(service, 'get_item', input)).ok, false)
  for (const operation of [{ op: 'update_item', id: 'work', contentVersions: [] }, { op: 'save_version', id: 'work', name: 'x'.repeat(81) }, { op: 'restore_version', id: 'work', versionId: 'unknown', content: {} }]) assert.equal((await op(service, [operation], `bad-${Math.random()}`)).ok, false)
  assert.equal(JSON.stringify(await call(service, 'get_item', { id: 'work' })).includes('SECRET_HISTORY'), false)
  assert.equal(chatPrompts(await store.read(), 'hello', { focusId: 'work' }).user.includes('SECRET_HISTORY'), false)
  const ro = createAutomationService({ store, producer: idle, settings: {}, readOnly: true })
  assert.equal((await call(ro, 'apply_ops', { ops: [{ op: 'save_version', id: 'work' }] }, 'ro')).error.code, 'READ_ONLY')
})

test('corrupt or unknown versions and production/assets/reserved jobs fail without partial content mutation', async t => {
  let busy = false
  const { store, service } = await fixture(t, { ...idle, isRunning: () => busy })
  await op(service, [{ op: 'save_version', id: 'work' }], 'save')
  const first = (await store.read()).items[0].contentVersions[0]
  for (const mode of ['reservation', 'asset', 'corrupt', 'unknown']) {
    await store.mutate('prepare', s => { const item=s.items[0]; item.production.cover.status = mode === 'asset' ? 'pending' : 'done'; item.contentVersions[0].sha256 = mode === 'corrupt' ? '0'.repeat(64) : first.sha256 })
    busy = mode === 'reservation'
    const before = JSON.stringify((await store.read()).items[0])
    const result = await op(service, [{ op: 'restore_version', id: 'work', versionId: mode === 'unknown' ? 'missing' : first.id }], mode)
    assert.equal(result.ok, false, mode); assert.equal(JSON.stringify((await store.read()).items[0]), before, mode)
  }
})

test('external replacements automatically back up meaningful content once and preserve handwritten draft attribution', async t => {
  const { store, service } = await fixture(t)
  const before = structuredClone((await store.read()).items[0])
  const request = { id: 'work', accountId: 'a', article: '外部新稿', title: '新标题' }
  const result = await call(service, 'write_draft', request, 'external')
  assert.equal(result.ok, true); assert.equal(result.result.modelCalls, 0)
  const item = (await store.read()).items[0]
  assert.equal(item.contentVersions[0].source, 'before_write_draft'); assert.equal(item.contentVersions[0].content.production.article, before.production.article)
  assert.deepEqual(item.drafts, before.drafts); assert.equal(item.status, 'published')
  assert.notEqual(item.production.generationId, before.production.generationId); assert.equal(item.production.savedPath, undefined)
  await call(service, 'write_draft', request, 'external'); assert.equal((await store.read()).items[0].contentVersions.length, 1)
})

test('exports exclusively create new traceable folders and preserve every byte in earlier user folders', async t => {
  const { root } = await fixture(t)
  const old = join(root, 'user-folder'); await import('node:fs/promises').then(fs => fs.mkdir(old)); await writeFile(join(old, '脚本.md'), 'USER EDIT')
  const p = { title: '../同名/作品', article: 'export article', savedPath: old }
  const results = await Promise.all(Array.from({ length: 3 }, () => saveProduction(p, { filesDir: root, exportDir: join(root, 'out'), accountId: 'a' })))
  assert.equal(new Set(results.map(r => r.path)).size, 3)
  assert.equal(await readFile(join(old, '脚本.md'), 'utf8'), 'USER EDIT')
  for (const result of results) {
    const manifest = JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8'))
    assert.match(manifest.contentSha256, /^[a-f0-9]{64}$/); assert.equal(manifest.versionId, null); assert.equal(manifest.versionNumber, null)
    assert.equal(JSON.stringify(manifest).includes(root), false); assert.equal((await readdir(result.path)).includes('脚本.md'), true)
  }
})

test('restore identity protects title/body/draft ABA from older Undo and ordinary later edit Undo still works', async t => {
  const { store, service } = await fixture(t)
  await op(service, [{ op: 'save_version', id: 'work', name: 'original' }], 'v1')
  const versionId = (await store.read()).items[0].contentVersions[0].id
  await store.mutate('old edits', state => applyOps(state, [{ op: 'update_item', id: 'work', title: 'ABA', body: 'ABA' }, { op: 'save_draft', id: 'work', text: 'ABA' }]))
  await op(service, [{ op: 'save_version', id: 'work', name: 'ABA' }], 'v2')
  const abaId = (await store.read()).items[0].contentVersions[1].id
  await store.mutate('reset outside Undo', s => { s.items[0].title='reset';s.items[0].body='reset';s.items[0].drafts.article.text='reset' }, { undoable: false })
  await store.mutate('restore outside Undo', s => applyOps(s, [{ op: 'restore_version', id: 'work', versionId: abaId }]), { undoable: false })
  await store.undoLast() // save V2
  await store.undoLast() // older title/body/draft edit must not own the restored ABA content
  let item = (await store.read()).items[0]
  assert.equal(item.title, 'ABA'); assert.equal(item.body, 'ABA'); assert.equal(item.drafts.article.text, 'ABA'); assert.equal(item.contentVersions.length, 3)
  await store.mutate('later edit', s => applyOps(s, [{ op: 'update_item', id: 'work', body: 'later' }]))
  await store.undoLast(); assert.equal((await store.read()).items[0].body, 'ABA')
  await op(service, [{ op: 'restore_version', id: 'work', versionId }], 'own-restore')
  await store.undoLast(); item = (await store.read()).items[0]
  assert.equal(item.title, 'ABA'); assert.equal(item.contentVersions.length, 4)
  await call(service, 'write_draft', { id: 'work', title: 'later replacement', article: 'later generation' }, 'rewrite-after-restore')
  const generationId = (await store.read()).items[0].production.generationId
  await store.undoLast() // write_draft own Undo may revert replacement; history remains
  assert.ok((await store.read()).items[0].contentVersions.length >= 4)
  assert.ok(generationId)
})

test('Producer reservations block version writes inside the queued mutation and regeneration backs up before replacement', async t => {
  const { store } = await fixture(t)
  const { Producer } = await import('../src/produce.js')
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const producer = new Producer({ store, settings: { read: async () => { entered(); await new Promise(resolve => { release = resolve }); return { generateImages: false } } } })
  producer.run = async () => {} // no provider access; inspect actual replacement only
  const service = createAutomationService({ store, producer, settings: {} })
  const before = (await store.read()).items[0].production.article
  const pending = producer.start('work', { accountId: 'a' }); await waiting
  const denied = await op(service, [{ op: 'save_version', id: 'work' }], 'reservation-save')
  assert.equal(denied.ok, false); assert.equal((await store.read()).items[0].contentVersions, undefined)
  release(); await pending
  const item = (await store.read()).items[0]
  assert.equal(item.contentVersions[0].source, 'before_produce'); assert.equal(item.contentVersions[0].content.production.article, before)
  assert.equal(item.production.status, 'running'); assert.ok(item.contentRevision)
})

test('stable exports stay on the sealed version through mid-await edits/restores and record outcome separately', async t => {
  const { root, store, service } = await fixture(t)
  await store.mutate('safe export assets', s => { s.items[0].production.cover = null; s.items[0].production.article = 'SEALED ARTICLE'; s.items[0].media = null })
  await op(service, [{ op: 'save_version', id: 'work', name: 'old' }], 'saved')
  const first = (await store.read()).items[0].contentVersions[0]
  await op(service, [{ op: 'update_production', id: 'work', article: 'TO EXPORT' }], 'edited')
  let enter, release; const waiting = new Promise(resolve => { enter = resolve })
  const paused = createAutomationService({ store, producer: idle, settings: { read: async () => { enter(); await new Promise(resolve => { release=resolve }); return { exportDir: join(root, 'out') } } } })
  const exporting = call(paused, 'export', { id: 'work', accountId: 'a' }, 'export')
  await waiting
  await op(service, [{ op: 'restore_version', id: 'work', versionId: first.id }], 'restore')
  release(); const exported = await exporting
  assert.equal(exported.ok, true, JSON.stringify(exported)); assert.equal(exported.result.currentMatches, false)
  assert.match(await readFile(join(exported.result.path, '脚本.md'), 'utf8'), /TO EXPORT/)
  assert.doesNotMatch(await readFile(join(exported.result.path, '脚本.md'), 'utf8'), /SEALED ARTICLE/)
  const item = (await store.read()).items[0]
  assert.equal(item.production.article, 'SEALED ARTICLE'); assert.equal(item.production.savedPath, undefined)
  assert.equal(item.contentVersionExports.length, 1); assert.equal(item.contentVersionExports[0].versionId, exported.result.versionId)
  const manifest = JSON.parse(await readFile(join(exported.result.path, 'manifest.json'), 'utf8'))
  assert.equal(manifest.itemId, 'work'); assert.equal(manifest.versionNumber, 2); assert.equal(manifest.contentSha256, item.contentVersions[1].sha256)
  const replay = await call(paused, 'export', { id: 'work', accountId: 'a' }, 'export'); assert.equal(replay.cached, true)
  assert.equal((await store.read()).items[0].contentVersionExports.length, 1)
})

test('export persistence faults return durable uncertainty with surviving output evidence', async t => {
  const { root, store, service } = await fixture(t)
  await store.mutate('no local assets', s => { s.items[0].production.cover = null; s.items[0].production.article = 'kept file' })
  const mutate = store.mutate.bind(store)
  store.mutate = (label, fn, options) => label === '记录导出结果' ? Promise.reject(new Error('disk fault')) : mutate(label, fn, options)
  const result = await call(service, 'export', { id: 'work' }, 'fault')
  assert.equal(result.ok, false); assert.equal(result.error.code, 'OUTCOME_UNKNOWN')
  assert.equal(result.error.details.export.versionNumber, 1)
  assert.match(await readFile(join(result.error.details.export.path, '脚本.md'), 'utf8'), /kept file/)
  assert.ok((await readdir(root)).includes('exports'))
})

test('pending production and schema-corrupt historical content are rejected without changing working data', async t => {
  const { store, service } = await fixture(t)
  await store.mutate('pending', s => { s.items[0].production.status = 'pending' })
  const before = JSON.stringify((await store.read()).items[0])
  const result = await op(service, [{ op: 'save_version', id: 'work' }], 'pending-production')
  assert.equal(result.ok, false); assert.equal(JSON.stringify((await store.read()).items[0]), before)
  await store.mutate('idle', s => { s.items[0].production.status = 'done' })
  await op(service, [{ op: 'save_version', id: 'work' }], 'good-version')
  const { contentSha256 } = await import('../src/versions.js')
  await store.mutate('corrupt with matching hash', s => { const v=s.items[0].contentVersions[0];v.content.production.article={arbitrary:'value'};v.sha256=contentSha256(v.content) })
  const corrupt = (await store.read()).items[0], stateBefore = JSON.stringify(corrupt)
  assert.equal((await op(service, [{ op: 'restore_version', id: 'work', versionId: corrupt.contentVersions[0].id }], 'schema-corrupt')).ok, false)
  assert.equal(JSON.stringify((await store.read()).items[0]), stateBefore)
})

test('repeated restore keeps every archived working copy with unique increasing version numbers', async t => {
  const { store, service } = await fixture(t)
  await op(service, [{ op: 'save_version', id: 'work' }], 'first')
  const versionId = (await store.read()).items[0].contentVersions[0].id
  for (let n=0;n<3;n++) {
    await op(service, [{ op: 'update_production', id: 'work', article: `working ${n}` }, { op: 'restore_version', id: 'work', versionId }], `repeat-${n}`)
  }
  const history=(await new Store(store.root).read()).items[0].contentVersions
  assert.deepEqual(history.map(v=>v.number),[1,2,3,4]);assert.equal(new Set(history.map(v=>v.id)).size,4)
  assert.deepEqual(history.slice(1).map(v=>v.content.production.article),['working 0','working 1','working 2'])
})

test('asset pre-start reservations block save and restore before any asset status is persisted', async t => {
  const { store, service } = await fixture(t)
  await op(service, [{ op: 'save_version', id: 'work' }], 'before-asset')
  const versionId=(await store.read()).items[0].contentVersions[0].id
  const { Producer }=await import('../src/produce.js')
  let enter,release;const waiting=new Promise(resolve=>{enter=resolve})
  const producer=new Producer({store,settings:{read:async()=>{enter();await new Promise(resolve=>{release=resolve});return {}}},ready:()=>false})
  const reserving=producer.regenerate('work','cover','a');await waiting
  const scoped=createAutomationService({store,producer,settings:{}})
  for (const [i,operation] of [{op:'save_version',id:'work'},{op:'restore_version',id:'work',versionId}].entries()) assert.equal((await op(scoped,[operation],`reserved-${i}`)).ok,false)
  release();await assert.rejects(reserving)
  assert.equal((await store.read()).items[0].contentVersions.length,1)
})

test('global chat ops cannot bypass reserved production locks for version operations', async t => {
  const { store }=await fixture(t)
  const { chatTurn }=await import('../src/host.js')
  const ctx={get:name=>name==='agentDefaultModel'?{currentSelection:()=>({provider:'stub',model:'stub'})}:name==='llm'?{prepareCall:async()=>({config:{},stream:async function*(){yield {type:'text-delta',text:JSON.stringify({reply:'stub',ops:[{op:'save_version',id:'work'}]})}}})}:undefined}
  const result=await chatTurn(ctx,store,{settings:{read:async()=>({})},producer:{...idle,isRunning:()=>true,ready:()=>false}},{message:'synthetic version request'})
  assert.equal(result.answer.errors.length,1);assert.equal((await store.read()).items[0].contentVersions,undefined)
})

test('maximum Unicode version labels and admitted long account IDs export within filesystem component limits', async t => {
  const {root}=await fixture(t)
  const {randomUUID}=await import('node:crypto')
  const p={title:'中'.repeat(200),article:'Unicode content'},version={id:randomUUID(),number:123,name:'版'.repeat(80),sha256:'1'.repeat(64)}
  const outputs=await Promise.all([1,2].map(()=>saveProduction(p,{filesDir:root,exportDir:join(root,'unicode'),accountId:'账'.repeat(200),itemId:'项'.repeat(200),version})))
  assert.notEqual(outputs[0].path,outputs[1].path)
  for(const out of outputs){
    for(const component of out.path.slice(root.length).split('/'))assert.ok(Buffer.byteLength(component,'utf8')<=255,component)
    const manifest=JSON.parse(await readFile(join(out.path,'manifest.json'),'utf8'));assert.equal(manifest.versionName,version.name);assert.equal(manifest.accountId,'账'.repeat(200))
    assert.match(await readFile(join(out.path,'脚本.md'),'utf8'),/Unicode content/)
  }
})

test('export recovery evidence is bounded and excludes content, settings, providers and source paths',async()=>{
  const {boundedExportEvidence}=await import('../src/export-evidence.js')
  const evidence=boundedExportEvidence({path:'x'.repeat(5000),itemId:'i'.repeat(300),versionId:'v'.repeat(300),versionNumber:2,versionName:'n'.repeat(100),contentSha256:'a'.repeat(100),exportedAt:'t'.repeat(100),files:Array.from({length:120},(_,i)=>`asset-${i}.png`),settings:{key:'SECRET'},provider:'SECRET',article:'PRIVATE CONTENT',sourcePath:'/private/source'})
  assert.equal(evidence.path.length,4096);assert.equal(evidence.itemId.length,200);assert.equal(evidence.versionId.length,200);assert.equal(evidence.versionName.length,80);assert.equal(evidence.files.length,100);assert.equal(evidence.filesTotal,120);assert.equal(evidence.filesTruncated,true)
  assert.doesNotMatch(JSON.stringify(evidence),/SECRET|PRIVATE CONTENT|private\/source/)
})

for(const mode of ['transient','permanent','prior-unknown'])test(`export journal ${mode} final receipt faults retain bounded evidence and never replay`,async t=>{
  const {root,store}=await fixture(t)
  await store.mutate('safe export',s=>{s.items[0].production={status:'done',title:'journal export',article:'PRIVATE_ARTICLE',cover:null,images:[],shots:[]}})
  const {MutationJournal}=await import('../src/automation/journal.js'),journal=new MutationJournal(join(root,'fault-journal'))
  const persist=journal.persist.bind(journal);let calls=0,failed=true
  journal.persist=async()=>{calls++;if(calls===2||(mode==='permanent'&&calls>2&&failed))throw new Error('PRIVATE_PROVIDER receipt failure');return persist()}
  if(mode==='prior-unknown'){const mutate=store.mutate.bind(store);store.mutate=(label,...args)=>label==='记录导出结果'?Promise.reject(new Error('store outcome fault')):mutate(label,...args)}
  const service=createAutomationService({store,journal,producer:idle,settings:{read:async()=>({exportDir:join(root,'exports')})}})
  const first=await call(service,'export',{id:'work',accountId:'a'},'receipt-fault')
  assert.equal(first.ok,false);assert.equal(first.error.code,'OUTCOME_UNKNOWN');const evidence=first.error.details?.export;assert.ok(evidence?.path);assert.ok(evidence.versionId)
  assert.match(await readFile(join(evidence.path,'脚本.md'),'utf8'),/PRIVATE_ARTICLE/);assert.doesNotMatch(JSON.stringify(first),/PRIVATE_PROVIDER|PRIVATE_ARTICLE/)
  const status=await journal.status('receipt-fault');assert.equal(status.status,'unknown');assert.deepEqual(status.response.error.details.export,evidence)
  const replay=await call(service,'export',{id:'work',accountId:'a'},'receipt-fault');assert.equal(replay.error.code,'OUTCOME_UNKNOWN');assert.deepEqual(replay.error.details.export,evidence)
  const toolStatus=await call(service,'request_status',{requestId:'receipt-fault'});assert.deepEqual(toolStatus.result.response.error.details.export,evidence)
  if(mode!=='permanent')assert.deepEqual((await new MutationJournal(journal.root).status('receipt-fault')).response.error.details.export,evidence)
  assert.equal((await readdir(join(root,'exports', (await readdir(join(root,'exports')))[0]))).length,1)
  assert.notEqual(JSON.parse(await readFile(journal.file,'utf8'))['receipt-fault'].status,'done')
  failed=false
  const second=await call(service,'apply_ops',{ops:[{op:'add_item',title:'another intent'}]},'after-fault');assert.equal(second.ok,true)
  const recovered=await new MutationJournal(journal.root).status('receipt-fault');assert.equal(recovered.status,'unknown');assert.deepEqual(recovered.response.error.details.export,evidence)
})

for(const repairFails of [true,false])test(`after-rename directory-sync failure recovers ${repairFails?'the intact completed receipt':'the repaired unknown receipt'} without redispatch`,async t=>{
  const {root,store}=await fixture(t)
  await store.mutate('safe actual export',s=>{s.items[0].production={status:'done',title:'after rename',article:'AFTER_RENAME_ARTICLE',cover:null,images:[],shots:[]}})
  const {MutationJournal}=await import('../src/automation/journal.js'),journal=new MutationJournal(join(root,'after-rename-journal'))
  const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module'),originalOpen=fs.open
  let directorySyncs=0,repairAttempts=0,afterRenameFault=false,dispatches=0
  const restore=()=>{fs.open=originalOpen;syncBuiltinESMExports()}
  fs.open=async function(path,...args){
    if(afterRenameFault&&String(path).startsWith(`${journal.file}.`)&&args[0]==='wx'){
      repairAttempts++
      if(repairFails)throw new Error('Injected UNKNOWN repair write failure')
    }
    const handle=await originalOpen(path,...args)
    if(String(path)===journal.root&&args[0]==='r'){
      const sync=handle.sync.bind(handle)
      handle.sync=async()=>{directorySyncs++;if(directorySyncs===2){afterRenameFault=true;throw new Error('Injected directory fsync failure after actual rename')}return sync()}
    }
    return handle
  }
  syncBuiltinESMExports()
  let first
  try{
    const service=createAutomationService({store,journal,producer:idle,settings:{read:async()=>{dispatches++;return {exportDir:join(root,'exports')}}}})
    first=await call(service,'export',{id:'work',accountId:'a'},'after-rename')
    assert.equal(first.ok,false);assert.equal(first.error.code,'OUTCOME_UNKNOWN');assert.equal(repairAttempts,1);assert.ok(directorySyncs>=2)
    const live=await journal.status('after-rename');assert.equal(live.status,'unknown');assert.deepEqual(live.response.error.details.export,first.error.details.export)
  }finally{restore()}
  const evidence=first.error.details.export
  assert.match(await readFile(join(evidence.path,'脚本.md'),'utf8'),/AFTER_RENAME_ARTICLE/)
  assert.equal(JSON.parse(await readFile(join(evidence.path,'manifest.json'),'utf8')).versionId,evidence.versionId)
  const disk=JSON.parse(await readFile(journal.file,'utf8'))['after-rename'];assert.equal(disk.status,repairFails?'done':'unknown')
  const fresh=new MutationJournal(journal.root),freshService=createAutomationService({store,journal:fresh,producer:idle,settings:{read:async()=>{dispatches++;throw new Error('Must not dispatch export again')}}})
  const recovered=await fresh.status('after-rename');assert.equal(recovered.status,repairFails?'done':'unknown')
  const replay=await call(freshService,'export',{id:'work',accountId:'a'},'after-rename')
  if(repairFails){assert.equal(replay.ok,true);assert.equal(replay.cached,true);assert.equal(replay.result.path,evidence.path);assert.equal(replay.result.versionId,evidence.versionId)}
  else{assert.equal(replay.ok,false);assert.equal(replay.error.code,'OUTCOME_UNKNOWN');assert.deepEqual(replay.error.details.export,evidence)}
  assert.equal(dispatches,1);assert.doesNotMatch(JSON.stringify(replay),/AFTER_RENAME_ARTICLE|Injected directory|repair write failure/)
  const item=(await store.read()).items.find(row=>row.id==='work');assert.equal(item.contentVersions.length,1);assert.equal(item.contentVersionExports.length,1)
  assert.equal((await readdir(join(root,'exports',(await readdir(join(root,'exports')))[0]))).length,1)
})
