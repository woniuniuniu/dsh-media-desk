// Identifier-only receipts survive an uncertain journal final write, including
// logical duplicates whose immutable record belongs to an older request ID.
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200
const kinds = new Set(['evaluation', 'forecast', 'prediction', 'publication', 'retrospective'])
export function boundedLabEvidence(value) {
  const rows = Array.isArray(value?.records) ? value.records : value?.record ? [value.record] : []
  const records = []
  for (const row of rows.slice(0, 10)) {
    if (!row || !id(row.id) || !kinds.has(row.kind) || !id(row.itemId) || !(row.accountId === null || id(row.accountId))) continue
    const record = { id: row.id, kind: row.kind, itemId: row.itemId, accountId: row.accountId }
    for (const key of ['contentVersionId', 'evaluationId', 'forecastId', 'predictionId', 'metricId']) if (id(row[key])) record[key] = row[key]
    if (typeof row.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.requestId)) record.requestId = row.requestId
    records.push(record)
  }
  return records.length ? { records } : null
}
