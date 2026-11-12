import { createAccountProjection, enterAccountWorkspace, leaveAccountWorkspace, matchesWorkspace, originScope, reconcileAccountWorkspace, workspaceOrigin } from '../src/accounts.js'
// 浏览器侧的状态：Host 状态的本地镜像，加上只属于界面的选中、视图等。
import React from 'react'
import { boundedExportEvidence } from '../src/export-evidence.js'
import { coverDataUrl } from './cover.js'
import { lang, plural, setLanguagePreference, t } from './i18n.js'

const BASE = 'media-desk/'

let snapshot = {
  state: null, model: null, modelOk: null, modelError: null, canUndo: false, error: null,
  accountId: undefined, workspaceEntered: false, workspaceRevision: 0, view: 'accounts', mode: 'scatter', focusId: null, sheetOrigin: null, dockOpen: true, studioDock: false, chatQuote: null, query: '', kindFilter: 'all', related: null,
  live: {}, articleEditing: {}, exportRecoveries: {}, studioRevision: 0, settings: null, settingsOpen: false, modelPickOpen: false, thinking: false, toast: null, capture: null, dialog: null,
}
const listeners = new Set()

export function getDesk() {
  return snapshot
}

export function setDesk(patch) {
  const previous = snapshot
  const next = typeof patch === 'function' ? patch(snapshot) : patch
  if(next.capture) next.capture={...next.capture,accountId:snapshot.accountId}
  snapshot = { ...snapshot, ...next }
  snapshot = reconcileAccountWorkspace(snapshot)
  if (!snapshot.workspaceEntered && snapshot.view !== 'accounts') snapshot = { ...snapshot, view: 'accounts' }
  if(snapshot.focusId && snapshot.accountId!==undefined && snapshot.state && !snapshot.state.items.some(i=>i.id===snapshot.focusId&&(i.accountId??null)===snapshot.accountId)) snapshot={...snapshot,focusId:null,sheetOrigin:null,studioDock:false,chatQuote:null}
  if (snapshot.accountId !== previous.accountId || snapshot.workspaceRevision !== previous.workspaceRevision || snapshot.focusId !== previous.focusId || snapshot.studioRevision !== previous.studioRevision) {
    invalidateArticleEditors()
    snapshot = { ...snapshot, articleEditing: {}, studioRevision: (previous.studioRevision ?? 0) + 1 }
  }
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const project = createAccountProjection()
export function selectAccount(accountId) { invalidateArticleEditors();snapshot={...enterAccountWorkspace(snapshot,accountId),articleEditing:{},studioRevision:(snapshot.studioRevision??0)+1};listeners.forEach(fn=>fn()) }
export function leaveAccounts() { invalidateArticleEditors();snapshot={...leaveAccountWorkspace(snapshot),articleEditing:{},studioRevision:(snapshot.studioRevision??0)+1};listeners.forEach(fn=>fn()) }
export function useDesk(selector) {
  return React.useSyncExternalStore(subscribe, () => selector(project(snapshot)))
}

async function request(path, body, { mutationOwned = false } = {}) {
  if (body !== undefined && !mutationOwned) {
    clientMutationEpoch += 1
    if (typeof body.id === 'string') itemWriteEpoch.set(body.id, (itemWriteEpoch.get(body.id) ?? 0) + 1)
  }
  const res = await fetch(BASE + path, body === undefined ? { headers: { 'x-media-desk-lang': lang() } } : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() }, body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || t('请求失败（{status}）', { status: res.status })), data.code === 'OUTCOME_UNKNOWN' ? { code: data.code, exportEvidence: boundedExportEvidence(data.details?.export) } : {})
  return data
}

let toastTimer = null
export function toast(text, { undo = false, error = false } = {}) {
  clearTimeout(toastTimer)
  setDesk({ toast: { text, undo, error, key: Date.now() } })
  toastTimer = setTimeout(() => setDesk({ toast: null }), undo || text.length > 24 ? 6000 : 3200)
}

export function report(err) {
  toast(err.message || String(err), { error: true })
}

export async function loadDesk() {
  try {
    // 先读设置拿到语言偏好，示例数据按这个语言返回
    const settings = await request('settings')
    setLanguagePreference(settings.language)
    const data = await request('state')
    setDesk({ settings, state: data.state, model: data.model, modelOk: data.modelOk, modelError: data.modelError, canUndo: data.canUndo, error: null })
  } catch (err) {
    setDesk({ error: err.message })
  }
}

const failedCreative = new Map(), latestCreative = new Map(), creativeQueues = new Map(), articleEditors = new Map(), reconcileCreative = new Map(), itemWriteEpoch = new Map()
let writeSequence = 0, editorSequence = 0, reconcileSequence = 0, clientMutationEpoch = 0
const originNow = () => ({ ...workspaceOrigin(snapshot), entered: snapshot.workspaceEntered })
const sameOrigin = origin => snapshot.accountId === origin.accountId && snapshot.workspaceRevision === origin.workspaceRevision && snapshot.workspaceEntered === origin.entered
const writeKey = (id, origin) => JSON.stringify([id, origin.accountId, origin.workspaceRevision])
function invalidateEditorWrites(owner) {
  const key = writeKey(owner.id, owner.origin), fields = latestCreative.get(key), failures = failedCreative.get(key)
  for (const [field, entry] of fields ?? []) if (entry.owner === owner) {
    fields.set(field, { token: ++writeSequence })
  }
  for (const [field, failure] of failures ?? []) if (failure.owner === owner) failures.delete(field)
  if (!failures?.size) failedCreative.delete(key)
}
function invalidateArticleEditors() {
  for (const owner of articleEditors.values()) invalidateEditorWrites(owner)
  articleEditors.clear()
}
export function isCurrentArticleEditor(owner) {
  return Boolean(owner && articleEditors.get(owner.id) === owner && sameOrigin(owner.origin) && snapshot.focusId === owner.id && snapshot.studioRevision === owner.studioRevision)
}
export function releaseArticleEditor(owner) {
  if (!owner) return false
  invalidateEditorWrites(owner)
  if (articleEditors.get(owner.id) !== owner) return false
  articleEditors.delete(owner.id)
  const articleEditing = { ...snapshot.articleEditing }
  if (articleEditing[owner.id] === owner.token) delete articleEditing[owner.id]
  setDesk({ articleEditing })
  return true
}
export function setArticleEditing(id, editing) {
  if (!editing) return releaseArticleEditor(articleEditors.get(id))
  releaseArticleEditor(articleEditors.get(id))
  const owner = { id, token: `article_${++editorSequence}`, origin: originNow(), studioRevision: snapshot.studioRevision, revision: 0, acknowledgedRevision: 0, pending: null, pendingRevision: null }
  articleEditors.set(id, owner)
  setDesk({ articleEditing: { ...snapshot.articleEditing, [id]: owner.token } })
  return owner
}
export function touchArticleEditor(owner) { if (isCurrentArticleEditor(owner)) owner.revision += 1 }
export function cancelArticleEditing(id, owner = articleEditors.get(id)) {
  return isCurrentArticleEditor(owner) && releaseArticleEditor(owner)
}
export async function dispatchOps(ops, options = {}) {
  const { label = t('操作'), undoable = true, silent = false } = options
  const origin = originNow()
  const accountId = Object.hasOwn(options, 'accountId') ? options.accountId : snapshot.accountId
  const creative = ops.filter(op => ['save_draft', 'update_production'].includes(op.op) || op.op === 'update_item' && ['title', 'body', 'media', 'tags'].some(key => op[key] !== undefined))
  const versionMutation = ops.some(op => ['save_version', 'restore_version'].includes(op.op))
  const itemOps = new Set(['update_item', 'delete_item', 'schedule_item', 'set_status', 'save_draft', 'update_production', 'save_version', 'restore_version'])
  const ids = [...new Set(ops.flatMap(op => op.op === 'assign_items' ? op.ids ?? [] : itemOps.has(op.op) ? [op.id] : []).filter(id => typeof id === 'string'))]
  const mutationEpoch = ++clientMutationEpoch
  const studioRevision = snapshot.studioRevision, epochs = new Map()
  for (const id of ids) { const epoch = (itemWriteEpoch.get(id) ?? 0) + 1; itemWriteEpoch.set(id, epoch); epochs.set(id, epoch) }
  const entryMap = new Map()
  for (const op of creative) {
    const key = writeKey(op.id, origin), fields = latestCreative.get(key) ?? new Map()
    for (const field of Object.keys(op).filter(field => !['op', 'id', 'accountId'].includes(field))) {
      const name = `${op.op === 'update_production' ? 'production' : op.op}.${field}`
      const owner = name === 'production.article' ? options.editorOwner ?? articleEditors.get(op.id) : undefined
      const entry = { key, field: name, token: ++writeSequence, owner }
      fields.set(name, entry); entryMap.set(JSON.stringify([key, name]), entry)
    }
    latestCreative.set(key, fields)
  }
  const entries = [...entryMap.values()]
  const current = () => entries.every(entry => latestCreative.get(entry.key)?.get(entry.field)?.token === entry.token) && ids.every(id => itemWriteEpoch.get(id) === epochs.get(id))
  const studioCurrent = () => !ids.length || snapshot.studioRevision === studioRevision
  const mark = failed => {
    for (const entry of entries) {
      if (latestCreative.get(entry.key)?.get(entry.field)?.token !== entry.token) continue
      const fields = failedCreative.get(entry.key) ?? new Map()
      if (failed) fields.set(entry.field, entry); else fields.delete(entry.field)
      if (fields.size) failedCreative.set(entry.key, fields); else failedCreative.delete(entry.key)
    }
  }
  // Order actual UI requests by item across close/reopen and account navigation.
  // Tokens also prevent an already superseded intent from replacing newer local text.
  const dependencies = [...new Set(ids.map(id => creativeQueues.get(id)).filter(Boolean))]
  const task = (async () => {
    if (dependencies.length) await Promise.all(dependencies)
    try {
      const data = await request('ops', { ops, label, undoable, accountId }, { mutationOwned: true })
      mark(Boolean(data.errors?.length))
      const responseCurrent = current() && studioCurrent() && (!versionMutation || clientMutationEpoch === mutationEpoch) && (!options.editorOwner || isCurrentArticleEditor(options.editorOwner))
      if (sameOrigin(origin) && responseCurrent) {
        setDesk({ state: data.state, canUndo: undoable || snapshot.canUndo })
        for (const id of ids) reconcileCreative.delete(id)
        if (data.errors?.length) toast(data.errors[0], { error: true })
        else if (!silent && data.receipts?.[0]) toast(data.receipts[0].text, { undo: undoable })
      }
      if (!sameOrigin(origin) || !responseCurrent) for (const id of ids) reconcileCreative.set(id, ++reconcileSequence)
      return { ...data, creativeWriteCurrent: responseCurrent }
    } catch (err) {
      mark(true)
      for (const id of ids) reconcileCreative.set(id, ++reconcileSequence)
      if (sameOrigin(origin) && current() && studioCurrent() && (!options.editorOwner || isCurrentArticleEditor(options.editorOwner))) report(err)
      return null
    }
  })()
  const settled = task.finally(() => {
    for (const id of ids) if (creativeQueues.get(id) === settled) creativeQueues.delete(id)
  })
  for (const id of ids) creativeQueues.set(id, settled)
  return settled
}
async function readyForVersion(id, origin, accountId) {
  const studioRevision = snapshot.studioRevision
  const scopeCurrent = () => sameOrigin(origin) && snapshot.focusId === id && snapshot.studioRevision === studioRevision && (snapshot.state?.items.find(item => item.id === id)?.accountId ?? null) === accountId
  const key = writeKey(id, origin)
  for (;;) {
    if (snapshot.articleEditing[id]) { toast(t('请先完成或取消文章编辑，再操作版本。'), { error: true }); return false }
    while (creativeQueues.get(id)) await creativeQueues.get(id)
    if (!scopeCurrent() || snapshot.articleEditing[id]) return false
    if (failedCreative.has(key)) { toast(t('最近的内容修改未保存成功，请重新保存后再操作版本。'), { error: true }); return false }
    const needed = reconcileCreative.get(id)
    if (!needed) return true
    const epoch = itemWriteEpoch.get(id), mutationEpoch = clientMutationEpoch
    try {
      // Retiring an editor never cancels an already dispatched HTTP write.
      // Re-read after the queue settles before capturing or exporting any content.
      const data = await request('state')
      if (!scopeCurrent() || snapshot.articleEditing[id]) return false
      if (creativeQueues.get(id) || itemWriteEpoch.get(id) !== epoch || clientMutationEpoch !== mutationEpoch || reconcileCreative.get(id) !== needed) continue
      const refreshed = data.state?.items?.find(item => item.id === id)
      if (!refreshed || (refreshed.accountId ?? null) !== accountId) return false
      setDesk({ state: data.state, ...(typeof data.canUndo === 'boolean' ? { canUndo: data.canUndo } : {}) })
      reconcileCreative.delete(id)
    } catch (err) {
      if (scopeCurrent()) report(err)
      return false
    }
  }
}
export async function runVersionOperation(id, operation) {
  const origin = originNow(), item = snapshot.state?.items.find(item => item.id === id), accountId = item?.accountId ?? null
  if (!item || !await readyForVersion(id, origin, accountId)) return null
  return dispatchOps([{ ...operation, id }], { accountId, label: t(operation.op === 'restore_version' ? '恢复版本' : '保存版本') })
}

export async function undo() {
  try {
    const data = await request('undo', {})
    setDesk({ state: data.state, canUndo: data.canUndo, toast: null })
    if (data.label) toast(t('已撤销：{label}', { label: data.label }))
  } catch (err) {
    report(err)
  }
}

export function openItem(id, origin = null) {
  setDesk({ focusId: id, sheetOrigin: origin })
}

export function closeItem() {
  setDesk({ focusId: null, sheetOrigin: null, studioDock: false, chatQuote: null, studioRevision: (snapshot.studioRevision ?? 0) + 1 })
}

/** 一键成稿。任务在 Host 里跑，这里只负责启动和看进度。 */
export async function runProduce(id, options = {}) {
  const { accountId = snapshot.state.items.find(i => i.id === id)?.accountId, withImages } = typeof options === 'string' || options === null ? { accountId: options } : options
  try {
    const data = await request('produce', { id, accountId, ...(typeof withImages === 'boolean' ? { withImages } : {}) })
    setDesk({ state: data.state })
  } catch (err) {
    report(err)
  }
}

export async function cancelProduce(id) {
  try {
    await request('produce/cancel', { id })
  } catch (err) {
    report(err)
  }
}

export async function regenAsset(id, target) {
  try {
    const data = await request('produce/regen', { id, target })
    setDesk({ state: data.state })
  } catch (err) {
    report(err)
  }
}

function mergeProduction(id, production, status) {
  setDesk(s => ({ state: { ...s.state, items: s.state.items.map(item => (item.id === id ? { ...item, production, ...(status ? { status } : {}) } : item)) } }))
}

/** 轮询进度，返回停止函数。 */
export function watchProduction(id) {
  let stopped = false
  const tick = async () => {
    while (!stopped) {
      try {
        const data = await request(`production?id=${encodeURIComponent(id)}`)
        if (stopped) return
        setDesk(s => ({ live: { ...s.live, [id]: data.live } }))
        if (data.production) mergeProduction(id, data.production, data.status)
      } catch {
        // 连接抖动时下一轮再试
      }
      await new Promise(r => setTimeout(r, 700))
    }
  }
  tick()
  return () => { stopped = true }
}

export async function saveSettings(payload) {
  try {
    const settings = await request('settings', payload)
    setLanguagePreference(settings.language)
    setDesk({ settings })
    toast(t('设置已保存'))
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function fetchModels() {
  return request('models')
}

/** 切换助手模型；两个字段都空表示跟随默认。 */
export async function saveAssistant(assistant) {
  try {
    const settings = await request('settings', { assistant })
    setDesk({ settings, model: settings.assistantEffective ?? snapshot.model })
    toast(t('助手模型已切换'))
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function testImage(payload) {
  try {
    const settings = await request('settings', payload)
    setLanguagePreference(settings.language)
    setDesk({ settings })
    const { src } = await request('settings/test', {})
    return src
  } catch (err) {
    report(err)
    return null
  }
}

function runActions(actions, origin, actionAccountId) {
  if (!matchesWorkspace(snapshot, origin)) return
  for (const action of actions) {
    if(actionAccountId!==undefined && action.id && !snapshot.state.items.some(i=>i.id===action.id&&(i.accountId??null)===actionAccountId))continue
    if (action.type === 'produce' && action.id) {
      openItem(action.id)
      runProduce(action.id, { accountId: actionAccountId })
    }
    if (action.type === 'open' && action.id) openItem(action.id)
    if (action.type === 'nav' && action.view) setDesk({ view: action.view })
  }
}

export async function sendChat(text) {
  const { chatQuote: quote, focusId } = snapshot
  const origin = workspaceOrigin(snapshot)
  const accountId = snapshot.accountId !== undefined ? snapshot.accountId : focusId ? snapshot.state.items.find(i=>i.id===focusId)?.accountId ?? null : undefined
  // 选中的段落或某一镜，随消息一起交给模型
  const message = quote ? (quote.text ? t('关于{label}「{quote}」：{text}', { label: quote.label, quote: quote.text, text }) : t('关于{label}：{text}', { label: quote.label, text })) : text
  setDesk(s => ({
    thinking: true,
    chatQuote: null,
    state: { ...s.state, chat: [...s.state.chat, { id: `tmp_${Date.now()}`, role: 'user', text: message, itemId: focusId ?? undefined, accountId:accountId??null }] },
  }))
  try {
    const data = await request('chat', { message, focusId: focusId ?? undefined, accountId })
    setDesk({ state: data.state, canUndo: true, modelOk: data.modelOk, modelError: data.modelError })
    runActions(data.actions || [], origin,accountId)
  } catch (err) {
    report(err)
    await loadDesk()
  } finally {
    setDesk({ thinking: false })
  }
}

export async function saveProduced(id) {
  const origin = originNow(), studioRevision = snapshot.studioRevision, item = snapshot.state?.items.find(row => row.id === id), accountId = item?.accountId ?? null
  let epoch = null
  try {
    if (!item || !await readyForVersion(id, origin, accountId)) return
    epoch = (itemWriteEpoch.get(id) ?? 0) + 1
    itemWriteEpoch.set(id, epoch)
    const mutationEpoch = ++clientMutationEpoch
    // Only short item mutations are queued. Frozen export work never blocks typing.
    const sealed = await request('produce/seal', { id, accountId }, { mutationOwned: true })
    const production = sealed.production
    const videoCover = await coverDataUrl({ src: production.cover?.src, text: production.coverText || production.title }).catch(() => undefined)
    const data = await request('produce/save', { id, videoCover, accountId, versionId: sealed.versionId }, { mutationOwned: true })
    const scopeCurrent = sameOrigin(origin) && snapshot.focusId === id && snapshot.studioRevision === studioRevision
    const responseCurrent = scopeCurrent && itemWriteEpoch.get(id) === epoch && clientMutationEpoch === mutationEpoch
    if (responseCurrent) { setDesk({ state: data.state }); reconcileCreative.delete(id) }
    else reconcileCreative.set(id, ++reconcileSequence)
    if (scopeCurrent) toast(!responseCurrent || data.currentMatches === false ? t('历史版本已导出，当前内容未标记为已保存。') : t('已保存到 {path}', { path: data.path }))
  } catch (err) {
    if (epoch !== null) reconcileCreative.set(id, ++reconcileSequence)
    if (err.exportEvidence) setDesk({ exportRecoveries: { ...snapshot.exportRecoveries, [id]: { ...err.exportEvidence, accountId } } })
    if (sameOrigin(origin) && snapshot.studioRevision === studioRevision) report(err)
  }
}

export function dismissExportRecovery(id) {
  const exportRecoveries = { ...snapshot.exportRecoveries }; delete exportRecoveries[id]; setDesk({ exportRecoveries })
}

export async function revealSaved(id) {
  try {
    await request('produce/reveal', { id })
  } catch (err) {
    report(err)
  }
}

export async function clearChat() {
  try {
    const data = await request('chat/clear', originScope(snapshot))
    setDesk({ state: data.state })
  } catch (err) {
    report(err)
  }
}

export async function captureUrl(url, extra = {}) {
  const origin=originScope(snapshot)
  try {
    const data = await request('capture-url', { url, ...origin, ...extra })
    setDesk({ state: data.state, canUndo: true })
    toast(t('已收藏到灵感墙'), { undo: true })
    return data.id
  } catch (err) {
    report(err)
    return null
  }
}

export async function uploadFile(file) {
  const res = await fetch(`${BASE}upload`, { method: 'POST', headers: { 'content-type': file.type, 'x-media-desk-lang': lang() }, body: file })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || t('上传失败'))
  return data
}

export async function captureFiles(files, origin = originScope(snapshot)) {
  for (const file of files) {
    try {
      const { src, kind } = await uploadFile(file)
      const title = file.name.replace(/\.[^.]+$/, '')
      await dispatchOps([{ op: 'add_item', kind, title, media: { src } }], { label: t('收藏 {title}', { title }), silent: true, ...origin })
      toast(t('已放到灵感墙'), { undo: true })
    } catch (err) {
      report(err)
    }
  }
}

export async function refreshAccount(payload) {
  try {
    const data = await request('account/refresh', payload)
    setDesk({ state: data.state, canUndo: true })
    if (data.fetchError) toast(t('读取主页失败：{error}', { error: data.fetchError }), { error: true })
    else toast(t('已更新账号档案'))
    return data
  } catch (err) {
    report(err)
    return null
  }
}

export async function extractStyle(payload) {
  try {
    const data = await request('style/extract', { ...originScope(snapshot), ...payload })
    setDesk({ state: data.state, canUndo: true })
    const missed = data.failures?.length ?? 0
    toast(missed ? t(plural(missed, '风格提炼好了，有 1 个链接没抓到', '风格提炼好了，有 {n} 个链接没抓到'), { n: missed }) : t('风格提炼好了，之后就按它写'), { undo: true })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function monidStatus() {
  try {
    return await request('monid/status')
  } catch (err) {
    return { state: 'error', message: err.message }
  }
}

export async function importAccount(payload) {
  try {
    const data = await request('monid/import', { ...originScope(snapshot), ...payload })
    setDesk({ state: data.state, canUndo: true })
    const spent = data.cost ? t('，花费 ${cost}', { cost: data.cost.toFixed(3) }) : ''
    const what = t(plural(data.count, '读到 {name} 的 1 条内容，新增 {added} 条', '读到 {name} 的 {count} 条内容，新增 {added} 条'), { name: data.nickname, count: data.count, added: data.added })
    toast(data.styleError ? t('{what}{spent}。风格没提炼成：{error}', { what, spent, error: data.styleError }) : t('{what}，已提炼成风格{spent}', { what, spent }), { error: Boolean(data.styleError), undo: !data.styleError })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function learnSkills() {
  try {
    const data = await request('skills/learn', originScope(snapshot))
    setDesk({ state: data.state, canUndo: true })
    toast(data.added ? t(plural(data.added, '从数据里提炼出 1 条新规则，等你确认', '从数据里提炼出 {n} 条新规则，等你确认'), { n: data.added }) : t('目前的数据还提炼不出新规则'))
  } catch (err) {
    report(err)
  }
}

export async function exportSkills() {
  try {
    const data = await request('skills/export', originScope(snapshot))
    setDesk({ state: data.state })
    toast(t(plural(data.rules, '已导出 Skill：{name}（1 条规则）', '已导出 Skill：{name}（{n} 条规则）'), { name: data.name, n: data.rules }))
  } catch (err) {
    report(err)
  }
}

export function fetchInsights(platform, accountId = snapshot.accountId) {
  const params = new URLSearchParams()
  if (accountId !== undefined) params.set('accountId', JSON.stringify(accountId))
  if (platform) params.set('platform', platform)
  return request('insights' + (params.size ? `?${params}` : ''))
}

