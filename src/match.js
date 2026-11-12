// 配对：认出哪些候选稿已被负责人发出，记录实发文字；认出用过的回复草稿。
// 纯函数：不读写、不取时钟、不调模型。

export const STRONG = 0.8
export const MIN = 0.55
export const GAP = 0.1
export const SHORT = 12
export const REPLY_PAIR_MIN = 0.3
const WINDOW_MS = 96 * 3600 * 1000
const SKEW_MS = 5 * 60 * 1000
const EDIT_SAME = 0.98

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]{1,15}/g, ' ')
    .replace(/#/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function gramSet(text) {
  const chars = Array.from(normalizeText(text))
  const set = new Set()
  if (chars.length === 0) return set
  if (chars.length === 1) { set.add(chars[0]); return set }
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1])
  return set
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const g of small) if (large.has(g)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export function similarity(a, b) {
  return jaccard(gramSet(a), gramSet(b))
}

function ms(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0)

export function matchSent(state, { now } = {}) {
  let changed = 0
  const mine = Array.isArray(state.mine) ? state.mine : []

  // 帖子 / 引用：与候选稿贪心配对。
  // 第一名和第二名按时间窗内的全部候选稿算（不管状态、是否已配过），只有分配时才限于还能配的；
  // 否则竞争的那条过期、丢弃或配给别人之后，原先分不清的一对就会被配上。
  const matchable = c => ['pending', 'approved', 'sent'].includes(c.status) && !c.sentPostId
  // 先只比时间（便宜）：按创建时间排好序，二分找出每条实发内容时间窗里的候选稿；
  // 字的二元组只为窗口里有候选稿的实发内容算，候选稿的每条最多算一次
  const cands = (state.candidates || [])
    .map(c => ({ c, t: ms(c.createdAt), grams: null, len: 0, open: matchable(c) }))
    .filter(x => x.t !== null)
    .sort((x, y) => x.t - y.t)
  const firstAtOrAfter = t => {
    let lo = 0
    let hi = cands.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cands[mid].t < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const prepare = x => {
    if (x.grams === null) {
      x.grams = gramSet(x.c.text)
      x.len = Array.from(normalizeText(x.c.text)).length
    }
    return x
  }
  const pairs = []
  for (const m of mine) {
    if ((m.kind !== 'post' && m.kind !== 'quote') || m.candidateId) continue
    const t = ms(m.postedAt)
    if (t === null) continue
    const from = firstAtOrAfter(t - WINDOW_MS)
    const to = firstAtOrAfter(t + SKEW_MS + 1)
    if (from >= to) continue
    const p = { m, t, grams: gramSet(m.text), len: Array.from(normalizeText(m.text)).length }
    const scored = []
    for (let i = from; i < to; i++) {
      const k = prepare(cands[i])
      scored.push({ p, k, sim: jaccard(p.grams, k.grams) })
    }
    // 该条实发内容的第一名与第二名（在配对分配之前算好，结果与遍历顺序无关）
    const sims = scored.map(e => e.sim).sort((a, b) => b - a)
    const top = sims[0] ?? 0
    const second = sims[1] ?? 0
    // 最像的那条（并列时任一条）已不能配：这条实发内容什么都不配
    if (scored.some(e => e.sim === top && !e.k.open)) continue
    for (const e of scored) {
      if (!e.k.open) continue
      const short = p.len < SHORT || e.k.len < SHORT
      const ok = e.sim >= STRONG
        || (!short && e.sim >= MIN && e.sim === top && top - second >= GAP)
      if (ok) pairs.push(e)
    }
  }
  pairs.sort((x, y) => y.sim - x.sim || x.p.t - y.p.t
    || cmp(String(x.p.m.id), String(y.p.m.id)) || cmp(String(x.k.c.id), String(y.k.c.id)))
  const usedMine = new Set()
  const usedCand = new Set()
  for (const { p, k } of pairs) {
    if (usedMine.has(p.m) || usedCand.has(k.c)) continue
    usedMine.add(p.m)
    usedCand.add(k.c)
    const c = k.c
    if (c.status === 'pending' || c.status === 'approved') c.status = 'sent'
    c.sentText = p.m.text
    c.sentPostId = p.m.id
    c.sentAt = p.m.postedAt
    if (c.decidedAt == null) c.decidedAt = p.m.postedAt
    p.m.candidateId = c.id
    changed++
  }

  // 回复：按 toPostId 找最近一次起草
  const replies = mine
    .filter(m => m.kind === 'reply' && m.inReplyTo && m.replyId == null)
    .map(m => ({ m, t: ms(m.postedAt) }))
    .filter(x => x.t !== null)
    .sort((x, y) => x.t - y.t || cmp(String(x.m.id), String(y.m.id)))
  for (const { m, t } of replies) {
    let best = null
    let bestT = -Infinity
    for (const d of state.replyDrafts || []) {
      if (d.sentText != null || d.toPostId !== m.inReplyTo.postId) continue
      const n = ms(d.notifiedAt)
      if (n === null || n > t + SKEW_MS) continue
      if (n > bestT || (n === bestT && cmp(String(d.id), String(best.id)) < 0)) { best = d; bestT = n }
    }
    if (!best) continue
    best.sentText = m.text
    best.sentAt = m.postedAt
    m.replyId = best.id
    changed++
  }
  return { changed }
}

export function editPairs(state) {
  const out = []
  for (const c of state.candidates || []) {
    if (!c.aiText || !c.sentText) continue
    if (similarity(c.aiText, c.sentText) < EDIT_SAME) {
      out.push({ aiText: c.aiText, sentText: c.sentText, kind: 'post', at: ms(c.sentAt) ?? 0 })
    }
  }
  for (const r of state.replyDrafts || []) {
    if (!r.sentText) continue
    const sentGrams = gramSet(r.sentText)
    let bestText = null
    let bestSim = -1
    for (const d of r.drafts || []) {
      if (typeof d !== 'string') continue
      const s = jaccard(gramSet(d), sentGrams)
      if (s > bestSim) { bestSim = s; bestText = d }
    }
    // 回复只按帖子关联、不看相似度；与所有草稿都不像的（自己另写的）不算改稿
    if (bestText !== null && bestSim >= REPLY_PAIR_MIN && bestSim < EDIT_SAME) {
      out.push({ aiText: bestText, sentText: r.sentText, kind: 'reply', at: ms(r.sentAt) ?? 0 })
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out.map(({ aiText, sentText, kind }) => ({ aiText, sentText, kind }))
}
