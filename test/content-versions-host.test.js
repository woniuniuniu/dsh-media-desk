import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Store } from '../src/store.js'
import host from '../src/host.js'

test('GUI route seals content before browser cover work, exports sealed data and preserves newer working content', async t => {
  const home = await mkdtemp(join(tmpdir(), 'md-versions-host-'));t.after(()=>rm(home,{recursive:true,force:true}))
  const old=process.env.DSH_HOME;process.env.DSH_HOME=home;t.after(()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old})
  const store=new Store(join(home,'media-desk'))
  await store.mutate('setup',s=>{s.accounts=[{id:'a',platform:'快手',handle:'A'}];s.items=[{id:'work',accountId:'a',title:'idea',production:{status:'done',title:'SEALED',article:'ORIGINAL',cover:null,images:[],shots:[]}}]})
  await writeFile(join(store.root,'settings.json'),JSON.stringify({exportDir:join(home,'exports')}))
  let route;const effects=[]
  host.apply({effect:fn=>effects.push(fn),webServer:{register:options=>{route=options.handler;return()=>{}}},get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined})
  const dispose=effects[1]();t.after(()=>dispose?.()) // Do not start a bridge, model or installed runtime.
  async function request(path,body){const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',url:`/media-desk/${path}`,headers:{}});let result;await route(req,{setHeader(){},end(value){result={status:this.statusCode,body:JSON.parse(value)}}});return result}
  const sealed=await request('produce/seal',{id:'work',accountId:'a'})
  assert.equal(sealed.status,200);assert.equal(sealed.body.production.article,'ORIGINAL');assert.ok(sealed.body.versionId)
  assert.equal((await request('ops',{accountId:'a',ops:[{op:'update_production',id:'work',article:'NEW WORKING ARTICLE'}]})).status,200)
  const saved=await request('produce/save',{id:'work',accountId:'a',versionId:sealed.body.versionId})
  assert.equal(saved.status,200);assert.equal(saved.body.currentMatches,false);assert.match(await readFile(join(saved.body.path,'脚本.md'),'utf8'),/ORIGINAL/)
  const item=saved.body.state.items[0];assert.equal(item.production.article,'NEW WORKING ARTICLE');assert.equal(item.production.savedPath,undefined);assert.equal(item.contentVersionExports[0].versionId,sealed.body.versionId)
  const invalid=await request('produce/save',{id:'work',accountId:'missing',versionId:sealed.body.versionId});assert.equal(invalid.status,400)
})

test('GUI export uncertainty retains bounded recovery evidence without state or private error details', async t => {
  const home=await mkdtemp(join(tmpdir(),'md-versions-fault-'));t.after(()=>rm(home,{recursive:true,force:true}))
  const old=process.env.DSH_HOME;process.env.DSH_HOME=home;t.after(()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old})
  const store=new Store(join(home,'media-desk'))
  await store.mutate('setup',s=>{s.accounts=[];s.items=[{id:'work',accountId:null,title:'idea',production:{status:'done',title:'saved',article:'KEPT OUTPUT',cover:null,images:[],shots:[]}}]})
  await writeFile(join(store.root,'settings.json'),JSON.stringify({exportDir:join(home,'exports'),privateMarker:'PRIVATE_SETTINGS'}))
  let route;const effects=[];host.apply({effect:fn=>effects.push(fn),webServer:{register:opts=>{route=opts.handler;return()=>{}}},get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined});const dispose=effects[1]();t.after(()=>dispose?.())
  const original=Store.prototype.mutate
  Store.prototype.mutate=function(label,...args){if(label==='记录导出结果')return Promise.reject(new Error('PRIVATE_PROVIDER disk detail'));return original.call(this,label,...args)}
  t.after(()=>{Store.prototype.mutate=original})
  const req=Readable.from([Buffer.from(JSON.stringify({id:'work',accountId:null}))]);Object.assign(req,{method:'POST',url:'/media-desk/produce/save',headers:{}})
  let result;await route(req,{setHeader(){},end(body){result={status:this.statusCode,body:JSON.parse(body)}}})
  assert.equal(result.status,500);assert.equal(result.body.code,'OUTCOME_UNKNOWN')
  const evidence=result.body.details.export;assert.equal(evidence.itemId,'work');assert.equal(evidence.versionNumber,1);assert.match(evidence.versionId,/^[a-f0-9-]{36}$/)
  assert.match(await readFile(join(evidence.path,'脚本.md'),'utf8'),/KEPT OUTPUT/);assert.equal(JSON.parse(await readFile(join(evidence.path,'manifest.json'),'utf8')).versionId,evidence.versionId)
  assert.equal(result.body.state,undefined);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE_SETTINGS|PRIVATE_PROVIDER/)
})

for(const routeKind of ['GUI','MCP'])test(`${routeKind} sealed exports copy builtin assets exactly and reject remote or missing references before output`,async t=>{
  const {readdir,mkdir}=await import('node:fs/promises')
  const home=await mkdtemp(join(tmpdir(),'md-assets-version-'));t.after(()=>rm(home,{recursive:true,force:true}))
  const old=process.env.DSH_HOME;process.env.DSH_HOME=home;t.after(()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old})
  const store=new Store(join(home,'media-desk')),out=join(home,'exports'),sentinel=join(out,'old-user-folder');await store.read();await mkdir(sentinel,{recursive:true});await writeFile(join(sentinel,'keep.md'),'USER EDIT')
  await store.mutate('setup',s=>{s.accounts=[];s.items=[]})
  await writeFile(join(store.root,'settings.json'),JSON.stringify({exportDir:out}))
  let route;const effects=[]
  host.apply({effect:fn=>effects.push(fn),webServer:{register:options=>{route=options.handler;return()=>{}}},get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined});const dispose=effects[1]();t.after(()=>dispose?.())
  const {createAutomationService}=await import('../src/automation/service.js'),service=createAutomationService({store,producer:{isRunning:()=>false,anyAssetActive:()=>false},settings:{read:async()=>({exportDir:out})}})
  async function exportOne(id){if(routeKind==='MCP')return service.call({tool:'media_desk_export',input:{id,accountId:null},requestId:`asset-${id}`});const req=Readable.from([Buffer.from(JSON.stringify({id,accountId:null}))]);Object.assign(req,{method:'POST',url:'/media-desk/produce/save',headers:{}});let result;await route(req,{setHeader(){},end(value){result={status:this.statusCode,body:JSON.parse(value)}}});return result}
  for(const [id,src] of [['remote','https://example.invalid/required.png'],['missing','media-desk/files/required-missing.png']]){
    await store.mutate('invalid asset',s=>{s.items=[{id,accountId:null,title:id,production:{status:'done',title:id,article:'body',images:[{src,caption:'required'}],shots:[],cover:null}}]})
    const result=await exportOne(id);if(routeKind==='MCP'){assert.equal(result.ok,false);assert.equal(result.error.code,'ASSET_ERROR')}else{assert.equal(result.status,400);assert.equal(result.body.code,'ASSET_ERROR')}
    assert.deepEqual(await readdir(out),['old-user-folder']);assert.equal((await store.read()).items[0].production.savedAt,undefined)
  }
  await store.mutate('builtin asset',s=>{s.items=[{id:'builtin',accountId:null,title:'builtin',production:{status:'done',title:'builtin',article:'## Section\nBody',cover:{src:'media-desk/assets/facade.jpg'},images:[{src:'media-desk/assets/facade.jpg',caption:'builtin bytes',anchor:'Section'}],shots:[{src:'media-desk/assets/facade.jpg',visual:'builtin shot',voice:'voice'}]}}]})
  const result=await exportOne('builtin'),saved=routeKind==='MCP'?result.result:result.body
  if(routeKind==='MCP')assert.equal(result.ok,true,JSON.stringify(result));else assert.equal(result.status,200)
  for(const file of ['配图1.jpg','封面原图.jpg','分镜01.jpg'])assert.deepEqual(await readFile(join(saved.path,file)),await readFile(new URL('../assets/facade.jpg',import.meta.url)))
  assert.match(await readFile(join(saved.path,'分镜脚本.md'),'utf8'),/分镜01.jpg/)
  assert.match(await readFile(join(saved.path,'脚本.md'),'utf8'),/!\[builtin bytes\]\(配图1.jpg\)/);assert.equal(await readFile(join(sentinel,'keep.md'),'utf8'),'USER EDIT')
})
