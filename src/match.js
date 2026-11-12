// 配对：认出哪些候选稿已被负责人发出，记录实发文字；认出用过的回复草稿。
// 纯函数：不读写、不取时钟、不调模型。

const THRESHOLD = 0.55
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

  // 帖子 / 引用：与候选稿贪心配对
  const cands = (state.candidates || [])
    .filter(c => ['pending', 'approved', 'sent'].includes(c.status) && !c.sentPostId)
    .map(c => ({ c, t: ms(c.createdAt), grams: gramSet(c.text) }))
    .filter(x => x.t !== null)
  const posts = mine
    .filter(m => (m.kind === 'post' || m.kind === 'quote') && !m.candidateId)
    .map(m => ({ m, t: ms(m.postedAt), grams: gramSet(m.text) }))
    .filter(x => x.t !== null)
  const pairs = []
  for (const p of posts) {
    for (const k of cands) {
      if (k.t > p.t + SKEW_MS || k.t < p.t - WINDOW_MS) continue
      const sim = jaccard(p.grams, k.grams)
      if (sim >= THRESHOLD) pairs.push({ p, k, sim })
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
    if (r.sentText == null) continue
    const sentGrams = gramSet(r.sentText)
    let bestText = null
    let bestSim = -1
    for (const d of r.drafts || []) {
      if (typeof d !== 'string') continue
      const s = jaccard(gramSet(d), sentGrams)
      if (s > bestSim) { bestSim = s; bestText = d }
    }
    if (bestText !== null && bestSim < EDIT_SAME) {
      out.push({ aiText: bestText, sentText: r.sentText, kind: 'reply', at: ms(r.sentAt) ?? 0 })
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out.map(({ aiText, sentText, kind }) => ({ aiText, sentText, kind }))
}
