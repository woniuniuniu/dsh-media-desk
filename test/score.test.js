import assert from 'node:assert/strict'
import { test } from 'node:test'
import { baseline, burst, eligible, engagement, qualityScore, velocity } from '../src/score.js'

const NOW = new Date('2026-11-11T12:00:00Z')
const post = (handle, id, hoursAgo, likes, extra = {}) => ({ id, handle, likes, replies: 0, reposts: 0, quotes: 0, views: 0, isRepost: false, used: false,
  postedAt: new Date(NOW - hoursAgo * 3600e3).toISOString(), fetchedAt: NOW.toISOString(), ...extra })

test('互动量与速度', () => {
  assert.equal(engagement({ likes: 10, reposts: 2, quotes: 1, replies: 3 }), 25)
  assert.equal(velocity(post('a', '1', 5, 100)), 20)
  assert.equal(velocity(post('a', '2', 0.1, 100)), 100)   // 不足 1 小时按 1 小时算
})
test('基线：账号自己的中位数；样本不足 5 条用全体中位数；不小于 1', () => {
  const big = [10, 20, 30, 40, 50].map((v, i) => post('big', `b${i}`, 1, v))
  const small = [post('small', 's1', 1, 2)]
  assert.equal(baseline([...big, ...small], 'big'), 30)
  assert.equal(baseline([...big, ...small], 'small'), 25)
  assert.equal(baseline([post('z', 'z1', 1, 0)], 'z'), 1)
})
test('基线：偶数条取中间两值的平均；空列表返回 1', () => {
  const four = [10, 20, 30, 40, 50, 60].map((v, i) => post('e', `e${i}`, 1, v))
  assert.equal(baseline(four, 'e'), 35)
  assert.equal(baseline([], 'x'), 1)
  assert.deepEqual(eligible([], NOW), [])
})
test('小账号的突然爆发排在大账号的日常之前', () => {
  const big = [1000, 1000, 1000, 1000, 1100].map((v, i) => post('big', `b${i}`, 1, v))
  const small = [5, 5, 5, 5, 60].map((v, i) => post('small', `s${i}`, 1, v))
  const all = [...big, ...small]
  assert.ok(burst(small[4], all) > burst(big[4], all))
  assert.equal(eligible(all, NOW)[0].id, 's4')
})
test('只取 36 小时内、非转发、未用过的，最多 20 条', () => {
  const many = Array.from({ length: 30 }, (_, i) => post('a', `m${i}`, 1, i))
  const out = eligible([...many, post('a', 'old', 37, 9999), post('a', 'rt', 1, 9999, { isRepost: true }), post('a', 'used', 1, 9999, { used: true })], NOW)
  assert.equal(out.length, 20)
  assert.ok(!out.some(p => ['old', 'rt', 'used'].includes(p.id)))
})
test('burst 相同时新帖在前；基线取自全部输入而非仅合格帖', () => {
  const a = post('a', 'older', 3, 30)
  const b = post('a', 'newer', 2, 20)
  assert.deepEqual(eligible([a, b], NOW).map(p => p.id), ['newer', 'older'])
  const old = [1, 1, 1, 1, 1].map((v, i) => post('h', `o${i}`, 40, v))
  const fresh = post('h', 'f', 1, 10)
  assert.equal(burst(fresh, [...old, fresh]), 10)
  assert.deepEqual(eligible([...old, fresh], NOW).map(p => p.id), ['f'])
})
test('时间无法解析的帖子：速度为 0、不入选，不产生 NaN', () => {
  const bad = post('a', 'bad', 1, 50, { postedAt: 'garbage' })
  const bad2 = post('a', 'bad2', 1, 50, { fetchedAt: undefined })
  const good = post('a', 'good', 1, 5)
  assert.equal(velocity(bad), 0)
  assert.equal(velocity(bad2), 0)
  const all = [bad, bad2, good]
  assert.ok(Number.isFinite(baseline(all, 'a')))
  assert.ok(Number.isFinite(burst(bad, all)))
  assert.deepEqual(eligible(all, NOW).map(p => p.id), ['good'])
})
test('选题质量：三项至少占两项才及格', () => {
  assert.equal(qualityScore({ fun: 2, info: 0, resonance: 0 }), 0)
  assert.equal(qualityScore({ fun: 1, info: 2, resonance: 0 }), 0.5)
  assert.equal(qualityScore({ fun: 9, info: 2, resonance: 'x' }), 4 / 6)
})
