import { allAccountCounts, accountCounts, normalizedAccountId, requireAccount, requireMembership, resolveChatScope, scopeState, scopedActions } from '../accounts.js'
import Ajv from 'ajv'
import { draftFormat } from '../style.js'
import { catalog, PLUGIN_VERSION, PROTOCOL_VERSION } from './catalog.js'
import { failure, invalid } from './errors.js'
import { sharedMutationJournal } from './journal.js'
import { createContentLabService } from '../content-lab/service.js'
import { baselineSummary, labRecords, recordMetadata } from '../content-lab/records.js'
import { automationDirectory } from './paths.js'
import { randomUUID } from 'node:crypto'
import { assertVersionIdle, backupMeaningful, selectedVersion, versionMetadata } from '../versions.js'
import { applyOps } from '../ops.js'
import { computeInsights } from '../learn.js'
import { PLATFORMS } from '../platforms.js'
import { collectionTimestamp } from '../metrics.js'
import { sealExport, verifyExportTarget, recordExport } from '../export-state.js'
import { saveProduction, resolveExportDir } from '../export.js'
import { importLocalFile } from './import-file.js'

const ajv = new Ajv({ allErrors: false, strict: false })
const definitions = new Map(catalog.map(t => [t.name, { ...t, validate: ajv.compile(t.inputSchema) }]))
const META = ['id', 'accountId', 'title', 'kind', 'status', 'platform', 'scheduledAt', 'publishedAt', 'createdAt', 'pinned', 'tags', 'parentId', 'importRequestId']
const pick = (row, keys) => Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]))
const clipped = (v, n = 500) => typeof v === 'string' ? v.slice(0, n) : v
function compactLabReceipt(response) {
  if (!response?.result?.record) return response
  // Old completed receipts may contain a full frozen prediction or forecast.
  // Project their baselines at read time without changing durable archives.
  const project = value => Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, row]) => [key, key === 'baseline' ? baselineSummary(row) : project(row)])) : value
  return { ...response, result: { ...response.result, record: project(response.result.record) } }
}
function metadata(row) { const out = pick(row, META); out.title = clipped(out.title, 300); out.tags = out.tags?.slice(0, 24).map(x => clipped(x, 100)); out.productionStatus = row.production?.status ?? null; return out }
function avatarImportMetadata(account) {
  const marker = account.avatarImport
  return typeof account.avatar === 'string' && marker?.src === account.avatar && typeof marker.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(marker.requestId) ? { avatarImportRequestId: marker.requestId } : {}
}
function mediaMetadata(media) {
  if (!media) return null
  const out = {}
  for (const key of ['src', 'poster']) if (typeof media[key] === 'string' && /^(media-desk\/(assets|files)\/[\w.-]+$|https?:\/\/)/.test(media[key])) out[key] = clipped(media[key], 4000)
  for (const key of ['w', 'h']) if (Number.isFinite(media[key])) out[key] = media[key]
  return out
}
function productionStatus(item, producer) {
  const p = item.production
  return { id: item.id, status: item.status, production: p ? { ...pick(p, ['status', 'stage', 'startedAt', 'finishedAt', 'savedAt', 'format', 'withImages']), title: clipped(p.title, 300), error: p.error ? 'Production failed. Inspect the workbench for details.' : null, assets: [p.cover, ...p.images ?? [], ...p.shots ?? []].filter(Boolean).map(a => ({ status: a.status, error: a.error ? 'Asset generation failed. Inspect the workbench for details.' : null })) } : null, live: pick(producer.status(item.id), ['running', 'stage']) }
}
function validateSchedule(input) {
  for (const op of input.ops ?? []) {
    if (op.op === 'add_metric' && op.collectedAt != null && !collectionTimestamp(op.collectedAt)) throw invalid('collectedAt must be a calendar-valid timezone-qualified ISO8601 timestamp, or null for unknown.')
    if (typeof op.scheduledAt === 'string') {
      const [year, month, day] = op.scheduledAt.slice(0, 10).split('-').map(Number)
      const last = new Date(0); last.setUTCFullYear(year, month, 0)
      if (month < 1 || month > 12 || day < 1 || day > last.getUTCDate()) throw invalid('scheduledAt has an invalid calendar date.')
    }
    if (op.scheduledAt !== undefined && op.scheduledAt !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(op.scheduledAt) || Number.isNaN(Date.parse(op.scheduledAt)))) throw invalid('scheduledAt must be timezone-qualified ISO8601, or null to cancel.')
  }
}
export function createAutomationService({ store, settings, producer, assist, models = async () => ({ providers: [] }), readOnly = false, profile = 'desktop', callText, now, journal = sharedMutationJournal(automationDirectory(store.root, profile)) }) {
  const lab = createContentLabService({ store, producer, callText, now })
  async function find(id, accountId) { const state = await store.read(); const row = state.items.find(i=>i.id===id); if(!row) throw Object.assign(new Error('Item not found.'),{code:'NOT_FOUND'}); return requireMembership(state,id,accountId) }
  async function dispatch(tool, input, requestId) {
    if (!['media_desk_get_content_lab', 'media_desk_content_lab_action'].includes(tool) && input.accountId !== undefined) requireAccount(await store.read(),input.accountId)
    switch (tool) {
      case 'media_desk_get_content_lab': return lab.read(input)
      case 'media_desk_content_lab_action': return lab.action(input, requestId)
      case 'media_desk_list_accounts': {
        const state=await store.read();const counts=allAccountCounts(state); const q=input.query?.toLocaleLowerCase(); const rows=state.accounts.filter(a=>(!q||`${a.handle} ${a.platform} ${a.group} ${a.id}`.toLocaleLowerCase().includes(q))&&(input.platform===undefined||a.platform===input.platform)&&(input.group===undefined||a.group===input.group)&&(input.archived===undefined||Boolean(a.archived)===input.archived));const offset=input.offset??0,limit=input.limit??20;return {accounts:rows.slice(offset,offset+limit).map(a=>({...Object.fromEntries(Object.entries(pick(a,['id','handle','platform','avatar','group','archived','defaultStyleId','draftFormat'])).map(([k,v])=>[k,clipped(v,k==='avatar'?4000:300)])),...avatarImportMetadata(a),counts:counts.get(a.id)??{items:0,published:0,scheduled:0,metrics:0}})),total:rows.length,offset,nextOffset:offset+limit<rows.length?offset+limit:null}
      }
      case 'media_desk_get_account': {const state=await store.read();const a=requireAccount(state,input.id);return {...Object.fromEntries(Object.entries(pick(a,['id','handle','platform','url','avatar','group','positioning','audience','defaultStyleId','draftFormat','archived','note','followers','createdAt'])).map(([k,v])=>[k,clipped(v,4000)])),...avatarImportMetadata(a),counts:accountCounts(state,a.id)} }
      case 'media_desk_status': return { protocolVersion: PROTOCOL_VERSION, pluginVersion: PLUGIN_VERSION, available: true, readOnly, supportedPlatforms: PLATFORMS }
      case 'media_desk_list_items': {
        const query = input.query?.toLocaleLowerCase()
        const rows = scopeState(await store.read(),input.accountId).items.filter(i => (!query || `${i.title}\n${i.body}\n${i.importRequestId ?? ''}`.toLocaleLowerCase().includes(query)) && (!input.status || i.status === input.status) && (input.platform === undefined || i.platform === input.platform))
        const offset = input.offset ?? 0; const limit = input.limit ?? 20
        return { items: rows.slice(offset, offset + limit).map(metadata), total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null }
      }
      case 'media_desk_get_item': {
        const row = await find(input.id,input.accountId); const result = { ...metadata(row), truncated: {} }; const limit = input.maxChars ?? 8000
        for (const field of input.fields ?? []) {
          if (field === 'versions') {
            const history = row.contentVersions ?? [], offset = input.versionOffset ?? 0, count = input.versionLimit ?? 20
            result.versions = { items: history.slice(offset, offset + count).map(versionMetadata), total: history.length, offset, nextOffset: offset + count < history.length ? offset + count : null }
            if (input.versionId) {
              const v = selectedVersion(row, input.versionId), json = JSON.stringify(v.content)
              result.version = { ...versionMetadata(v), content: json.length > limit ? { preview: json.slice(0, limit), encoding: 'json-fragment' } : structuredClone(v.content) }
              result.truncated.version = json.length > limit
            }
          } else if (field === 'media') {
            result.media = mediaMetadata(row.media)
          } else if (field === 'production') {
            const p = row.production
            if (!p) { result.production = null; continue }
            // Text-only snapshot. Omit internal paths, engine responses and unrelated state.
            const safe = pick(p, ['status', 'stage', 'format', 'withImages', 'title', 'coverText', 'characters', 'facts', 'outline', 'article', 'cover', 'images', 'shots'])
            for (const key of ['cover', 'images', 'shots']) {
              const asset = a => a ? pick(a, ['no', 'shot', 'seconds', 'visual', 'voice', 'caption', 'anchor', 'prompt', 'src', 'status']) : null
              if (Array.isArray(safe[key])) safe[key] = safe[key].slice(0, 24).map(asset)
              else safe[key] = asset(safe[key])
            }
            // JSON fragment is explicitly bounded and can be fetched separately from article.
            const json = JSON.stringify(safe)
            result.production = json.length > limit ? { preview: json.slice(0, limit), encoding: 'json-fragment' } : safe
            result.truncated.production = json.length > limit
          } else {
            const text = String(field === 'article' ? row.production?.article ?? row.drafts?.article?.text ?? '' : row.body ?? '')
            result[field] = text.slice(0, limit); result.truncated[field] = text.length > limit
          }
        }
        return result
      }
      case 'media_desk_import_file': {
        requireAccount(await store.read(), input.accountId)
        const avatar = input.destination === 'avatar'
        return importLocalFile({ path: input.path, filesDir: store.filesDir, imagesOnly: avatar }, async (asset, filename) => {
          let changed = false
          try {
            return await store.mutate(avatar ? '导入账号头像' : '导入本地素材', state => {
              const account = requireAccount(state, input.accountId)
              if (avatar) {
                const result = applyOps(state, [{ op: 'update_account', id: input.accountId, avatar: asset.media.src }])
                if (result.errors.length || result.receipts.length !== 1) throw invalid('Unable to set the imported account avatar.')
                account.avatarImport = { requestId, src: asset.media.src }
                changed = true
                return { destination: 'avatar', accountId: account.id, ...asset }
              }
              const result = applyOps(state, [{ op: 'add_item', accountId: input.accountId ?? null, title: input.title ?? filename, ...(input.body !== undefined ? { body: input.body } : {}), ...(input.tags !== undefined ? { tags: input.tags } : {}), kind: asset.kind, media: asset.media }])
              if (result.errors.length || result.receipts.length !== 1) throw invalid('Unable to add the imported media item.')
              const item = state.items.find(row => row.id === result.receipts[0].target)
              item.importRequestId = requestId
              changed = true
              return { id: item.id, accountId: item.accountId, title: item.title, ...asset }
            })
          } catch (error) {
            if (changed) throw Object.assign(new Error('The import commit outcome is uncertain. Inspect request status and the target item or account before any new action.'), { code: 'OUTCOME_UNKNOWN' })
            throw error
          }
        })
      }
      case 'media_desk_apply_ops': {
        const result = await store.mutate(input.label || '本地自动化', state => applyOps(state, input.ops, {accountId:input.accountId, isBusy: id => producer.isRunning(id) || producer.anyAssetActive(id)}))
        const compact = { receipts: result.receipts.map(r => ({ ...r, text: clipped(r.text, 500) })), errors: result.errors.map(e => clipped(e, 500)) }
        if (compact.errors.length) return failure('PARTIAL_FAILURE', 'Some operations failed. Successful receipts are retained; do not repeat the batch.', compact)
        return compact
      }
      case 'media_desk_assist': {
        if (!assist) return failure('UNAVAILABLE', 'Model-assisted authoring is unavailable in this Host.')
        const accountId=resolveChatScope(await store.read(),input)
        const turn = await assist({ message: input.message, ...(input.focusId ? { focusId: input.focusId } : {}), ...(accountId!==undefined?{accountId}:{}) })
        const answer = turn.answer ?? {}
        const receipts = (answer.receipts ?? []).slice(0, 100).map(r => ({ ...pick(r, ['target', 'kind']), text: clipped(r.text, 500) }))
        const errors = (answer.errors ?? []).slice(0, 100).map(e => clipped(e, 500))
        const jobs = []; const uiHints = []; const seen = new Set()
        const actions = scopedActions(await store.read(),turn.actions,accountId)
        for (const action of actions.slice(0, 100)) {
          if (action?.type === 'produce' && typeof action.id === 'string' && action.id.length <= 200 && !seen.has(action.id)) {
            seen.add(action.id)
            try { jobs.push({ id: action.id, started: await producer.start(action.id, { accountId }) }) } catch { errors.push('A requested production job could not start. Inspect the item status before further action.') }
          } else if (action?.type === 'open' && typeof action.id === 'string') uiHints.push({ type: 'open', id: action.id.slice(0, 200) })
          else if (action?.type === 'nav' && typeof action.view === 'string') uiHints.push({ type: 'nav', view: action.view.slice(0, 100) })
        }
        if (actions.length > 100) errors.push('Additional production actions were not dispatched; inspect the workbench.')
        const result = { reply: clipped(answer.text ?? '', 4000), receipts, errors, jobs, uiHints, modelUsed: Boolean(answer.engine && answer.engine !== 'local'), engine: clipped(answer.engine ?? 'local', 200), notice: clipped(answer.notice, 500) }
        return errors.length ? failure('PARTIAL_FAILURE', 'The assistant turn completed with errors. Preserve successful receipts and inspect jobs; do not repeat the turn.', result) : result
      }
      case 'media_desk_write_draft': {
        await find(input.id,input.accountId)
        if (producer.isRunning(input.id) || producer.anyAssetActive(input.id)) throw Object.assign(new Error('Production is active; cancel and wait before writing a draft.'), { code: 'BUSY' })
        await store.mutate('保存外部草稿', state => {
          const item = requireMembership(state,input.id,input.accountId)
          if (!item) throw Object.assign(new Error('Item not found.'), { code: 'NOT_FOUND' })
          assertVersionIdle(item, id => producer.isRunning(id) || producer.anyAssetActive(id))
          backupMeaningful(item, 'before_write_draft')
          const previous = item.production ?? {}
          const p = { ...previous, status: 'done', stage: 'done', format: input.format ?? previous.format ?? draftFormat(scopeState(state, normalizedAccountId(item)).draftFormat), title: input.title ?? previous.title ?? item.title, article: input.article ?? previous.article ?? '', coverText: input.coverText ?? previous.coverText ?? input.title ?? item.title, finishedAt: new Date().toISOString(), images: previous.images ?? [], cover: previous.cover ?? null, shots: previous.shots ?? [] }
          for (const key of ['characters', 'facts', 'outline']) if (input[key] !== undefined) p[key] = input[key]
          if (input.shots) p.shots = input.shots.map((shot, index) => ({ ...previous.shots?.[index], ...shot, no: index + 1 }))
          delete p.error
          for (const key of ['savedPath', 'savedAt', 'savedAccountId']) delete p[key]
          p.generationId = randomUUID()
          item.contentRevision = randomUUID()
          item.production = p
          if (input.title !== undefined) item.title = input.title
          if (item.status !== 'published') item.status = item.scheduledAt ? 'ready' : 'draft'
        })
        return { id: input.id, saved: true, modelCalls: 0 }
      }
      case 'media_desk_produce': await find(input.id,input.accountId); return { id: input.id, started: await producer.start(input.id, { accountId: input.accountId, withImages: input.withImages }) }
      case 'media_desk_production_status': return productionStatus(await find(input.id,input.accountId), producer)
      case 'media_desk_cancel_production': await find(input.id,input.accountId); await producer.cancel(input.id); return { id: input.id, cancellationRequested: true }
      case 'media_desk_regenerate_asset': await find(input.id,input.accountId); await producer.regenerate(input.id, input.target,input.accountId); return { id: input.id, target: input.target, requested: true }
      case 'media_desk_export': {
        const sealed = await sealExport(store, producer, input.id, input.accountId)
        const { renderProductionCover, validateProductionAssets } = await import('./cover.js')
        await validateProductionAssets(sealed.production, store.filesDir)
        const videoCover = await renderProductionCover(sealed.production, { filesDir: store.filesDir })
        const exportDir = resolveExportDir((await settings.read()).exportDir)
        await verifyExportTarget(store, producer, sealed)
        const saved = await saveProduction(sealed.production, { filesDir: store.filesDir, exportDir, videoCover, accountId: sealed.accountId, itemId: sealed.itemId, version: sealed.version })
        const outcome = await recordExport(store, sealed, saved)
        return { ...saved, ...outcome }
      }
      case 'media_desk_get_insights': {
        const all = computeInsights(scopeState(await store.read(),input.accountId), { platform: input.platform })
        const collections = {}, limit = 30
        const bound = (value, path = '') => {
          if (Array.isArray(value)) {
            collections[path] = { total: value.length, returned: Math.min(value.length, limit), limit, truncated: value.length > limit }
            return value.slice(0, limit).map((row, i) => bound(row, `${path}[${i}]`))
          }
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, bound(row, path ? `${path}.${key}` : key)]))
          return typeof value === 'string' ? value.slice(0, 500) : value
        }
        return { ...bound(all), collections }
      }
      case 'media_desk_list_styles': {
        const s = scopeState(await store.read(),input.accountId); const offset = input.offset ?? 0; const limit = input.limit ?? 20
        return { activeStyleId: s.activeStyleId ?? null, total: (s.styles ?? []).length, styles: (s.styles ?? []).slice(offset, offset + limit).map(row => Object.fromEntries(Object.entries(pick(row, ['id', 'name', 'icon', 'summary', 'tone', 'sentences', 'opening', 'structure', 'logic', 'story', 'flow', 'words', 'avoid', 'samples'])).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 10).map(x => clipped(x, 300)) : clipped(v, 800)]))) }
      }
      case 'media_desk_models': return models()
      case 'media_desk_request_status': {
        const status = await journal.status(input.requestId)
        return status.tool === 'media_desk_content_lab_action' && status.response ? { ...status, response: compactLabReceipt(status.response) } : status
      }
    }
  }
  return {
    async call({ tool, input = {}, requestId }) {
      const def = definitions.get(tool)
      if (!def) return failure('UNKNOWN_TOOL', 'Unknown tool.')
      if (def.mutation && readOnly) return failure('READ_ONLY', 'Mutations are disabled.', undefined, requestId)
      const args = { ...input }
      if (def.mutation) {
        if (requestId !== undefined && args.requestId !== undefined && requestId !== args.requestId) return failure('INVALID_ARGUMENT', 'Envelope and input requestId must match.', undefined, requestId)
        requestId ??= args.requestId
        args.requestId = requestId
        if (!requestId) return failure('REQUEST_ID_REQUIRED', 'Mutations require a durable requestId.')
      }
      if (!def.validate(args)) return failure('INVALID_ARGUMENT', 'Input does not match tool schema.', { path: def.validate.errors?.[0]?.instancePath, rule: def.validate.errors?.[0]?.keyword }, requestId)
      try { validateSchedule(args) } catch (e) { return failure(e.code, e.message, undefined, requestId) }
      if (def.mutation) delete args.requestId
      const invoke = async () => {
        try { const result = await dispatch(tool, args, requestId); return result?.ok === false ? result : { ok: true, result } } catch (e) {
          // Provider details/settings never leave this boundary. Known validation errors are safe.
          if (e.exportEvidence) return failure('OUTCOME_UNKNOWN', e.message, { export: e.exportEvidence })
          return failure(e.code === 'NOT_FOUND' || e.code === 'BUSY' || e.code === 'INVALID_ARGUMENT' || e.code === 'ASSET_ERROR' || ['UNAVAILABLE', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'INVALID_MODEL_RESULT'].includes(e.code) ? e.code : def.mutation ? 'OUTCOME_UNKNOWN' : 'OPERATION_FAILED', ['NOT_FOUND', 'BUSY', 'INVALID_ARGUMENT', 'ASSET_ERROR', 'UNAVAILABLE', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'INVALID_MODEL_RESULT'].includes(e.code) ? e.message : 'Operation outcome is uncertain; inspect request status and workbench state before acting.')
        }
      }
      try {
        const dispatched = def.mutation ? await journal.execute(requestId, tool, args, invoke) : await invoke()
        const response = tool === 'media_desk_content_lab_action' ? compactLabReceipt(dispatched) : dispatched
        if (tool === 'media_desk_content_lab_action' && response.error?.code === 'OUTCOME_UNKNOWN') {
          // Recovery lookup is best-effort. A lookup failure must not turn an
          // already-dispatched operation into a claim that nothing was sent.
          try {
            const records = labRecords(await store.read()).filter(r => r.requestId === requestId && r.accountId === args.accountId).slice(0, 10).map(recordMetadata)
            if (records.length) response.error.details = { contentLab: { records } }
          } catch {}
        }
        return response
      } catch { return failure('JOURNAL_ERROR', 'Unable to record mutation intent; no new dispatch was started.', undefined, requestId) }
    },
  }
}
