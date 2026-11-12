import { createHash, randomUUID } from 'node:crypto'
import { normalizedAccountId } from '../accounts.js'
import { contentSha256, creativeFingerprint } from '../versions.js'
import { collectionTimestamp, COUNTERS, validCounter } from '../metrics.js'
import { associatedMetric, viewCounter } from './observations.js'
export { associatedMetric, viewCounter } from './observations.js'
import { exactMedian, makeComparisonPolicy, bucketForPolicy } from './comparison.js'

export const textSha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
export const DAY_MS = 86400000
export const BASELINE_POLICY = Object.freeze({ id: 'earliest-per-work-within-6h-v2', maxLatenessHours: 6, minimumWorks: 3, maxWorks: 20, selectionPolicyId: 'recent20-collected-desc-item-id-v1', exactHorizonMeasurement: false })
export const BUCKETS = Object.freeze(['<0.3x', '0.3x..<1x', '1x..<3x', '3x..<10x', '>=10x'])
export const labError = (message, code = 'INVALID_ARGUMENT') => Object.assign(new Error(message), { code, status: code === 'BUSY' ? 409 : 400 })
export const labRecords = state => state.contentLab?.records ?? []
export function dataKnown(state, item) {
  return item.status === 'published' || Boolean(item.publishedAt) || labRecords(state).some(r => r.kind === 'publication' && r.itemId === item.id) || state.metrics.some(metric => associatedMetric(state, metric, item))
}
function targetIdentity(state, id) {
  const item = state.items.find(i => i.id === id)
  if (!item) return { fingerprint: null, scopeFingerprint: null, known: false }
  let sha
  try { sha = creativeFingerprint(item) } catch { sha = 'invalid' }
  const accountId = normalizedAccountId(item), account = state.accounts.find(row => row.id === accountId)
  return { fingerprint: JSON.stringify([accountId, item.platform ?? null, sha, item.contentRevision ?? null]), scopeFingerprint: JSON.stringify([accountId, item.platform ?? null, accountId === null || Boolean(account), account?.platform ?? null]), known: dataKnown(state, item) }
}
export function labTargetSnapshot(state) {
  return new Map(Object.keys(state.contentLab?.targets ?? {}).map(id => [id, targetIdentity(state, id)]))
}
// Store calls this after all ordinary mutations and Undo. These sticky markers
// preserve knowledge and creative lineage even when a user reverses that edit.
export function trackLabTargets(before, state) {
  for (const [id, target] of Object.entries(state.contentLab?.targets ?? {})) {
    const current = targetIdentity(state, id), prior = before.get(id)
    if (prior && prior.fingerprint !== current.fingerprint) target.epoch = randomUUID()
    if (prior && prior.scopeFingerprint !== current.scopeFingerprint) target.scopeEpoch = randomUUID()
    target.known = Boolean(target.known || prior?.known || current.known)
  }
}
export function prepareTarget(state, item) {
  state.contentLab ??= { schemaVersion: 1, records: [], targets: {} }
  state.contentLab.targets ??= {}
  if (!Object.hasOwn(state.contentLab.targets, item.id)) Object.defineProperty(state.contentLab.targets, item.id, { value: { epoch: randomUUID(), scopeEpoch: randomUUID(), known: false }, enumerable: true, writable: true, configurable: true })
  const target = state.contentLab.targets[item.id]
  target.scopeEpoch ??= randomUUID()
  target.known ||= dataKnown(state, item)
  return target
}
export function sealRecord(record) {
  // Hash exactly what Store's JSON writer can persist. In particular, absent
  // optional identity fields must not become hashed-but-unpersisted undefined.
  const copy = JSON.parse(JSON.stringify(record)); delete copy.integrity
  return { ...copy, integrity: contentSha256(copy) }
}
export function verifyRecord(record) {
  if (!record || typeof record.id !== 'string' || !['evaluation', 'forecast', 'prediction', 'publication', 'retrospective'].includes(record.kind)) throw labError('Content-lab record was not found or is invalid.')
  const { integrity, ...payload } = record
  if (typeof integrity !== 'string' || contentSha256(payload) !== integrity) throw labError('Content-lab record integrity check failed.')
  if (record.kind === 'evaluation' && (textSha256(record.manuscript.text) !== record.textSha256 || record.rubric.id !== record.rubricId || record.rubric.version !== record.rubricVersion)) throw labError('Content-lab manuscript integrity check failed.')
  if (record.kind === 'prediction') { verifyRecord(record.evaluation); verifyRecord(record.forecast) }
  return record
}
export function getRecord(state, id, kind, accountId) {
  const record = labRecords(state).find(row => row.id === id && row.accountId === accountId && (!kind || row.kind === kind))
  return verifyRecord(record)
}
export function appendRecord(state, payload) {
  const record = sealRecord({ id: randomUUID(), ...payload })
  state.contentLab.records.push(record)
  return record
}
const metadataKeys = ['id', 'kind', 'requestId', 'accountId', 'itemId', 'platform', 'format', 'contentVersionId', 'creativeSha256', 'textSha256', 'createdAt', 'evaluationId', 'forecastId', 'predictionId', 'metricId', 'rubricId', 'rubricVersion', 'composite', 'blindness', 'eligibleAtEvaluation', 'horizonDays', 'lockedAt', 'publishedAt', 'dueAt', 'timing', 'elapsedMs', 'latenessMs', 'bucketHit', 'observedBucket', 'predictedBucket', 'topBuckets', 'assignedProbability', 'comparisonStatus', 'calibration', 'manuscriptMatch', 'publicationManuscriptMatch', 'registrationCreativeSha256']
export function recordMetadata(record) {
  verifyRecord(record)
  return structuredClone(Object.fromEntries(metadataKeys.filter(k => record[k] !== undefined).map(k => [k, record[k]])))
}
function withoutManuscripts(value) {
  if (Array.isArray(value)) return value.map(withoutManuscripts)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'manuscript').map(([k, v]) => [k, withoutManuscripts(v)]))
  return value
}
export function recordDetail(record, { includeManuscript = false, maxChars = 8000 } = {}) {
  verifyRecord(record)
  const safe = includeManuscript ? structuredClone(record) : withoutManuscripts(record)
  delete safe.integrity
  const json = JSON.stringify(safe)
  return json.length <= maxChars ? { record: safe, truncated: false } : { record: { ...recordMetadata(record), preview: json.slice(0, maxChars), encoding: 'json-fragment' }, truncated: true }
}
export function metricSnapshot(state, metricId, prediction, publication, now) {
  const matches = state.metrics.filter(row => row.id === metricId)
  if (matches.length !== 1) throw labError('Select one unambiguous metric ID.')
  const metric = matches[0], item = state.items.find(row => row.id === prediction.itemId)
  if (!item || !associatedMetric(state, metric, item) || normalizedAccountId(item) !== prediction.accountId || metric.platform !== prediction.platform) throw labError('Metric identity does not match this prediction account, work and platform.')
  const collectedAt = collectionTimestamp(metric.collectedAt), due = Date.parse(publication.publishedAt) + prediction.horizonDays * DAY_MS
  if (!collectedAt || Date.parse(collectedAt) < due || Date.parse(collectedAt) > now || ['legacy-import-time', 'legacy-date', 'deterministic'].includes(metric.collectionTimeBasis)) throw labError('Metric needs a reliable collection time at or after the due instant, and no later than now.')
  const values = Object.fromEntries(COUNTERS.map(k => [k, k === 'views' ? viewCounter(metric) : validCounter(metric[k]) ? metric[k] : null]))
  const provenance = { metricId: metric.id, itemId: metric.itemId ?? null, externalId: typeof metric.externalId === 'string' ? metric.externalId.slice(0, 300) : null, accountId: normalizedAccountId(metric), platform: metric.platform, source: typeof metric.source === 'string' ? metric.source.slice(0, 300) : null, collectedAt, collectionTimeBasis: typeof metric.collectionTimeBasis === 'string' ? metric.collectionTimeBasis.slice(0, 100) : 'self-declared', semantics: metric.semantics === 'cumulative' ? 'cumulative' : 'legacy-cumulative' }
  return { ...values, provenance, collectedAt, dueAt: new Date(due).toISOString(), elapsedMs: Date.parse(collectedAt) - Date.parse(publication.publishedAt), latenessMs: Date.parse(collectedAt) - due }
}
export function relativeBucket(views, baseline) {
  return bucketForPolicy(views, makeComparisonPolicy({ numerator: String(baseline), denominator: '1' }))
}
export function baselineFor(state, evaluation, horizonDays, now) {
  const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0
  const perItem = new Map()
  for (const r of labRecords(state)) {
    if (r.kind !== 'retrospective' || r.accountId !== evaluation.accountId || r.platform !== evaluation.platform || r.format !== evaluation.format || r.horizonDays !== horizonDays || r.itemId === evaluation.itemId) continue
    verifyRecord(r)
    const collected = Date.parse(r.actuals.collectedAt)
    if (r.publicationManuscriptMatch !== 'matching' || !validCounter(r.actuals.views) || r.latenessMs < 0 || r.latenessMs > BASELINE_POLICY.maxLatenessHours * 3600000 || !Number.isFinite(collected) || collected > now) continue
    const previous = perItem.get(r.itemId)
    if (!previous || collected < Date.parse(previous.actuals.collectedAt) || collected === Date.parse(previous.actuals.collectedAt) && compareId(r.id, previous.id) < 0) perItem.set(r.itemId, r)
  }
  // Freeze a disclosed recent cohort after choosing the earliest observation
  // per work. Older history cannot inflate context or silently disable scoring.
  const rows = [...perItem.values()].sort((a, b) => Date.parse(b.actuals.collectedAt) - Date.parse(a.actuals.collectedAt) || compareId(a.itemId, b.itemId) || compareId(a.id, b.id)).slice(0, BASELINE_POLICY.maxWorks)
  const values = rows.map(r => r.actuals.views).sort((a, b) => a - b), n = values.length
  const median = exactMedian(values)
  const usable = n >= BASELINE_POLICY.minimumWorks && median !== null && BigInt(median.exact.numerator) > 0n
  return { policy: { ...BASELINE_POLICY }, usable, count: n, totalEligibleCount: perItem.size, medianViews: usable ? median.display : null, medianViewsExact: usable ? median.exact : null, medianViewsApproximate: usable && median.approximate, reason: usable ? 'comparable-timed-observations' : n < BASELINE_POLICY.minimumWorks ? 'insufficient-basis' : 'zero-baseline', sources: rows.map(r => ({ retrospectiveId: r.id, itemId: r.itemId, metricId: r.metricId, views: r.actuals.views, collectedAt: r.actuals.collectedAt, elapsedMs: r.elapsedMs, latenessMs: r.latenessMs })) }
}

// The same small whitelist is used for both model contexts and action receipts,
// including old frozen baselines whose archived source lists may be very large.
export function baselineSummary(baseline) {
  if (!baseline) return null
  const policy = {}
  for (const key of ['id', 'selectionPolicyId']) if (typeof baseline.policy?.[key] === 'string') policy[key] = baseline.policy[key].slice(0, 120)
  for (const key of ['maxLatenessHours', 'minimumWorks', 'maxWorks']) if (validCounter(baseline.policy?.[key])) policy[key] = baseline.policy[key]
  if (typeof baseline.policy?.exactHorizonMeasurement === 'boolean') policy.exactHorizonMeasurement = baseline.policy.exactHorizonMeasurement
  const exact = baseline.medianViewsExact
  const medianViewsExact = exact && ['numerator', 'denominator'].every(k => typeof exact[k] === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(exact[k])) && exact.denominator !== '0' ? { numerator: exact.numerator, denominator: exact.denominator } : null
  let earliest = null, latest = null
  for (const source of baseline.sources ?? []) {
    const at = collectionTimestamp(source.collectedAt)
    if (!at) continue
    if (earliest === null || at < earliest) earliest = at
    if (latest === null || at > latest) latest = at
  }
  // Preserve a previously compacted receipt's date range on cached replay.
  if (earliest === null) earliest = collectionTimestamp(baseline.sourceDateRange?.earliestCollectedAt)
  if (latest === null) latest = collectionTimestamp(baseline.sourceDateRange?.latestCollectedAt)
  const count = validCounter(baseline.count) ? baseline.count : 0
  return { policy, usable: baseline.usable === true, count, totalEligibleCount: validCounter(baseline.totalEligibleCount) ? baseline.totalEligibleCount : count, medianViews: typeof baseline.medianViews === 'number' && Number.isFinite(baseline.medianViews) ? baseline.medianViews : null, medianViewsExact, medianViewsApproximate: baseline.medianViewsApproximate === true, reason: typeof baseline.reason === 'string' ? baseline.reason.slice(0, 200) : null, sourceDateRange: { earliestCollectedAt: earliest, latestCollectedAt: latest } }
}
