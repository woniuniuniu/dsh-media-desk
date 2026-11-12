process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import test from 'node:test'
import { computeInsights } from '../src/insights.js'
import { emptyState } from '../src/seed.js'

const NOW = new Date('2026-11-12T12:00:00+08:00')
const at = s => new Date(`${s}+08:00`).toISOString()

const walk = (v, path, check) => {
  if (typeof v === 'number') check(v, path)
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, check))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, check)
}
const assertFinite = (result) => walk(result, 'r', (n, p) => assert.ok(Number.isFinite(n), `${p} = ${n}`))

const mineItem = (id, kind, postedAt, extra = {}) => ({
  id, kind, text: id, url: `https://x.com/me/status/${id}`, postedAt: at(postedAt), fetchedAt: at(postedAt),
  likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0, inReplyTo: null, candidateId: null, replyId: null, ...extra,
})
const cand = (id, typeId, status, createdAt, extra = {}) => ({
  id, typeId, status, createdAt: at(createdAt), form: 'post', text: id, aiText: null, sentText: null, sentPostId: null, sentAt: null, discardReason: null, ...extra,
})

test('空状态：每个字段的形状和零值', () => {
  const r = computeInsights(emptyState(), NOW)
  assert.deepEqual(r, {
    followers: { series: [], now: null, delta7: null, delta30: null },
    totals: { d7: { posts: 0, replies: 0, views: 0, likes: 0 }, d30: { posts: 0, replies: 0, views: 0, likes: 0 } },
    byType: [],
    top: [],
    replies: { drafted: 0, sent: 0, sentRate: 0, avgEngagement: 0 },
    funnel: { drafted: 0, approved: 0, sent: 0, discarded: 0, expired: 0, discardReasons: { not_interested: 0, not_me: 0, stale: 0, none: 0 } },
    edits: { pairs: 0, medianLengthRatio: null },
  })
})

test('手工数据集：每个数字的精确值，且不改动 state', () => {
  const state = emptyState()
  state.voice.types = [{ id: 't_model', name: '模型' }, { id: 't_tech', name: '技术' }]
  state.followers = [
    { day: '2026-11-12', count: 160 }, { day: '2026-10-01', count: 100 }, { day: '2026-11-04', count: 150 }, { day: '2026-10-13', count: 120 },
  ]
  state.candidates = [
    cand('c1', 't_model', 'sent', '2026-11-10 09:00', { aiText: '今天发布了新模型很强', sentText: '今天发布了新模型，真的很强，值得看', sentAt: at('2026-11-11 09:00') }),
    cand('c2', 't_tech', 'sent', '2026-11-07 09:00', { aiText: '一二三四五六七八', sentText: '一二三四五六七八九十', sentAt: at('2026-11-08 09:00') }),
    cand('c3', 't_model', 'sent', '2026-10-31 09:00', { aiText: '一二三四五六七八', sentText: '一二三四五六', sentAt: at('2026-11-01 09:00') }),
    cand('c4', 't_model', 'pending', '2026-11-11 09:00'),
    cand('c5', 't_model', 'discarded', '2026-11-11 10:00', { discardReason: 'not_me' }),
    cand('c6', 't_model', 'discarded', '2026-11-11 11:00'),
    cand('c7', 't_tech', 'expired', '2026-11-09 09:00'),
    cand('c8', 't_tech', 'approved', '2026-11-11 12:00'),
    cand('c9', 't_tech', 'sent', '2026-09-01 09:00'),
  ]
  state.mine = [
    mineItem('m1', 'post', '2026-11-11 12:00', { text: '甲'.repeat(100), candidateId: 'c1', views: 1000, likes: 10, reposts: 2, quotes: 1, replies: 3 }),
    mineItem('m2', 'post', '2026-11-08 12:00', { candidateId: 'c2', views: 500, likes: 5 }),
    mineItem('m3', 'post', '2026-11-01 12:00', { candidateId: 'c3', views: 200, likes: 20 }),
    mineItem('m4', 'quote', '2026-11-12 08:00', { views: 300, likes: 8 }),
    mineItem('m5', 'reply', '2026-11-11 15:00', { views: 50, likes: 2, replies: 1 }),
    mineItem('m6', 'reply', '2026-10-01 12:00', { views: 9999, likes: 99 }),
    mineItem('m7', 'post', '2026-10-20 12:00', { views: 700, likes: 1 }),
    mineItem('m8', 'post', '2026-11-20 12:00', { views: 5000, likes: 50 }),
    mineItem('m9', 'post', '2026-11-11 13:00', { candidateId: 'gone', views: 10 }),
  ]
  state.replyDrafts = [
    { id: 'r_1', toHandle: 'a', toPostId: '1', drafts: ['好的', '不错'], notifiedAt: at('2026-11-10 09:00'), sentText: '好', sentAt: at('2026-11-10 10:00') },
    { id: 'r_2', toHandle: 'a', toPostId: '2', drafts: ['x', 'y'], notifiedAt: at('2026-11-11 09:00'), sentText: null, sentAt: null },
    { id: 'r_3', toHandle: 'a', toPostId: '3', drafts: ['x', 'y'], notifiedAt: at('2026-09-01 09:00'), sentText: '旧', sentAt: at('2026-09-01 10:00') },
  ]
  const before = structuredClone(state)
  const r = computeInsights(state, NOW)
  assert.deepEqual(state, before)

  assert.deepEqual(r, {
    followers: {
      series: [{ day: '2026-10-01', count: 100 }, { day: '2026-10-13', count: 120 }, { day: '2026-11-04', count: 150 }, { day: '2026-11-12', count: 160 }],
      now: 160, delta7: 10, delta30: 40,
    },
    totals: {
      d7: { posts: 4, replies: 1, views: 1860, likes: 25 },
      d30: { posts: 6, replies: 1, views: 2760, likes: 46 },
    },
    byType: [
      { typeId: 't_model', name: '模型', posts: 2, avgViews: 600, avgEngagement: 22.5 },
      { typeId: 't_tech', name: '技术', posts: 1, avgViews: 500, avgEngagement: 5 },
    ],
    top: [
      { id: 'm1', text: '甲'.repeat(80), url: 'https://x.com/me/status/m1', views: 1000, likes: 10, replies: 3, reposts: 2, typeName: '模型' },
      { id: 'm3', text: 'm3', url: 'https://x.com/me/status/m3', views: 200, likes: 20, replies: 0, reposts: 0, typeName: '模型' },
      { id: 'm4', text: 'm4', url: 'https://x.com/me/status/m4', views: 300, likes: 8, replies: 0, reposts: 0, typeName: null },
      { id: 'm2', text: 'm2', url: 'https://x.com/me/status/m2', views: 500, likes: 5, replies: 0, reposts: 0, typeName: '技术' },
      { id: 'm7', text: 'm7', url: 'https://x.com/me/status/m7', views: 700, likes: 1, replies: 0, reposts: 0, typeName: null },
    ],
    replies: { drafted: 2, sent: 1, sentRate: 0.5, avgEngagement: 5 },
    funnel: { drafted: 8, approved: 1, sent: 3, discarded: 2, expired: 1, discardReasons: { not_interested: 0, not_me: 1, stale: 0, none: 1 } },
    edits: { pairs: 5, medianLengthRatio: 1.25 },
  })
  assertFinite(r)
})

test('粉丝序列只有一天时 delta7、delta30 为 null；序列最多取最近 90 天', () => {
  const state = emptyState()
  state.followers = [{ day: '2026-11-12', count: 5 }]
  assert.deepEqual(computeInsights(state, NOW).followers, { series: [{ day: '2026-11-12', count: 5 }], now: 5, delta7: null, delta30: null })
  state.followers = Array.from({ length: 120 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), count: i }))
  const f = computeInsights(state, NOW).followers
  assert.equal(f.series.length, 90)
  assert.equal(f.series[0].count, 30)
  assert.equal(f.now, 119)
  assert.equal(f.delta7, 7)
  assert.equal(f.delta30, 30)
})

test('类型被删除时名字退回类型 id；没有配上候选稿的内容不进 byType', () => {
  const state = emptyState()
  state.candidates = [cand('c1', 't_gone', 'sent', '2026-11-10 09:00')]
  state.mine = [mineItem('m1', 'post', '2026-11-11 12:00', { candidateId: 'c1', views: 10, likes: 1 }), mineItem('m2', 'post', '2026-11-11 12:00', { likes: 99 })]
  const r = computeInsights(state, NOW)
  assert.deepEqual(r.byType, [{ typeId: 't_gone', name: 't_gone', posts: 1, avgViews: 10, avgEngagement: 1 }])
})

test('所有数字都是有限数：空状态、畸形状态、超大指标', () => {
  assertFinite(computeInsights(emptyState(), NOW))
  assertFinite(computeInsights({}, NOW))
  assertFinite(computeInsights(null, NOW))
  const huge = Number.MAX_VALUE
  const bad = {
    followers: [{ day: 'x', count: 1 }, { day: '2026-11-12', count: NaN }, { day: '2026-11-12', count: 7 }, null, { day: '2026-11-01', count: Infinity }],
    voice: { types: 'nope' },
    candidates: [null, 5, cand('c1', 't', 'discarded', '2026-11-11 09:00', { discardReason: 'weird', aiText: '  ', sentText: 'x' }), { id: 'c2', status: 'sent', createdAt: 'bad', aiText: 'a', sentText: 'b' },
      cand('c3', 't', 'sent', '2026-11-11 09:00', { aiText: 12345, sentText: '一二三四' })],
    mine: [
      mineItem('a', 'post', '2026-11-11 09:00', { views: huge, likes: huge, reposts: huge, quotes: Infinity, replies: NaN, candidateId: 'c1' }),
      mineItem('b', 'post', '2026-11-11 10:00', { views: huge, likes: huge, candidateId: 'c1' }),
      mineItem('c', 'reply', '2026-11-11 10:00', { views: '9', likes: -5 }),
      { id: 'd', kind: 'post', postedAt: 'garbage', views: 5 },
      { id: 'e', kind: 'post', postedAt: at('2026-11-11 09:00'), text: null, url: undefined },
    ],
    replyDrafts: [{ id: 'r', notifiedAt: 'zzz', drafts: 7, sentText: 'x', sentAt: 'zzz' }, { id: 's', notifiedAt: at('2026-11-11 09:00'), drafts: ['a'], sentText: 'b', sentAt: at('2026-11-11 10:00') }],
  }
  const r = computeInsights(bad, NOW)
  assertFinite(r)
  assert.equal(r.followers.now, 7)
  assert.equal(r.funnel.discardReasons.none, 1)
  assert.equal(r.top.length, 3)
})
