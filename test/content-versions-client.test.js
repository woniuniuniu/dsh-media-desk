import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
async function client(fetch, hooks = {}) {
  const result = await build({ stdin: { contents: "export * from './client/versions.jsx'; export * from './client/desk.js'; export { ArticleTile, Studio } from './client/studio.jsx'", resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'] })
  const module = { exports: {} }, react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment', useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useLayoutEffect: () => {}, useSyncExternalStore: (subscribe, read) => read(), useMemo: fn => fn(), useCallback: fn => fn, ...hooks }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: () => react, fetch, URLSearchParams, setTimeout: () => 0, clearTimeout() {} })
  const api = module.exports, state = { accounts: [{ id: 'a' }, { id: 'b' }], items: [{ id: 'work', accountId: 'a', title: '当前', production: { status: 'done', article: 'current' }, contentVersions: [{ id: 'v1', number: 1, name: '初稿', createdAt: '2026-11-12T00:00:00Z', content: { title: '原灵感', body: '历史正文', drafts: { article: { text: '手写草稿' } }, production: { title: '原成稿', article: '历史成稿' } } }] }], metrics: [], skills: [], chat: [], styles: [] }
  api.setDesk({ state }); api.selectAccount('a'); api.openItem('work'); return { api, state }
}
const elements = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flat(Infinity).flatMap(elements)]
const textOf = tree => !tree || typeof tree !== 'object' ? String(tree ?? '') : tree.children.flat(Infinity).map(textOf).join(' ')

test('rendered history provides naming, Vn/time, read-only creative preview and explanatory restore action', async () => {
  const slots = []; let slot = 0
  const { api, state } = await client(async () => { throw new Error('Unexpected request') }, { useState: value => { const at = slot++; if (!(at in slots)) slots[at] = value; return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }] } })
  const render = () => { slot = 0; return api.VersionHistory({ item: state.items[0] }) }
  let tree = render()
  assert.ok(elements(tree).some(e => e.type === 'input' && e.props.maxLength === 80)); assert.match(textOf(tree), /V\s*1.*初稿/)
  elements(tree).find(e => e.type === 'button' && /V\s*1/.test(textOf(e))).props.onClick()
  tree = render()
  for (const text of ['原灵感', '历史正文', '手写草稿', '原成稿', '历史成稿', '恢复前会先保存当前内容']) assert.ok(textOf(tree).includes(text), text)
  assert.equal(elements(tree).some(e => e.type === 'textarea' && !e.props.readOnly), false)
  assert.equal(textOf(tree).includes('v1'), false)
})

test('version actions block local article editing, wait for blur writes, stop after failures and ignore scope switches', async () => {
  const requests = []
  const { api, state } = await client((url, options) => new Promise(resolve => requests.push({ url, body: JSON.parse(options.body), resolve })))
  api.setArticleEditing('work', true)
  assert.equal(await api.runVersionOperation('work', { op: 'save_version', name: 'named' }), null); assert.equal(requests.length, 0)
  api.setArticleEditing('work', false)
  const writing = api.dispatchOps([{ op: 'update_production', id: 'work', title: '最新标题' }], { silent: true })
  const version = api.runVersionOperation('work', { op: 'save_version', name: 'named' })
  assert.equal(requests.length, 1)
  requests[0].resolve({ ok: false, json: async () => ({ error: 'write failed' }) })
  await writing; await version; assert.equal(requests.length, 1)
  assert.equal(await api.runVersionOperation('work', { op: 'restore_version', versionId: 'v1' }), null); assert.equal(requests.length, 1)
  const retry = api.dispatchOps([{ op: 'update_production', id: 'work', title: '最新标题' }], { silent: true })
  requests[1].resolve({ ok: true, json: async () => ({ state, receipts: [{}], errors: [] }) }); await retry
  const pending = api.runVersionOperation('work', { op: 'save_version', name: 'named' }); await Promise.resolve(); await Promise.resolve()
  assert.equal(requests[2].body.ops[0].name, 'named'); assert.equal(requests[2].body.accountId, 'a')
  api.selectAccount('b'); const current = api.getDesk().state
  requests[2].resolve({ ok: true, json: async () => ({ state: { ...state, marker: 'late' }, receipts: [{}], errors: [] }) }); await pending
  assert.equal(api.getDesk().accountId, 'b'); assert.equal(api.getDesk().state, current)
})

test('article Save keeps local editor open after a rejected write and Cancel clears the history guard', async () => {
  const slots = []; let slot = 0
  const { api, state } = await client(async () => ({ ok: false, json: async () => ({ error: 'failed' }) }), { useState: value => { const at = slot++; if (!(at in slots)) slots[at] = value; return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next }] } })
  const render = () => { slot = 0; return api.ArticleTile({ item: state.items[0], tileRef: { current: null } }) }
  let tree = render(); const edit = elements(tree).find(e => e.props.label === '直接修改'); edit.props.onClick()
  tree = render(); const area = elements(tree).find(e => e.type === 'textarea'); area.props.onChange({ target: { value: 'unsaved local article' } })
  tree = render(); await elements(tree).find(e => e.type === 'button' && textOf(e).trim() === '完成').props.onClick()
  tree = render(); assert.equal(elements(tree).find(e => e.type === 'textarea').props.value, 'unsaved local article')
  assert.match(api.getDesk().articleEditing.work, /./)
  elements(tree).find(e => e.type === 'button' && textOf(e) === '取消').props.onClick()
  assert.equal(api.getDesk().articleEditing.work, undefined)
  await api.runVersionOperation('work', { op: 'save_version' })
  assert.doesNotMatch(api.getDesk().toast?.text ?? '', /最近的内容修改未保存成功/)
})

test('cancelling a failed article edit preserves an unrelated settled failed title save', async () => {
  const { api } = await client(async () => ({ ok: false, json: async () => ({ error: 'failed save' }) }))
  await api.dispatchOps([{ op: 'update_production', id: 'work', title: 'unsaved title' }], { silent: true })
  api.setArticleEditing('work', true)
  await api.dispatchOps([{ op: 'update_production', id: 'work', article: 'unsaved article' }], { silent: true })
  api.cancelArticleEditing('work')
  await api.runVersionOperation('work', { op: 'save_version' })
  assert.match(api.getDesk().toast.text, /最近的内容修改未保存成功/)
})

test('GUI export seals before composition and keeps origin version/account while ignoring late workspace responses', async () => {
  const requests=[]
  const { api, state } = await client(async (url, options) => {
    const body=JSON.parse(options.body);requests.push({url,body})
    if (url.endsWith('produce/seal')) return {ok:true,json:async()=>({versionId:'sealed-id',production:{title:'SEALED TITLE',article:'SEALED ARTICLE',cover:null}})}
    return {ok:true,json:async()=>({state:{...state,marker:'late-export'},path:'synthetic',currentMatches:false})}
  })
  const pending=api.saveProduced('work');await Promise.resolve();api.selectAccount('b');await pending
  assert.equal(requests.length,2);assert.equal(requests[0].body.accountId,'a');assert.equal(requests[1].body.accountId,'a');assert.equal(requests[1].body.versionId,'sealed-id')
  assert.equal(api.getDesk().accountId,'b');assert.equal(api.getDesk().state.marker,undefined)
})

const tick=()=>new Promise(resolve=>setImmediate(resolve))
function hookHarness(){
  const instances=new Map();let current
  const hooks={
    useState:initial=>{const record=current,at=record.slot++;if(!(at in record.state))record.state[at]=typeof initial==='function'?initial():initial;return [record.state[at],next=>{record.state[at]=typeof next==='function'?next(record.state[at]):next}]},
    useRef:initial=>{const at=current.ref++;return current.refs[at]??=( {current:initial} )},
    useEffect:(fn,deps)=>{const at=current.effect++,old=current.effects[at];if(!old||!deps||deps.some((v,i)=>v!==old.deps?.[i])){old?.cleanup?.();current.effects[at]={deps,pending:fn}}},
  }
  return {hooks,render(name,component,props,flush=true){current=instances.get(name)??{state:[],refs:[],effects:[]};instances.set(name,current);Object.assign(current,{slot:0,ref:0,effect:0});const tree=component(props);for(const effect of current.effects)if(flush&&effect.pending){const fn=effect.pending;delete effect.pending;effect.cleanup=fn()}return tree},unmount(name){for(const effect of instances.get(name)?.effects??[])effect.cleanup?.();instances.delete(name)}}
}

test('GUI preserves uncertain export evidence in a visible recovery notice and never retries automatically',async()=>{
  const requests=[]
  const {api,state}=await client(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return url.endsWith('produce/seal')?{ok:true,json:async()=>({versionId:'sealed',production:{title:'sealed',article:'text',cover:null}})}:{ok:false,json:async()=>({error:'导出文件已保留，但保存记录未能确认。',code:'OUTCOME_UNKNOWN',details:{export:{path:'/tmp/synthetic-export',itemId:'work',accountId:'a',versionId:'private-id',versionNumber:2,versionName:'待核对',files:['脚本.md'],privateSettings:'SECRET_KEYS'}}})}})
  await api.saveProduced('work')
  assert.equal(requests.length,2);assert.equal(api.getDesk().state,state)
  const tree=api.VersionHistory({item:state.items[0]})
  assert.match(textOf(tree),/导出结果待核对/);assert.match(textOf(tree),/synthetic-export/);assert.match(textOf(tree),/V\s*2/);assert.match(textOf(tree),/不要重复导出/)
  assert.doesNotMatch(textOf(tree),/private-id|SECRET_KEYS/)
})

for(const mode of ['workspace-return','same-workspace-reopen'])test(`old article Save and cleanup cannot release a new editor after ${mode}`,async()=>{
  const h=hookHarness(),requests=[]
  const {api,state}=await client((url,options)=>new Promise(resolve=>requests.push({url,body:JSON.parse(options.body),resolve})),h.hooks)
  const render=name=>h.render(name,api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}})
  let tree=render('old');elements(tree).find(e=>e.props.label==='直接修改').props.onClick();tree=render('old');elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'FIRST SAVE'}});tree=render('old')
  const pending=elements(tree).find(e=>e.type==='button'&&textOf(e).trim()==='完成').props.onClick()
  assert.equal(requests.length,1)
  if(mode==='workspace-return'){api.selectAccount('b');api.selectAccount('a');api.openItem('work')}else{api.closeItem();api.openItem('work')}
  tree=render('new');elements(tree).find(e=>e.props.label==='直接修改').props.onClick();tree=render('new');elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'UNSAVED SECOND'}});tree=render('new')
  requests[0].resolve({ok:true,json:async()=>({state:{...state,items:[{...state.items[0],production:{status:'done',article:'FIRST SAVE'}}]},receipts:[{}],errors:[]})});await pending
  tree=render('new');assert.equal(elements(tree).find(e=>e.type==='textarea')?.props.value,'UNSAVED SECOND');assert.ok(api.getDesk().articleEditing.work)
  h.unmount('old');assert.ok(api.getDesk().articleEditing.work,'stale effect cleanup cannot release the new editor')
  assert.equal(await api.runVersionOperation('work',{op:'save_version'}),null);assert.equal(requests.length,1)
})

for(const latestFails of [true,false])test(`creative write ordering preserves ${latestFails?'newer failure':'newer success'} and the visible latest text`,async()=>{
  const h=hookHarness(),requests=[]
  const {api,state}=await client((url,options)=>new Promise(resolve=>requests.push({url,body:JSON.parse(options.body),resolve})),h.hooks)
  const studio=h.render('discover-studio',api.Studio,{},false)
  const idea=elements(studio).find(e=>e.type?.name==='ChatPanel').props.top
  const card=h.render('discover-card',idea.type,idea.props)
  const AutoText=elements(card).find(e=>e.type?.name==='AutoText').type
  const render=()=>h.render('auto',AutoText,{value:api.getDesk().state.items[0].production.title??'original',onCommit:title=>api.dispatchOps([{op:'update_production',id:'work',title}],{silent:true}),label:'title'})
  let tree=render();tree.props.onChange({target:{value:'OLDER A'}});tree=render();const a=tree.props.onBlur()
  tree.props.onChange({target:{value:'LATEST B'}});tree=render();const b=tree.props.onBlur()
  const success=text=>({ok:true,json:async()=>({state:{...state,items:[{...state.items[0],production:{...state.items[0].production,title:text}}]},receipts:[{}],errors:[]})})
  const failure={ok:false,json:async()=>({error:'synthetic failed save'})}
  // Before serialization this reproduces the out-of-order completion; after it,
  // only A is sent until settled, so the same two intents are tested in order.
  if(requests.length===2){requests[1].resolve(latestFails?failure:success('LATEST B'));await tick();requests[0].resolve(latestFails?success('OLDER A'):failure)}
  else{assert.equal(requests.length,1);requests[0].resolve(latestFails?success('OLDER A'):failure);await tick();assert.equal(requests.length,2);requests[1].resolve(latestFails?failure:success('LATEST B'))}
  await Promise.all([a,b]);await tick();tree=render();tree=render()
  assert.equal(tree.props.value,'LATEST B')
  const version=api.runVersionOperation('work',{op:'save_version'});await tick()
  if(latestFails){assert.equal(await version,null);assert.equal(requests.length,2);assert.match(api.getDesk().toast.text,/最近的内容修改未保存成功/)}
  else{assert.equal(requests.length,3);requests[2].resolve({ok:true,json:async()=>({state:api.getDesk().state,receipts:[{}],errors:[]})});await version}
})

test('a batch writing one field twice owns its final value and updates the current client state',async()=>{
  let server
  const {api,state}=await client(async()=>({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})}))
  server={...state,items:[{...state.items[0],production:{...state.items[0].production,title:'BATCH FINAL'}}]}
  const result=await api.dispatchOps([{op:'update_production',id:'work',title:'batch first'},{op:'update_production',id:'work',title:'BATCH FINAL'}],{silent:true})
  assert.equal(result.creativeWriteCurrent,true);assert.equal(api.getDesk().state.items[0].production.title,'BATCH FINAL')
})

test('typing again during an article Save retains the new draft and editor registration',async()=>{
  const h=hookHarness(),requests=[]
  const {api,state}=await client((url,options)=>new Promise(resolve=>requests.push({resolve})),h.hooks)
  const render=()=>h.render('article',api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}})
  let tree=render();elements(tree).find(e=>e.props.label==='直接修改').props.onClick();tree=render();elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'submitted'}});tree=render()
  const pending=elements(tree).find(e=>e.type==='button'&&textOf(e).trim()==='完成').props.onClick()
  elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'new unsaved keystrokes'}})
  requests[0].resolve({ok:true,json:async()=>({state:{...state,items:[{...state.items[0],production:{status:'done',article:'submitted'}}]},receipts:[{}],errors:[]})});await pending
  tree=render();assert.equal(elements(tree).find(e=>e.type==='textarea')?.props.value,'new unsaved keystrokes');assert.ok(api.getDesk().articleEditing.work)
})

test('old article cancellation cannot clear a newer editor or its failed field ownership',async()=>{
  const requests=[]
  const {api,state}=await client((url,options)=>new Promise(resolve=>requests.push({resolve})))
  const oldOwner=api.setArticleEditing('work',true)
  const a=api.dispatchOps([{op:'update_production',id:'work',article:'older'}],{silent:true,editorOwner:oldOwner})
  assert.equal(api.cancelArticleEditing('work',oldOwner),true)
  const newOwner=api.setArticleEditing('work',true)
  const b=api.dispatchOps([{op:'update_production',id:'work',article:'newer'}],{silent:true,editorOwner:newOwner})
  assert.equal(requests.length,1)
  requests[0].resolve({ok:true,json:async()=>({state,receipts:[{}],errors:[]})});await a;await tick();requests[1].resolve({ok:false,json:async()=>({error:'newer failed'})});await b
  assert.equal(api.cancelArticleEditing('work',oldOwner),false);api.releaseArticleEditor(oldOwner)
  assert.equal(api.getDesk().articleEditing.work,newOwner.token);assert.equal(api.isCurrentArticleEditor(newOwner),true)
  assert.equal(await api.runVersionOperation('work',{op:'restore_version',versionId:'v1'}),null);assert.equal(requests.length,2)
})

test('refocusing an already open work keeps its editor, while close/reopen changes studio component ownership',async()=>{
  const h=hookHarness(),{api}=await client(async()=>{throw new Error('Unexpected request')},h.hooks)
  const owner=api.setArticleEditing('work',true)
  api.openItem('work');assert.equal(api.isCurrentArticleEditor(owner),true)
  const before=h.render('studio',api.Studio,{},false)
  const sheet=elements(before).find(e=>e.type?.name==='Sheet'),idea=elements(before).find(e=>e.type?.name==='ChatPanel').props.top
  api.closeItem();api.openItem('work')
  const after=h.render('studio',api.Studio,{},false)
  assert.notEqual(elements(after).find(e=>e.type?.name==='Sheet').props.key,sheet.props.key)
  assert.notEqual(elements(after).find(e=>e.type?.name==='ChatPanel').props.top.props.key,idea.props.key)
})

test('article Cancel discards its prior failed save while an owned retry is pending',async()=>{
  const requests=[]
  const {api,state}=await client((url,options)=>url.endsWith('/state')?Promise.resolve({ok:true,json:async()=>({state})}):new Promise(resolve=>requests.push({resolve})))
  const owner=api.setArticleEditing('work',true)
  const first=api.dispatchOps([{op:'update_production',id:'work',article:'failed'}],{silent:true,editorOwner:owner})
  requests[0].resolve({ok:false,json:async()=>({error:'failed'})});await first
  const retry=api.dispatchOps([{op:'update_production',id:'work',article:'retry'}],{silent:true,editorOwner:owner})
  assert.equal(api.cancelArticleEditing('work',owner),true)
  requests[1].resolve({ok:false,json:async()=>({error:'late retry failed'})});await retry
  const version=api.runVersionOperation('work',{op:'save_version'});await tick()
  assert.equal(requests.length,3);requests[2].resolve({ok:true,json:async()=>({state,receipts:[{}],errors:[]})});await version
})

function fixtureStateWithText(state,text){return {...state,items:[{...state.items[0],production:{...state.items[0].production,title:text,article:text}}]}}

test('AutoText blur queues an ORIGINAL→A→ORIGINAL intent before versions can capture server A',{timeout:5000},async()=>{
  const h=hookHarness(),requests=[];let server
  const {api,state}=await client((url,options)=>new Promise(resolve=>requests.push({url,body:options.body?JSON.parse(options.body):null,resolve})),h.hooks)
  server=fixtureStateWithText(state,'ORIGINAL');api.setDesk({state:server})
  const studio=h.render('discover',api.Studio,{},false),idea=elements(studio).find(e=>e.type?.name==='ChatPanel').props.top,card=h.render('card',idea.type,idea.props)
  const AutoText=elements(card).find(e=>e.type?.name==='AutoText').type
  const render=()=>h.render('auto-aba',AutoText,{value:api.getDesk().state.items[0].production.title,onCommit:title=>api.dispatchOps([{op:'update_production',id:'work',title}],{silent:true}),label:'title'})
  let tree=render();assert.notEqual(tree.props.disabled,true);tree.props.onChange({target:{value:'A'}});tree=render();const a=tree.props.onBlur()
  tree.props.onChange({target:{value:'ORIGINAL'}});tree=render();const b=tree.props.onBlur();assert.equal(tree.props.value,'ORIGINAL');assert.notEqual(tree.props.disabled,true)
  const version=api.runVersionOperation('work',{op:'save_version'});await tick();assert.equal(requests.length,1)
  server=fixtureStateWithText(state,'A');requests[0].resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await tick()
  assert.equal(requests[1]?.body.ops[0].op,'update_production');assert.equal(requests[1].body.ops[0].title,'ORIGINAL')
  server=fixtureStateWithText(state,'ORIGINAL');requests[1].resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await Promise.all([a,b]);await tick()
  assert.equal(requests[2].body.ops[0].op,'save_version');assert.equal(api.getDesk().state.items[0].production.title,server.items[0].production.title)
  requests[2].resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await version
  tree=render();tree=render();assert.equal(tree.props.value,'ORIGINAL')
})

test('Article Save queues an ORIGINAL→A→ORIGINAL edit and holds the history guard until its own ack',{timeout:5000},async()=>{
  const h=hookHarness(),requests=[]
  const {api,state}=await client((url,options)=>new Promise(resolve=>requests.push({url,body:options.body?JSON.parse(options.body):null,resolve})),h.hooks)
  api.setDesk({state:fixtureStateWithText(state,'ORIGINAL')})
  const render=()=>h.render('article-aba',api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}})
  let tree=render();elements(tree).find(e=>e.props.label==='直接修改').props.onClick();tree=render();elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'A'}});tree=render()
  const a=elements(tree).find(e=>e.type==='button'&&textOf(e).trim()==='完成').props.onClick()
  elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'ORIGINAL'}});tree=render();const save=elements(tree).find(e=>e.type==='button'&&textOf(e).trim()==='完成');assert.notEqual(save.props.disabled,true);const b=save.props.onClick()
  tree=render();assert.equal(elements(tree).find(e=>e.type==='textarea')?.props.value,'ORIGINAL');assert.ok(api.getDesk().articleEditing.work)
  const history=h.render('history-aba',api.VersionHistory,{item:api.getDesk().state.items[0]});assert.equal(elements(history).find(e=>e.type==='button'&&textOf(e)==='保存版本').props.disabled,true)
  requests[0].resolve({ok:true,json:async()=>({state:fixtureStateWithText(state,'A'),receipts:[{}],errors:[]})});await tick()
  assert.equal(requests[1]?.body.ops[0].article,'ORIGINAL');assert.ok(api.getDesk().articleEditing.work)
  requests[1].resolve({ok:true,json:async()=>({state:fixtureStateWithText(state,'ORIGINAL'),receipts:[{}],errors:[]})});await Promise.all([a,b])
  tree=render();assert.equal(api.getDesk().articleEditing.work,undefined);assert.equal(elements(tree).some(e=>e.type==='textarea'),false);assert.equal(api.getDesk().state.items[0].production.article,'ORIGINAL')
})

for(const navigation of ['cancel','close-reopen','workspace-return'])test(`accepted pending Save is reconciled before a version after ${navigation}`,{timeout:5000},async()=>{
  const h=hookHarness(),requests=[];let server,stateReads=0,captured
  const {api,state}=await client((url,options)=>{
    if(url.endsWith('/state')){stateReads++;return Promise.resolve({ok:true,json:async()=>({state:server,canUndo:true})})}
    const body=JSON.parse(options.body)
    if(body.ops?.[0].op==='save_version'){captured=server.items[0].production.article;return Promise.resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})})}
    return new Promise(resolve=>requests.push({url,body,resolve}))
  },h.hooks)
  server=fixtureStateWithText(state,'OLD');api.setDesk({state:server})
  const render=name=>h.render(name,api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}})
  let tree=render('old-accepted');elements(tree).find(e=>e.props.label==='直接修改').props.onClick();tree=render('old-accepted');elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'ACCEPTED A'}});tree=render('old-accepted')
  const saving=elements(tree).find(e=>e.type==='button'&&textOf(e).trim()==='完成').props.onClick()
  tree=render('old-accepted');assert.match(textOf(tree),/取消编辑不会撤回已发送的保存/)
  if(navigation==='cancel')elements(tree).find(e=>e.type==='button'&&textOf(e)==='取消').props.onClick()
  else if(navigation==='close-reopen'){api.closeItem();api.openItem('work')}
  else{api.selectAccount('b');api.selectAccount('a');api.openItem('work')}
  const version=api.runVersionOperation('work',{op:'save_version'});await tick();assert.equal(captured,undefined)
  server=fixtureStateWithText(state,'ACCEPTED A');requests[0].resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await saving;await version
  assert.equal(stateReads,1);assert.equal(captured,'ACCEPTED A');assert.equal(api.getDesk().state.items[0].production.article,'ACCEPTED A')
})

test('reconciliation does not steal a newly dirty article editor or a later workspace',{timeout:5000},async()=>{
  const h=hookHarness(),requests=[];let server,resolveRead
  const {api,state}=await client((url,options)=>url.endsWith('/state')?new Promise(resolve=>{resolveRead=resolve}):new Promise(resolve=>requests.push({body:JSON.parse(options.body),resolve})),h.hooks)
  server=fixtureStateWithText(state,'OLD');api.setDesk({state:server})
  const owner=api.setArticleEditing('work',true),saving=api.dispatchOps([{op:'update_production',id:'work',article:'A'}],{silent:true,editorOwner:owner});api.cancelArticleEditing('work',owner)
  server=fixtureStateWithText(state,'A');requests[0].resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await saving
  const version=api.runVersionOperation('work',{op:'save_version'});await tick();assert.equal(typeof resolveRead,'function')
  let tree=h.render('new-dirty',api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}});elements(tree).find(e=>e.props.label==='直接修改').props.onClick();tree=h.render('new-dirty',api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}});elements(tree).find(e=>e.type==='textarea').props.onChange({target:{value:'UNSAVED NEW'}})
  resolveRead({ok:true,json:async()=>({state:server})});assert.equal(await version,null)
  tree=h.render('new-dirty',api.ArticleTile,{item:api.getDesk().state.items[0],tileRef:{current:null}});assert.equal(elements(tree).find(e=>e.type==='textarea').props.value,'UNSAVED NEW');assert.ok(api.getDesk().articleEditing.work);assert.equal(requests.length,1)
  elements(tree).find(e=>e.type==='button'&&textOf(e)==='取消').props.onClick()
  const next=api.runVersionOperation('work',{op:'save_version'});await tick();api.selectAccount('b');resolveRead({ok:true,json:async()=>({state:{...server,marker:'late-reconcile'}})});assert.equal(await next,null);assert.equal(api.getDesk().state.marker,undefined);assert.equal(requests.length,1)
})

test('failed authoritative reconciliation blocks capture and remains retryable without repeating a save', {timeout:5000},async()=>{
  const requests=[];let server,reads=0,captured
  const {api,state}=await client((url,options)=>{
    if(url.endsWith('/state')){reads++;return Promise.resolve(reads===1?{ok:false,json:async()=>({error:'state unavailable'})}:{ok:true,json:async()=>({state:server})})}
    const body=JSON.parse(options.body);if(body.ops?.[0].op==='save_version'){captured=server.items[0].production.article;return Promise.resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})})}
    return new Promise(resolve=>requests.push({resolve}))
  })
  server=fixtureStateWithText(state,'OLD');api.setDesk({state:server})
  const owner=api.setArticleEditing('work',true),saving=api.dispatchOps([{op:'update_production',id:'work',article:'A'}],{silent:true,editorOwner:owner});api.cancelArticleEditing('work',owner)
  server=fixtureStateWithText(state,'A');requests[0].resolve({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await saving
  assert.equal(await api.runVersionOperation('work',{op:'save_version'}),null);assert.equal(captured,undefined);assert.equal(api.getDesk().state.items[0].production.article,'OLD')
  assert.ok(await api.runVersionOperation('work',{op:'save_version'}));assert.equal(reads,2);assert.equal(captured,'A');assert.equal(requests.length,1)
})

test('export reconciles an accepted retired Save before sealing and composing its content', {timeout:5000},async()=>{
  const order=[];let server,resolveSave
  const {api,state}=await client((url,options)=>{
    const name=url.slice('media-desk/'.length);order.push(name)
    if(name==='ops')return new Promise(resolve=>{resolveSave=resolve})
    if(name==='state')return Promise.resolve({ok:true,json:async()=>({state:server})})
    if(name==='produce/seal')return Promise.resolve({ok:true,json:async()=>({versionId:'accepted-version',production:server.items[0].production})})
    if(name==='produce/save'){assert.equal(JSON.parse(options.body).versionId,'accepted-version');return Promise.resolve({ok:true,json:async()=>({state:server,path:'/tmp/synthetic-export',currentMatches:true})})}
    throw new Error('Unexpected request')
  })
  server=fixtureStateWithText(state,'OLD');api.setDesk({state:server})
  const owner=api.setArticleEditing('work',true),saving=api.dispatchOps([{op:'update_production',id:'work',article:'ACCEPTED EXPORT'}],{silent:true,editorOwner:owner});api.cancelArticleEditing('work',owner)
  server=fixtureStateWithText(state,'ACCEPTED EXPORT');resolveSave({ok:true,json:async()=>({state:server,receipts:[{}],errors:[]})});await saving
  await api.saveProduced('work');assert.deepEqual(order,['ops','state','produce/seal','produce/save']);assert.equal(api.getDesk().state.items[0].production.article,'ACCEPTED EXPORT')
})

test('the history Save handler cannot replace a later accepted title response',{timeout:5000},async()=>{
  const h=hookHarness(),requests=[];let latest
  const {api,state}=await client((url,options)=>url.endsWith('/state')?Promise.resolve({ok:true,json:async()=>({state:latest})}):new Promise(resolve=>requests.push({body:JSON.parse(options.body),resolve})),h.hooks)
  const old=fixtureStateWithText(state,'OLD');latest=fixtureStateWithText(state,'LATEST');api.setDesk({state:old})
  let tree=h.render('history-late',api.VersionHistory,{item:old.items[0]});const saving=elements(tree).find(e=>e.type==='button'&&textOf(e)==='保存版本').props.onClick();await tick();assert.equal(requests.length,1)
  const studio=h.render('discover-late',api.Studio,{},false),idea=elements(studio).find(e=>e.type?.name==='ChatPanel').props.top,card=h.render('card-late',idea.type,idea.props),AutoText=elements(card).find(e=>e.type?.name==='AutoText').type
  const render=()=>h.render('title-late',AutoText,{value:api.getDesk().state.items[0].production.title,onCommit:title=>api.dispatchOps([{op:'update_production',id:'work',title}],{silent:true})})
  tree=render();tree.props.onChange({target:{value:'LATEST'}});tree=render();const editing=tree.props.onBlur()
  const success=value=>({ok:true,json:async()=>({state:value,receipts:[{}],errors:[]})})
  if(requests.length===2){requests[1].resolve(success(latest));await editing;requests[0].resolve(success(old))}
  else{assert.equal(requests.length,1);requests[0].resolve(success(old));await tick();assert.equal(requests[1].body.ops[0].title,'LATEST');requests[1].resolve(success(latest))}
  await Promise.all([saving,editing]);tree=render();tree=render();assert.equal(tree.props.value,'LATEST');assert.equal(api.getDesk().state.items[0].production.title,'LATEST')
})

test('the GUI export handler does not block typing or apply an older export state over a later title',{timeout:5000},async()=>{
  const h=hookHarness();let exportResolve,latest,old,reads=0;const writes=[]
  const {api,state}=await client((url,options)=>{
    if(url.endsWith('/state')){reads++;return Promise.resolve({ok:true,json:async()=>({state:latest})})}
    if(url.endsWith('produce/seal'))return Promise.resolve({ok:true,json:async()=>({versionId:'old-version',production:old.items[0].production})})
    if(url.endsWith('produce/save'))return new Promise(resolve=>{exportResolve=resolve})
    return new Promise(resolve=>writes.push({body:JSON.parse(options.body),resolve}))
  },h.hooks)
  old=fixtureStateWithText(state,'OLD');latest=fixtureStateWithText(state,'LATEST');api.setDesk({state:old})
  const studio=h.render('studio-export',api.Studio,{},false),sheet=elements(studio).find(e=>e.type?.name==='Sheet'),sheetTree=h.render('sheet-export',sheet.type,sheet.props,false),hero=elements(sheetTree).find(e=>e.type?.name==='HeroTile'),heroTree=h.render('hero-export',hero.type,hero.props,false)
  const saving=elements(heroTree).find(e=>e.type==='button'&&textOf(e).trim()==='保存').props.onClick();await tick();assert.equal(typeof exportResolve,'function')
  const auto=elements(heroTree).find(e=>e.type?.name==='AutoText'),render=()=>h.render('hero-title-export',auto.type,{...auto.props,value:api.getDesk().state.items[0].production.title})
  let tree=render();tree.props.onChange({target:{value:'LATEST'}});tree=render();const editing=tree.props.onBlur();assert.equal(writes.length,1,'typing is not held behind the long export')
  writes[0].resolve({ok:true,json:async()=>({state:latest,receipts:[{}],errors:[]})});await editing
  exportResolve({ok:true,json:async()=>({state:old,path:'/tmp/synthetic-export',currentMatches:true})});await saving
  tree=render();tree=render();assert.equal(api.getDesk().state.items[0].production.title,'LATEST');assert.equal(tree.props.value,'LATEST')
  const version=api.runVersionOperation('work',{op:'save_version'});await tick();assert.equal(reads,1);assert.equal(writes.length,2);writes[1].resolve({ok:true,json:async()=>({state:latest,receipts:[{}],errors:[]})});await version
})
