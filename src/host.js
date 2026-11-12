// dsh-x-desk host 半片：/x-desk/* 接口、文件服务和模型调用。
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sync } from './sync.js'
import { Composer } from './compose.js'
import { extractOwnVoice, learnDaily } from './learn.js'
import { Longform } from './longform.js'
import { computeInsights } from './insights.js'
import { Exchange } from './exchange.js'
import { Lock } from './lock.js'
import { Worker, countImage, imagesUsedToday, localDay, resolveExchangeDir } from './worker.js'
import { callModel, assistantModelOverride, defaultSelection, extractJson, modelInfo, modelStatus, setAssistantModel, withTimeout } from './ai.js'
import { generateImage } from './images.js'
import { generateToolImage, imageTool } from './image-tool.js'
import { applyOps, newId } from './ops.js'
import { importVoice, setCondensed } from './voice.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { publicSettings, Settings, imageReady } from './settings.js'
import { Store } from './store.js'
import { tr } from './i18n.js'

const MAX_JSON = 4_000_000
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBuffer(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error(tr('内容太大')), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const raw = await readBuffer(req, MAX_JSON)
  if (!raw.length) return {}
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error(tr('请求不是有效的 JSON')), { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error(tr('请求内容要是一个 JSON 对象')), { status: 400 })
  return body
}

/** 外部服务（文字模型、生图）的失败带上 502，错误文字原样给界面看；其余没有状态码的错误一律按内部错误处理。 */
async function upstream(promise) {
  try {
    return await promise
  } catch (err) {
    if (!err.status) err.status = 502
    throw err
  }
}

/** 图片文件，支持按字节范围读取。 */
async function sendFile(req, res, file) {
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return json(res, 404, { error: tr('不支持的文件类型') })
  let info
  try {
    info = await stat(file)
  } catch {
    return json(res, 404, { error: tr('文件不存在') })
  }
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.setHeader('x-content-type-options', 'nosniff')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  return createReadStream(file).pipe(res)
}


function engineLabel(ctx) {
  const info = modelInfo(ctx)
  return info ? info.label : null
}

// 手动同步与后台共用当前目录的实例，避免同一交换文件夹并发同步。
function syncFor(desk, settings, store) {
  const dir = resolveExchangeDir(settings, store.root)
  if (desk.sync?.dir !== dir) desk.sync = new Sync({ dir, projectDir: fileURLToPath(new URL('../', import.meta.url)) })
  return desk.sync
}

async function route({ ctx, store, desk, callText }, req, res) {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname.replace(/^\/x-desk\/?/, '')
  const method = req.method || 'GET'

  if ((method === 'GET' || method === 'HEAD') && path.startsWith('files/')) {
    const name = path.slice('files/'.length)
    if (!/^[\w.-]+$/.test(name)) return json(res, 400, { error: tr('路径无效') })
    await store.read()
    return sendFile(req, res, join(store.filesDir, name))
  }
  if (method === 'GET') {
    if (path === 'state') {
      const state = await store.read()
      const settings = await desk.settings.read()
      const exchangeDir = resolveExchangeDir(settings, store.root)
      // ownHandle 给界面在显示时拼自己帖子的链接，存下来的数据不改
      return json(res, 200, { state, exchangeDir, ownHandle: settings.ownHandle, model: engineLabel(ctx), modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: store.undo.length > 0, composing: desk.composer.busy })
    }
    if (path === 'sync/status') {
      const settings = await desk.settings.read()
      const { runs } = await store.read()
      return json(res, 200, { ...await syncFor(desk, settings, store).status(), ...settings.sync, lastSyncAt: runs.lastSyncAt, lastSyncError: runs.lastSyncError })
    }
    if (path === 'insights') return json(res, 200, computeInsights(await store.read(), new Date(), { ownHandle: (await desk.settings.read()).ownHandle }))
    if (path === 'settings') return json(res, 200, publicSettings(await desk.settings.read(), Boolean(imageTool(ctx))))
    if (path === 'models') {
      // 列出 Harness 里已接的提供方和它们公布的模型，给工作台的助手模型选择器用
      const llm = ctx.get('llm')
      const providers = llm ? await llm.listProviders() : []
      const settled = await Promise.allSettled(providers.map(async p => ({
        provider: p.id, name: p.name,
        models: (await llm.listModels(p.id)).map(m => ({ id: m.id, name: m.name || m.id })),
      })))
      return json(res, 200, {
        providers: settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(p => p.models.length),
        default: defaultSelection(ctx),
        current: assistantModelOverride(),
      })
    }
    return json(res, 404, { error: tr('接口不存在') })
  }
  if (method !== 'POST') return json(res, 405, { error: tr('不支持的方法') })

  // 所有写操作都拒绝跨站请求
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: tr('拒绝跨站请求') })

  const body = await readJson(req)
  switch (path) {
    case 'sync/run': {
      const settings = await desk.settings.read()
      if (!settings.sync.enabled) return json(res, 400, { error: '同步还没打开' })
      const result = await desk.worker.syncNow()
      if (result.error === '上一轮同步还没结束') return json(res, 409, result)
      return json(res, 200, { ...result, status: await syncFor(desk, settings, store).status() })
    }
    case 'ops': {
      const label = typeof body.label === 'string' ? body.label : tr('操作')
      const { slots } = await desk.settings.read()
      const result = await store.mutate(label, (draft) => {
        const applied = applyOps(draft, body.ops, { now: new Date(), slots })
        return { ...applied, state: draft }
      }, { undoable: body.undoable !== false })
      return json(res, 200, { ...result, canUndo: store.undo.length > 0 })
    }
    case 'voice/import': {
      const condense = async prompts => (await callText({ ...prompts, maxTokens: 1500, light: true })).text
      return json(res, 200, { state: await importVoice({ store, callText: condense }, body) })
    }
    case 'voice/condensed': return json(res, 200, { state: await setCondensed({ store }, body) })
    case 'style/extract': {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return json(res, 400, { error: tr('先贴入要提炼的文字') })
      let reply
      try {
        reply = await callText({ ...stylePrompts(text, typeof body.name === 'string' ? body.name : ''), maxTokens: 1500, light: true })
        return json(res, 200, { style: normalizeStyle(extractJson(reply.text), body.name) })
      } catch (err) {
        return json(res, 502, { error: tr('提炼风格失败：{reason}', { reason: err.message }) })
      }
    }
    case 'voice/extract-own': {
      // 只返回风格卡，不保存；不足 10 条时 extractOwnVoice 自己抛 400
      const style = await upstream(extractOwnVoice({ callText, state: await store.read() }))
      return json(res, 200, { style })
    }
    case 'undo': {
      const label = await store.undoLast()
      return json(res, 200, { label, state: await store.read(), canUndo: store.undo.length > 0 })
    }
    case 'settings': {
      const before = modelInfo(ctx)
      const updated = await desk.settings.update(body)
      setAssistantModel(updated.assistant)
      const after = modelInfo(ctx)
      // 换了模型，上一个模型的失败状态不再算数
      if (before?.provider !== after?.provider || before?.model !== after?.model) Object.assign(modelStatus, { ok: null, error: null })
      return json(res, 200, { ...publicSettings(updated, Boolean(imageTool(ctx))), assistantEffective: modelInfo(ctx)?.label ?? null })
    }
    case 'settings/test': {
      const settings = await desk.settings.read()
      if (!imageReady(settings, Boolean(imageTool(ctx)))) return json(res, 400, { error: tr(settings.image.source === 'tool' ? '未找到订阅生图工具，或默认执行器不支持直接调用；请检查插件和执行器后刷新工作台' : '先填好接口地址、模型和密钥') })
      await store.read()
      const prompt = 'A single paper boat on calm water, black and white pencil line art sketch, plain white paper background, no text.'
      const { buffer, ext } = await upstream(settings.image.source === 'tool' ? generateToolImage(ctx, settings.image, prompt) : generateImage(settings.image, prompt))
      const name = `${newId('t')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      return json(res, 200, { src: `x-desk/files/${name}` })
    }
    case 'compose/run': {
      const busy = () => json(res, 409, { error: tr('正在出稿，请稍等'), busy: true })
      if (desk.composer.busy) return busy()
      const state = await store.read()
      if (state.runs.lastComposeDay === localDay(new Date()) && body.force !== true) return json(res, 409, { error: tr('今天已经成稿了；要再来一次请选择强制重新成稿') })
      desk.worker.noteAttempt()
      const result = await desk.composer.composeDaily({ undoable: false })
      if (result.busy) return busy()
      return json(res, 200, { ...result, state: await store.read(), composing: desk.composer.busy })
    }
    case 'candidate/revise': {
      await desk.composer.revise(body.id, { view: body.view, instruction: body.instruction, typeId: body.typeId }, { undoable: false })
      return json(res, 200, { state: await store.read() })
    }
    case 'longform/suggest': {
      const result = await desk.longform.suggest({ undoable: false })
      return json(res, 200, { ...result, state: await store.read() })
    }
    case 'longform/draft': {
      await desk.longform.draft(body.id, { undoable: false })
      return json(res, 200, { state: await store.read() })
    }
    case 'longform/revise': {
      // 改稿会替换负责人手改过的正文，所以可以撤销；初稿只填空正文，不占撤销位
      await desk.longform.revise(body.id, body.instruction, { undoable: true })
      return json(res, 200, { state: await store.read(), canUndo: store.undo.length > 0 })
    }
    case 'note/compose': {
      await desk.composer.composeFromNote(body.id, { undoable: false })
      return json(res, 200, { state: await store.read() })
    }
    case 'candidate/image': {
      const settings = await desk.settings.read()
      const state = await store.read()
      const candidate = state.candidates.find(c => c.id === body.id)
      if (!candidate) return json(res, 404, { error: tr('找不到候选稿') })
      if (candidate.status !== 'approved') return json(res, 400, { error: tr('只有已通过的候选稿才能配图') })
      if (!imageReady(settings, Boolean(imageTool(ctx)))) return json(res, 400, { error: tr('还没有配置生图：请先在设置里填好生图接口或选择订阅生图工具') })
      if (imagesUsedToday(state, new Date()) >= settings.dailyImages) return json(res, 429, { error: tr('今天的配图数量已达上限（{n} 张）', { n: settings.dailyImages }) })
      const prompt = `${candidate.text}\n\n为这条推文配一张简洁的横版插图，不要出现文字`
      const { buffer, ext } = await upstream(settings.image.source === 'tool' ? generateToolImage(ctx, settings.image, prompt) : generateImage(settings.image, prompt))
      const name = `${newId('i')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      // 配图额度不能被撤销退回，也不占用户的撤销位
      await store.mutate('配图', s => {
        const row = s.candidates.find(c => c.id === body.id)
        if (row) row.image = name
        countImage(s, new Date())
      }, { undoable: false })
      return json(res, 200, { state: await store.read() })
    }
    default: return json(res, 404, { error: tr('接口不存在') })
  }
}

/**
 * Web 服务不会替插件路由鉴权，所以每个请求都要自己走一遍 Host/Origin 和登录凭证检查。
 * 拿不到鉴权服务时一律拒绝。
 * @param {object} ctx - Cordis 上下文。
 * @param {{headers: object}} req - HTTP 请求。
 * @returns {number|undefined} 拒绝时的状态码；可以继续时为 undefined。
 */
export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

/**
 * /x-desk/* 的请求处理函数：先鉴权，再路由；出错时有状态码的错误原样返回，其余只回"内部错误"，不把本机路径等细节给浏览器。
 * @param {{ctx: object, store: object, desk: {settings: object, composer: object, worker: object}, callText: Function}} deps
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createHandler(deps) {
  return async (req, res) => {
    try {
      const rejection = requestRejection(deps.ctx, req)
      if (rejection) {
        json(res, rejection, { error: tr('未授权') })
        return
      }
      await route(deps, req, res)
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return
      }
      json(res, err.status || 500, { error: err.status ? err.message : tr('内部错误') })
    }
  }
}

export const name = 'dsh-x-desk'

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const store = new Store()
    const settings = new Settings(store.root)
    const desk = { settings }
    // 文字模型调用统一限时 2 分钟，失败带 502
    const timed = withTimeout(options => callModel(ctx, options))
    const callText = options => upstream(timed(options))
    const composer = new Composer({ store, settings, callText })
    desk.composer = composer
    desk.longform = new Longform({ store, callText })
    const worker = new Worker({
      store, settings, composer,
      lock: new Lock(join(store.root, 'worker.lock'), { ttlMs: 600_000 }),
      exchangeFor: current => new Exchange(resolveExchangeDir(current, store.root)),
      learn: { learnDaily: () => learnDaily({ store, callText, now: () => new Date() }) },
      longform: desk.longform,
      sync: { syncOnce: async () => syncFor(desk, await settings.read(), store).syncOnce() },
    })
    desk.worker = worker
    ctx.effect(() => worker.start(), 'dsh-x-desk: worker')
    // 启动时恢复用户在工作台里选过的助手模型
    settings.read().then(saved => setAssistantModel(saved.assistant)).catch(() => {})
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/x-desk',
      handler: createHandler({ ctx, store, desk, callText }),
    }), 'dsh-x-desk: /x-desk routes')
  },
}
