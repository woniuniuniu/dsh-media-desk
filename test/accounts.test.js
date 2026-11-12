import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSeed, migrateState } from '../src/seed.js'
import { applyOps } from '../src/ops.js'
import { Store } from '../src/store.js'
import { computeInsights } from '../src/learn.js'
import { articlePrompts } from '../src/ai.js'
import { importPosts } from '../src/monid.js'
import { saveProduction } from '../src/export.js'
const seed = () => { const s = buildSeed(new Date()); for (const k of ['items','metrics','accounts','chat','skills']) s[k] = []; return s }
const add = (s, op) => { const r = applyOps(s, [op]); assert.deepEqual(r.errors, []); return r.receipts[0]?.target }
const account = (s, handle='one', platform='抖音') => add(s,{op:'add_account',handle,platform})

test('migration adds nullable attribution without guessing from same platform and is idempotent', () => {
  const s = seed(); s.items = [{id:'legacy',platform:'抖音',body:'keep'}]; s.metrics=[{id:'m',itemId:'legacy',views:4}]; s.chat=[{id:'c',text:'keep'}]; s.accounts=[{id:'a',platform:'抖音'},{id:'b',platform:'抖音'}]
  const migrated=migrateState(s); assert.equal(migrated.items[0].accountId,null); assert.equal(migrated.metrics[0].accountId,null); assert.equal(migrated.chat[0].accountId,null); assert.equal(migrated.accounts[1].archived,false)
  assert.deepEqual(migrateState(structuredClone(migrated)),migrated)
})
test('same-platform accounts, inheritance, invalid references and atomic bounded assignment', () => {
  const s=seed(); const a=account(s), b=account(s,'two','快手'); const id=add(s,{op:'add_item',title:'one',accountId:a,status:'published'}); const child=add(s,{op:'add_item',title:'child',parentId:id}); assert.equal(s.items.find(i=>i.id===child).accountId,a)
  const item=s.items.find(i=>i.id===id); const published=item.publishedAt; assert.equal(item.platform,'抖音')
  for (const op of [{op:'add_item',title:'bad',accountId:'bad'},{op:'update_item',id,platform:'X'},{op:'update_account',id:a,defaultStyleId:'bad'},{op:'assign_items',ids:[id,'missing'],accountId:b,updatePlatform:true},{op:'assign_items',ids:[id],accountId:b}]) assert.equal(applyOps(s,[op]).errors.length,1)
  add(s,{op:'add_metric',itemId:id,platform:'抖音',views:8}); add(s,{op:'assign_items',ids:[id],accountId:b,updatePlatform:true}); assert.equal(item.accountId,b); assert.equal(item.platform,'快手'); assert.equal(item.publishedAt,published); assert.equal(s.metrics[0].accountId,b); assert.equal(s.items.find(i=>i.id===child).accountId,a)
  assert.equal(applyOps(s,[{op:'assign_items',ids:Array(101).fill(id),accountId:null}]).errors.length,1)
})
test('deleting account detaches content/metrics/chat and normal undo restores attribution',async t=>{
 const root=await mkdtemp(join(tmpdir(),'md-accounts-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new Store(root);let a,id;await store.mutate('setup',s=>{Object.assign(s,seed());a=account(s);id=add(s,{op:'add_item',title:'keep',accountId:a});add(s,{op:'add_metric',itemId:id,platform:'抖音',views:8});s.chat.push({id:'c',accountId:a,text:'keep'})});await store.mutate('delete',s=>add(s,{op:'delete_account',id:a}));let s=await store.read();assert.equal(s.items[0].accountId,null);assert.equal(s.metrics[0].accountId,null);assert.equal(s.chat[0].accountId,null);await store.undoLast();s=await store.read();assert.equal(s.items[0].accountId,a);assert.equal(s.accounts[0].id,a)
})
test('scope metrics follow item, insights isolate same-platform accounts and defaults do not blend',async()=>{
 const {scopeState}=await import('../src/accounts.js');const s=seed();const a=account(s),b=account(s,'two');const x=add(s,{op:'add_item',title:'a',accountId:a}),y=add(s,{op:'add_item',title:'SECRET',accountId:b});s.metrics=[{id:'m',itemId:x,accountId:b,platform:'抖音',views:3,date:new Date().toISOString()},{id:'n',itemId:y,platform:'抖音',views:99,date:new Date().toISOString()},{id:'u',platform:'抖音',views:2,date:new Date().toISOString()}];assert.equal(computeInsights(scopeState(s,a)).views,3);assert.equal(computeInsights(scopeState(s,null)).views,2)
 const st=add(s,{op:'add_style',name:'only A',tone:'A style'});add(s,{op:'update_account',id:a,defaultStyleId:st,positioning:'A positioning',audience:'A audience'});assert.equal(s.activeStyleId,null);const p=articlePrompts(s,s.items.find(i=>i.id===x),'',null);assert.match(p.system,/A style/);assert.match(JSON.stringify(p),/A positioning/);assert.doesNotMatch(JSON.stringify(p),/SECRET/)
 const r=applyOps(s,[{op:'update_item',id:y,title:'attack'},{op:'set_style',id:st},{op:'add_item',title:'scoped'}],{accountId:a});assert.equal(r.errors.length,1);assert.equal(s.accounts.find(i=>i.id===a).defaultStyleId,st);assert.equal(s.items[0].accountId,a);assert.equal(s.items.find(i=>i.id===y).title,'SECRET')
})
test('Monid reimport attributes by external account and never steals existing attribution',()=>{
 const s=seed(), a=account(s),b=account(s,'two');const input={account:{platform:'抖音',id:'external',url:'https://www.douyin.com/user/external'},profile:{nickname:'import'},posts:[{id:'p',title:'post',body:'text',publishedAt:new Date().toISOString(),views:4}]};const first=importPosts(s,input);assert.ok(first.accountId);assert.equal(s.items[0].accountId,first.accountId);importPosts(s,input);assert.equal(s.items.length,1);assert.equal(s.metrics.length,1);assert.equal(s.accounts.length,3);s.items[0].accountId=b;importPosts(s,input);assert.equal(s.items[0].accountId,b);assert.equal(s.metrics[0].accountId,b)
})
test('export identical account titles remains separate; reassignment cannot overwrite another account path',async t=>{
 const root=await mkdtemp(join(tmpdir(),'md-account-export-'));t.after(()=>rm(root,{recursive:true,force:true}));const p={title:'same',article:'A'};const a=await saveProduction(p,{filesDir:root,exportDir:root,accountId:'a'});const b=await saveProduction({...p,article:'B'},{filesDir:root,exportDir:root,accountId:'b'});assert.notEqual(a.path,b.path);const moved=await saveProduction({...p,savedPath:a.path,savedAccountId:'a',article:'moved'},{filesDir:root,exportDir:root,accountId:'b'});assert.notEqual(moved.path,a.path);assert.match(await readFile(join(a.path,'脚本.md'),'utf8'),/A/)
})
test('assignment rejects active production and active assets without altering any selected item',()=>{
 const s=seed(),a=account(s),b=account(s,'b');const x=add(s,{op:'add_item',title:'x',accountId:a}),y=add(s,{op:'add_item',title:'y',accountId:a});s.items.find(i=>i.id===x).production={status:'running'};let r=applyOps(s,[{op:'assign_items',ids:[y,x],accountId:b}]);assert.equal(r.errors.length,1);assert.equal(s.items.find(i=>i.id===y).accountId,a);s.items.find(i=>i.id===x).production={status:'done',cover:{status:'running'}};r=applyOps(s,[{op:'assign_items',ids:[x],accountId:b}]);assert.equal(r.errors.length,1)
})
test('chat scope derives focus, rejects mismatches, filters returned actions and CSV records row errors',async()=>{
 const {resolveChatScope,scopedActions,parseAccountsCsv,switchAccountState}=await import('../src/accounts.js');const s=seed(),a=account(s),b=account(s,'b');const x=add(s,{op:'add_item',title:'x',accountId:a}),y=add(s,{op:'add_item',title:'y',accountId:b});assert.equal(resolveChatScope(s,{focusId:x}),a);assert.throws(()=>resolveChatScope(s,{focusId:x,accountId:b}),/another account/);assert.deepEqual(scopedActions(s,[{type:'produce',id:y},{type:'open',id:x}],a),[{type:'open',id:x}]);const changed=switchAccountState({state:s,focusId:x,dialog:{},capture:{}},b);assert.equal(changed.focusId,null);assert.equal(changed.capture,null);const csv=parseAccountsCsv('platform,handle,group\n抖音,"one, name",g\n抖音,,g');assert.equal(csv.rows.length,1);assert.equal(csv.rows[0].op.handle,'one, name');assert.equal(csv.errors[0].row,3)
})
test('frontend projection caches arrays and async-origin helpers retain source account after switch',async()=>{
 const {createAccountProjection,originScope}=await import('../src/accounts.js');const s=seed(),a=account(s),b=account(s,'b');add(s,{op:'add_item',title:'a',accountId:a});const project=createAccountProjection();const snapshot={state:s,accountId:a};const first=project(snapshot);assert.equal(project({...snapshot,thinking:true}).state.items,first.state.items);const origin=originScope(snapshot);assert.equal(origin.accountId,a);const next=project({...snapshot,accountId:b});assert.equal(next.state.items.length,0);assert.equal(origin.accountId,a)
})
test('bulk CSV retains failed lines and reports unavailable dispatch; limits non-header input to 100 accounts',async()=>{
 const {applyAccountsCsv,parseAccountsCsv}=await import('../src/accounts.js');const result=await applyAccountsCsv('抖音,good\n抖音,bad\n抖音,offline',async op=>op.handle==='bad'?{errors:['invalid']}:op.handle==='offline'?null:{errors:[]});assert.equal(result.added,1);assert.equal(result.errors.length,2);assert.equal(result.remaining,'抖音,bad\n抖音,offline');assert.equal(parseAccountsCsv(Array.from({length:101},(_,i)=>`抖音,${i}`).join('\n')).rows.length,0)
})
test('invalid explicit item attribution, parent cross-account linkage and moving legacy saved export fail safely',()=>{
 const s=seed(),a=account(s),b=account(s,'b');assert.equal(applyOps(s,[{op:'add_item',title:'bad',accountId:4}]).errors.length,1);const x=add(s,{op:'add_item',title:'a',accountId:a});assert.equal(applyOps(s,[{op:'add_item',title:'cross',parentId:x,accountId:b}],{accountId:b}).errors.length,1);s.items[0].production={status:'done',savedPath:'/legacy/path'};add(s,{op:'assign_items',ids:[x],accountId:b});assert.equal(s.items[0].production.savedAccountId,a)
})
test('deleting an account with active generation is rejected; new seed metrics and accounts have additive defaults',()=>{
 const s=seed(),a=account(s);const x=add(s,{op:'add_item',accountId:a,title:'x'});s.items[0].production={status:'running'};assert.equal(applyOps(s,[{op:'delete_account',id:a}]).errors.length,1);assert.equal(s.items[0].accountId,a);const fresh=buildSeed(new Date());assert.equal(fresh.metrics[0].accountId,null);assert.equal(fresh.accounts[0].archived,false)
})
test('account rule exports have separate folders and do not include another accounts rules',async t=>{
 const {scopeState}=await import('../src/accounts.js');const {exportSkill}=await import('../src/learn.js');const root=await mkdtemp(join(tmpdir(),'md-account-rules-'));t.after(()=>rm(root,{recursive:true,force:true}));const s=seed(),a=account(s),b=account(s,'b');add(s,{op:'add_skill',name:'A rule',rule:'A only',status:'active',accountId:a});add(s,{op:'add_skill',name:'SECRET',rule:'B only',status:'active',accountId:b});const one=await exportSkill(scopeState(s,a),root),two=await exportSkill(scopeState(s,b),root);assert.notEqual(one.path,two.path);assert.doesNotMatch(await readFile(one.path,'utf8'),/SECRET/)
})
test('explicit Monid target cannot duplicate an already resolved identity on another profile',async()=>{
 const {validateImportTarget}=await import('../src/accounts.js');const s=seed(),a=account(s),b=account(s,'b');s.accounts[0].externalId='抖音:external';assert.throws(()=>validateImportTarget(s,{platform:'抖音',id:'external',url:'https://www.douyin.com/user/external'},b),/another account/)
})
test('scoped rules cannot be moved through update_skill and account deletion detaches every linked metric',()=>{
 const s=seed(),a=account(s),b=account(s,'b');const rule=add(s,{op:'add_skill',name:'rule',rule:'only A',accountId:a});assert.equal(applyOps(s,[{op:'update_skill',id:rule,accountId:b}],{accountId:a}).errors.length,1);assert.equal(s.skills[0].accountId,a);const x=add(s,{op:'add_item',title:'x',accountId:a});s.metrics.push({id:'wrong',itemId:x,accountId:b,views:8});add(s,{op:'delete_account',id:a});assert.equal(s.metrics[0].accountId,null)
})
test('scoped parent deletion leaves an explicitly reassigned foreign child unchanged',()=>{
 const s=seed(),a=account(s),b=account(s,'b');const parent=add(s,{op:'add_item',title:'parent',accountId:a});const child=add(s,{op:'add_item',title:'child',parentId:parent});add(s,{op:'assign_items',ids:[child],accountId:b});const before=structuredClone(s.items.find(i=>i.id===child));const result=applyOps(s,[{op:'delete_item',id:parent}],{accountId:a});assert.deepEqual(result.errors,[]);assert.equal(s.items.some(i=>i.id===parent),false);assert.deepEqual(s.items.find(i=>i.id===child),before)
})
test('clearing sample accounts detaches authored content and related attribution without deleting content',()=>{
 const s=buildSeed(new Date()),accountId=s.accounts[0].id;const x=add(s,{op:'add_item',title:'authored',accountId});add(s,{op:'add_metric',itemId:x,platform:s.accounts[0].platform,views:8});add(s,{op:'add_skill',name:'authored rule',rule:'keep',accountId});s.chat.push({id:'authored-chat',text:'keep',accountId});add(s,{op:'clear_samples'});assert.equal(s.items.find(i=>i.id===x).accountId,null);assert.equal(s.metrics[0].accountId,null);assert.equal(s.skills[0].accountId,null);assert.equal(s.chat[0].accountId,null)
})
test('account platform cannot change while standalone account metrics retain the old platform',()=>{
 const s=seed(),a=account(s);add(s,{op:'add_metric',accountId:a,platform:'抖音',views:12});const result=applyOps(s,[{op:'update_account',id:a,platform:'快手'}]);assert.equal(result.errors.length,1);assert.equal(s.accounts[0].platform,'抖音');assert.equal(s.metrics[0].platform,'抖音')
})

test('account avatars persist plugin images across reload, replacement, removal and Undo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'md-account-avatar-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  let id
  await store.mutate('avatar add', s => { Object.assign(s, seed()); id = add(s, { op: 'add_account', platform: '快手', handle: 'Portrait', avatar: 'media-desk/files/portrait.png' }) })
  assert.equal((await new Store(root).read()).accounts[0].avatar, 'media-desk/files/portrait.png')
  await store.mutate('avatar replace', s => add(s, { op: 'update_account', id, avatar: 'media-desk/assets/other.webp' }))
  assert.equal((await store.read()).accounts[0].avatar, 'media-desk/assets/other.webp')
  await store.mutate('avatar remove', s => add(s, { op: 'update_account', id, avatar: null }))
  assert.equal((await store.read()).accounts[0].avatar, null)
  await store.undoLast()
  assert.equal((await store.read()).accounts[0].avatar, 'media-desk/assets/other.webp')
  await store.mutate('avatar clear', s => add(s, { op: 'update_account', id, avatar: '' }))
  assert.equal((await store.read()).accounts[0].avatar, null)
})

test('invalid avatar inputs reject the whole account operation without mutating fields', () => {
  const s = seed(), id = account(s)
  for (const avatar of [false, 4, {}, [], 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'file:///tmp/a.png', '/tmp/a.png', 'media-desk/files/../a.png', 'media-desk/files/a.mp4', 'media-desk/files/a.svg', 'https://example.com/' + 'a'.repeat(4000)]) {
    const before = structuredClone(s)
    assert.equal(applyOps(s, [{ op: 'update_account', id, handle: 'Must not change', avatar }]).errors.length, 1, String(avatar))
    assert.deepEqual(s, before)
    assert.equal(applyOps(s, [{ op: 'add_account', platform: '抖音', handle: 'Bad', avatar }]).errors.length, 1)
    assert.deepEqual(s, before)
  }
  const long = 'https://example.com/avatar.png?token=' + 'a'.repeat(3500)
  add(s, { op: 'update_account', id, avatar: long })
  assert.equal(s.accounts[0].avatar, long)
  const legacy = { ...seed(), accounts: [{ id: 'old', avatar: long }, { id: 'missing' }] }
  assert.equal(migrateState(legacy).accounts[0].avatar, long)
  assert.equal(Object.hasOwn(legacy.accounts[1], 'avatar'), false)
})
