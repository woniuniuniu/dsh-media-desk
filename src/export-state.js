// Shared GUI / automation export boundary. Seal before any settings, render or filesystem await.
import { boundedExportEvidence } from './export-evidence.js'
import { randomUUID } from 'node:crypto'
import { normalizedAccountId, requireMembership } from './accounts.js'
import { assertVersionIdle, creativeFingerprint, saveVersion, selectedVersion } from './versions.js'

const busy = producer => id => Boolean(producer?.isRunning(id) || producer?.anyAssetActive(id))
export async function sealExport(store, producer, id, accountId) {
  return store.mutate('固定导出版本', state => {
    const item = requireMembership(state, id, accountId)
    assertVersionIdle(item, busy(producer))
    if (!item.production?.article) throw Object.assign(new Error('还没有可以保存的成稿'), { code: 'INVALID_ARGUMENT', status: 400 })
    const version = saveVersion(item, { source: 'export', deduplicate: true })
    return { itemId: id, accountId: normalizedAccountId(item), version: structuredClone(version), production: structuredClone(version.content.production) }
  }, { undoable: false })
}
export async function readSealedExport(store, producer, id, accountId, versionId) {
  const state = await store.read(), item = requireMembership(state, id, accountId)
  assertVersionIdle(item, busy(producer))
  const version = selectedVersion(item, versionId)
  if (!version.content.production?.article) throw Object.assign(new Error('历史版本没有可导出的成稿。'), { code: 'INVALID_ARGUMENT', status: 400 })
  return { itemId: id, accountId: normalizedAccountId(item), version: structuredClone(version), production: structuredClone(version.content.production) }
}
export async function verifyExportTarget(store, producer, sealed) {
  const item = requireMembership(await store.read(), sealed.itemId, sealed.accountId)
  assertVersionIdle(item, busy(producer))
  selectedVersion(item, sealed.version.id)
}
export async function recordExport(store, sealed, saved) {
  try {
    return await store.mutate('记录导出结果', state => {
      // Keep evidence on the original item even if it moved while files were written.
      const item = state.items.find(row => row.id === sealed.itemId)
      if (!item) throw new Error('The original item no longer exists.')
      selectedVersion(item, sealed.version.id)
      item.contentVersionExports = [...item.contentVersionExports ?? [], { id: randomUUID(), versionId: sealed.version.id, versionNumber: sealed.version.number, versionName: sealed.version.name, accountId: sealed.accountId, path: saved.path, files: saved.files, exportedAt: saved.exportedAt, contentSha256: sealed.version.sha256 }]
      const currentMatches = normalizedAccountId(item) === sealed.accountId && creativeFingerprint(item) === sealed.version.sha256
      if (currentMatches && item.production) {
        item.production.savedPath = saved.path; item.production.savedAccountId = sealed.accountId; item.production.savedAt = saved.exportedAt
      }
      return { currentMatches }
    }, { undoable: false })
  } catch {
    throw Object.assign(new Error('导出文件已保留，但保存记录未能确认。请检查文件和当前内容后再操作。'), { code: 'OUTCOME_UNKNOWN', exportEvidence: boundedExportEvidence(saved) })
  }
}
