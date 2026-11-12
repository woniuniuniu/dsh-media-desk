import { allAccountCounts, accountCounts, normalizedAccountId, requireAccount, requireMembership, resolveChatScope, scopeState, scopedActions } from '../accounts.js'
import Ajv from 'ajv'
import { draftFormat } from '../style.js'
import { catalog, PLUGIN_VERSION, PROTOCOL_VERSION } from './catalog.js'
import { failure, invalid } from './errors.js'
import { MutationJournal } from './journal.js'
import { automationDirectory } from './paths.js'
import { applyOps } from '../ops.js'
import { computeInsights } from '../learn.js'
import { PLATFORMS } from '../platforms.js'
import { saveProduction, resolveExportDir } from '../export.js'

const ajv = new Ajv({ allErrors: false, strict: false })
const definitions = new Map(catalog.map(t => [t.name, { ...t, validate: ajv.compile(t.inputSchema) }]))
const META = ['id', 'accountId', 'title', 'kind', 'status', 'platform', 'scheduledAt', 'publishedAt', 'createdAt', 'pinned', 'tags', 'parentId']
const pick = (row, keys) => Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]))
const clipped = (v, n = 500) => typeof v === 'string' ? v.slice(0, n) : v
function metadata(row) { const out = pick(row, META); out.title = clipped(out.title, 300); out.tags = out.tags?.slice(0, 24).map(x => clipped(x, 100)); out.productionStatus = row.production?.status ?? null; return out }
function productionStatus(item, producer) {
  const p = item.production
  return { id: item.id, status: item.status, production: p ? { ...pick(p, ['status', 'stage', 'startedAt', 'finishedAt', 'savedAt', 'format', 'withImages']), title: clipped(p.title, 300), error: p.error ? 'Production failed. Inspect the workbench for details.' : null, assets: [p.cover, ...p.images ?? [], ...p.shots ?? []].filter(Boolean).map(a => ({ status: a.status, error: a.error ? 'Asset generation failed. Inspect the workbench for details.' : null })) } : null, live: pick(producer.status(item.id), ['running', 'stage']) }
}
function validateSchedule(input) {
  for (const op of input.ops ?? []) {
    if (typeof op.scheduledAt === 'string') {
      const [year, month, day] = op.scheduledAt.slice(0, 10).split('-').map(Number)
      const last = new Date(0); last.setUTCFullYear(year, month, 0)
      if (month < 1 || month > 12 || day < 1 || day > last.getUTCDate()) throw invalid('scheduledAt has an invalid calendar date.')
    }
    if (op.scheduledAt !== undefined && op.scheduledAt !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(op.scheduledAt) || Number.isNaN(Date.parse(op.scheduledAt)))) throw invalid('scheduledAt must be timezone-qualified ISO8601, or null to cancel.')
  }
}
export function createAutomationService({ store, settings, producer, assist, models = async () => ({ providers: [] }), readOnly = false, profile = 'desktop', journal = new MutationJournal(automationDirectory(store.root, profile)) }) {
  async function find(id, accountId) { const state = await store.read(); const row = state.items.find(i=>i.id===id); if(!row) throw Object.assign(new Error('Item not found.'),{code:'NOT_FOUND'}); return requireMembership(state,id,accountId) }
  async function dispatch(tool, input) {
    if (input.accountId !== undefined) requireAccount(await store.read(),input.accountId)
    switch (tool) {
      case 'media_desk_list_accounts': {
        const state=await store.read();const counts=allAccountCounts(state); const q=input.query?.toLocaleLowerCase(); const rows=state.accounts.filter(a=>(!q||`${a.handle} ${a.platform} ${a.group} ${a.id}`.toLocaleLowerCase().includes(q))&&(input.platform===undefined||a.platform===input.platform)&&(input.group===undefined||a.group===input.group)&&(input.archived===undefined||Boolean(a.archived)===input.archived));const offset=input.offset??0,limit=input.limit??20;return {accounts:rows.slice(offset,offset+limit).map(a=>({...Object.fromEntries(Object.entries(pick(a,['id','handle','platform','avatar','group','archived','defaultStyleId','draftFormat'])).map(([k,v])=>[k,clipped(v,k==='avatar'?4000:300)])),counts:counts.get(a.id)??{items:0,published:0,scheduled:0,metrics:0}})),total:rows.length,offset,nextOffset:offset+limit<rows.length?offset+limit:null}
      }
      case 'media_desk_get_account': {const state=await store.read();const a=requireAccount(state,input.id);return {...Object.fromEntries(Object.entries(pick(a,['id','handle','platform','url','avatar','group','positioning','audience','defaultStyleId','draftFormat','archived','note','followers','createdAt'])).map(([k,v])=>[k,clipped(v,4000)])),counts:accountCounts(state,a.id)} }
      case 'media_desk_status': return { protocolVersion: PROTOCOL_VERSION, pluginVersion: PLUGIN_VERSION, available: true, readOnly, supportedPlatforms: PLATFORMS }
      case 'media_desk_list_items': {
        const query = input.query?.toLocaleLowerCase()
        const rows = scopeState(await store.read(),input.accountId).items.filter(i => (!query || `${i.title}\n${i.body}`.toLocaleLowerCase().includes(query)) && (!input.status || i.status === input.status) && (input.platform === undefined || i.platform === input.platform))
        const offset = input.offset ?? 0; const limit = input.limit ?? 20
        return { items: rows.slice(offset, offset + limit).map(metadata), total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null }
      }
      case 'media_desk_get_item': {
        const row = await find(input.id,input.accountId); const result = { ...metadata(row), truncated: {} }; const limit = input.maxChars ?? 8000
        for (const field of input.fields ?? []) {
          if (field === 'production') {
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
      case 'media_desk_apply_ops': {
        const result = await store.mutate(input.label || '本地自动化', state => applyOps(state, input.ops, {accountId:input.accountId}))
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
          const previous = item.production ?? {}
          const p = { ...previous, status: 'done', stage: 'done', format: input.format ?? previous.format ?? draftFormat(scopeState(state, normalizedAccountId(item)).draftFormat), title: input.title ?? previous.title ?? item.title, article: input.article ?? previous.article ?? '', coverText: input.coverText ?? previous.coverText ?? input.title ?? item.title, finishedAt: new Date().toISOString(), images: previous.images ?? [], cover: previous.cover ?? null, shots: previous.shots ?? [] }
          for (const key of ['characters', 'facts', 'outline']) if (input[key] !== undefined) p[key] = input[key]
          if (input.shots) p.shots = input.shots.map((shot, index) => ({ ...previous.shots?.[index], ...shot, no: index + 1 }))
          delete p.error
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
        const row = structuredClone(await find(input.id,input.accountId))
        const originAccountId=normalizedAccountId(row)
        if (!row.production?.article) throw invalid('No article is available to export.')
        if (producer.isRunning(input.id) || producer.anyAssetActive(input.id)) throw Object.assign(new Error('Production is active.'), { code: 'BUSY' })
        const { renderProductionCover, validateProductionAssets } = await import('./cover.js')
        await validateProductionAssets(row.production, store.filesDir)
        const videoCover = await renderProductionCover(row.production, { filesDir: store.filesDir })
        const exportDir=resolveExportDir((await settings.read()).exportDir)
        requireMembership(await store.read(),input.id,originAccountId)
        const saved = await saveProduction(row.production, { filesDir: store.filesDir, exportDir, videoCover, accountId:originAccountId })
        await store.mutate('保存成稿', state => { const p = requireMembership(state,input.id,originAccountId).production; if (p) { p.savedPath = saved.path; p.savedAccountId = originAccountId; p.savedAt = new Date().toISOString() } }, { undoable: false })
        return saved
      }
      case 'media_desk_get_insights': {
        const all = computeInsights(scopeState(await store.read(),input.accountId), { platform: input.platform })
        // Bound every collection and strip verbose edit source material.
        return JSON.parse(JSON.stringify(all, (key, value) => Array.isArray(value) ? value.slice(0, 30) : typeof value === 'string' ? value.slice(0, 500) : value))
      }
      case 'media_desk_list_styles': {
        const s = scopeState(await store.read(),input.accountId); const offset = input.offset ?? 0; const limit = input.limit ?? 20
        return { activeStyleId: s.activeStyleId ?? null, total: (s.styles ?? []).length, styles: (s.styles ?? []).slice(offset, offset + limit).map(row => Object.fromEntries(Object.entries(pick(row, ['id', 'name', 'icon', 'summary', 'tone', 'sentences', 'opening', 'structure', 'logic', 'story', 'flow', 'words', 'avoid', 'samples'])).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 10).map(x => clipped(x, 300)) : clipped(v, 800)]))) }
      }
      case 'media_desk_models': return models()
      case 'media_desk_request_status': return journal.status(input.requestId)
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
        try { const result = await dispatch(tool, args); return result?.ok === false ? result : { ok: true, result } } catch (e) {
          // Provider details/settings never leave this boundary. Known validation errors are safe.
          return failure(e.code === 'NOT_FOUND' || e.code === 'BUSY' || e.code === 'INVALID_ARGUMENT' || e.code === 'ASSET_ERROR' ? e.code : def.mutation ? 'OUTCOME_UNKNOWN' : 'OPERATION_FAILED', ['NOT_FOUND', 'BUSY', 'INVALID_ARGUMENT', 'ASSET_ERROR'].includes(e.code) ? e.message : 'Operation outcome is uncertain; inspect request status and workbench state before acting.')
        }
      }
      try { return def.mutation ? await journal.execute(requestId, tool, args, invoke) : await invoke() } catch { return failure('JOURNAL_ERROR', 'Unable to record mutation intent; no new dispatch was started.', undefined, requestId) }
    },
  }
}
