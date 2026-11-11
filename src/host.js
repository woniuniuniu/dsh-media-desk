// dsh-x-desk host 半片：/x-desk/* 接口、文件服务和模型调用。
import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Composer } from './compose.js'
import { Exchange } from './exchange.js'
import { Lock } from './lock.js'
import { Worker, countImage, imagesUsedToday, localDay, resolveExchangeDir } from './worker.js'
import { callModel, assistantModelOverride, defaultSelection, extractJson, modelInfo, modelStatus, setAssistantModel } from './ai.js'
import { generateImage } from './images.js'
import { generateToolImage, imageTool } from './image-tool.js'
import { applyOps, newId } from './ops.js'
import { importVoice, setCondensed } from './voice.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { publicSettings, Settings, imageReady } from './settings.js'
import { Store } from './store.js'
import { tr } from './i18n.js'

const MAX_JSON = 4_000_000
const MAX_UPLOAD = 25_000_000
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
const UPLOAD_EXT = Object.fromEntries(Object.entries(MIME).filter(([ext]) => ext !== '.jpeg').map(([ext, type]) => [type, ext]))

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
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error(tr('请求不是有效的 JSON')), { status: 400 })
  }
}

/** 支持 Range，视频才能正常拖动和循环。 */
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

async function handleUpload(req, store, res) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = UPLOAD_EXT[type]
  if (!ext) return json(res, 415, { error: tr('不支持这种文件：{type}', { type: type || tr('未知') }) })
  const buffer = await readBuffer(req, MAX_UPLOAD)
  await store.read()
  const name = `${newId('f')}${ext}`
  await writeFile(join(store.filesDir, name), buffer)
  return json(res, 200, { src: `x-desk/files/${name}` })
}

async function route(ctx, store, desk, req, res) {
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
      const exchangeDir = resolveExchangeDir(await desk.settings.read(), store.root)
      return json(res, 200, { state, exchangeDir, model: engineLabel(ctx), modelOk: modelStatus.ok, modelError: modelStatus.error, canUndo: store.undo.length > 0 })
    }
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

  if (path === 'upload') return handleUpload(req, store, res)
  const body = await readJson(req)
  switch (path) {
    case 'ops': {
      const label = typeof body.label === 'string' ? body.label : tr('操作')
      const { slots } = await desk.settings.read()
      const result = await store.mutate(label, (draft) => {
        const applied = applyOps(draft, body.ops, { now: new Date(), slots })
        return { ...applied, state: draft }
      }, { undoable: body.undoable !== false })
      return json(res, 200, result)
    }
    case 'voice/import': {
      const callText = async prompts => (await callModel(ctx, { ...prompts, maxTokens: 1500, light: true })).text
      return json(res, 200, { state: await importVoice({ store, callText }, body) })
    }
    case 'voice/condensed': return json(res, 200, { state: await setCondensed({ store }, body) })
    case 'style/extract': {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return json(res, 400, { error: tr('先贴入要提炼的文字') })
      let reply
      try {
        reply = await callModel(ctx, { ...stylePrompts(text, typeof body.name === 'string' ? body.name : ''), maxTokens: 1500, light: true })
        return json(res, 200, { style: normalizeStyle(extractJson(reply.text), body.name) })
      } catch (err) {
        return json(res, 502, { error: tr('提炼风格失败：{reason}', { reason: err.message }) })
      }
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
      const { buffer, ext } = await (settings.image.source === 'tool' ? generateToolImage(ctx, settings.image, prompt) : generateImage(settings.image, prompt))
      const name = `${newId('t')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      return json(res, 200, { src: `x-desk/files/${name}` })
    }
    case 'compose/run': {
      const state = await store.read()
      if (state.runs.lastComposeDay === localDay(new Date()) && body.force !== true) return json(res, 409, { error: tr('今天已经成稿了；要再来一次请选择强制重新成稿') })
      desk.worker.noteAttempt()
      const result = await desk.composer.composeDaily({ undoable: false })
      return json(res, 200, { ...result, state: await store.read() })
    }
    case 'candidate/revise': {
      await desk.composer.revise(body.id, { view: body.view, instruction: body.instruction, typeId: body.typeId }, { undoable: false })
      return json(res, 200, { state: await store.read() })
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
      const { buffer, ext } = await (settings.image.source === 'tool' ? generateToolImage(ctx, settings.image, prompt) : generateImage(settings.image, prompt))
      const name = `${newId('i')}${ext}`
      await writeFile(join(store.filesDir, name), buffer)
      await store.mutate('配图', s => {
        const row = s.candidates.find(c => c.id === body.id)
        if (row) row.image = name
        countImage(s, new Date())
      })
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

export const name = 'dsh-x-desk'

export default {
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const store = new Store()
    const settings = new Settings(store.root)
    const desk = { settings }
    const composer = new Composer({ store, settings, callText: options => callModel(ctx, options) })
    desk.composer = composer
    const worker = new Worker({
      store, settings, composer,
      lock: new Lock(join(store.root, 'worker.lock'), { ttlMs: 600_000 }),
      exchangeFor: current => new Exchange(resolveExchangeDir(current, store.root)),
    })
    desk.worker = worker
    ctx.effect(() => worker.start(), 'dsh-x-desk: worker')
    // 启动时恢复用户在工作台里选过的助手模型
    settings.read().then(saved => setAssistantModel(saved.assistant)).catch(() => {})
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/x-desk',
      handler: async (req, res) => {
        try {
          const rejection = requestRejection(ctx, req)
          if (rejection) {
            json(res, rejection, { error: tr('未授权') })
            return
          }
          await route(ctx, store, desk, req, res)
        } catch (err) {
          if (res.headersSent) {
            res.end()
            return
          }
          json(res, err.status || 500, { error: err.message })
        }
      },
    }), 'dsh-x-desk: /x-desk routes')
  },
}
