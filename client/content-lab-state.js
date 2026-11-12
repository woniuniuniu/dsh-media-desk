import React from 'react'
import { getDesk, withContentLabReady } from './desk.js'
import { lang, t } from './i18n.js'
import { collectionTimestamp } from '../src/metrics.js'
import { associatedMetric, viewCounter } from '../src/content-lab/observations.js'
export { viewCounter as contentLabViewCounter } from '../src/content-lab/observations.js'

const operations = new Map(), listeners = new Set()
let revision = 0, sequence = 0
const keyFor = (accountId, itemId, action) => JSON.stringify([accountId, itemId, action])
const notify = () => { revision++; listeners.forEach(fn => fn()) }
export function useContentLabOperations() { return React.useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn) }, () => revision) }
export const getContentLabOperation = (accountId, itemId, action) => operations.get(keyFor(accountId, itemId, action))
export function contentLabError(code) {
  return t(({ INVALID_ARGUMENT: '请核对所选版本、时间和数据；内容变化后需重新评估。', BUSY: '请等待正在进行的操作完成。', READ_ONLY: '当前连接只允许查看，无法保存。', UNAVAILABLE: '服务暂不可用，请检查工作台连接。', MODEL_UNAVAILABLE: '模型暂不可用，请检查当前模型连接。', MODEL_TIMEOUT: '模型未及时返回，请先核对操作结果。', INVALID_MODEL_RESULT: '模型返回格式无效，未保存结果。', OUTCOME_UNKNOWN: '结果待核对，请使用核对结果，不要重复提交。', REQUEST_ID_CONFLICT: '此核对编号已用于另一项操作，请先核对原结果。', JOURNAL_ERROR: '操作未能开始，请检查本机保存空间和权限。' })[code] ?? '无法完成操作，请检查连接后核对结果。')
}
async function call(path, input) {
  let response, envelope
  try {
    response = await fetch(`media-desk/content-lab/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-media-desk-lang': lang() }, body: JSON.stringify(input) })
    envelope = await response.json()
  } catch { throw Object.assign(new Error(contentLabError('OUTCOME_UNKNOWN')), { code: 'OUTCOME_UNKNOWN' }) }
  if (!response.ok || envelope?.ok !== true) {
    const code = envelope?.error?.code ?? 'UNAVAILABLE'
    throw Object.assign(new Error(contentLabError(code)), { code, evidence: envelope?.error?.details?.contentLab?.records?.slice(0, 10) ?? [] })
  }
  return { result: envelope.result, requestId: envelope.requestId }
}
export async function readContentLab(input) { return (await call('read', input)).result }
const unresolved = entry => entry && ['pending', 'unknown', 'checking'].includes(entry.status)
export async function runContentLabAction(itemId, accountId, intent) {
  const key = keyFor(accountId, itemId, intent.action), existing = operations.get(key)
  if (unresolved(existing)) return null
  const requestId = globalThis.crypto?.randomUUID?.() ?? `lab-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`
  const input = { ...intent, ...(intent.action === 'evaluate' ? { itemId } : {}), accountId, requestId }
  const entry = { status: 'pending', requestId, input, itemId, accountId, action: intent.action }
  operations.set(key, entry); notify()
  try {
    const receipt = await withContentLabReady(itemId, accountId, () => call('action', input))
    if (!receipt) { entry.status = 'blocked'; entry.message = t('请先完成保存并重新打开当前内容。'); return null }
    entry.status = 'done'; entry.result = receipt.result
    entry.originalRequestId = receipt.result?.record?.requestId
    entry.existing = Boolean(entry.originalRequestId && entry.originalRequestId !== requestId)
    return receipt.result
  } catch (error) {
    entry.status = error.code === 'OUTCOME_UNKNOWN' || error.code === 'MODEL_TIMEOUT' || error.code === 'REQUEST_ID_CONFLICT' ? 'unknown' : 'failed'
    entry.message = error.message; entry.evidence = error.evidence
    return null
  } finally { if (operations.get(key) === entry) notify() }
}
export async function checkContentLabOperation(accountId, itemId, action) {
  const key = keyFor(accountId, itemId, action), entry = operations.get(key)
  if (!entry || !['unknown', 'pending'].includes(entry.status)) return null
  if (entry.status === 'pending') return null
  entry.status = 'checking'; notify()
  try {
    const status = (await call('request-status', { requestId: entry.requestId })).result
    const records = await readContentLab({ accountId, itemId, queryRequestId: entry.requestId, limit: 10 })
    const original = status.response?.result?.record
    const record = original ?? records.items?.[0] ?? entry.evidence?.find(row => row.id)
    if (record) {
      // Fetching full detail is still explicit and scoped in the component.
      entry.status = 'done'; entry.result = { record }; entry.originalRequestId = record.requestId; entry.existing = Boolean(record.requestId && record.requestId !== entry.requestId)
      delete entry.message; delete entry.evidence
    } else if (status.status === 'done' && status.response?.ok === false) {
      entry.status = 'failed'; entry.message = contentLabError(status.response.error?.code)
    } else { entry.status = 'unknown'; entry.message = t('尚未确认结果，请保留核对编号，稍后再次核对。') }
    return entry.result ?? null
  } catch { entry.status = 'unknown'; entry.message = t('核对未完成，请检查连接后再次核对。'); return null }
  finally { if (operations.get(key) === entry) notify() }
}
export function metricReviewEligibility(metric, prediction, now = Date.now(), context = {}) {
  const item = { id: prediction.itemId, accountId: prediction.accountId, platform: prediction.platform }
  if (!associatedMetric({ items: context.items ?? [item] }, metric, item)) return { eligible: false, reason: t('数据与作品、账号或平台不匹配') }
  if (context.metrics && context.metrics.filter(row => row.id === metric.id).length !== 1) return { eligible: false, reason: t('数据编号不唯一，请核对原始记录') }
  const at = Date.parse(collectionTimestamp(metric.collectedAt)), due = Date.parse(prediction.dueAt)
  if (!collectionTimestamp(metric.collectedAt) || ['legacy-import-time', 'legacy-date', 'deterministic'].includes(metric.collectionTimeBasis)) return { eligible: false, reason: t('采集时间未知或不可靠') }
  if (!Number.isFinite(due) || at < due) return { eligible: false, reason: t('尚未达到复盘时间') }
  if (at > now) return { eligible: false, reason: t('采集时间晚于当前时间') }
  return { eligible: true, reason: at > due ? t('迟到累计观测，不是精确到期数据') : t('到期观测'), latenessMs: at - due }
}
export function contentLabMetricOptions(metrics, items, prediction, now = Date.now()) {
  const item = items.find(row => row.id === prediction.itemId && (row.accountId ?? null) === prediction.accountId && row.platform === prediction.platform)
  if (!item) return []
  return metrics.filter(metric => associatedMetric({ items }, metric, item)).map(metric => ({ metric, views: viewCounter(metric), ...metricReviewEligibility(metric, prediction, now, { items, metrics }) }))
}

export function contentLabMedian(baseline) {
  const exact = baseline?.medianViewsExact
  if (exact && /^(0|[1-9][0-9]*)$/.test(exact.numerator) && ['1', '2'].includes(exact.denominator)) {
    if (exact.denominator === '1') return exact.numerator
    const numerator = BigInt(exact.numerator)
    return `${numerator / 2n}${numerator % 2n ? '.5' : ''}`
  }
  return baseline?.medianViews == null ? t('未知') : String(baseline.medianViews)
}
export function contentLabScope(item) { const desk = getDesk(); return JSON.stringify([desk.accountId, desk.workspaceRevision, desk.studioRevision, item?.id, item?.accountId ?? null]) }
