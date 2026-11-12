process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Composer } from '../src/compose.js'
import { Exchange } from '../src/exchange.js'
import { Lock } from '../src/lock.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'
import { Worker, addNotice, localDay } from '../src/worker.js'
import * as runs from '../src/runs.js'
import { computeInsights } from '../src/insights.js'
import { MAX_MINE, MAX_REPLY_DRAFTS } from '../src/worker.js'

const NOW = new Date('2026-11-11T11:05:00+08:00') // 周三
const MONDAY = new Date('2026-11-16T11:05:00+08:00')
const TODAY = '2026-11-11'
const A = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键是看你自己的场景。'
const A_SMALL = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键看自己的场景。'
const ID = '1856000000000000001'
const iso = (d, minutes = 0) => new Date(d.getTime() + minutes * 60_000).toISOString()

async function setup({ now = NOW, learn, longform, composed = true, lock } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'worker-learn-'))
  const clock = { t: now }
  const store = new Store(root)
  const settings = new Settings(root)
  const ex = new Exchange(join(root, 'exchange'))
  await ex.ensure()
  const callText = async () => ({ text: '[]', model: 'fake' })
  const composer = new Composer({ store, settings, callText, now: () => clock.t })
  const realLock = new Lock(join(root, 'worker.lock'), { now: () => clock.t.getTime() })
  const worker = new Worker({ store, settings, composer, lock: lock ?? realLock, exchangeFor: () => ex, now: () => clock.t, learn, longform })
  if (composed) await store.mutate('seed', s => { s.runs.lastComposeDay = localDay(now) }, { undoable: false })
  return { root, clock, store, settings, ex, worker }
}

const mineFile = (ex, name, over = {}) => writeFile(join(ex.root, 'mine', name), JSON.stringify({
  schema: 1, postId: ID, kind: 'post', text: A_SMALL, postedAt: iso(NOW, -60), fetchedAt: iso(NOW, -30),
  metrics: { likes: 1, replies: 2, reposts: 3, quotes: 4, views: 50 }, ...over,
}))
const replyFile = (ex, name, over = {}) => writeFile(join(ex.root, 'replies', name), JSON.stringify({
  schema: 1, toHandle: 'karpathy', toPostId: '1855000000000000001', drafts: ['草稿一', '草稿二'], notifiedAt: iso(NOW, -90), ...over,
}))
const cand = (id, extra = {}) => ({
  id, form: 'post', typeId: 't_model', text: A, aiText: A, title: '旧', sourcePostIds: [], sourceNoteId: null, quoteUrl: null,
  reason: '', score: 1, status: 'pending', createdAt: iso(NOW, -120), scheduledAt: null, decidedAt: null, discardReason: null,
  view: null, revision: 0, image: null, sentText: null, sentPostId: null, sentAt: null, ...extra,
})

test('addNotice 和 localDay 在 runs.js，worker.js 重新导出同一份', () => {
  assert.equal(runs.addNotice, addNotice)
  assert.equal(runs.localDay, localDay)
})

test('放入 mine/ 后候选稿被标为已发，下一轮也不再为它写 drafts 文件', async () => {
  const { worker, store, ex, settings } = await setup()
  await settings.update({ ownHandle: 'me_x' })
  await store.mutate('seed', s => { s.candidates.push(cand('c_sent1')) }, { undoable: false })
  await mineFile(ex, 'a.json')
  await worker.tick()
  let s = await store.read()
  const c = s.candidates[0]
  assert.equal(c.status, 'sent')
  assert.equal(c.sentText, A_SMALL)
  assert.equal(c.sentPostId, ID)
  assert.equal(s.mine.length, 1)
  assert.equal(s.mine[0].candidateId, 'c_sent1')
  assert.equal(s.mine[0].url, `https://x.com/me_x/status/${ID}`)
  assert.deepEqual(await readdir(join(ex.root, 'drafts')), [])
  await worker.tick()
  assert.deepEqual(await readdir(join(ex.root, 'drafts')), [])
  assert.equal(store.undo.length, 0)
  s = await store.read()
  assert.equal(s.mine.length, 1)
})

test('Review Focus 1：同一条实发内容再次出现只更新互动数，文字和配对不变；更早的读取被忽略', async () => {
  const { worker, store, ex } = await setup()
  await store.mutate('seed', s => { s.candidates.push(cand('c_sent1')) }, { undoable: false })
  await mineFile(ex, 'a.json')
  await worker.tick()
  const first = structuredClone((await store.read()).mine[0])
  await mineFile(ex, 'b.json', { text: '完全不同的文字', metrics: { likes: 10, replies: 20, reposts: 30, quotes: 40, views: 500 }, fetchedAt: iso(NOW, -5) })
  await worker.tick()
  let s = await store.read()
  assert.equal(s.mine.length, 1)
  assert.deepEqual(
    { ...s.mine[0], likes: 0 },
    { ...first, likes: 0, replies: 20, reposts: 30, quotes: 40, views: 500, fetchedAt: iso(NOW, -5) },
  )
  assert.equal(s.mine[0].likes, 10)
  assert.equal(s.mine[0].text, A_SMALL)
  assert.equal(s.mine[0].candidateId, 'c_sent1')
  assert.equal(s.candidates[0].sentText, A_SMALL)
  await mineFile(ex, 'c.json', { metrics: { likes: 99, replies: 0, reposts: 0, quotes: 0, views: 0 }, fetchedAt: iso(NOW, -50) })
  await worker.tick()
  s = await store.read()
  assert.equal(s.mine[0].likes, 10)
  assert.equal(s.mine[0].fetchedAt, iso(NOW, -5))
})

test('粉丝序列：一天一条，取当天 fetchedAt 最晚的值，与文件顺序无关；只存 day/count/at', async () => {
  const { worker, store, ex } = await setup()
  await mineFile(ex, 'a.json', { postId: '1856000000000000001', fetchedAt: '2026-11-11T09:00:00+08:00', followers: 100 })
  await mineFile(ex, 'b.json', { postId: '1856000000000000002', fetchedAt: '2026-11-11T10:00:00+08:00', followers: 120 })
  await mineFile(ex, 'c.json', { postId: '1856000000000000003', fetchedAt: '2026-11-11T08:00:00+08:00', followers: 90 })
  await mineFile(ex, 'd.json', { postId: '1856000000000000004', fetchedAt: '2026-11-10T23:30:00+08:00', followers: 80 })
  await mineFile(ex, 'e.json', { postId: '1856000000000000005', fetchedAt: '2026-11-11T10:30:00+08:00' })
  await worker.tick()
  let s = await store.read()
  assert.deepEqual(s.followers.map(f => Object.keys(f).sort()), [['at', 'count', 'day'], ['at', 'count', 'day']])
  assert.deepEqual(s.followers.map(f => [f.day, f.count]), [['2026-11-10', 80], ['2026-11-11', 120]])
  // 之后读到同一天更晚的值才会覆盖；更早的不会
  await mineFile(ex, 'f.json', { postId: '1856000000000000006', fetchedAt: '2026-11-11T07:00:00+08:00', followers: 1 })
  await mineFile(ex, 'g.json', { postId: '1856000000000000007', fetchedAt: '2026-11-11T10:45:00+08:00', followers: 130 })
  await worker.tick()
  s = await store.read()
  assert.deepEqual(s.followers.map(f => [f.day, f.count]), [['2026-11-10', 80], ['2026-11-11', 130]])
})

test('replies/ 重复文件不重复入库；notifiedAt 不同算另一次起草', async () => {
  const { worker, store, ex } = await setup()
  await replyFile(ex, 'a.json')
  await replyFile(ex, 'b.json')
  await worker.tick()
  let s = await store.read()
  assert.equal(s.replyDrafts.length, 1)
  assert.match(s.replyDrafts[0].id, /^r_/)
  assert.equal(s.replyDrafts[0].sentText, null)
  await replyFile(ex, 'c.json')
  await replyFile(ex, 'd.json', { notifiedAt: iso(NOW, -10) })
  await worker.tick()
  s = await store.read()
  assert.equal(s.replyDrafts.length, 2)
  assert.equal(new Set(s.replyDrafts.map(r => r.id)).size, 2)
})

test('回复：自己发出的 reply 配上起草记录，replyDrafts 记下实发文字', async () => {
  const { worker, store, ex } = await setup()
  await replyFile(ex, 'a.json')
  await mineFile(ex, 'm.json', { kind: 'reply', text: '草稿一，改了几个字', inReplyTo: { handle: 'karpathy', postId: '1855000000000000001' } })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.replyDrafts[0].sentText, '草稿一，改了几个字')
  assert.equal(s.mine[0].replyId, s.replyDrafts[0].id)
})

test('保留期：mine 180 天、replyDrafts 90 天、followers 400 天', async () => {
  const { worker, store } = await setup()
  const day = n => iso(NOW, -n * 1440)
  const row = (id, postedAt) => ({ id, kind: 'post', text: 'x', url: null, postedAt, fetchedAt: postedAt, likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0, inReplyTo: null, candidateId: null, replyId: null })
  await store.mutate('seed', s => {
    s.mine = [row('1856000000000000011', day(181)), row('1856000000000000012', day(179))]
    s.replyDrafts = [
      { id: 'r_old', toHandle: 'a', toPostId: '1', drafts: ['x'], notifiedAt: day(91), sentText: null, sentAt: null },
      { id: 'r_new', toHandle: 'a', toPostId: '2', drafts: ['x'], notifiedAt: day(89), sentText: null, sentAt: null },
    ]
    s.followers = [{ day: localDay(new Date(NOW - 401 * 86400e3)), count: 1, at: day(401) }, { day: localDay(new Date(NOW - 399 * 86400e3)), count: 2, at: day(399) }]
  }, { undoable: false })
  await worker.tick()
  const s = await store.read()
  assert.deepEqual(s.mine.map(m => m.id), ['1856000000000000012'])
  assert.deepEqual(s.replyDrafts.map(r => r.id), ['r_new'])
  assert.deepEqual(s.followers.map(f => f.count), [2])
})

test('learnDaily 抛错：只记一条提示，本轮其余步骤照常完成', async () => {
  const learn = { learnDaily: async () => { throw new Error('学习炸了') } }
  const { worker, store, ex } = await setup({ learn })
  await store.mutate('seed', s => { s.candidates.push(cand('c_keep1')) }, { undoable: false })
  await mineFile(ex, 'a.json', { followers: 7 })
  assert.deepEqual(await worker.tick(), { ran: true })
  const s = await store.read()
  assert.ok(s.runs.notices.some(n => n.text.includes('学习炸了')))
  assert.equal(s.mine.length, 1)
  assert.equal(s.followers.length, 1)
  assert.ok((await readdir(join(ex.root, 'voice'))).includes('SKILL.md'))
})

test('默认没有学习和长文：旧的构造方式照常工作', async () => {
  const { worker } = await setup({ now: MONDAY })
  assert.deepEqual(await worker.tick(), { ran: true })
})

test('learnDaily 每轮在每日成稿之后调用', async () => {
  const order = []
  const learn = { learnDaily: async () => { order.push('learn') } }
  const { worker, store } = await setup({ learn, composed: false })
  const orig = worker.composer.composeDaily.bind(worker.composer)
  worker.composer.composeDaily = async o => { order.push('compose'); return orig(o) }
  await worker.tick()
  assert.deepEqual(order, ['compose', 'learn'])
  assert.equal(store.undo.length, 0)
})

function fakeLongform(result = { created: 2, error: null }) {
  const calls = []
  return { calls, suggest: async opts => { calls.push(opts); if (result instanceof Error) throw result; return result } }
}

test('长文周建议：只在周一、成稿尝试之后、每周一次；用 undoable:false', async () => {
  assert.equal(MONDAY.getDay(), 1)
  const lf = fakeLongform()
  // 周三不跑
  const wed = await setup({ longform: lf })
  await wed.worker.tick()
  assert.equal(lf.calls.length, 0)
  // 周一但今天还没成稿：不跑
  const early = await setup({ now: MONDAY, longform: lf, composed: false })
  early.worker.composer.composeDaily = async () => ({ ok: false })
  await early.store.mutate('t', s => { s.runs.lastComposeDay = '2026-11-15' }, { undoable: false })
  await early.worker.tick()
  assert.equal(lf.calls.length, 0)
  // 周一且已成稿：跑一次，之后同一周不再跑
  const mon = await setup({ now: MONDAY, longform: lf })
  await mon.worker.tick()
  await mon.worker.tick()
  assert.deepEqual(lf.calls, [{ undoable: false }])
  assert.equal((await mon.store.read()).runs.lastLongformWeek, '2026-W47')
  assert.equal(mon.store.undo.length, 0)
  // 下一周的周一再跑
  mon.clock.t = new Date('2026-11-23T11:05:00+08:00')
  await mon.store.mutate('t', s => { s.runs.lastComposeDay = '2026-11-23' }, { undoable: false })
  await mon.worker.tick()
  assert.equal(lf.calls.length, 2)
  assert.equal((await mon.store.read()).runs.lastLongformWeek, '2026-W48')
})

test('长文周建议：没有素材（返回 error）或抛错，本周都算过，不会整天每分钟重试', async () => {
  const none = fakeLongform({ created: 0, error: '还没有足够的内容来建议长文选题' })
  const a = await setup({ now: MONDAY, longform: none })
  await a.worker.tick()
  await a.worker.tick()
  assert.equal(none.calls.length, 1)
  assert.equal((await a.store.read()).runs.lastLongformWeek, '2026-W47')
  const boom = fakeLongform(new Error('长文炸了'))
  const b = await setup({ now: MONDAY, longform: boom })
  await b.worker.tick()
  await b.worker.tick()
  assert.equal(boom.calls.length, 1)
  const s = await b.store.read()
  assert.equal(s.runs.lastLongformWeek, '2026-W47')
  assert.ok(s.runs.notices.some(n => n.text.includes('长文炸了')))
})

test('每个新阶段前都续锁：锁被接管时本轮停止，没读到的文件下轮还在', async () => {
  let n = 0
  const lock = { acquire: async () => (n += 1) === 1, release: async () => {} }
  const learn = { learnDaily: async () => { throw new Error('不该被调用') } }
  const { worker, store, ex } = await setup({ lock, learn })
  await mineFile(ex, 'a.json')
  assert.deepEqual(await worker.tick(), { ran: true, aborted: true })
  const s = await store.read()
  assert.equal(s.mine.length, 0)
  assert.ok(s.runs.notices.some(x => x.text === '后台处理被另一个进程接管，本轮已停止'))
  assert.ok(!s.runs.notices.some(x => x.text.includes('不该被调用')))
})

test('学习阶段之前锁被接管：不调用 learnDaily', async () => {
  // acquire 调用顺序：开头 1，读入 mine 2、replies 3、配对 4，成稿 5，学习 6
  let n = 0
  const lock = { acquire: async () => (n += 1) < 6, release: async () => {} }
  let called = 0
  const learn = { learnDaily: async () => { called += 1 } }
  const { worker } = await setup({ lock, learn })
  assert.deepEqual(await worker.tick(), { ran: true, aborted: true })
  assert.equal(called, 0)
})

test('停止后（热重载留下的旧实例）新阶段一个都不跑', async () => {
  const learn = { learnDaily: async () => { throw new Error('不该被调用') } }
  const { worker, store, ex } = await setup({ learn })
  await mineFile(ex, 'a.json')
  worker.stopped = true
  assert.deepEqual(await worker.tick(), { ran: false })
  assert.equal((await store.read()).mine.length, 0)
})

test('addNotice 仍可用', () => {
  const s = { runs: { notices: [] } }
  addNotice(s, '一条', NOW)
  assert.equal(s.runs.notices.length, 1)
})

const FUTURE = '2099-01-01T00:00:00Z'
const minute = (n, from = NOW) => new Date(from.getTime() + n * 60_000)

test('fetchedAt 在 2099：存下来的是"现在"，之后真实的读取照常更新互动数', async () => {
  const { worker, store, ex, clock } = await setup()
  await mineFile(ex, 'a.json', { fetchedAt: FUTURE })
  await worker.tick()
  let s = await store.read()
  assert.equal(s.mine[0].fetchedAt, NOW.toISOString())
  assert.equal(s.mine[0].likes, 1)
  clock.t = minute(5)
  await mineFile(ex, 'b.json', { fetchedAt: minute(4).toISOString(), metrics: { likes: 9, replies: 2, reposts: 3, quotes: 4, views: 50 } })
  await worker.tick()
  s = await store.read()
  assert.equal(s.mine[0].likes, 9)
  assert.equal(s.mine[0].fetchedAt, minute(4).toISOString())
})

test('粉丝数读取时间在 2099：不产生未来的日期，复盘里的当前粉丝数是真实的最新值', async () => {
  const { worker, store, ex, clock } = await setup()
  await mineFile(ex, 'a.json', { fetchedAt: FUTURE, followers: 999 })
  await worker.tick()
  let s = await store.read()
  assert.deepEqual(s.followers.map(f => f.day), [TODAY])
  assert.equal(s.followers[0].at, NOW.toISOString())
  clock.t = minute(5)
  await mineFile(ex, 'b.json', { postId: '1856000000000000002', fetchedAt: minute(4).toISOString(), followers: 1234 })
  await worker.tick()
  s = await store.read()
  assert.deepEqual(s.followers.map(f => [f.day, f.count]), [[TODAY, 1234]])
  assert.equal(computeInsights(s, clock.t).followers.now, 1234)
})

test('postedAt 比现在晚 10 分钟：不收、只记一条提示、文件不算处理过；时间到了之后被收下', async () => {
  const { worker, store, ex, clock } = await setup()
  await mineFile(ex, 'a.json', { postedAt: minute(10).toISOString(), fetchedAt: minute(10).toISOString(), followers: 5 })
  await worker.tick()
  await worker.tick()
  let s = await store.read()
  assert.equal(s.mine.length, 0)
  assert.equal(s.followers.length, 0)
  assert.deepEqual(s.runs.notices.filter(n => n.text.includes('时间比现在还晚')).map(n => n.text), ['有 1 条内容的时间比现在还晚，先不收'])
  clock.t = minute(11)
  await worker.tick()
  s = await store.read()
  assert.equal(s.mine.length, 1)
  assert.equal(s.mine[0].id, ID)
  assert.equal(s.followers.length, 1)
})

test('postedAt 只比现在晚 2 分钟：正常收下', async () => {
  const { worker, store, ex } = await setup()
  await mineFile(ex, 'a.json', { postedAt: minute(2).toISOString(), fetchedAt: minute(2).toISOString() })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.mine.length, 1)
  assert.equal(s.mine[0].fetchedAt, NOW.toISOString())
  assert.ok(!s.runs.notices.some(n => n.text.includes('时间比现在还晚')))
})

test('回复草稿的 notifiedAt 比现在晚 10 分钟：不收、记提示、之后收下；晚 2 分钟直接收', async () => {
  const { worker, store, ex, clock } = await setup()
  await replyFile(ex, 'a.json', { notifiedAt: minute(10).toISOString() })
  await replyFile(ex, 'b.json', { toPostId: '1855000000000000002', notifiedAt: minute(2).toISOString() })
  await worker.tick()
  let s = await store.read()
  assert.deepEqual(s.replyDrafts.map(r => r.toPostId), ['1855000000000000002'])
  assert.ok(s.runs.notices.some(n => n.text === '有 1 条回复草稿的时间比现在还晚，先不收'))
  clock.t = minute(11)
  await worker.tick()
  s = await store.read()
  assert.equal(s.replyDrafts.length, 2)
})

test('保留期之外：比现在还晚的记录被丢；条数封顶时先丢最旧的', async () => {
  const { worker, store } = await setup()
  const row = (i, postedAt) => ({ id: `18560000000${String(i).padStart(8, '0')}`, kind: 'post', text: 'x', url: null, postedAt, fetchedAt: postedAt, likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0, inReplyTo: null, candidateId: null, replyId: null })
  await store.mutate('seed', s => {
    s.mine = Array.from({ length: MAX_MINE + 1 }, (_, i) => row(i, iso(NOW, -(i + 1))))
    s.mine.push(row(99999, iso(NOW, 60)))
    s.replyDrafts = Array.from({ length: MAX_REPLY_DRAFTS + 1 }, (_, i) => ({ id: `r_${i}`, toHandle: 'a', toPostId: '1', drafts: ['x'], notifiedAt: iso(NOW, -(i + 1)), sentText: null, sentAt: null }))
    s.replyDrafts.push({ id: 'r_future', toHandle: 'a', toPostId: '1', drafts: ['x'], notifiedAt: iso(NOW, 60), sentText: null, sentAt: null })
    s.followers = [{ day: '2026-11-12', count: 5, at: iso(NOW, 1440) }, { day: TODAY, count: 7, at: iso(NOW) }]
  }, { undoable: false })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.mine.length, MAX_MINE)
  assert.ok(!s.mine.some(m => m.id.endsWith('99999')))
  assert.ok(!s.mine.some(m => m.id === row(MAX_MINE, '').id), '最旧的一条被丢')
  assert.ok(s.mine.some(m => m.id === row(MAX_MINE - 1, '').id))
  assert.equal(s.replyDrafts.length, MAX_REPLY_DRAFTS)
  assert.ok(!s.replyDrafts.some(r => r.id === 'r_future' || r.id === `r_${MAX_REPLY_DRAFTS}`))
  assert.deepEqual(s.followers.map(f => f.day), [TODAY])
})

test('matchSent 抛错不会跳过候选稿过期；每一步各自记提示', async () => {
  const { worker, store } = await setup()
  await store.mutate('seed', s => {
    s.candidates.push(cand('c_old', { createdAt: '2026-11-01T00:00:00.000Z' }))
    s.replyDrafts = [null]
    s.mine = [{ id: ID, kind: 'reply', text: 'x', url: null, postedAt: iso(NOW, -5), fetchedAt: iso(NOW, -5), likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0, inReplyTo: { handle: 'a', postId: '1' }, candidateId: null, replyId: null }]
  }, { undoable: false })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.candidates[0].status, 'expired')
  assert.ok(s.runs.notices.some(n => n.text.startsWith('识别已发内容出错')))
})
