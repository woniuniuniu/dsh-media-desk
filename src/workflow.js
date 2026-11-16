// Shared data helpers: safe to import from both the Host and the browser.
const FORMATS = new Set(['article', 'script'])
const clone = value => value === undefined ? undefined : structuredClone(value)

export function creationFormat(item, fallback = 'script') {
  if (FORMATS.has(item?.creationFormat)) return item.creationFormat
  if (FORMATS.has(item?.production?.format)) return item.production.format
  if (item?.production) return 'script'
  if (item?.drafts?.article?.text && !item?.drafts?.script?.text) return 'article'
  if (item?.drafts?.script?.text && !item?.drafts?.article?.text) return 'script'
  return FORMATS.has(fallback) ? fallback : 'script'
}

export function productionFor(item, format) {
  if (!FORMATS.has(format)) return undefined
  const active = item?.production
  if (active && (active.format || creationFormat(item)) === format) return active
  if (item?.productions?.[format]) return item.productions[format]
  const draft = item?.drafts?.[format]
  if (typeof draft?.text === 'string' && draft.text.trim()) return {
    format, status: 'done', stage: 'done', title: item.title || '', article: draft.text,
    ...(typeof draft.aiText === 'string' ? { aiArticle: draft.aiText } : {}), legacyFromDraft: true,
  }
  return undefined
}

/** Switch the active product without destroying the other format's work. */
export function selectCreationFormat(item, format) {
  if (!FORMATS.has(format)) throw new Error('内容类型无效')
  const previous = creationFormat(item)
  const activeFormat = item.production?.format || previous
  if (item.production) {
    item.productions = { ...item.productions, [item.production.format || previous]: clone(item.production) }
  }
  if (activeFormat !== format || !item.production) {
    const target = clone(productionFor(item, format))
    if (target) item.production = target
    else delete item.production
  }
  item.creationFormat = format
  return item
}

/** A read-only workspace view. Existing articles are never silently marked confirmed. */
export function articleWorkspace(item) {
  const production = productionFor(item, 'article')
  const saved = clone(item?.articleWorkflow || {})
  const legacy = !item?.articleWorkflow && Boolean(production?.article)
  const sources = item?.body || item?.url ? [{
    id: 'initial', title: item.title || '', url: item.url || '', text: item.body || '',
    kind: 'reference', verified: false,
  }] : []
  return {
    revision: 0, stage: legacy ? 'writing' : 'sources', sources,
    sourcesConfirmed: false,
    pointConfirmed: false, outlineConfirmed: false,
    draftFinalized: false, draftStale: false, imagesStale: false,
    legacy, draftHistory: [], imageHistory: [], imagesPlanned: false,
    ...saved,
    point: { thesis: '', audience: '', boundary: '', ...saved.point },
    outline: { title: '', text: '', ...saved.outline },
  }
}

/** Explicit text edits revoke finalization and image readiness, while retaining all assets. */
export function markArticleDraftChanged(item) {
  if (creationFormat(item) !== 'article') return null
  const workspace = articleWorkspace(item)
  item.articleWorkflow = {
    ...workspace, revision: workspace.revision + 1, stage: 'writing', draftFinalized: false,
    draftStale: Boolean(workspace.draftStale && !(workspace.sourcesConfirmed && workspace.pointConfirmed && workspace.outlineConfirmed)), imagesPlanned: false,
    imagesStale: Boolean(workspace.imagesStale || item.production?.cover || item.production?.images?.length),
  }
  return item.articleWorkflow
}
