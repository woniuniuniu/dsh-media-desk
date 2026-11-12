// 工作台设置。密钥和内容数据分开存放，文件权限 600，也不会返回给浏览器。
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tr } from './i18n.js'
import { dshHome } from './store.js'

const DEFAULTS = {
  image: { source: 'http', baseUrl: '', model: '', apiKey: '', size: '1536x1024', quality: '', toolSize: '1536x1024', toolQuality: '', extra: '' },
  // 助手文字模型：空对象表示跟随 DeepSeek Harness 默认模型
  assistant: { provider: '', model: '' },
  sync: { enabled: false, intervalSec: 120 },
  exchangeDir: '',
  ownHandle: '',
  composeAt: '07:00',
  slots: ['09:00', '12:30', '18:00', '21:00', '22:30'],
  dailyCandidates: 7,
  dailyImages: 3,
}

/** 只取 defaults 里有的字段，旧版本留下的字段一律丢掉。 */
function known(defaults, saved) {
  const source = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  return Object.fromEntries(Object.keys(defaults).map(key => [key, source[key] !== undefined ? source[key] : structuredClone(defaults[key])]))
}

/** 原版插件的数据目录（本插件绝不读写它），交换文件夹不能设在它里面。 */
function insideOldPluginDir(dir) {
  const rel = relative(join(dshHome(), 'media-desk'), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function checkTime(value, label) {
  if (typeof value !== 'string' || !TIME.test(value)) throw Object.assign(new Error(tr('{label}要写成 HH:MM，比如 07:00', { label })), { status: 400 })
  return value
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export class Settings {
  constructor(root) {
    this.file = join(root, 'settings.json')
    this.value = null
  }

  async read() {
    // 每次都读文件：桌面版和 Web 版可能同时运行
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'))
      this.value = { ...known(DEFAULTS, saved), image: known(DEFAULTS.image, saved?.image), assistant: known(DEFAULTS.assistant, saved?.assistant), sync: known(DEFAULTS.sync, saved?.sync) }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      this.value = structuredClone(DEFAULTS)
    }
    return this.value
  }

  /** 空密钥表示不修改，clearKey 才会删除。 */
  async update(patch) {
    const current = await this.read()
    const next = structuredClone(current)
    const image = patch.image ?? {}
    if (image.source !== undefined) {
      if (!['http', 'tool'].includes(image.source)) throw Object.assign(new Error(tr('生图来源无效')), { status: 400 })
      next.image.source = image.source
    }
    for (const key of ['model', 'size', 'quality']) {
      if (typeof image[key] === 'string') next.image[key] = image[key].trim().slice(0, 200)
    }
    for (const [key, values, message] of [
      ['toolSize', ['', '1024x1024', '1024x1536', '1536x1024', 'auto'], '订阅生图工具不支持这个尺寸'],
      ['toolQuality', ['', 'low', 'medium', 'high', 'auto'], '订阅生图工具不支持这个质量'],
    ]) {
      if (image[key] !== undefined) {
        if (typeof image[key] !== 'string' || !values.includes(image[key].trim())) throw Object.assign(new Error(tr(message)), { status: 400 })
        next.image[key] = image[key].trim()
      }
    }
    if (typeof image.baseUrl === 'string') {
      const url = image.baseUrl.trim().replace(/\/+$/, '').replace(/\/images\/generations$/, '')
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error(tr('接口地址要以 http:// 或 https:// 开头')), { status: 400 })
      next.image.baseUrl = url
    }
    if (typeof image.extra === 'string') {
      const extra = image.extra.trim()
      if (extra) {
        let parsed
        try {
          parsed = JSON.parse(extra)
        } catch {
          parsed = null
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error(tr('附加参数要是一个 JSON 对象')), { status: 400 })
      }
      next.image.extra = extra
    }
    if (typeof image.apiKey === 'string' && image.apiKey.trim()) next.image.apiKey = image.apiKey.trim()
    if (image.clearKey === true) next.image.apiKey = ''
    if (patch.assistant && typeof patch.assistant === 'object') {
      const provider = typeof patch.assistant.provider === 'string' ? patch.assistant.provider.trim().slice(0, 200) : ''
      const model = typeof patch.assistant.model === 'string' ? patch.assistant.model.trim().slice(0, 200) : ''
      // provider 和 model 要么都填（指定模型），要么都空（跟随默认）
      if (Boolean(provider) !== Boolean(model)) throw Object.assign(new Error(tr('助手模型的提供方和模型要一起填')), { status: 400 })
      next.assistant = { provider, model }
    }
    if (patch.sync?.enabled !== undefined) {
      if (typeof patch.sync.enabled !== 'boolean') throw Object.assign(new Error('同步开关必须是布尔值'), { status: 400 })
      next.sync.enabled = patch.sync.enabled
    }
    if (patch.sync?.intervalSec !== undefined) next.sync.intervalSec = clamp(patch.sync.intervalSec, 60, 3600, current.sync.intervalSec)
    if (patch.exchangeDir !== undefined) {
      const dir = typeof patch.exchangeDir === 'string' ? patch.exchangeDir.trim() : null
      if (dir === null || dir.length > 500 || (dir && !isAbsolute(dir))) throw Object.assign(new Error(tr('交换文件夹要留空，或填一个绝对路径')), { status: 400 })
      if (dir && insideOldPluginDir(dir)) throw Object.assign(new Error(tr('交换文件夹不能放在原版插件的数据目录里')), { status: 400 })
      next.exchangeDir = dir
    }
    if (patch.ownHandle !== undefined) {
      const handle = typeof patch.ownHandle === 'string' ? patch.ownHandle.trim().replace(/^@/, '') : null
      if (handle === null || (handle && !/^[A-Za-z0-9_]{1,15}$/.test(handle))) throw Object.assign(new Error(tr('账号名只能是字母、数字、下划线，最多 15 个字符')), { status: 400 })
      next.ownHandle = handle
    }
    if (patch.composeAt !== undefined) next.composeAt = checkTime(patch.composeAt, '成稿时间')
    if (patch.slots !== undefined) {
      if (!Array.isArray(patch.slots) || patch.slots.length < 1 || patch.slots.length > 8) throw Object.assign(new Error(tr('发帖时段要有 1 到 8 个')), { status: 400 })
      next.slots = patch.slots.map(slot => checkTime(slot, '发帖时段'))
    }
    if (patch.dailyCandidates !== undefined) next.dailyCandidates = clamp(patch.dailyCandidates, 1, 12, current.dailyCandidates)
    if (patch.dailyImages !== undefined) next.dailyImages = clamp(patch.dailyImages, 0, 10, current.dailyImages)
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
    this.value = next
    return next
  }
}

export function imageReady(settings, toolAvailable = false) {
  if (settings.image.source === 'tool') return toolAvailable
  return Boolean(settings.image.baseUrl && settings.image.model && settings.image.apiKey)
}

/** 发给浏览器的版本：只告诉它有没有密钥和末四位。 */
export function publicSettings(settings, toolAvailable = false) {
  const { apiKey, ...image } = settings.image
  return { ...settings, image: { ...image, hasKey: Boolean(apiKey), keyHint: apiKey ? apiKey.slice(-4) : '' }, imageToolAvailable: toolAvailable, imageReady: imageReady(settings, toolAvailable) }
}
