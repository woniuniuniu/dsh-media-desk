// 界面小工具：界面只有中文，t() 只做占位符替换。

/**
 * 界面文字。key 就是中文原文，{name} 是占位符。
 * @param {string} zh - 中文原文。
 * @param {Record<string, unknown>} [vars] - 占位符的值。
 * @returns {string} 中文文字。
 */
export function t(zh, vars) {
  return vars ? zh.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key]))) : zh
}

export function dayKey(date) {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function pad(n) {
  return String(n).padStart(2, '0')
}

export function fmtTime(iso) {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDate(iso) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function relativeDay(iso) {
  const diff = Math.round((new Date(dayKey(iso)) - new Date(dayKey(new Date()))) / 86400000)
  if (diff === 0) return t('今天')
  if (diff === 1) return t('明天')
  if (diff === 2) return t('后天')
  if (diff === -1) return t('昨天')
  if (diff < 0 && diff > -8) return t('{n}天前', { n: -diff })
  return fmtDate(iso)
}

export function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function compact(n) {
  if (n === null || n === undefined) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`
  return n.toLocaleString()
}

export function num1(n) {
  return Number.isFinite(n) ? n.toFixed(1) : '—'
}

const URL_RUN = /https?:\/\/[^\s]+/g

/** 与 src/inbox.js 的 safeText 一致：孤立代理项换成 U+FFFD，按码点截断。 */
export function safeText(text, max) {
  const raw = String(text ?? '')
  const whole = raw.toWellFormed ? raw.toWellFormed() : raw
  if (max === undefined || whole.length <= max) return whole
  let out = ''
  let n = 0
  for (const ch of whole) {
    if (n === max) break
    out += ch
    n += 1
  }
  return out
}

/** 一键发帖链接，与 src/inbox.js 的 intentUrl 一致；文字先过 safeText，encodeURIComponent 不会抛错。 */
export function intentUrl(candidate) {
  let url = `https://x.com/intent/tweet?text=${encodeURIComponent(safeText(candidate.text))}`
  if (candidate.form === 'quote' && candidate.quoteUrl) url += `&url=${encodeURIComponent(safeText(candidate.quoteUrl))}`
  return url
}

/** X 的字数，与 src/inbox.js 的 tweetLength 一致：码点在 U+1100 及以上计 2，其余计 1；网址统一计 23。 */
export function tweetLength(text) {
  let count = 0
  const rest = String(text).replace(URL_RUN, () => {
    count += 23
    return ''
  })
  for (const ch of rest) count += ch.codePointAt(0) >= 0x1100 ? 2 : 1
  return count
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/

/**
 * 从「@name」「name」或主页链接里取出账号名；不合法返回 null。
 * @param {string} input - 用户输入。
 * @returns {string|null} 账号名。
 */
export function extractHandle(input) {
  let value = String(input ?? '').trim()
  const link = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i.exec(value)
  if (link) value = link[1]
  else if (/^https?:\/\//i.test(value)) return null
  value = value.replace(/^@/, '')
  return HANDLE.test(value) ? value : null
}

/**
 * 排期页右侧「接下来要发的」：只取已通过的，按排期时间升序。
 * @param {Array<{status: string, scheduledAt?: string}>} candidates - 候选稿。
 * @returns {Array<object>} 排序后的候选稿。
 */
export function upcomingList(candidates) {
  return candidates
    .filter(row => row.status === 'approved' && row.scheduledAt)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
}

export function recentSent(candidates, now, { days = 7, max = 10 } = {}) {
  return candidates
    .filter(row => {
      const when = Date.parse(row.sentAt ?? row.decidedAt)
      return row.status === 'sent' && when >= now - days * 86400000 && when <= now
    })
    .sort((a, b) => (Date.parse(b.sentAt ?? b.decidedAt) || 0) - (Date.parse(a.sentAt ?? a.decidedAt) || 0))
    .slice(0, max)
}

/** 已过排期时间仍没发。 */
export function isDue(candidate, now = new Date()) {
  return candidate.status === 'approved' && Boolean(candidate.scheduledAt) && Date.parse(candidate.scheduledAt) <= now.getTime()
}

/**
 * 把排期挪到另一天，保留原来的几点几分。
 * @param {string} iso - 原排期时间。
 * @param {Date} date - 目标日期。
 * @returns {string} 新的 ISO 时间。
 */
export function moveToDay(iso, date) {
  const previous = new Date(iso)
  const target = new Date(date)
  target.setHours(previous.getHours(), previous.getMinutes(), 0, 0)
  return target.toISOString()
}

const CARD_TEXT = ['name', 'summary', 'tone', 'sentences', 'opening', 'structure']
const CARD_LIST = ['words', 'avoid', 'samples']

/** 风格卡 → 编辑表单（列表字段一行一项）。 */
export function cardToForm(card) {
  const form = {}
  for (const key of CARD_TEXT) form[key] = card?.[key] ?? ''
  for (const key of CARD_LIST) form[key] = (card?.[key] ?? []).join('\n')
  return form
}

/** 编辑表单 → 风格卡，空行丢掉。 */
export function formToCard(form) {
  const card = {}
  for (const key of CARD_TEXT) card[key] = String(form[key] ?? '').trim()
  for (const key of CARD_LIST) card[key] = String(form[key] ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  return card
}

/**
 * 今天的成稿状态。按 runs.lastComposeOutcome 判断：'ok' 成功、'empty' 当天没东西可写（不再重试）、'failed' 失败。
 * lastComposeError 在失败后会一直留到下次成功，所以失败只在"今天试过"时才算今天的。
 * @param {{lastComposeDay: string|null, lastComposeError: string|null, lastComposeAt?: string|null, lastComposeOutcome?: 'ok'|'empty'|'failed'|null}} runs - 状态里的 runs。
 * @param {string} composeAt - 设置里的成稿时间 HH:MM。
 * @param {Date} now - 当前时间。
 * @param {boolean} [composing] - 后台或手动正在出稿。
 * @returns {{kind: 'running'}|{kind: 'done', at: string|null}|{kind: 'empty', message: string}|{kind: 'failed', error: string}|{kind: 'waiting', composeAt: string}} 状态。
 */
export function composeStatus(runs, composeAt, now, composing = false) {
  if (composing) return { kind: 'running' }
  const today = dayKey(now)
  const outcome = runs.lastComposeOutcome ?? null
  const triedToday = Boolean(runs.lastComposeAt) && dayKey(runs.lastComposeAt) === today
  if (outcome === 'failed' && triedToday) return { kind: 'failed', error: runs.lastComposeError ?? '' }
  if (runs.lastComposeDay === today) {
    if (outcome === 'empty') return { kind: 'empty', message: runs.lastComposeError ?? t('今天没有新素材') }
    return { kind: 'done', at: runs.lastComposeAt ?? null }
  }
  return { kind: 'waiting', composeAt }
}

/**
 * 一次 ops 请求之后要弹的提示。接口返回 { applied: string[], errors: string[] }：有错误时提示第一条错误，
 * 否则（不 silent 时）提示第一条成功说明，可撤销的操作带撤销按钮。
 * @param {{applied?: string[], errors?: string[]}|null} data - 接口返回。
 * @param {{undoable?: boolean, silent?: boolean}} [options]
 * @returns {{text: string, undo: boolean, error: boolean}|null} 不需要提示时为 null。
 */
export function opsToast(data, { undoable = true, silent = false } = {}) {
  if (data?.errors?.length) return { text: String(data.errors[0]), undo: false, error: true }
  if (!silent && data?.applied?.length) return { text: String(data.applied[0]), undo: undoable, error: false }
  return null
}

const DESK_KEYS = ['state', 'model', 'modelOk', 'modelError', 'canUndo', 'exchangeDir', 'composing', 'ownHandle']

/** GET state 的返回 → 界面状态里对应的几个字段。 */
export function deskFromState(data) {
  return {
    state: data.state, model: data.model ?? null, modelOk: data.modelOk ?? null, modelError: data.modelError ?? null,
    canUndo: data.canUndo === true, exchangeDir: data.exchangeDir ?? null, composing: data.composing === true, ownHandle: data.ownHandle ?? '',
  }
}

/** 定时刷新拿到的内容和界面里现有的一样时不更新，免得无谓重绘。 */
export function sameDesk(snapshot, patch) {
  return DESK_KEYS.every(key => JSON.stringify(snapshot[key] ?? null) === JSON.stringify(patch[key] ?? null))
}

export const PLACEHOLDER = '【此处填你的经历】'

/** 正文里还留着需要本人填写的经历时，通过前要先确认。 */
export function needsStoryConfirm(text) {
  return typeof text === 'string' && text.includes(PLACEHOLDER)
}

export function linePath(series, width, height, pad = 8) {
  const rows = (Array.isArray(series) ? series : []).filter(row => Number.isFinite(row?.count)).sort((a, b) => String(a.day).localeCompare(String(b.day)))
  if (!rows.length) return ''
  if (![width, height, pad].every(Number.isFinite)) return ''
  const counts = rows.map(row => row.count)
  const min = counts.reduce((a, b) => Math.min(a, b))
  const max = counts.reduce((a, b) => Math.max(a, b))
  // 先缩放计数，避免两个有限极值相减溢出。
  const scale = Math.max(Math.abs(min), Math.abs(max), 1)
  const round = n => Number.isFinite(n) ? Number(n.toFixed(1)) : 0
  return rows.map((row, i) => {
    const fraction = rows.length === 1 ? 0.5 : i / (rows.length - 1)
    const level = min === max ? 0.5 : (row.count / scale - min / scale) / (max / scale - min / scale)
    const x = pad * (1 - fraction) + (width - pad) * fraction
    const y = (height - pad) * (1 - level) + pad * level
    return `${i ? 'L' : 'M'} ${round(x)},${round(y)}`
  }).join(' ')
}

export function groupLongforms(longforms) {
  const groups = { idea: [], draft: [], done: [] }
  for (const row of longforms) if (Object.hasOwn(groups, row.status)) groups[row.status].push(row)
  const time = row => Number.isFinite(Date.parse(row.updatedAt)) ? Date.parse(row.updatedAt) : -Infinity
  for (const rows of Object.values(groups)) rows.sort((a, b) => time(b) - time(a))
  return groups
}

export function splitPlaceholder(text) {
  const parts = text.split(PLACEHOLDER)
  const segments = []
  parts.forEach((part, i) => {
    if (i) segments.push({ text: PLACEHOLDER, mark: true })
    if (part) segments.push({ text: part, mark: false })
  })
  return segments
}

export function mineLink(mine, ownHandle) {
  if (typeof mine.url === 'string' && mine.url.startsWith('https://x.com/')) return mine.url
  return typeof ownHandle === 'string' && HANDLE.test(ownHandle) && /^\d{5,25}$/.test(mine.id)
    ? `https://x.com/${ownHandle}/status/${mine.id}` : null
}

export function pct(n) {
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—'
}

/** 复盘只链接到重新构造的 X 帖子地址，不透传外部 URL。 */
export function insightLink(url) {
  const match = typeof url === 'string' && /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[?#].*)?$/.exec(url)
  return match ? mineLink({ id: match[2] }, match[1]) : null
}

export function signed(n) {
  return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n}` : '—'
}
