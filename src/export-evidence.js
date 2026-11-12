// Safe recovery DTO shared by the GUI and automation. No content/settings/provider fields.
export function boundedExportEvidence(value) {
  if (!value || typeof value.path !== 'string' || !value.path) return null
  const out = { path: value.path.slice(0, 4096) }
  for (const key of ['itemId', 'accountId', 'versionId']) out[key] = typeof value[key] === 'string' ? value[key].slice(0, 200) : null
  out.versionNumber = Number.isSafeInteger(value.versionNumber) && value.versionNumber > 0 ? value.versionNumber : null
  out.versionName = typeof value.versionName === 'string' ? value.versionName.slice(0, 80) : ''
  for (const [key, max] of [['contentSha256', 64], ['exportedAt', 40]]) if (typeof value[key] === 'string') out[key] = value[key].slice(0, max)
  const files = Array.isArray(value.files) ? value.files : []
  out.files = files.slice(0, 100).filter(file => typeof file === 'string' && !/[\\/]/.test(file)).map(file => file.slice(0, 200))
  out.filesTotal = Number.isSafeInteger(value.filesTotal) && value.filesTotal >= files.length ? value.filesTotal : files.length
  out.filesTruncated = out.filesTotal > out.files.length
  return out
}
