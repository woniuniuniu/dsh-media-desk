import { normalizePlatform } from './platforms.js'
// Account identity is explicit. A platform is never an account identifier.
export const accountError = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT', status: 400 })
export const normalizedAccountId = row => row?.accountId ?? null
export function requireAccount(state, id) {
  if (id === undefined || id === null) return null
  const row = state.accounts?.find(a => a.id === id)
  if (!row) throw accountError('Account not found.')
  return row
}
export function requireStyle(state, id) {
  if (id !== null && !state.styles?.some(s => s.id === id)) throw accountError('Style not found.')
}
export function requireMembership(state, id, accountId) {
  requireAccount(state, accountId)
  const row = state.items.find(i => i.id === id)
  if (!row) throw accountError('Item not found.')
  if (accountId !== undefined && normalizedAccountId(row) !== accountId) throw accountError('Item belongs to another account.')
  return row
}
export function migrateAccounts(state) {
  state.accounts ??= []
  for (const row of state.accounts) for (const [key,value] of Object.entries({group:'',positioning:'',audience:'',defaultStyleId:null,draftFormat:null,archived:false})) if (row[key] === undefined) row[key] = value
  for (const key of ['items','metrics','chat','skills']) for (const row of state[key] ?? []) if (row.accountId === undefined) row.accountId = null
  return state
}
export function metricAccountId(state, metric) {
  return metric.itemId ? normalizedAccountId(state.items.find(i => i.id === metric.itemId)) : normalizedAccountId(metric)
}
export function scopeState(state, accountId) {
  if (accountId === undefined) return state
  const account = requireAccount(state, accountId)
  const itemAccounts = new Map(state.items.map(i=>[i.id,normalizedAccountId(i)]))
  return { ...state, accountId, account, activeStyleId: account ? account.defaultStyleId ?? null : state.activeStyleId,
    draftFormat: account?.draftFormat ?? state.draftFormat,
    items: state.items.filter(i => normalizedAccountId(i) === accountId),
    metrics: state.metrics.filter(m => (m.itemId ? itemAccounts.get(m.itemId) ?? null : normalizedAccountId(m)) === accountId),
    chat: state.chat.filter(c => normalizedAccountId(c) === accountId),
    skills: state.skills.filter(s => normalizedAccountId(s) === accountId),
    accounts: account ? [account] : [],
  }
}
export function accountCounts(state, id) {
  const scoped = scopeState(state,id)
  return { items: scoped.items.length, published: scoped.items.filter(i=>i.status==='published').length, scheduled: scoped.items.filter(i=>i.scheduledAt && i.status!=='published').length, metrics: scoped.metrics.length }
}
export function resolveChatScope(state, body) {
  const focus = body.focusId && (body.accountId!==undefined || state.items.some(i=>i.id===body.focusId)) ? requireMembership(state,body.focusId,body.accountId) : null
  const accountId = body.accountId !== undefined ? body.accountId : focus ? normalizedAccountId(focus) : undefined
  requireAccount(state,accountId)
  return accountId
}
export function scopedActions(state, actions, accountId) {
  if(accountId===undefined) return (Array.isArray(actions)?actions:[]).filter(a=>a && ['produce','open','nav'].includes(a.type))
  return (Array.isArray(actions)?actions:[]).filter(a=>a && ['produce','open','nav'].includes(a.type)).filter(a=>{
    if (a.type==='nav') return true
    try { requireMembership(state,a.id,accountId);return true } catch { return false }
  })
}
export function validateImportTarget(state, resolved, accountId) {
  const target = requireAccount(state,accountId)
  if (!target) return null
  if(state.accounts.some(a=>a.id!==target.id && a.externalId===`${resolved.platform}:${resolved.id}`)) throw accountError('This external identity belongs to another account.')
  if (target.platform !== resolved.platform || target.externalId && target.externalId !== `${resolved.platform}:${resolved.id}`) throw accountError('Import account identity does not match target.')
  const clean = value => String(value??'').replace(/\/$/,'').split(/[?#]/)[0]
  if (target.url && clean(target.url) !== clean(resolved.url)) throw accountError('Import URL does not match target account.')
  return target
}
// Frontend selection helpers also run in Node tests; no shared server selection.
export function switchAccountState(snapshot, accountId) {
  requireAccount(snapshot.state,accountId)
  return { ...snapshot, accountId, focusId:null, sheetOrigin:null, studioDock:false, chatQuote:null, capture:null, dialog:null, related:null, query:'', kindFilter:'all', selectedIds:[] }
}
export function enterAccountWorkspace(snapshot, accountId) {
  return { ...switchAccountState(snapshot, accountId), workspaceEntered: true, workspaceRevision: (snapshot.workspaceRevision ?? 0) + 1, view: 'content' }
}
export function leaveAccountWorkspace(snapshot) {
  return { ...switchAccountState(snapshot, undefined), workspaceEntered: false, workspaceRevision: (snapshot.workspaceRevision ?? 0) + 1, view: 'accounts' }
}
export function reconcileAccountWorkspace(snapshot) {
  return snapshot.accountId && snapshot.state && !snapshot.state.accounts.some(account => account.id === snapshot.accountId)
    ? leaveAccountWorkspace(snapshot) : snapshot
}
export const workspaceOrigin = snapshot => ({ accountId: snapshot.accountId, workspaceRevision: snapshot.workspaceRevision })
export const matchesWorkspace = (snapshot, origin) => Boolean(snapshot.workspaceEntered && snapshot.accountId === origin.accountId && snapshot.workspaceRevision === origin.workspaceRevision)
export function parseAccountsCsv(text) {
  const rows=[]; const errors=[]
  const lines=String(text).trim().split(/\r?\n/)
  if(lines.length>101) return {rows,errors:[{row:0,message:'At most 100 accounts per batch.'}]}
  const fields=['platform','handle','group','url','positioning','audience','note']
  lines.forEach((line,index)=>{
    if(!line.trim())return
    const values=[];let value='',quoted=false
    for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){values.push(value.trim());value=''}else value+=c} values.push(value.trim())
    if(index===0&&['platform','平台'].includes(values[0]))return
    if(quoted||values.length>fields.length||!values[0]||!values[1]){errors.push({row:index+1,message:'Platform and name are required; use valid CSV.'});return}
    values[0] = normalizePlatform(values[0]) ?? values[0]
    rows.push({row:index+1,op:Object.fromEntries([['op','add_account'],...values.map((v,i)=>[fields[i],v])])})
  })
  if(rows.length>100) return {rows:[],errors:[{row:0,message:'At most 100 accounts per batch.'}]}
  return {rows,errors}
}

export function allAccountCounts(state) {
  const counts=new Map();const empty=()=>({items:0,published:0,scheduled:0,metrics:0});const at=id=>{if(!counts.has(id))counts.set(id,empty());return counts.get(id)};const itemAccounts=new Map();
  for(const i of state.items){const id=normalizedAccountId(i);itemAccounts.set(i.id,id);const c=at(id);c.items++;if(i.status==='published')c.published++;else if(i.scheduledAt)c.scheduled++}
  for(const m of state.metrics)at(m.itemId?itemAccounts.get(m.itemId)??null:normalizedAccountId(m)).metrics++;return counts
}
export function createAccountProjection() {
  let previousState,previousId,projected
  return snapshot=>{
    if(snapshot.state!==previousState||snapshot.accountId!==previousId){previousState=snapshot.state;previousId=snapshot.accountId;projected=snapshot.state?scopeState(snapshot.state,snapshot.accountId):null}
    return {...snapshot,allState:snapshot.state,state:projected}
  }
}
export const originScope = snapshot => ({accountId:snapshot.accountId})

export async function applyAccountsCsv(text,dispatch) {
  const parsed=parseAccountsCsv(text);const errors=[...parsed.errors];let added=0;
  for(const row of parsed.rows){try{const result=await dispatch(row.op);if(!result) errors.push({row:row.row,message:'Request failed. No success was confirmed.'});else if(result.errors?.length)errors.push({row:row.row,message:result.errors.join('; ')});else added++}catch(e){errors.push({row:row.row,message:e.message})}}
  const failed=new Set(errors.map(e=>e.row));const lines=String(text).trim().split(/\r?\n/);return {added,errors,remaining:failed.has(0)?text:lines.filter((line,index)=>failed.has(index+1)).join('\n')}
}

export function hasActiveProduction(item) {
  return item.production?.status === 'running'
    || [item.production?.cover, ...item.production?.images ?? [], ...item.production?.shots ?? []]
      .some(asset => asset && ['running', 'pending'].includes(asset.status))
}

export function assertAccountTransition(current, next) {
  const nextItems = new Map(next.items.map(item => [item.id, item]))
  const nextAccounts = new Set(next.accounts.map(account => account.id))
  for (const item of current.items) {
    if (!hasActiveProduction(item)) continue
    const after = nextItems.get(item.id)
    const accountId = normalizedAccountId(item)
    if (!after || normalizedAccountId(after) !== accountId || accountId && !nextAccounts.has(accountId)) {
      throw accountError('Wait for active production and assets to finish before undoing account changes or deleting content.')
    }
  }
}

export function detachAccounts(state, ids) {
  const removed = new Set(ids)
  const items = new Set(state.items.filter(item => removed.has(item.accountId)).map(item => item.id))
  for (const item of state.items) {
    if (items.has(item.id) && item.production?.savedPath && item.production.savedAccountId === undefined) {
      item.production.savedAccountId = normalizedAccountId(item)
    }
  }
  for (const key of ['items', 'metrics', 'chat', 'skills']) {
    for (const row of state[key] ?? []) {
      if (removed.has(row.accountId) || key === 'metrics' && items.has(row.itemId)) row.accountId = null
    }
  }
}
