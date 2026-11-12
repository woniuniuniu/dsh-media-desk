// 复盘数据：把存下来的状态算成复盘页要显示的数字。纯函数：不读写、不取时钟（now 由调用方给）、不改 state。
import { editPairs } from './match.js'
import { safeText } from './inbox.js'
import { engagement } from './score.js'

const DAY = 24 * 3600e3
const REASONS = ['not_interested', 'not_me', 'stale']
const SKEW = 5 * 60e3 // 与 score.js 一致的时钟偏差
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const list = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [])
const ms = iso => (typeof iso === 'string' ? Date.parse(iso) : NaN)
const metric = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, v)) : 0)
const round = (v, digits) => {
  const k = 10 ** digits
  const r = Math.round(v * k) / k
  return Number.isFinite(r) ? r : 0
}
const mean = (sum, n) => (n === 0 ? 0 : sum / n)
const median = values => {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function followersBlock(raw) {
  const rows = list(raw)
    .filter(r => typeof r.day === 'string' && DAY_RE.test(r.day) && Number.isFinite(Date.parse(`${r.day}T00:00:00Z`)) && typeof r.count === 'number' && !Number.isNaN(r.count))
    .map(r => ({ day: r.day, count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(r.count))) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const series = rows.slice(-90)
  const latest = series.length ? series[series.length - 1] : null
  const delta = days => {
    if (!latest) return null
    const cutoff = Date.parse(`${latest.day}T00:00:00Z`) - days * DAY
    let base = null
    for (const r of series) if (Date.parse(`${r.day}T00:00:00Z`) <= cutoff) base = r
    return base ? latest.count - base.count : null
  }
  return { series, now: latest ? latest.count : null, delta7: delta(7), delta30: delta(30) }
}

export function computeInsights(state, now) {
  const t = new Date(now).getTime()
  const inWindow = (iso, days) => {
    const x = ms(iso)
    return Number.isFinite(t) && Number.isFinite(x) && x <= t + SKEW && x > t - days * DAY
  }
  const types = list(state?.voice?.types)
  const typeName = id => types.find(x => x.id === id)?.name ?? id
  const candidates = list(state?.candidates)
  const candById = new Map(candidates.map(c => [c.id, c]))
  const mine = list(state?.mine)

  const totalsFor = days => {
    const out = { posts: 0, replies: 0, views: 0, likes: 0 }
    for (const m of mine) {
      if (!inWindow(m.postedAt, days)) continue
      if (m.kind === 'post' || m.kind === 'quote') out.posts += 1
      else if (m.kind === 'reply') out.replies += 1
      else continue
      out.views += metric(m.views)
      out.likes += metric(m.likes)
    }
    return out
  }

  const recent = mine.filter(m => inWindow(m.postedAt, 30))

  const groups = new Map()
  for (const m of recent) {
    const c = m.candidateId == null ? null : candById.get(m.candidateId)
    if (!c) continue
    const g = groups.get(c.typeId) ?? { posts: 0, views: 0, eng: 0 }
    g.posts += 1
    g.views += metric(m.views)
    g.eng += engagement(m)
    groups.set(c.typeId, g)
  }
  const byType = [...groups].map(([typeId, g]) => ({
    typeId, name: typeName(typeId), posts: g.posts, avgViews: round(mean(g.views, g.posts), 1), avgEngagement: round(mean(g.eng, g.posts), 1),
  })).sort((a, b) => b.avgEngagement - a.avgEngagement)

  const top = recent
    .filter(m => m.kind === 'post' || m.kind === 'quote')
    .map(m => ({ m, e: engagement(m), at: ms(m.postedAt) }))
    .sort((a, b) => b.e - a.e || b.at - a.at)
    .slice(0, 5)
    .map(({ m }) => {
      const c = m.candidateId == null ? null : candById.get(m.candidateId)
      return {
        id: m.id, text: safeText(m.text, 80), url: m.url ?? null, views: metric(m.views), likes: metric(m.likes),
        replies: metric(m.replies), reposts: metric(m.reposts), typeName: c ? typeName(c.typeId) : null,
      }
    })

  const drafts = list(state?.replyDrafts)
  const notified = drafts.filter(r => inWindow(r.notifiedAt, 30))
  const drafted = notified.length
  const sent = notified.filter(r => typeof r.sentText === 'string' && r.sentText !== '').length
  const myReplies = recent.filter(m => m.kind === 'reply')
  const replies = {
    drafted, sent, sentRate: drafted === 0 ? 0 : round(sent / drafted, 2),
    avgEngagement: round(mean(myReplies.reduce((s, m) => s + engagement(m), 0), myReplies.length), 1),
  }

  const made = candidates.filter(c => inWindow(c.createdAt, 30))
  const count = status => made.filter(c => c.status === status).length
  const discardReasons = { not_interested: 0, not_me: 0, stale: 0, none: 0 }
  for (const c of made) {
    if (c.status !== 'discarded') continue
    discardReasons[REASONS.includes(c.discardReason) ? c.discardReason : 'none'] += 1
  }
  const funnel = {
    drafted: made.length, approved: count('approved'), sent: count('sent'), discarded: count('discarded'), expired: count('expired'), discardReasons,
  }

  const pairs = editPairs({ candidates, replyDrafts: drafts.map(r => ({ ...r, drafts: Array.isArray(r.drafts) ? r.drafts : [] })) })
  const ratios = []
  for (const p of pairs) {
    if (p.kind !== 'post' || typeof p.aiText !== 'string' || typeof p.sentText !== 'string') continue
    const a = Array.from(p.aiText.trim()).length
    if (a === 0) continue
    ratios.push(Array.from(p.sentText.trim()).length / a)
  }

  return {
    followers: followersBlock(state?.followers),
    totals: { d7: totalsFor(7), d30: totalsFor(30) },
    byType,
    top,
    replies,
    funnel,
    edits: { pairs: pairs.length, medianLengthRatio: ratios.length ? round(median(ratios), 2) : null },
  }
}
