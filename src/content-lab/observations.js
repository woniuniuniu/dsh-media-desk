// Shared, browser-safe identity and provenance policy. No stored data is changed.
import { normalizedAccountId } from '../accounts.js'
import { resolveMetricItem, validCounter } from '../metrics.js'

export function associatedMetric(state, metric, item) {
  const resolved = resolveMetricItem(state.items, metric)
  return !resolved.reason && resolved.item?.id === item.id && metric.platform === item.platform && normalizedAccountId(metric) === normalizedAccountId(item)
}

export function viewCounter(metric) {
  if (!validCounter(metric.views)) return null
  if (metric.views === 0 && metric.semantics !== 'cumulative' && metric.collectionTimeBasis !== 'self-declared' && metric.collectionTimeBasis !== 'platform-observed' && metric.source !== 'manual' && metric.source !== 'user-declared') return null
  return metric.views
}
