// 候选稿的状态迁移、排期、过期和发帖链接。纯函数：只改传入的 state，不读时钟（now 由调用方给）。
const REASONS = ['not_interested', 'not_me', 'stale']
const EXPIRE_MS = 48 * 3600 * 1000
const SEARCH_DAYS = 14
const URL_RUN = /https?:\/\/[^\s]+/g

const find = (state, id) => state.candidates.find(row => row.id === id)
const validDate = value => typeof value === 'string' && !Number.isNaN(new Date(value).getTime())

/**
 * 存入或截断文字的唯一入口：孤立代理项换成 U+FFFD（否则发帖链接编码会抛错），按码点截断，不会把 emoji 切成两半。
 * @param {unknown} text - 文字。
 * @param {number} [max] - 最多保留的码点数。
 * @returns {string} 合法的文字。
 */
export function safeText(text, max) {
  const whole = String(text ?? '').toWellFormed()
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

/** 一键发帖链接：文字（和引用的原帖链接）预填进 X 的发帖页。 */
export function intentUrl(candidate) {
  let url = `https://x.com/intent/tweet?text=${encodeURIComponent(safeText(candidate.text))}`
  if (candidate.form === 'quote' && candidate.quoteUrl) url += `&url=${encodeURIComponent(safeText(candidate.quoteUrl))}`
  return url
}

/** X 的字数：码点在 U+1100 及以上计 2，其余计 1；网址统一计 23。 */
export function tweetLength(text) {
  let count = 0
  const rest = String(text).replace(URL_RUN, () => {
    count += 23
    return ''
  })
  for (const ch of rest) count += ch.codePointAt(0) >= 0x1100 ? 2 : 1
  return count
}

/**
 * 从 now 起第一个没被已通过的稿子占用的时段（本机时区）。14 天内排满时返回第 14 天后的第一个时段。
 * @returns {string} ISO 时间。
 */
export function nextSlot(state, slots, now) {
  const times = [...slots].sort().map(slot => slot.split(':').map(Number))
  const taken = new Set(state.candidates.filter(row => row.status === 'approved' && row.scheduledAt).map(row => new Date(row.scheduledAt).getTime()))
  const at = (day, [hour, minute]) => {
    const date = new Date(now)
    date.setDate(date.getDate() + day)
    date.setHours(hour, minute, 0, 0)
    return date
  }
  for (let day = 0; day < SEARCH_DAYS; day += 1) {
    for (const time of times) {
      const date = at(day, time)
      if (date.getTime() > now.getTime() && !taken.has(date.getTime())) return date.toISOString()
    }
  }
  return at(SEARCH_DAYS, times[0]).toISOString()
}

/** pending → approved；已通过的稿子只在给了新的 scheduledAt 时改时间。 */
export function approve(state, id, { now, slots, scheduledAt }) {
  const row = find(state, id)
  if (!row) return false
  if (row.status === 'approved') {
    if (!validDate(scheduledAt)) return false
    const next = new Date(scheduledAt).toISOString()
    if (next === row.scheduledAt) return false
    row.scheduledAt = next
    return true
  }
  if (row.status !== 'pending') return false
  row.status = 'approved'
  row.decidedAt = now.toISOString()
  row.scheduledAt = validDate(scheduledAt) ? new Date(scheduledAt).toISOString() : nextSlot(state, slots, now)
  return true
}

/** pending | approved → discarded。 */
export function discard(state, id, { now, reason } = {}) {
  const row = find(state, id)
  if (!row || (row.status !== 'pending' && row.status !== 'approved')) return false
  row.status = 'discarded'
  row.decidedAt = now.toISOString()
  row.discardReason = REASONS.includes(reason) ? reason : null
  row.scheduledAt = null
  return true
}

/** approved → sent。 */
export function markSent(state, id, { now }) {
  const row = find(state, id)
  if (!row || row.status !== 'approved') return false
  row.status = 'sent'
  row.decidedAt = now.toISOString()
  return true
}

/** approved → pending（撤回）。 */
export function unapprove(state, id) {
  const row = find(state, id)
  if (!row || row.status !== 'approved') return false
  row.status = 'pending'
  row.scheduledAt = null
  row.decidedAt = null
  return true
}

/** 改文字，只对 pending、approved 生效。 */
export function setText(state, id, text) {
  const row = find(state, id)
  if (!row || typeof text !== 'string' || (row.status !== 'pending' && row.status !== 'approved')) return false
  row.text = safeText(text, 4000)
  row.revision += 1
  return true
}

/** 超过 48 小时没处理的 pending 标为 expired，返回数量。 */
export function expire(state, now) {
  const cutoff = now.getTime() - EXPIRE_MS
  let count = 0
  for (const row of state.candidates) {
    if (row.status !== 'pending' || !(new Date(row.createdAt).getTime() < cutoff)) continue
    row.status = 'expired'
    row.decidedAt = now.toISOString()
    count += 1
  }
  return count
}

/** 处理一条已校验的决定。view / revise 交给模型（Task 10），这里只确认稿子还能被处理。 */
export function applyDecision(state, decision, { now, slots }) {
  const row = find(state, decision.candidateId)
  if (!row) return 'ignored'
  switch (decision.action) {
    case 'approve': return approve(state, row.id, { now, slots }) ? 'applied' : 'ignored'
    case 'discard': return discard(state, row.id, { now, reason: decision.reason }) ? 'applied' : 'ignored'
    case 'sent': return markSent(state, row.id, { now }) ? 'applied' : 'ignored'
    case 'view':
    case 'revise': return row.status === 'pending' || row.status === 'approved' ? 'needs_model' : 'ignored'
    default: return 'ignored'
  }
}
