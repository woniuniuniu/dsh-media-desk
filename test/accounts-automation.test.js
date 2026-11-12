import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../src/store.js'
import {createAutomationService} from '../src/automation/service.js'
const call=(s,tool,input={},requestId)=>s.call({tool:`media_desk_${tool}`,input,requestId})
test('account catalog CRUD, per-request list scope, dedup, strict schema and readonly share Store',async t=>{
 const root=await mkdtemp(join(tmpdir(),'md-accounts-auto-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new Store(root);await store.mutate('empty',s=>{for(const k of ['accounts','items','metrics','chat'])s[k]=[]});const opts={store,settings:{read:async()=>({})},producer:{isRunning:()=>false,anyAssetActive:()=>false}};const service=createAutomationService(opts);const input={ops:[{op:'add_account',platform:'抖音',handle:'same'},{op:'add_account',platform:'抖音',handle:'same'}]};const a=await call(service,'apply_ops',input,'accounts');assert.equal(a.ok,true);const ids=a.result.receipts.map(r=>r.target);assert.deepEqual((await call(service,'apply_ops',input,'accounts')).result,a.result);const list=await call(service,'list_accounts',{limit:1});assert.equal(list.result.total,2);assert.equal(list.result.accounts[0].counts.items,0);assert.ok(list.result.nextOffset);assert.equal((await call(service,'get_account',{id:ids[1]})).result.id,ids[1]);for(const id of ids)assert.equal((await call(service,'apply_ops',{accountId:id,ops:[{op:'add_item',title:'one'}]},'item-'+id)).ok,true);assert.equal((await call(service,'list_items',{accountId:ids[0]})).result.total,1);const all=await call(service,'list_items');const other=all.result.items.find(i=>i.accountId===ids[1]).id;assert.equal((await call(service,'write_draft',{accountId:ids[0],id:other,article:'attack'},'attack')).error.code,'INVALID_ARGUMENT');assert.equal((await call(service,'list_accounts',{secret:true})).error.code,'INVALID_ARGUMENT');const ro=createAutomationService({...opts,readOnly:true});assert.equal((await call(ro,'apply_ops',input,'ro')).error.code,'READ_ONLY');assert.equal((await call(ro,'list_accounts')).ok,true)
})
test('export retains immutable origin and refuses reassignment while awaiting settings before filesystem writes',async t=>{
 const {applyOps}=await import('../src/ops.js');const {readdir}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'md-export-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new Store(root);let a,b,id;await store.mutate('setup',s=>{s.accounts=[];s.items=[];s.metrics=[];const add=op=>applyOps(s,[op]).receipts[0].target;a=add({op:'add_account',platform:'抖音',handle:'a'});b=add({op:'add_account',platform:'抖音',handle:'b'});id=add({op:'add_item',title:'same',accountId:a});s.items[0].production={status:'done',title:'same',article:'A article',images:[],shots:[]}});let entered,release;const paused=new Promise(resolve=>{entered=resolve});const settings={read:async()=>{entered();await new Promise(resolve=>{release=resolve});return {exportDir:join(root,'exports')}}};const service=createAutomationService({store,settings,producer:{isRunning:()=>false,anyAssetActive:()=>false}});const pending=call(service,'export',{id,accountId:a},'export-origin');await paused;await store.mutate('move',s=>applyOps(s,[{op:'assign_items',ids:[id],accountId:b}]));release();const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'INVALID_ARGUMENT');const item=(await store.read()).items.find(i=>i.id===id);assert.equal(item.accountId,b);assert.equal(item.production.savedPath,undefined);assert.equal((await readdir(root)).includes('exports'),false)
})

test('insights platform filter follows account scope and excludes unidentified snapshots; discovery includes Kuaishou', async t => {
 const { catalog } = await import('../src/automation/catalog.js')
 const { applyOps } = await import('../src/ops.js')
 const root = await mkdtemp(join(tmpdir(), 'md-kuaishou-insights-'))
 t.after(() => rm(root, { recursive: true, force: true }))
 const store = new Store(root)
 let a, b
 await store.mutate('setup', s => {
  for (const key of ['accounts', 'items', 'metrics', 'chat', 'skills']) s[key] = []
  const add = op => { const r = applyOps(s, [op]); assert.deepEqual(r.errors, []); return r.receipts[0].target }
  a = add({ op: 'add_account', platform: '快手', handle: 'A', followers: 10 })
  b = add({ op: 'add_account', platform: '快手', handle: 'B', followers: 20 })
  add({ op: 'add_account', platform: '抖音', handle: 'Other', followers: 90 })
  const item = add({ op: 'add_item', accountId: a, title: 'Kuaishou A', status: 'published' })
  const foreign = add({ op: 'add_item', accountId: b, title: 'SECRET B', status: 'published' })
  const other = add({ op: 'add_item', platform: '抖音', title: 'Other platform', status: 'published' })
  s.metrics = [
   { itemId: item, accountId: b, platform: '快手', views: 3, date: '2026-11-12' },
   { accountId: a, platform: '快手', views: 7, date: '2026-11-12' },
   { itemId: foreign, platform: '快手', views: 20, date: '2026-11-12' },
   { platform: '快手', views: 4, date: '2026-11-12' },
   { itemId: other, platform: '抖音', views: 99, date: '2026-11-12' },
  ]
 })
 const service = createAutomationService({ store, settings: {}, producer: {} })
 const one = await call(service, 'get_insights', { accountId: a, platform: '快手' })
 assert.equal(one.ok, true)
 assert.equal(one.result.views, 3)
 assert.equal(one.result.coverage.excludedRecords, 1)
 assert.equal(one.result.followers, 10)
 assert.equal(one.result.published, 1)
 assert.equal(one.result.top.length, 1)
 assert.doesNotMatch(JSON.stringify(one), /SECRET/)
 assert.equal((await call(service, 'get_insights', { accountId: null, platform: '快手' })).result.views, null)
 const all = await call(service, 'get_insights', { platform: '快手' })
 assert.equal(all.result.views, 23)
 assert.equal(all.result.coverage.excludedRecords, 2)
 assert.equal(all.result.followers, 30)
 assert.equal(all.result.published, 2)
 assert.deepEqual(all.result.platforms.map(p => p.platform), ['快手'])
 assert.equal((await call(service, 'get_insights', { platform: '抖音' })).result.views, 99)
 assert.equal((await call(service, 'get_insights')).result.views, 122)
 assert.equal((await call(service, 'get_insights', { platform: 'Kwai' })).error.code, 'INVALID_ARGUMENT')
 assert.equal((await call(service, 'get_insights', { platform: '快手', secret: true })).error.code, 'INVALID_ARGUMENT')
 const status = await call(service, 'status')
 assert.equal(status.result.supportedPlatforms.length, 10)
 assert.ok(status.result.supportedPlatforms.includes('快手'))
 assert.equal(catalog.length, 18)
 assert.ok(catalog.find(t => t.name === 'media_desk_get_insights').inputSchema.properties.platform.enum.includes('快手'))
})

test('platform insights keep scoped legacy items referenced by selected metrics and label their metric platform', async t => {
 const { applyOps } = await import('../src/ops.js')
 const root = await mkdtemp(join(tmpdir(), 'md-legacy-platform-insights-'))
 t.after(() => rm(root, { recursive: true, force: true }))
 const store = new Store(root)
 let legacy, differentPlatform
 await store.mutate('setup', s => {
  for (const key of ['accounts', 'items', 'metrics', 'chat', 'skills']) s[key] = []
  const add = op => { const r = applyOps(s, [op]); assert.deepEqual(r.errors, []); return r.receipts[0].target }
  const accountId = add({ op: 'add_account', platform: '快手', handle: 'Foreign account' })
  const foreign = add({ op: 'add_item', accountId, title: 'SECRET foreign', status: 'published' })
  legacy = add({ op: 'add_item', title: 'Legacy item', status: 'published' })
  differentPlatform = add({ op: 'add_item', title: 'Originally Douyin', platform: '抖音', status: 'published' })
  for (const itemId of [legacy, differentPlatform]) add({ op: 'add_metric', itemId, platform: '快手', views: 100 })
  add({ op: 'add_metric', itemId: differentPlatform, platform: '抖音', views: 500 })
  add({ op: 'add_metric', itemId: foreign, platform: '快手', views: 1000 })
  add({ op: 'add_metric', platform: '快手', views: 25 })
 })
 const service = createAutomationService({ store, settings: {}, producer: {} })
 const result = await call(service, 'get_insights', { accountId: null, platform: '快手' })
 assert.equal(result.ok, true)
 assert.equal(result.result.views, 200)
 assert.equal(result.result.coverage.excludedRecords, 1)
 assert.equal(result.result.published, 2)
 assert.deepEqual(new Set(result.result.top.map(row => row.id)), new Set([legacy, differentPlatform]))
 assert.ok(result.result.top.every(row => row.platform === '快手' && row.views === 100))
 assert.doesNotMatch(JSON.stringify(result), /SECRET/)
 const unfiltered = await call(service, 'get_insights', { accountId: null })
 assert.equal(unfiltered.result.top.find(row => row.id === differentPlatform).platform, '抖音')
 assert.equal(unfiltered.result.views, 700)
 assert.deepEqual(unfiltered.result.top.filter(row => row.id === differentPlatform).map(row => [row.platform, row.views]), [['抖音', 500], ['快手', 100]])
})

test('avatar automation accepts local images and long URLs, retains compact output and scope guards', async t => {
 const { catalog } = await import('../src/automation/catalog.js')
 const root = await mkdtemp(join(tmpdir(), 'md-avatar-auto-'))
 t.after(() => rm(root, { recursive: true, force: true }))
 const store = new Store(root)
 await store.mutate('empty', s => { for (const key of ['accounts', 'items', 'metrics', 'chat']) s[key] = [] })
 const opts = { store, settings: {}, producer: {} }, service = createAutomationService(opts)
 const long = 'https://example.com/a.png?token=' + 'x'.repeat(3500)
 const created = await call(service, 'apply_ops', { ops: [{ op: 'add_account', platform: '快手', handle: 'A', avatar: long }, { op: 'add_account', platform: '抖音', handle: 'B', avatar: 'media-desk/files/b.png' }] }, 'avatars')
 assert.equal(created.ok, true)
 const [a, b] = created.result.receipts.map(row => row.target)
 assert.equal((await call(service, 'get_account', { id: a })).result.avatar, long)
 assert.equal((await call(service, 'list_accounts')).result.accounts.find(row => row.id === a).avatar, long)
 assert.equal((await call(service, 'get_account', { id: b })).result.avatar, 'media-desk/files/b.png')
 assert.equal((await call(service, 'apply_ops', { accountId: a, ops: [{ op: 'update_account', id: b, avatar: null }] }, 'foreign-avatar')).ok, false)
 for (const avatar of ['data:image/png;base64,AAAA', 'media-desk/files/a.mp4', '/tmp/a.jpg', 'https://example.com/' + 'x'.repeat(4000)]) assert.equal((await call(service, 'apply_ops', { ops: [{ op: 'update_account', id: a, avatar }] }, 'bad-avatar-' + avatar.slice(0, 30))).ok, false)
 assert.equal((await call(service, 'apply_ops', { ops: [{ op: 'update_account', id: a, avatar: null, secret: 1 }] }, 'avatar-unknown')).error.code, 'INVALID_ARGUMENT')
 const ro = createAutomationService({ ...opts, readOnly: true })
 assert.equal((await call(ro, 'apply_ops', { ops: [{ op: 'update_account', id: a, avatar: null }] }, 'avatar-ro')).error.code, 'READ_ONLY')
 assert.equal((await call(ro, 'get_account', { id: a })).result.avatar, long)
 assert.equal(catalog.length, 18)
})
