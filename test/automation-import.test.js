import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, readdir, stat, symlink, mkdir, truncate, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { Store } from '../src/store.js'
import { createAutomationService } from '../src/automation/service.js'
import { MutationJournal } from '../src/automation/journal.js'
import { writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { importLocalFile } from '../src/automation/import-file.js'
import { automationDirectory } from '../src/automation/paths.js'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
const call = (service, tool, input = {}, requestId) => service.call({ tool: `media_desk_${tool}`, input, requestId })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canvas = createCanvas(3, 2)
canvas.getContext('2d').fillRect(0, 0, 3, 2)
const png = canvas.toBuffer('image/png')
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'md-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(join(root, 'media-desk'))
  await store.mutate('empty', s => { s.items = []; s.accounts = [{ id: 'account-a', platform: '快手', handle: 'A' }] })
  const options = { store, settings: {}, producer: {}, assist: () => { throw new Error('must not call model') }, ...extra }
  const service = createAutomationService(options)
  const source = join(root, '中文 image.png'); await writeFile(source, png)
  return { root, store, service, source, options }
}

test('local image import creates one scoped idea, preserves bytes, and returns compact inspectable media', async t => {
  const { root, store, service, source } = await fixture(t)
  const result = await call(service, 'import_file', { path: source, accountId: 'account-a', title: '中文 English', body: 'private body', tags: ['素材'] }, 'import-one')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(Object.keys(result.result).sort(), ['accountId','bytes','id','kind','media','mimeType','sha256','title'].sort())
  assert.equal(result.result.title, '中文 English'); assert.equal(result.result.kind, 'image')
  assert.equal(result.result.mimeType, 'image/png'); assert.equal(result.result.bytes, png.length); assert.equal(result.result.sha256, hash(png))
  assert.deepEqual({ w: result.result.media.w, h: result.result.media.h }, { w: 3, h: 2 })
  const destination = join(store.filesDir, basename(result.result.media.src))
  assert.deepEqual(await readFile(destination), png); assert.deepEqual(await readFile(source), png)
  assert.equal((await stat(destination)).mode & 0o777, 0o600)
  const state = await store.read(); assert.equal(state.items.length, 1)
  assert.equal(state.items[0].accountId, 'account-a'); assert.equal(state.items[0].platform, '快手'); assert.equal(state.items[0].status, 'idea')
  assert.equal(state.items[0].importRequestId, 'import-one'); assert.equal(JSON.stringify(state).includes(source), false)
  const list = await call(service, 'list_items', { query: 'import-one' }); assert.equal(list.result.total, 1); assert.equal(list.result.items[0].importRequestId, 'import-one'); assert.equal(list.result.items[0].media, undefined)
  const item = await call(service, 'get_item', { id: result.result.id, fields: ['media'] })
  assert.deepEqual(item.result.media, result.result.media); assert.equal(item.result.body, undefined)
  assert.equal(JSON.stringify(result).includes(root), false); assert.equal(JSON.stringify(result).includes('private body'), false)
})

test('image formats and conservative video containers import without transcoding or model calls', async t => {
  const { root, service, store } = await fixture(t)
  const mp4 = await readFile(new URL('../assets/v-ink.mp4', import.meta.url))
  const mov = Buffer.from(mp4); mov.write('qt  ', 8)
  // A small EBML WebM container fixture: DocType webm and a bounded Segment.
  const webm = Buffer.from('1a45dfa3874282847765626d18538067a81549a966872ad7b1830f42401654ae6b8fae8dd781018381018685565f5650381f43b67583e78100', 'hex')
  const formats = [ ['jpg', canvas.toBuffer('image/jpeg'), 'image/jpeg'], ['webp', canvas.toBuffer('image/webp'), 'image/webp'], ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'), 'image/gif'], ['mp4', mp4, 'video/mp4'], ['mov', mov, 'video/quicktime'], ['webm', webm, 'video/webm'] ]
  for (const [ext, bytes, mimeType] of formats) {
    const path = join(root, `sample.${ext}`); await writeFile(path, bytes)
    const r = await call(service, 'import_file', { path }, `format-${ext}`)
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.result.mimeType, mimeType); assert.equal(r.result.accountId, null)
    assert.equal(r.result.title, `sample.${ext}`); assert.equal(r.result.sha256, hash(bytes)); assert.deepEqual(await readFile(join(store.filesDir, basename(r.result.media.src))), bytes)
  }
})

test('invalid files fail safely with no copied file or content and never disclose source paths', async t => {
  const { root, service, store, source } = await fixture(t)
  const cases = [['text.png', Buffer.from('not an image')], ['wrong.jpg', png], ['empty.png', Buffer.alloc(0)], ['truncated.png', png.subarray(0,24)], ['unsupported.svg', Buffer.from('<svg/>')], ['fake.mp4', Buffer.from('ftyp isom')], ['fake.webm',Buffer.from('1a45dfa3874282847765626d18538067841654ae6b','hex')]]
  for (const [name, bytes] of cases) await writeFile(join(root, name), bytes)
  await mkdir(join(root, 'directory.png')); await symlink(source, join(root, 'link.png'))
  const huge = join(root, 'huge.png'); await writeFile(huge, png); await truncate(huge, 25000001)
  for (const name of [...cases.map(c => c[0]), 'directory.png', 'link.png', 'huge.png', 'missing.png']) {
    const r = await call(service, 'import_file', { path: join(root,name) }, `invalid-${name}`)
    assert.equal(r.ok, false, name); assert.equal(r.error.code, 'ASSET_ERROR', JSON.stringify(r)); assert.equal(JSON.stringify(r).includes(root), false)
  }
  assert.equal((await store.read()).items.length, 0); assert.deepEqual(await readdir(store.filesDir), [])
})

test('schema, account validation and read-only reject before source access', async t => {
  const { service, store, root, options } = await fixture(t)
  for (const input of [{path:'relative.png'}, {path:'https://example.com/a.png'}, {path:join(root,'missing.png'),bytes:'base64'}, {path:'x'.repeat(4097)}, {path:join(root,'missing.png'),title:'x'.repeat(301)}, {path:join(root,'missing.png'),tags:Array(25).fill('a')}]) {
    assert.equal((await call(service, 'import_file', input, 'schema-'+hash(JSON.stringify(input)))).error.code, 'INVALID_ARGUMENT')
  }
  const r = await call(service, 'import_file', { path: join(root,'missing.png'), accountId: 'missing' }, 'invalid-account')
  assert.equal(r.error.code, 'INVALID_ARGUMENT'); assert.deepEqual(await readdir(store.filesDir), [])
  const ro = createAutomationService({ ...options, readOnly: true, store: { root: store.root, read: () => { throw new Error('no I/O') } } })
  assert.equal((await call(ro, 'import_file', { path: '/unreadable.png' }, 'readonly')).error.code, 'READ_ONLY')
  assert.equal((await call(service, 'apply_ops', { ops: [{op:'add_item',title:'forged',importRequestId:'forged'}] }, 'forged')).error.code, 'INVALID_ARGUMENT')
})

test('journal covers the copy: concurrent duplicates copy once and cached results survive missing sources', async t => {
  const { service, source, store, root } = await fixture(t)
  const input = { path: source }
  const results = await Promise.all(Array.from({length:8}, () => call(service,'import_file',input,'copy-once')))
  assert.ok(results.every(r=>r.ok), JSON.stringify(results)); assert.equal(new Set(results.map(r=>r.result.id)).size,1)
  assert.equal((await readdir(store.filesDir)).length,1); assert.equal((await store.read()).items.length,1)
  await rm(source)
  const cached = await call(service,'import_file',input,'copy-once'); assert.equal(cached.ok,true); assert.equal(cached.cached,true)
  assert.equal((await call(service,'import_file',{...input,title:'changed'},'copy-once')).error.code,'REQUEST_ID_CONFLICT')
  const recovered = createAutomationService({ store, settings:{}, producer:{} })
  assert.equal((await call(recovered,'import_file',input,'copy-once')).cached,true)
  const raw = await readFile(join(automationDirectory(store.root,'desktop'),'journal.json'),'utf8'); assert.equal(raw.includes(source),false)
})

test('image dimensions are bounded before native decoding, and special files cannot block an import', async t => {
  const { root, service, store } = await fixture(t)
  const oversizedHeader = Buffer.from(png); oversizedHeader.writeUInt32BE(20000,16)
  const path = join(root,'dimensions.png'); await writeFile(path,oversizedHeader)
  assert.equal((await call(service,'import_file',{path},'dimensions')).error.code,'ASSET_ERROR')
  const fifo = join(root,'fifo.png'); await promisify(execFile)('/usr/bin/mkfifo',[fifo])
  assert.equal((await call(service,'import_file',{path:fifo},'fifo')).error.code,'ASSET_ERROR')
  assert.equal((await call(service,'import_file',{path:'/dev/null'},'device')).error.code,'ASSET_ERROR')
  assert.equal((await store.read()).items.length,0)
})

test('source modification during the copy refuses the item and removes its own copy', async t => {
  const { source, store, service } = await fixture(t)
  // Intercept only the read boundary to deterministically change the real source after its snapshot.
  let changed = false
  const fd=await open(source,'r');const prototype=Object.getPrototypeOf(fd);await fd.close();const read=prototype.read
  t.mock.method(prototype,'read',async function(...args){const result=await read.apply(this,args);if(!changed){changed=true;writeFileSync(source,Buffer.from('changed'))}return result})
  const result = await call(service,'import_file',{path:source},'changing-source')
  assert.equal(changed,true); assert.equal(result.error.code,'ASSET_ERROR')
  assert.equal((await store.read()).items.length,0); assert.deepEqual(await readdir(store.filesDir),[])
})

test('account removal before the serialized commit fails cleanly instead of silently unassigning', async t => {
  const { source, store, service } = await fixture(t)
  const mutate = store.mutate.bind(store)
  store.mutate = async (label, fn, options) => {
    if (label==='导入本地素材') await mutate('remove target',s=>{s.accounts=[]})
    return mutate(label,fn,options)
  }
  const result = await call(service,'import_file',{path:source,accountId:'account-a'},'deleted-account')
  assert.equal(result.error.code,'INVALID_ARGUMENT'); assert.equal((await store.read()).items.length,0); assert.deepEqual(await readdir(store.filesDir),[])
})

test('an uncertain Store persist retains the potentially committed asset and is inspectable by request ID', async t => {
  const { source, store, service } = await fixture(t)
  const persist=store.persist.bind(store)
  store.persist=async()=>{await persist();throw new Error('private path disk failure')}
  const result=await call(service,'import_file',{path:source},'uncertain-import')
  assert.equal(result.error.code,'OUTCOME_UNKNOWN'); assert.equal(JSON.stringify(result).includes('private path'),false)
  assert.equal((await readdir(store.filesDir)).length,1)
  const recovered=new Store(store.root); const state=await recovered.read(); assert.equal(state.items.length,1); assert.equal(state.items[0].importRequestId,'uncertain-import')
  assert.equal((await call(service,'list_items',{query:'uncertain-import'})).result.total,1)
  assert.equal((await call(service,'import_file',{path:source},'uncertain-import')).error.code,'OUTCOME_UNKNOWN')
})

test('pending import recovery never opens the source or creates another copy', async t => {
  const { root, store } = await fixture(t)
  const journalRoot=join(root,'pending-import'); const journal=new MutationJournal(journalRoot)
  const input={path:join(root,'gone.png')}; let finish
  const pending=journal.execute('pending-file','media_desk_import_file',input,()=>new Promise(resolve=>{finish=resolve}))
  while(!finish) await new Promise(resolve=>setImmediate(resolve))
  const service=createAutomationService({store,settings:{},producer:{},journal:new MutationJournal(journalRoot)})
  assert.equal((await call(service,'import_file',input,'pending-file')).error.code,'OUTCOME_UNKNOWN')
  assert.deepEqual(await readdir(store.filesDir),[])
  finish({ok:true,result:{}});await pending
})

test('at most two imports perform file work concurrently, and symlinked destination directories are refused', async t => {
  const { source, store, root, service } = await fixture(t)
  const releases=[]
  const commit=()=>new Promise(resolve=>releases.push(resolve))
  const first=importLocalFile({path:source,filesDir:store.filesDir},commit)
  const second=importLocalFile({path:source,filesDir:store.filesDir},commit)
  while(releases.length<2) await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(importLocalFile({path:source,filesDir:store.filesDir},commit),{code:'BUSY'})
  for(const release of releases)release({});await Promise.all([first,second])
  await rm(store.filesDir,{recursive:true});const outside=join(root,'outside');await mkdir(outside);await symlink(outside,store.filesDir)
  const result=await call(service,'import_file',{path:source},'unsafe-directory')
  assert.equal(result.error.code,'ASSET_ERROR'); assert.deepEqual(await readdir(outside),[])
})

test('opt-in media fields exclude private paths and return only bounded reference metadata', async t => {
  const {store,service}=await fixture(t)
  await store.mutate('legacy malformed media',s=>{s.items=[{id:'legacy',title:'Legacy',body:'private',media:{src:'/private/source.png',poster:'data:image/png;base64,secret',w:3,h:2,private:'secret'}}]})
  const r=await call(service,'get_item',{id:'legacy',fields:['media']})
  assert.deepEqual(r.result.media,{w:3,h:2});assert.equal(JSON.stringify(r).includes('/private'),false);assert.equal(JSON.stringify(r).includes('secret'),false)
})

test('legacy QuickTime MOV without ftyp imports with exact container bytes', async t => {
  const {root,service}=await fixture(t);const mp4=await readFile(new URL('../assets/v-ink.mp4',import.meta.url))
  const removed=mp4.readUInt32BE(0);const bytes=Buffer.from(mp4.subarray(removed));const offsets=bytes.indexOf(Buffer.from('stco'))
  for(let i=0;i<bytes.readUInt32BE(offsets+8);i++)bytes.writeUInt32BE(bytes.readUInt32BE(offsets+12+i*4)-removed,offsets+12+i*4)
  const path=join(root,'legacy.mov');await writeFile(path,bytes)
  const r=await call(service,'import_file',{path},'legacy-mov')
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.result.sha256,hash(bytes));assert.equal(r.result.mimeType,'video/quicktime')
})

test('avatar destination imports one exact-byte image directly to an account with a recoverable request marker', async t => {
  const {store,service,source}=await fixture(t)
  const input={path:source,destination:'avatar',accountId:'account-a'}
  const responses=await Promise.all(Array.from({length:4},()=>call(service,'import_file',input,'avatar-once')))
  assert.ok(responses.every(r=>r.ok),JSON.stringify(responses));const r=responses[0]
  assert.equal(r.result.destination,'avatar');assert.equal(r.result.accountId,'account-a');assert.equal(r.result.id,undefined);assert.equal(r.result.sha256,hash(png));assert.equal(r.result.media.w,3)
  const state=await store.read();assert.equal(state.items.length,0);assert.equal(state.accounts[0].avatar,r.result.media.src);assert.deepEqual(state.accounts[0].avatarImport,{requestId:'avatar-once',src:r.result.media.src})
  assert.equal((await call(service,'get_account',{id:'account-a'})).result.avatarImportRequestId,'avatar-once')
  assert.equal((await call(service,'list_accounts')).result.accounts[0].avatarImportRequestId,'avatar-once')
  assert.deepEqual(await readFile(join(store.filesDir,basename(r.result.media.src))),png);assert.deepEqual(await readFile(source),png);assert.equal((await readdir(store.filesDir)).length,1)
  await rm(source);assert.equal((await call(service,'import_file',input,'avatar-once')).cached,true)
  assert.equal((await call(service,'import_file',{...input,accountId:'missing'},'avatar-once')).error.code,'REQUEST_ID_CONFLICT')
})

test('avatar imports require a concrete account, reject item fields and videos, and cannot forge recovery markers', async t => {
  const {root,service,source,store,options}=await fixture(t)
  const base={path:source,destination:'avatar',accountId:'account-a'}
  for(const input of [{...base,accountId:undefined},{...base,accountId:null},{...base,title:'x'},{...base,body:''},{...base,tags:[]},{...base,destination:'other'}]) {
    const r=await call(service,'import_file',input,'avatar-invalid-'+hash(JSON.stringify(input)))
    assert.equal(r.error.code,'INVALID_ARGUMENT',JSON.stringify(r))
  }
  assert.equal((await call(service,'import_file',{...base,path:join(root,'missing.png'),accountId:'missing'},'avatar-scope')).error.code,'INVALID_ARGUMENT')
  const video=join(root,'avatar.mp4');await writeFile(video,await readFile(new URL('../assets/v-ink.mp4',import.meta.url)))
  assert.equal((await call(service,'import_file',{...base,path:video},'avatar-video')).error.code,'ASSET_ERROR')
  assert.equal((await call(service,'apply_ops',{ops:[{op:'update_account',id:'account-a',avatarImport:{requestId:'fake',src:'media-desk/files/fake.png'}}]},'avatar-forged')).error.code,'INVALID_ARGUMENT')
  const ro=createAutomationService({...options,readOnly:true,store:{root:store.root,read:()=>{throw new Error('no I/O')}}})
  assert.equal((await call(ro,'import_file',base,'avatar-readonly')).error.code,'READ_ONLY')
  assert.deepEqual(await readdir(store.filesDir),[]);assert.equal((await store.read()).items.length,0)
})

test('avatar replacement hides stale request markers and Undo restores references while retaining imported files', async t => {
  const {store,service,source}=await fixture(t)
  await store.mutate('old avatar',s=>{s.accounts[0].avatar='media-desk/files/old.png'})
  const r=await call(service,'import_file',{path:source,destination:'avatar',accountId:'account-a'},'avatar-undo')
  assert.equal(r.ok,true,JSON.stringify(r));const copied=join(store.filesDir,basename(r.result.media.src))
  await call(service,'apply_ops',{ops:[{op:'update_account',id:'account-a',avatar:'media-desk/files/manual.png'}]},'manual-avatar')
  assert.equal((await call(service,'get_account',{id:'account-a'})).result.avatarImportRequestId,undefined)
  assert.equal((await call(service,'list_accounts')).result.accounts[0].avatarImportRequestId,undefined)
  await store.undoLast();assert.equal((await call(service,'get_account',{id:'account-a'})).result.avatarImportRequestId,'avatar-undo')
  await store.undoLast();const account=(await call(service,'get_account',{id:'account-a'})).result
  assert.equal(account.avatar,'media-desk/files/old.png');assert.equal(account.avatarImportRequestId,undefined);assert.deepEqual(await readFile(copied),png);assert.equal((await store.read()).items.length,0)
})

test('uncertain avatar persistence retains its file and marker for account inspection', async t => {
  const {store,service,source}=await fixture(t);const persist=store.persist.bind(store)
  store.persist=async()=>{await persist();throw new Error('private persistence failure')}
  const input={path:source,destination:'avatar',accountId:'account-a'}
  const r=await call(service,'import_file',input,'avatar-unknown');assert.equal(r.error.code,'OUTCOME_UNKNOWN')
  const account=(await call(service,'get_account',{id:'account-a'})).result
  assert.equal(account.avatarImportRequestId,'avatar-unknown');assert.deepEqual(await readFile(join(store.filesDir,basename(account.avatar))),png)
  assert.equal((await call(service,'import_file',input,'avatar-unknown')).error.code,'OUTCOME_UNKNOWN');assert.equal((await store.read()).items.length,0)
})

test('avatar account removal during file work cleans up without an item or stale avatar', async t => {
  const {store,service,source}=await fixture(t);const mutate=store.mutate.bind(store)
  store.mutate=async(label,fn,options)=>{if(label==='导入账号头像')await mutate('delete avatar target',s=>{s.accounts=[]});return mutate(label,fn,options)}
  const r=await call(service,'import_file',{path:source,destination:'avatar',accountId:'account-a'},'avatar-deleted')
  assert.equal(r.error.code,'INVALID_ARGUMENT');assert.equal((await store.read()).items.length,0);assert.deepEqual(await readdir(store.filesDir),[])
})

test('a failed final journal write retains a committed media file and never dispatches again', async t => {
  const {store,source,root}=await fixture(t);const journal=new MutationJournal(join(root,'faulted-journal'));const persist=journal.persist.bind(journal);let writes=0
  journal.persist=async()=>{if(++writes===2)throw new Error('journal fault');return persist()}
  const service=createAutomationService({store,settings:{},producer:{},journal});const input={path:source}
  assert.equal((await call(service,'import_file',input,'journal-unknown')).error.code,'OUTCOME_UNKNOWN')
  assert.equal((await call(service,'import_file',input,'journal-unknown')).error.code,'OUTCOME_UNKNOWN')
  assert.equal((await store.read()).items.length,1);assert.equal((await readdir(store.filesDir)).length,1)
})

test('complete image boundaries are required even when the native decoder tolerates truncation', async t => {
  const jpeg=canvas.toBuffer('image/jpeg');const webp=canvas.toBuffer('image/webp')
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')
  const inputs=[['png',png.subarray(0,-12)],['jpg',jpeg.subarray(0,-2)],['gif',gif.subarray(0,-1)],['webp',webp.subarray(0,-2)]]
  for(const [extension,bytes]of inputs)await t.test(extension,async subtest=>{
    const {root,store,service}=await fixture(subtest)
    const path=join(root,`missing-end.${extension}`);await writeFile(path,bytes)
    const r=await call(service,'import_file',{path},`missing-end-${extension}`)
    assert.equal(r.ok,false,`truncated ${extension} was accepted`);assert.equal(r.error.code,'ASSET_ERROR')
    assert.deepEqual(await readFile(path),bytes);assert.deepEqual(await readdir(store.filesDir),[]);assert.equal((await store.read()).items.length,0)
  })
})

test('MP4 and MOV require bounded movie, track and media metadata rather than arbitrary box payloads', async t => {
  const box=(type,payload)=>{const result=Buffer.alloc(8+payload.length);result.writeUInt32BE(result.length);result.write(type,4);payload.copy(result,8);return result}
  const moov=box('moov',Buffer.from('x'));const mdat=box('mdat',Buffer.from('x'));const ftyp=box('ftyp',Buffer.from('isom0000'))
  const actual=await readFile(new URL('../assets/v-ink.mp4',import.meta.url))
  const withoutMovieHeader=Buffer.from(actual);const mvhd=withoutMovieHeader.indexOf(Buffer.from('mvhd'));assert.ok(mvhd>0);withoutMovieHeader.write('free',mvhd)
  const withoutMedia=Buffer.from(actual);const mdia=withoutMedia.indexOf(Buffer.from('mdia'));assert.ok(mdia>0);withoutMedia.write('free',mdia)
  const brokenTrack=Buffer.from(actual);const trak=brokenTrack.indexOf(Buffer.from('trak'));assert.ok(trak>0);brokenTrack.writeUInt32BE(actual.length,trak-4)
  const cases=[['fake.mp4',Buffer.concat([ftyp,moov,mdat])],['fake.mov',Buffer.concat([moov,mdat])],['no-mvhd.mp4',withoutMovieHeader],['no-mdia.mp4',withoutMedia],['bad-trak-size.mp4',brokenTrack]]
  for(const [name,bytes]of cases)await t.test(name,async subtest=>{
    const {root,store,service}=await fixture(subtest)
    const path=join(root,name);await writeFile(path,bytes);const r=await call(service,'import_file',{path},`metadata-${name}`)
    assert.equal(r.ok,false,`${name} was accepted`);assert.equal(r.error.code,'ASSET_ERROR');assert.deepEqual(await readFile(path),bytes)
    assert.deepEqual(await readdir(store.filesDir),[]);assert.equal((await store.read()).items.length,0)
  })
})

test('first import initializes a fresh Store when account scope is omitted', async t => {
  const root=await mkdtemp(join(tmpdir(),'md-import-first-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new Store(join(root,'desk'));const path=join(root,'first.png');await writeFile(path,png)
  const service=createAutomationService({store,settings:{},producer:{}})
  const r=await call(service,'import_file',{path},'first-import')
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.result.accountId,null)
  assert.equal((await store.read()).items.filter(item=>item.importRequestId==='first-import').length,1)
  assert.deepEqual(await readFile(join(store.filesDir,basename(r.result.media.src))),png)
})

test('WebM requires bounded Info, TrackEntry metadata and Cluster child elements', async t => {
  const element=(id,payload)=>Buffer.concat([Buffer.from(id,'hex'),Buffer.from([0x80|payload.length]),payload])
  const header=Buffer.from('1a45dfa3874282847765626d','hex')
  const info=element('1549a966',Buffer.from('2ad7b1830f4240','hex'))
  const tracks=element('1654ae6b',Buffer.from('ae8dd781018381018685565f565038','hex'))
  const cluster=element('1f43b675',Buffer.from('e78100','hex'))
  const container=parts=>Buffer.concat([header,element('18538067',Buffer.concat(parts))])
  const missingCodec=Buffer.from(tracks);missingCodec[missingCodec.indexOf(Buffer.from('8685','hex'))]=0x87
  const cases=[
    ['all-fake',container(['1549a966','1654ae6b','1f43b675'].map(id=>element(id,Buffer.from('x'))))],
    ['bad-track-entry',container([info,element('1654ae6b',element('ae',Buffer.from('x'))),cluster])],
    ['no-codec',container([info,missingCodec,cluster])],
    ['bad-info-child',container([element('1549a966',Buffer.from('2ad7b1880f4240','hex')),tracks,cluster])],
    ['bad-cluster-child',container([info,tracks,element('1f43b675',Buffer.from('e78300','hex'))])],
  ]
  for(const[name,bytes]of cases)await t.test(name,async subtest=>{
    const {root,store,service}=await fixture(subtest);const path=join(root,`${name}.webm`);await writeFile(path,bytes)
    const r=await call(service,'import_file',{path},`webm-${name}`);assert.equal(r.ok,false,`${name} was accepted`);assert.equal(r.error.code,'ASSET_ERROR')
    assert.deepEqual(await readFile(path),bytes);assert.deepEqual(await readdir(store.filesDir),[]);assert.equal((await store.read()).items.length,0)
  })
})

test('metadata and video imports work without native image support, while image failure stays local', async t => {
  const {store,source,root}=await fixture(t)
  const bundled=await build({entryPoints:['src/automation/service.js'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',supported:{'dynamic-import':false},define:{'import.meta.url':JSON.stringify(new URL('../src/automation/cover.js',import.meta.url).href)}})
  const realRequire=createRequire(import.meta.url);let nativeLoads=0;const module={exports:{}}
  vm.runInNewContext(bundled.outputFiles[0].text,{module,exports:module.exports,require:name=>{if(name==='@napi-rs/canvas'){nativeLoads++;throw new Error('native backend unavailable')}return realRequire(name)},process,Buffer,URL,console,structuredClone,setTimeout,clearTimeout})
  const service=module.exports.createAutomationService({store,settings:{},producer:{}})
  assert.equal((await call(service,'status')).ok,true);assert.equal((await call(service,'list_items')).result.total,0)
  assert.equal(nativeLoads,0)
  const image=await call(service,'import_file',{path:source},'missing-native-image');assert.equal(image.error.code,'ASSET_ERROR');assert.equal(nativeLoads,1);assert.deepEqual(await readdir(store.filesDir),[])
  const path=join(root,'native-free.mp4');await writeFile(path,await readFile(new URL('../assets/v-ink.mp4',import.meta.url)))
  const video=await call(service,'import_file',{path},'native-free-video');assert.equal(video.ok,true,JSON.stringify(video));assert.equal(video.result.kind,'video');assert.equal(nativeLoads,1)
  assert.equal((await call(service,'status')).ok,true)
})

test('MP4 size-zero mdat must contain all real sample references through EOF', async t => {
  const original=await readFile(new URL('../assets/v-ink.mp4',import.meta.url));const bytes=Buffer.from(original)
  const mdat=bytes.indexOf(Buffer.from('mdat'))-4;assert.equal(mdat,1725);bytes.writeUInt32BE(0,mdat)
  for(const[title,data,expected]of[['complete',bytes,true],['truncated',bytes.subarray(0,mdat+9),false]])await t.test(title,async subtest=>{
    const {root,store,service}=await fixture(subtest);const path=join(root,`${title}.mp4`);await writeFile(path,data)
    const result=await call(service,'import_file',{path},`size-zero-${title}`)
    assert.equal(result.ok,expected,JSON.stringify(result))
    if(expected)assert.equal(result.result.sha256,hash(data))
    else{assert.equal(result.error.code,'ASSET_ERROR');assert.deepEqual(await readdir(store.filesDir),[]);assert.equal((await store.read()).items.length,0)}
    assert.deepEqual(await readFile(path),data)
  })
})

test('fragmented MP4 with empty initialization tables validates its trun sample extents', async t => {
  const original=await readFile(new URL('../assets/v-ink.mp4',import.meta.url))
  const box=(type,payload)=>{const data=Buffer.alloc(8+payload.length);data.writeUInt32BE(data.length);data.write(type,4);payload.copy(data,8);return data}
  const full=(flags,...values)=>{const data=Buffer.alloc(4+4*values.length);data.writeUInt32BE(flags);values.forEach((value,index)=>data.writeUInt32BE(value,4+index*4));return data}
  const stsz=original.indexOf(Buffer.from('stsz'));const sampleCount=original.readUInt32BE(stsz+12)
  const sampleSizes=Array.from({length:sampleCount},(_,index)=>original.readUInt32BE(stsz+16+index*4))
  const tkhd=original.indexOf(Buffer.from('tkhd'));const trackId=original.readUInt32BE(tkhd+16)
  const stts=original.indexOf(Buffer.from('stts'));const sampleDuration=original.readUInt32BE(stts+16)
  function rewrite(start,end){const parts=[];for(let at=start;at<end;){const size=original.readUInt32BE(at);const type=original.toString('ascii',at+4,at+8);let payload=original.subarray(at+8,at+size)
    if(['moov','trak','mdia','minf','stbl'].includes(type))payload=rewrite(at+8,at+size)
    if(['stts','stsc','stco','stss','ctts'].includes(type))payload=full(0,0)
    if(type==='stsz')payload=full(0,0,0)
    if(type==='moov')payload=Buffer.concat([payload,box('mvex',box('trex',full(0,trackId,1,sampleDuration,0,0)))])
    if(type!=='mdat'&&type!=='free')parts.push(box(type,payload));at+=size}return Buffer.concat(parts)}
  const initialization=rewrite(0,original.length)
  const makeMoof=offset=>box('moof',Buffer.concat([box('mfhd',full(0,1)),box('traf',Buffer.concat([box('tfhd',full(0x020000,trackId)),box('tfdt',full(0,0)),box('trun',full(0x000201,sampleCount,offset,...sampleSizes))]))]))
  const moof=makeMoof(makeMoof(0).length+8)
  const mdatStart=original.indexOf(Buffer.from('mdat'))+4;const mdat=box('mdat',original.subarray(mdatStart));mdat.writeUInt32BE(0)
  const complete=Buffer.concat([initialization,moof,mdat]);const truncated=complete.subarray(0,initialization.length+moof.length+9)
  for(const[name,bytes,expected]of[['complete',complete,true],['truncated',truncated,false]])await t.test(name,async subtest=>{
    const {root,store,service}=await fixture(subtest);const path=join(root,`fragment-${name}.mp4`);await writeFile(path,bytes)
    const result=await call(service,'import_file',{path},`fragment-${name}`);assert.equal(result.ok,expected,JSON.stringify(result))
    if(expected)assert.equal(result.result.sha256,hash(bytes));else{assert.equal(result.error.code,'ASSET_ERROR');assert.deepEqual(await readdir(store.filesDir),[]);assert.equal((await store.read()).items.length,0)}
  })
})
