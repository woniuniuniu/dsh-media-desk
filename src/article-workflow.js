// Article creation is a sequence of explicit, saved decisions; video production stays separate.
import { randomUUID } from 'node:crypto'
import { articleImagesPrompts, articleOutlinePrompts, articlePointPrompts, articleWritePrompts, extractJson } from './ai.js'
import { normalizeMentions } from './mentions.js'
import { articleWorkspace, creationFormat, markArticleDraftChanged, productionFor } from './workflow.js'
import { tr } from './i18n.js'

const AI_ACTIONS = new Set(['suggest_point', 'suggest_outline', 'write', 'plan_images'])
const ACTIONS = new Set(['save_sources', 'confirm_sources', 'save_point', 'suggest_point', 'confirm_point', 'save_outline', 'suggest_outline', 'confirm_outline', 'write', 'save_draft', 'finalize', 'plan_images', 'generate_images'])
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
  if (['suggest_point', 'confirm_point'].includes(action) && !workspace.sourcesConfirmed) throw failure('请先确认资料与出处')
  if (action === 'confirm_point' && !workspace.point.thesis.trim()) throw failure('请先明确本篇观点')
  if (['suggest_outline', 'confirm_outline'].includes(action) && !workspace.pointConfirmed) throw failure('请先确认观点')
  if (action === 'confirm_outline' && (!workspace.outline.title.trim() || !workspace.outline.text.trim())) throw failure('请先保存标题和提纲')
  if (action === 'write' && !(workspace.sourcesConfirmed && workspace.pointConfirmed && workspace.outlineConfirmed)) throw failure('请先依次确认资料、观点和提纲，再写全文')
  if (action === 'finalize' && (!item.production?.article?.trim() || workspace.draftStale)) throw failure('请先修改并保存正文，再确认定稿')
  if (['plan_images', 'generate_images'].includes(action) && (!workspace.draftFinalized || workspace.draftStale || !item.production?.article?.trim())) throw failure('请先确认正文定稿，再规划或生成配图')
  if (action === 'generate_images' && (!workspace.imagesPlanned || workspace.imagesStale)) throw failure('请先根据当前定稿规划配图')
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
  const body = String(value ?? '').trim()
  if (!body) throw failure('正文不能为空')
  if (body.length > 200000) throw failure('正文超过长度限制')
  const previous = productionFor(item, 'article')
  if (previous?.article !== body || previous?.title !== title) saveDraftHistory(workspace, previous)
  workspace.draftStale = false
  const references = normalizeMentions(mentions)
  item.production = { ...item.production, format: 'article', status: 'done', stage: 'done', title: title || item.production?.title || item.title, article: body, ...(ai ? { aiArticle: body, engine: 'model' } : {}), mentions: references.length ? references : normalizeMentions(item.production?.mentions) }
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
      const prompts = action === 'suggest_point' ? articlePointPrompts(snapshot, item, workspace, options)
        : action === 'suggest_outline' ? articleOutlinePrompts(snapshot, item, workspace, options)
          : action === 'write' ? articleWritePrompts(snapshot, item, workspace, options)
            : articleImagesPrompts(snapshot, item, workspace, options)
      const result = await this.model({ ...prompts, maxTokens: action === 'write' ? 6000 : 2400, light: action !== 'write' }, action === 'write' ? 240000 : 90000)
      let value
      if (action === 'write') {
        if (typeof result.text !== 'string' || !result.text.trim()) throw failure('模型没有返回正文', 502)
        value = { text: result.text.replace(/^\s*#\s+.*\n?/, '').trim(), title: workspace.outline.title, model: result.model }
      } else {
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
        if (action === 'write') saveDraftHistory(workspace, { title: candidate.title, article: candidate.text }, { candidate: true, sourceRevision: revision })
        workspace.revision += 1
        item.articleWorkflow = workspace
        state.items[index] = item
        return { state, workflow: clone(workspace), stale: true }
      }
      assertAvailable(item)
      assertGate(action, workspace, item)
      item.creationFormat = 'article'
      if (action === 'save_sources') {
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
      } else if (action === 'write' || action === 'save_draft') {
        const title = text(data.title, 160) || item.production?.title || workspace.outline.title || item.title
        writeDraft(item, workspace, data.text, title, { ai: action === 'write', mentions })
        if (action === 'write') item.production.engine = data.model || 'model'
        state.items[index] = item
        return { state, workflow: articleWorkspace(item) }
      } else if (action === 'finalize') {
        workspace.draftFinalized = true
        workspace.stage = 'images'
      } else if (action === 'plan_images') {
        if (item.production.cover || item.production.images?.length) workspace.imageHistory = [...workspace.imageHistory || [], { id: randomUUID(), at: new Date().toISOString(), revision, cover: clone(item.production.cover), images: clone(item.production.images || []) }].slice(-5)
        item.production.cover = data.cover
        item.production.images = data.images
        workspace.imagesPlanned = true
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
