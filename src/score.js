// 选题打分：纯函数，不读时钟（调用方传 now），不依赖其他模块。
const HOUR = 3600e3
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const engagement = p => num(p.likes) + 2 * num(p.reposts) + 2 * num(p.quotes) + 3 * num(p.replies)

export function velocity(p) {
  const hours = (Date.parse(p.fetchedAt) - Date.parse(p.postedAt)) / HOUR
  if (!Number.isFinite(hours)) return 0
  return engagement(p) / Math.max(1, hours)
}

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function baseline(posts, handle) {
  const own = posts.filter(p => p.handle === handle)
  const pool = own.length < 5 ? posts : own
  if (!pool.length) return 1
  return Math.max(1, median(pool.map(velocity)))
}

export const burst = (post, posts) => velocity(post) / baseline(posts, post.handle)

export function eligible(posts, now) {
  const t = new Date(now).getTime()
  return posts
    .filter(p => {
      const age = t - Date.parse(p.postedAt)
      return Number.isFinite(age) && Number.isFinite(Date.parse(p.fetchedAt)) && age <= 36 * HOUR && !p.isRepost && !p.used
    })
    .map(p => ({ p, b: burst(p, posts) }))
    .sort((x, y) => y.b - x.b || Date.parse(y.p.postedAt) - Date.parse(x.p.postedAt))
    .slice(0, 20)
    .map(x => x.p)
}

const dim = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0, Math.round(v))) : 0)

export function qualityScore({ fun, info, resonance } = {}) {
  const d = [dim(fun), dim(info), dim(resonance)]
  if (d.filter(x => x > 0).length < 2) return 0
  return (d[0] + d[1] + d[2]) / 6
}
