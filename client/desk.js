// 浏览器侧的状态：Host 状态的本地镜像，加上只属于界面的视图、弹窗等。
import React from 'react'
import { t } from './util.js'

const BASE = 'x-desk/'

let snapshot = {
  state: null, model: null, modelOk: null, modelError: null, canUndo: false, error: null, exchangeDir: null,
  view: 'inbox', settings: null, settingsOpen: false, modelPickOpen: false, toast: null, dialog: null,
}
const listeners = new Set()

export function getDesk() {
  return snapshot
}

export function setDesk(patch) {
  snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) }
  listeners.forEach(fn => fn())
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDesk(selector) {
  return React.useSyncExternalStore(subscribe, () => selector(snapshot))
}

async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || t('请求失败（{status}）', { status: res.status })), { status: res.status })
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
    const settings = await api('settings')
    const data = await api('state')
    setDesk({ settings, state: data.state, model: data.model, modelOk: data.modelOk, modelError: data.modelError, canUndo: data.canUndo, error: null })
  } catch (err) {
    setDesk({ error: err.message })
  }
}

export async function dispatchOps(ops, { label = t('操作'), undoable = true, silent = false } = {}) {
  try {
    const data = await api('ops', { ops, label, undoable })
    setDesk({ state: data.state, canUndo: undoable || snapshot.canUndo })
    if (data.errors?.length) toast(data.errors[0], { error: true })
    else if (!silent && data.receipts?.[0]) toast(data.receipts[0].text, { undo: undoable })
    return data
  } catch (err) {
    report(err)
    return null
  }
}

export async function undo() {
  try {
    const data = await api('undo', {})
    setDesk({ state: data.state, canUndo: data.canUndo, toast: null })
    if (data.label) toast(t('已撤销：{label}', { label: data.label }))
  } catch (err) {
    report(err)
  }
}

export async function saveSettings(payload) {
  try {
    const settings = await api('settings', payload)
    setDesk({ settings })
    toast(t('设置已保存'))
    return true
  } catch (err) {
    report(err)
    return false
  }
}

export async function fetchModels() {
  return api('models')
}

/** 切换助手模型；两个字段都空表示跟随默认。 */
export async function saveAssistant(assistant) {
  try {
    const settings = await api('settings', { assistant })
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
    const settings = await api('settings', payload)
    setDesk({ settings })
    const { src } = await api('settings/test', {})
    return src
  } catch (err) {
    report(err)
    return null
  }
}

export async function uploadFile(file) {
  const res = await fetch(`${BASE}upload`, { method: 'POST', headers: { 'content-type': file.type }, body: file })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || t('上传失败'))
  return data
}

/**
 * 现在就出一批。当天已成功过且没带 force 时返回 { conflict: true }，由界面确认后再带 force 调用。
 * @returns {Promise<{created: number, error: string|null}|{conflict: true}|null>} 失败时返回 null（已提示）。
 */
export async function runCompose({ force = false } = {}) {
  try {
    const data = await api('compose/run', force ? { force: true } : {})
    setDesk({ state: data.state })
    return { created: data.created ?? 0, error: data.error ?? null }
  } catch (err) {
    if (err.status === 409) return { conflict: true }
    report(err)
    return null
  }
}

/** 对一条候选稿改稿：给看法、说一句话、或换类型，三选一。模型调用，不可撤销。 */
export async function reviseCandidate(id, { view, instruction, typeId }) {
  try {
    const body = { id }
    if (view !== undefined) body.view = view
    else if (instruction !== undefined) body.instruction = instruction
    else body.typeId = typeId
    const data = await api('candidate/revise', body)
    setDesk({ state: data.state })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

/** 用一条手动笔记出一条候选稿。 */
export async function composeNote(id) {
  try {
    const data = await api('note/compose', { id })
    setDesk({ state: data.state })
    return true
  } catch (err) {
    report(err)
    return false
  }
}

/** 给候选稿配图（排期页使用）。 */
export async function makeImage(id) {
  try {
    const data = await api('candidate/image', { id })
    setDesk({ state: data.state })
    return true
  } catch (err) {
    report(err)
    return false
  }
}
