// Article edits produce a reviewable candidate; only accepting it changes the document.
import { createHash, randomUUID } from 'node:crypto'
import { articleImagesPrompts, articleOutlinePrompts, articlePointPrompts, articleSelectionPrompts, articleWritePrompts, extractJson } from './ai.js'
import { normalizeMentions } from './mentions.js'
import { articleWorkspace, creationFormat, markArticleDraftChanged, productionFor } from './workflow.js'
import { tr } from './i18n.js'

const AI_ACTIONS = new Set(['suggest_point', 'suggest_outline', 'generate_draft', 'rewrite_selection', 'plan_images'])
const ACTIONS = new Set(['save_sources', 'confirm_sources', 'save_point', 'suggest_point', 'confirm_point', 'save_outline', 'suggest_outline', 'confirm_outline', 'write', 'generate_draft', 'rewrite_selection', 'accept_candidate', 'discard_candidate', 'save_draft', 'finalize', 'plan_images', 'generate_images'])
const clone = value => structuredClone(value)
const failure = (message, status = 400) => Object.assign(new Error(tr(message)), { status })
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : ''

function sourcesFrom(rows) {
  if (!Array.isArray(rows) || rows.length > 20) throw failure('资料最多保存 20 条')
  return rows.map((row, index) => {
    const url = text(row?.url, 2048)
    if (url) {
      let parsed
      try { parsed = new URL(url) } catch { throw failure('资料链接无效') }
      if (!['https:', 'http:'].includes(parsed.protocol)) throw failure('资料链接必须使用 http 或 https')
    }
    return { id: text(row?.id, 100) || `source_${index + 1}`, title: text(row?.title, 160), url, text: text(row?.text, 20000), kind: row?.kind === 'personal' ? 'personal' : 'reference', verified: row?.verified === true }
  })
}

function pointFrom(value) {
  return { thesis: text(value?.thesis), audience: text(value?.audience, 1000), boundary: text(value?.boundary, 1000) }
}

function outlineFrom(value) {
  return { title: text(value?.title, 160), text: text(value?.text, 12000) }
}

function assertAvailable(item) {
  if (item.production?.status === 'running' || [item.production?.cover, ...item.production?.images || [], ...item.production?.shots || []].some(row => row?.status === 'running')) throw failure('正在生成内容或图片，请等待完成后再修改', 409)
}

function assertGate(action, workspace, item) {
  if (['confirm_sources'].includes(action) && !workspace.sources.some(row => row.text?.trim())) throw failure('先保存至少一条资料摘录或亲身经历')
  if (action === 'confirm_point' && !workspace.point.thesis.trim()) throw failure('请先明确本篇观点')
  if (action === 'confirm_outline' && (!workspace.outline.title.trim() || !workspace.outline.text.trim())) throw failure('请先保存标题和提纲')
  if (['finalize', 'plan_images', 'generate_images'].includes(action) && !productionFor(item, 'article')?.article?.trim()) throw failure('请先写入文章正文')
  if (action === 'generate_images' && (!workspace.imagesPlanned || workspace.imagesStale || workspace.imagePlanTextHash !== documentHash(item))) throw failure('请先根据当前正文规划配图')
}

const documentText = item => productionFor(item, 'article')?.article || ''
const documentHash = item => createHash('sha256').update(documentText(item)).digest('hex')

function selectionFrom(item, value) {
  const body = documentText(item), start = value?.start, end = value?.end
  const boundary = position => !(position > 0 && position < body.length && /[\uD800-\uDBFF]/.test(body[position - 1]) && /[\uDC00-\uDFFF]/.test(body[position]))
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length || !boundary(start) || !boundary(end)) throw failure('请选择正文中有效的文本范围')
  if (typeof value?.text !== 'string' || !value.text.trim() || body.slice(start, end) !== value.text) throw failure('选中文本与当前正文不一致，请重新选择', 409)
  return { start, end, text: value.text }
}

function invalidate(workspace, item, from) {
  if (from === 'sources') workspace.sourcesConfirmed = false
  if (from === 'sources' || from === 'point') workspace.pointConfirmed = false
  workspace.outlineConfirmed = false
  workspace.draftFinalized = false
  workspace.imagesPlanned = false
  workspace.draftStale = Boolean(item.production?.article)
  workspace.imagesStale = Boolean(item.production?.cover || item.production?.images?.length || workspace.imagesStale)
  workspace.stage = from
}

function saveDraftHistory(workspace, production, extra = {}) {
  if (!production?.article?.trim()) return
  const version = { id: randomUUID(), at: new Date().toISOString(), title: production.title || '', text: production.article, revision: workspace.revision, ...extra }
  workspace.draftHistory = [...workspace.draftHistory || [], version].slice(-8)
}

function writeDraft(item, workspace, value, title, { ai = false, mentions = [] } = {}) {
  if (typeof value !== 'string') throw failure('正文必须是文本')
  const body = value
  if (body.length > 200000) throw failure('正文超过长度限制')
  const previous = productionFor(item, 'article')
  if (previous?.article !== body || previous?.title !== title) saveDraftHistory(workspace, previous)
  workspace.draftStale = false
  const references = normalizeMentions(mentions)
  item.production = { ...previous, ...item.production, format: 'article', status: 'done', stage: 'done', title, article: body, ...(ai ? { aiArticle: body, engine: 'model' } : {}), mentions: references.length ? references : normalizeMentions(previous?.mentions) }
  item.articleWorkflow = workspace
  markArticleDraftChanged(item)
  if (['idea', 'outline'].includes(item.status)) item.status = 'draft'
}

function normalizeImagePlan(value, count) {
  const image = (row, role) => ({ prompt: text(row?.prompt, 2000), alt: text(row?.alt || row?.caption, 240), role, status: 'idle', ...(role === 'figure' ? { caption: text(row?.caption, 160), anchor: text(row?.anchor, 160) } : {}) })
  const plannedCover = image(value?.cover, 'cover')
  const cover = plannedCover.prompt ? plannedCover : null
  const images = (Array.isArray(value?.images) ? value.images : []).slice(0, count).map(row => image(row, 'figure')).filter(row => row.prompt)
  if (!cover && !images.length) throw failure('模型没有返回可用的文章配图方案', 502)
  return { cover, images }
}

export class ArticleWorkflow {
  constructor({ store, settings, callText, renderAsset, ready }) {
    this.store = store
    this.settings = settings
    this.callText = callText
    this.renderAsset = renderAsset
    this.ready = ready
    this.jobs = new Set()
  }

  isBusy(id) { return this.jobs.has(id) }

  async model(request, timeout) {
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        this.callText({ ...request, signal: controller.signal }),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(failure('模型处理超时，已保存的内容保持不变', 504)) }, timeout)
        }),
      ])
    } catch (error) {
      if (!error.status) error.status = 502
      throw error
    } finally { clearTimeout(timer) }
  }

  async act(id, action, { data = {}, expectedRevision, context = '', mentions = [] } = {}) {
    if (!ACTIONS.has(action)) throw failure('文章步骤无效')
    if (action === 'write') action = 'generate_draft'
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure('请提供当前文章版本')
    const snapshot = clone(await this.store.read())
    const item = snapshot.items.find(row => row.id === id)
    if (!item) throw failure('找不到这条内容', 404)
    if (creationFormat(item, snapshot.draftFormat) !== 'article') throw failure('请先切换到文章创作', 409)
    const workspace = articleWorkspace(item)
    if (workspace.revision !== expectedRevision) throw failure('内容已更新，请刷新后再试', 409)
    assertAvailable(item)
    assertGate(action, workspace, item)
    if ((AI_ACTIONS.has(action) || action === 'generate_images') && this.isBusy(id)) throw failure('这篇文章正在处理，请等待完成', 409)
    if (!AI_ACTIONS.has(action) && action !== 'generate_images') return this.commit(id, action, expectedRevision, data, mentions)

    this.jobs.add(id)
    try {
      const settings = await this.settings.read()
      if (action === 'generate_images') {
        if (!this.ready?.(settings)) throw failure('请先接入生图模型')
        // Claim this exact revision before starting asynchronous asset jobs.
        const result = await this.commit(id, action, expectedRevision, {}, mentions)
        const production = result.state.items.find(row => row.id === id).production
        const targets = [...(production.cover?.prompt ? ['cover'] : []), ...production.images.map((_, index) => `image:${index}`)]
        if (!targets.length) throw failure('当前没有可生成的配图')
        await Promise.all(targets.map(target => this.renderAsset(id, target)))
        return { state: await this.store.read(), workflow: result.workflow, started: targets }
      }
      const options = { context, voice: settings.voice, imageCount: settings.imageCount }
      if (action === 'generate_draft' || action === 'rewrite_selection') {
        if (data.instruction !== undefined && typeof data.instruction !== 'string') throw failure('写作要求必须是文本')
        if (typeof data.instruction === 'string' && data.instruction.length > 12000) throw failure('写作要求超过长度限制')
        const instruction = text(data.instruction, 12000) || (action === 'rewrite_selection' ? '改进选中的这段文字。' : `根据选题「${item.title || ''}」写一篇文章。`)
        const selection = action === 'rewrite_selection' ? selectionFrom(item, data.selection) : undefined
        const prompts = selection
          ? articleSelectionPrompts(snapshot, item, { ...options, instruction, selection })
          : articleWritePrompts(snapshot, item, workspace, { ...options, instruction, title: data.title })
        const result = await this.model({ ...prompts, maxTokens: 6000 }, 240000)
        if (typeof result?.text !== 'string' || !selection && !result.text.trim()) throw failure('模型没有返回正文', 502)
        let body = result.text, title
        if (!selection) {
          const heading = /^\s*#\s+([^\n]+)\n?/.exec(body)
          title = text(data.title, 160) || text(heading?.[1], 160) || productionFor(item, 'article')?.title || item.title
          body = (heading ? body.slice(heading[0].length) : body).trim()
          if (!body) throw failure('模型没有返回正文', 502)
        }
        if (body.length > 200000) throw failure('模型返回的正文超过长度限制', 502)
        if (selection && documentText(item).length - (selection.end - selection.start) + body.length > 200000) throw failure('修改后的正文超过长度限制', 502)
        const candidate = { id: randomUUID(), kind: selection ? 'selection' : 'draft', text: body, ...(title !== undefined ? { title } : {}), instruction, baseRevision: expectedRevision, baseTextHash: documentHash(item), ...(selection ? { selection } : {}), mentions: normalizeMentions(mentions), at: new Date().toISOString(), status: 'pending' }
        return await this.saveCandidate(id, candidate, result.model)
      }
      const prompts = action === 'suggest_point' ? articlePointPrompts(snapshot, item, workspace, options)
        : action === 'suggest_outline' ? articleOutlinePrompts(snapshot, item, workspace, options)
          : articleImagesPrompts(snapshot, item, workspace, options)
      const result = await this.model({ ...prompts, maxTokens: 2400, light: true }, 90000)
      let value
      {
        let parsed
        try { parsed = extractJson(result.text) } catch { throw failure('模型返回的步骤内容无效，原内容保持不变', 502) }
        value = action === 'suggest_point' ? { point: pointFrom(parsed.point || parsed) }
          : action === 'suggest_outline' ? { outline: outlineFrom(parsed.outline || parsed) }
            : normalizeImagePlan(parsed, Math.max(0, Math.min(4, settings.imageCount ?? 2)))
        if (action === 'suggest_point' && !value.point.thesis) throw failure('模型没有返回有效观点', 502)
        if (action === 'suggest_outline' && (!value.outline.title || !value.outline.text)) throw failure('模型没有返回有效提纲', 502)
      }
      return await this.commit(id, action, expectedRevision, value, mentions, { candidate: value })
    } finally { this.jobs.delete(id) }
  }

  async saveCandidate(id, candidate, engine) {
    const result = await this.store.mutate('保存文章修改建议', state => {
      const index = state.items.findIndex(row => row.id === id)
      if (index < 0) throw failure('找不到这条内容', 404)
      const item = clone(state.items[index]), workspace = articleWorkspace(item)
      const stale = workspace.revision !== candidate.baseRevision || creationFormat(item, state.draftFormat) !== 'article' || documentHash(item) !== candidate.baseTextHash
      if (stale) candidate = { ...candidate, stale: true }
      workspace.editCandidates = [...workspace.editCandidates || [], clone(candidate)].slice(-8)
      item.articleWorkflow = workspace
      state.items[index] = item
      state.chat = [...state.chat || [],
        { id: randomUUID(), at: candidate.at, role: 'user', text: candidate.instruction, itemId: id, ...(candidate.mentions.length ? { mentions: candidate.mentions } : {}) },
        { id: randomUUID(), at: candidate.at, role: 'assistant', text: tr(stale ? '基于旧版正文的建议已保存，现稿保持不变。' : '修改建议已就绪，尚未替换正文。'), engine: engine || 'model', itemId: id },
      ].slice(-300)
      return { state, workflow: clone(workspace), candidate: clone(candidate), ...(stale ? { stale: true } : {}) }
    }, { undoable: false })
    if (result.stale) throw Object.assign(failure('生成期间正文已有修改，建议已保留，请重新生成', 409), result)
    return result
  }

  async commit(id, action, revision, data, mentions, { candidate } = {}) {
    const result = await this.store.mutate('文章创作步骤', state => {
      const index = state.items.findIndex(row => row.id === id)
      if (index < 0) throw failure('找不到这条内容', 404)
      const item = clone(state.items[index]), workspace = articleWorkspace(item)
      const stale = workspace.revision !== revision || creationFormat(item, state.draftFormat) !== 'article'
      if (stale) {
        if (!candidate) throw failure('内容已更新，请刷新后再试', 409)
        // Preserve a late model result as a candidate, never as the current user's draft.
        const record = { id: randomUUID(), at: new Date().toISOString(), action, data: candidate, sourceRevision: revision }
        workspace.candidateHistory = [...workspace.candidateHistory || [], record].slice(-4)
        workspace.revision += 1
        item.articleWorkflow = workspace
        state.items[index] = item
        return { state, workflow: clone(workspace), stale: true }
      }
      assertAvailable(item)
      assertGate(action, workspace, item)
      item.creationFormat = 'article'
      if (action === 'accept_candidate' || action === 'discard_candidate') {
        const candidate = workspace.editCandidates.find(row => row.id === data.candidateId)
        if (!candidate) throw failure('找不到这条修改建议', 404)
        if (candidate.status !== 'pending') throw failure('这条修改建议已经处理过', 409)
        if (action === 'discard_candidate') {
          candidate.status = 'discarded'
          item.articleWorkflow = workspace
          state.items[index] = item
          return { state, workflow: clone(workspace), candidate: clone(candidate) }
        }
        if (candidate.stale || candidate.baseRevision !== workspace.revision || candidate.baseTextHash !== documentHash(item)) throw failure('正文已经变化，请重新生成修改建议', 409)
        let body = candidate.text
        if (candidate.kind === 'selection') {
          const selection = selectionFrom(item, candidate.selection), current = documentText(item)
          body = current.slice(0, selection.start) + candidate.text + current.slice(selection.end)
        }
        const title = candidate.kind === 'draft' ? candidate.title : productionFor(item, 'article')?.title || item.title
        candidate.status = 'accepted'
        writeDraft(item, workspace, body, title ?? item.title, { ai: true, mentions: candidate.mentions })
        state.items[index] = item
        return { state, workflow: articleWorkspace(item), candidate: clone(candidate) }
      } else if (action === 'save_sources') {
        const sources = sourcesFrom(data.sources)
        if (!equal(sources, workspace.sources)) { workspace.sources = sources; invalidate(workspace, item, 'sources') }
      } else if (action === 'confirm_sources') {
        workspace.sourcesConfirmed = true
        workspace.stage = 'point'
      } else if (action === 'save_point' || action === 'suggest_point') {
        const point = pointFrom(data.point || data)
        if (!equal(point, workspace.point)) { workspace.point = point; invalidate(workspace, item, 'point') }
      } else if (action === 'confirm_point') {
        workspace.pointConfirmed = true
        workspace.stage = 'outline'
      } else if (action === 'save_outline' || action === 'suggest_outline') {
        const outline = outlineFrom(data.outline || data)
        if (!equal(outline, workspace.outline)) { workspace.outline = outline; invalidate(workspace, item, 'outline') }
      } else if (action === 'confirm_outline') {
        workspace.outlineConfirmed = true
        workspace.stage = 'writing'
      } else if (action === 'save_draft') {
        if (typeof data.title === 'string' && data.title.length > 200) throw failure('文章标题超过长度限制')
        const title = typeof data.title === 'string' ? data.title : productionFor(item, 'article')?.title || item.title
        const previous = productionFor(item, 'article')
        if (item.production && previous?.article === data.text && previous?.title === title) return { state, workflow: clone(workspace) }
        writeDraft(item, workspace, data.text, title, { mentions })
        state.items[index] = item
        return { state, workflow: articleWorkspace(item) }
      } else if (action === 'finalize') {
        workspace.draftFinalized = true
        workspace.stage = 'images'
      } else if (action === 'plan_images') {
        if (!item.production) item.production = clone(productionFor(item, 'article'))
        if (item.production.cover || item.production.images?.length) workspace.imageHistory = [...workspace.imageHistory || [], { id: randomUUID(), at: new Date().toISOString(), revision, cover: clone(item.production.cover), images: clone(item.production.images || []) }].slice(-5)
        item.production.cover = data.cover
        item.production.images = data.images
        workspace.imagesPlanned = true
        workspace.imagePlanTextHash = documentHash(item)
        workspace.imagesStale = false
        workspace.stage = 'images'
      } else if (action === 'generate_images') {
        if (!item.production.cover?.prompt && !item.production.images?.some(row => row.prompt)) throw failure('当前没有可生成的配图')
        workspace.stage = 'images'
      }
      workspace.revision += 1
      item.articleWorkflow = workspace
      state.items[index] = item
      return { state, workflow: clone(workspace) }
    })
    if (result.stale) throw Object.assign(failure('生成期间内容已有修改；结果已存为候选，请刷新后查看', 409), result)
    return result
  }
}
