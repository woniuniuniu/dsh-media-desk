// Stored metrics are cumulative observations. This module never changes raw history.
import { normalizedAccountId } from './accounts.js'
import { PLATFORMS } from './platforms.js'

export const COUNTERS = ['views', 'likes', 'comments', 'shares', 'saves']
const INTERACTIONS = COUNTERS.slice(1)
export const validCounter = value => Number.isSafeInteger(value) && value >= 0

/** A collection instant must be explicit, zoned and calendar-valid. Save/stat dates are not collection instants. */
export function collectionTimestamp(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value)
  if (!m) return null
  const [, year, month, day, hour, minute, second] = m.map((v, i) => i > 0 && i < 7 ? Number(v) : v)
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0)
  const days = calendar.getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const sumKnown = values => {
  const known = values.filter(v => v !== null && v !== undefined)
  if (!known.length) return null
  const total = known.reduce((a, b) => a + BigInt(b), 0n)
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null
}
export const engagement = row => sumKnown(INTERACTIONS.map(key => row[key]))
const day = iso => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const sourceOf = row => typeof row.source === 'string' && row.source.trim() ? row.source : null
const streamKey = (item, platform) => JSON.stringify([normalizedAccountId(item), item.id, platform])
const recordKey = row => JSON.stringify([row.id ?? null, row.itemId ?? null, row.externalId ?? null, row.platform ?? null, row.collectedAt ?? null, row.fetchedAt ?? null, row.date ?? null, sourceOf(row), ...COUNTERS.map(k => [typeof row[k], String(row[k])])])

function observation(row, now) {
  const raw = row.collectedAt
  const parsed = collectionTimestamp(raw)
  const future = parsed !== null && Date.parse(parsed) > now
  const collectedAt = future ? null : parsed
  const imported = typeof row.fetchedAt === 'string' ? Date.parse(row.fetchedAt) : NaN
  const dated = typeof row.date === 'string' ? Date.parse(row.date) : NaN
  const weak = Number.isFinite(imported) ? imported : Number.isFinite(dated) ? dated : null
  const weakBasis = Number.isFinite(imported) ? 'legacy-import-time' : Number.isFinite(dated) ? 'legacy-date' : 'deterministic'
  return { row, key: recordKey(row), source: sourceOf(row), collectedAt, time: collectedAt === null ? null : Date.parse(collectedAt), weak, weakBasis, timeReason: raw == null ? 'unknown-timestamp' : future ? 'future-timestamp' : !parsed ? 'invalid-timestamp' : null }
}

// Timed observations are preferred to incomparable undated records. This is a documented
// fallback policy, never evidence that an undated record predates a timed observation.
function order(a, b) {
  if (a.time !== null && b.time !== null) return a.time - b.time || a.key.localeCompare(b.key)
  if (a.time !== null || b.time !== null) return a.time !== null ? 1 : -1
  if (a.weak !== null && b.weak !== null) return a.weak - b.weak || a.key.localeCompare(b.key)
  if (a.weak !== null || b.weak !== null) return a.weak !== null ? 1 : -1
  return a.key.localeCompare(b.key)
}

function summarize(stream) {
  const observations = [...stream.observations].sort(order)
  const provenance = {}, counters = {}, selectedKeys = {}, selectedConflictFields = [], warnings = new Set()
  const timed = observations.filter(o => o.time !== null)
  const unknown = observations.filter(o => o.time === null)
  if (unknown.length) warnings.add('collection-time-unknown')
  if (unknown.some(o => o.weakBasis === 'legacy-date')) warnings.add('legacy-date-order-only')
  if (unknown.some(o => o.weakBasis === 'legacy-import-time')) warnings.add('legacy-import-time-only')
  if (unknown.length && timed.length) warnings.add('timed-and-undated-incomparable')
  if (observations.some(o => !o.source)) warnings.add('source-unknown')
  if (observations.some(o => o.row.semantics !== 'cumulative' && COUNTERS.some(k => o.row[k] === 0))) warnings.add('legacy-zero-provenance')
  for (const key of COUNTERS) {
    const chosen = observations.findLast(o => validCounter(o.row[key]))
    counters[key] = chosen?.row[key] ?? null
    selectedKeys[key] = chosen?.key ?? null
    provenance[key] = chosen ? { metricId: chosen.row.id ?? null, source: chosen.source, collectedAt: chosen.collectedAt, collectionTimeBasis: chosen.collectedAt === null ? null : chosen.row.collectionTimeBasis ?? 'self-declared', ordering: chosen.time !== null ? 'collection' : chosen.weakBasis } : null
    if (chosen && chosen !== observations.at(-1)) warnings.add('retained-earlier-field')
    if (observations.some(o => o.row[key] != null && !validCounter(o.row[key]))) warnings.add('invalid-counter')
    const groups = new Map()
    for (const o of timed) {
      const values = groups.get(o.time) ?? new Set()
      if (validCounter(o.row[key])) values.add(o.row[key])
      groups.set(o.time, values)
    }
    if ([...groups.values()].some(values => values.size > 1)) warnings.add('equal-time-conflict')
    if (chosen && chosen.time !== null && (groups.get(chosen.time)?.size ?? 0) > 1) selectedConflictFields.push(key)
  }
  const latest = Object.values(provenance).map(field => field?.collectedAt).filter(Boolean).sort().at(-1) ?? null
  const sources = [...new Set(observations.map(o => o.source).filter(Boolean))].sort()
  const current = observations.at(-1)
  const missingFields = COUNTERS.filter(key => !validCounter(current.row[key]))
  const retainedFields = missingFields.filter(key => counters[key] !== null)
  return {
    streamKey: stream.key, id: stream.item.id, title: stream.item.title, platform: stream.platform,
    ...counters, engaged: engagement(counters), engagedPartial: INTERACTIONS.some(key => counters[key] === null),
    provenance, source: sources.length === 1 && observations.every(o => o.source) ? sources[0] : null, sources,
    latestCollectedAt: latest, currentSource: current.source, missingFields, retainedFields,
    sameSnapshot: selectedKeys.views !== null && COUNTERS.every(key => selectedKeys[key] === selectedKeys.views),
    selectedConflictFields,
    completeSnapshot: missingFields.length === 0 && selectedConflictFields.length === 0,
    orderUncertain: unknown.length > 0 || selectedConflictFields.length > 0,
    warnings: [...warnings].sort(), rawRecords: observations.length,
  }
}

export function aggregateSnapshots(rows) {
  const result = Object.fromEntries(COUNTERS.map(key => [key, sumKnown(rows.map(row => row[key]))]))
  result.overflowFields = COUNTERS.filter(key => result[key] === null && rows.some(row => row[key] !== null))
  result.engaged = engagement(result)
  if (result.engaged === null && INTERACTIONS.some(key => result[key] !== null)) result.overflowFields.push('engaged')
  result.engagedPartial = INTERACTIONS.some(key => result[key] === null) || result.engaged === null || rows.some(row => row.engagedPartial)
  const matched = rows.filter(row => row.views > 0 && row.engaged !== null && !row.engagedPartial && row.sameSnapshot && row.selectedConflictFields.length === 0)
  const rateViews = sumKnown(matched.map(row => row.views)), rateEngaged = sumKnown(matched.map(row => row.engaged))
  result.engagementRate = rateViews > 0 && rateEngaged !== null ? rateEngaged / rateViews : null
  result.rateCoverage = { matchedWorks: matched.length, totalWorks: rows.length, views: rateViews, engaged: rateEngaged, partial: matched.length !== rows.length || rows.some(row => row.warnings.includes('legacy-zero-provenance')), explanation: 'Rate uses positive views and all four interaction counters from the same selected snapshot; unmatched works are excluded.' }
  return result
}

function growthTimeline(streams) {
  const days = new Map(), intervals = [], reasons = {}
  const note = reason => { reasons[reason] = (reasons[reason] ?? 0) + 1 }
  const getDay = date => {
    if (!days.has(date)) days.set(date, { date, views: null, engaged: null, partial: true, observedIntervals: 0, overflowFields: [] })
    return days.get(date)
  }
  for (const stream of streams) {
    const groups = new Map()
    for (const o of stream.observations) {
      if (o.time === null) { note(o.timeReason); continue }
      const group = groups.get(o.time) ?? []
      group.push(o)
      groups.set(o.time, group)
    }
    let previous = null
    for (const [time, group] of [...groups].sort((a, b) => a[0] - b[0])) {
      const values = {}, errors = {}
      for (const key of COUNTERS) {
        const valid = new Set(group.filter(o => validCounter(o.row[key])).map(o => o.row[key]))
        errors[key] = valid.size > 1 ? 'equal-time-conflict' : group.some(o => o.row[key] != null && !validCounter(o.row[key])) ? 'invalid' : group.some(o => o.row[key] == null) ? 'missing' : null
        values[key] = errors[key] ? null : [...valid][0] ?? null
      }
      const at = new Date(time).toISOString(), date = day(at), daily = getDay(date)
      if (!previous) note('baseline')
      else {
        const crossDay = day(previous.at) !== date
        if (crossDay) note('cross-day')
        const delta = {}, intervalReasons = {}
        for (const key of COUNTERS) {
          const reason = errors[key] ?? previous.errors[key] ?? (values[key] < previous.values[key] ? 'decrease' : null)
          delta[key] = reason ? null : values[key] - previous.values[key]
          if (reason) { intervalReasons[key] = reason; note(reason) }
        }
        const engaged = engagement(delta)
        const engagedOverflow = engaged === null && INTERACTIONS.some(key => delta[key] !== null)
        if (engagedOverflow) { intervalReasons.engaged = 'aggregate-overflow'; note('aggregate-overflow') }
        intervals.push({ streamKey: stream.key, id: stream.item.id, platform: stream.platform, from: previous.at, to: at, crossDay, ...delta, engaged, partial: true, reasons: intervalReasons })
        if (!crossDay) {
          if (engagedOverflow && !daily.overflowFields.includes('engaged')) { daily.overflowFields.push('engaged'); daily.engaged = null }
          for (const key of ['views', 'engaged']) {
            if (daily.overflowFields.includes(key)) continue
            const value = key === 'views' ? delta.views : engaged
            const total = sumKnown([daily[key], value])
            if (total === null && (daily[key] !== null || value !== null)) { daily.overflowFields.push(key); note('aggregate-overflow') }
            daily[key] = total
          }
          daily.observedIntervals += 1
        }
      }
      previous = { at, values, errors }
    }
  }
  return { daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), timeline: { intervals, reasons, explanation: 'Only adjacent reliable collection instants can yield observed increments. First baselines and broken intervals are unknown. Cross-day intervals are listed separately and excluded from daily values. Within-day values are partial observations, never complete daily growth.' } }
}

/** Resolve exact work identity using the caller's account-scoped items, never titles. */
export function resolveMetricItem(items, metric) {
  let item = items.find(row => row.id === metric.itemId), reason = null
  if (!item && !metric.itemId && metric.externalId) {
    const matches = items.filter(row => row.externalId === metric.externalId && normalizedAccountId(row) === normalizedAccountId(metric))
    if (matches.length === 1) item = matches[0]
    else if (matches.length > 1) reason = 'ambiguous externalId'
  }
  if (!item) reason ??= metric.itemId ? 'linked item not in scope' : 'no identifiable work'
  else if (!PLATFORMS.includes(metric.platform)) reason = 'missing/invalid platform'
  return { item, reason }
}

/** Resolve identities using exact IDs under the existing account scope, never titles. */
export function reduceMetrics(state, metrics = state.metrics, { now = Date.now(), identityItems = state.items } = {}) {
  const streams = new Map(), excluded = new Map()
  const observations = metrics.map(row => observation(row, now))
  for (const o of observations) {
    const metric = o.row
    const { item, reason } = resolveMetricItem(identityItems, metric)
    if (reason) { excluded.set(reason, (excluded.get(reason) ?? 0) + 1); continue }
    const key = streamKey(item, metric.platform)
    const stream = streams.get(key) ?? { key, item, platform: metric.platform, observations: [] }
    stream.observations.push(o)
    streams.set(key, stream)
  }
  const ordered = [...streams.values()].sort((a, b) => a.key.localeCompare(b.key))
  const rows = ordered.map(summarize)
  const rawLatestCollectedAt = observations.map(o => o.collectedAt).filter(Boolean).sort().at(-1) ?? null
  const latestCollectedAt = rows.map(row => row.latestCollectedAt).filter(Boolean).sort().at(-1) ?? null
  const published = state.items.filter(item => item.status === 'published')
  const missingWorks = [], withData = new Set(), withViews = new Set(), complete = new Set(), completeCounters = new Set()
  for (const item of published) {
    const linked = rows.filter(row => row.id === item.id)
    if (linked.some(row => COUNTERS.some(key => row[key] !== null))) withData.add(item.id)
    if (linked.some(row => row.views !== null)) withViews.add(item.id)
    if (linked.length && linked.every(row => COUNTERS.every(key => row[key] !== null))) completeCounters.add(item.id)
    if (linked.length && linked.every(row => row.completeSnapshot)) complete.add(item.id)
    for (const row of linked.length ? linked : [{ platform: item.platform ?? null }]) {
      const missingFields = row.missingFields ?? [...COUNTERS]
      if (missingFields.length) missingWorks.push({ id: item.id, title: item.title, platform: row.platform, reason: linked.length ? 'missing/invalid fields' : 'no linked snapshot', missingFields, retainedFields: row.retainedFields ?? [], unknownFields: COUNTERS.filter(key => row[key] == null), source: row.currentSource ?? null, latestCollectedAt: row.latestCollectedAt ?? null })
    }
  }
  const unknownTimeRecords = observations.filter(o => o.time === null).length
  const coverage = {
    published: published.length, withData: withData.size, withViews: withViews.size,
    complete: complete.size, completeCounters: completeCounters.size,
    rawRecords: metrics.length,
    linkedRecords: ordered.reduce((n, stream) => n + stream.observations.length, 0),
    uniqueWorks: rows.length, uniqueItems: new Set(rows.map(row => row.id)).size,
    excludedRecords: [...excluded.values()].reduce((a, b) => a + b, 0),
    excludedReasons: [...excluded].sort().map(([reason, count]) => ({ reason, count })),
    unknownTimeRecords,
    unknownTimeWorks: rows.filter(row => row.warnings.includes('collection-time-unknown')).length,
    unknownSourceRecords: observations.filter(o => !o.source).length,
    legacyZeroRecords: metrics.filter(row => row.semantics !== 'cumulative' && COUNTERS.some(key => row[key] === 0)).length,
    latestCollectedAt, rawLatestCollectedAt,
    latestCollectedAtScope: unknownTimeRecords || rows.some(row => COUNTERS.some(key => !row.provenance[key]?.collectedAt)) || withData.size < published.length ? 'known subset' : 'all selected valid fields',
    missingWorks, missingWorksCount: new Set(missingWorks.map(row => row.id)).size,
    missingEntriesCount: missingWorks.length,
    fieldCounts: Object.fromEntries(COUNTERS.map(key => [key, rows.filter(row => row[key] !== null).length])),
    explanation: 'Coverage counts published items; uniqueWorks counts item/platform streams. Complete means all five counters in the selected snapshot; completeCounters permits retained earlier fields. Missing works list fields absent/invalid in the selected snapshot, even when an earlier valid value is retained. Legacy zeros may have been defaults. Sources are self-declared. Collection time is never inferred from stat/save/account dates.',
  }
  return { rows, coverage, ...growthTimeline(ordered) }
}
