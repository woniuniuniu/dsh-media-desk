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

export function fmtWhen(iso) {
  if (!iso) return t('未排期')
  return `${fmtDate(iso)} ${fmtTime(iso)}`
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

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

/** 草稿预览用的极简 Markdown：先转义，再处理结构，模型输出里的 HTML 不会被执行。 */
export function renderMarkdown(source) {
  const lines = source.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i += 1; continue }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i += 1; continue }
    if (/^>\s?/.test(line)) {
      const quote = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(inline(lines[i].replace(/^>\s?/, ''))); i += 1 }
      out.push(`<blockquote>${quote.join('<br>')}</blockquote>`)
      continue
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()))
      const head = cells(line)
      i += 2
      const body = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i += 1 }
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^\s*([-*·]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const rows = []
      while (i < lines.length && /^\s*([-*·]|\d+\.)\s+/.test(lines[i])) { rows.push(`<li>${inline(lines[i].replace(/^\s*([-*·]|\d+\.)\s+/, ''))}</li>`); i += 1 }
      out.push(ordered ? `<ol>${rows.join('')}</ol>` : `<ul>${rows.join('')}</ul>`)
      continue
    }
    const para = []
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|>|\|)/.test(lines[i]) && !/^\s*([-*·]|\d+\.)\s+/.test(lines[i])) { para.push(inline(lines[i])); i += 1 }
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`)
    else { out.push(`<p>${inline(line)}</p>`); i += 1 }
  }
  return out.join('')
}

/** 正文长度：按字数，不算空白。 */
export function textLength(text) {
  return text.replace(/\s/g, '').length
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
