process.env.TZ = 'Asia/Shanghai'
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, similarity, matchSent, editPairs } from '../src/match.js'

const A = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键是看你自己的场景。'
const A_SMALL = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键看自己的场景。'
const A_REWRITE = '模型评测的榜单分数越来越高，真实任务里差距并不大，最终还是要看自己的场景。'
const OTHER = '周末去爬山，天气很好，拍了很多照片，晚上和朋友吃了火锅。'
const B = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距没那么大，关键还是看自己的场景，别迷信排名。'
const B_SMALL = '今天聊聊模型评测：榜单分数越来越高，真实任务里的表现差距没那么大，关键还是看自己的场景，别迷信排名啊。'

const NOW = Date.parse('2026-11-12T12:00:00+08:00')
const iso = (s) => new Date(Date.parse(s)).toISOString()
const cand = (id, text, createdAt, extra = {}) => ({
  id, form: 'post', typeId: 't_model', text, aiText: text, title: '', sourcePostIds: [], sourceNoteId: null,
  quoteUrl: null, reason: '', score: 1, status: 'pending', createdAt: iso(createdAt), scheduledAt: null,
  decidedAt: null, discardReason: null, view: 'draft', revision: 1, image: null, imageAt: null,
  sentText: null, sentPostId: null, sentAt: null, ...extra,
})
const mine = (id, text, postedAt, extra = {}) => ({
  id, kind: 'post', text, url: null, postedAt: iso(postedAt), fetchedAt: iso(postedAt),
  likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0, inReplyTo: null, candidateId: null, replyId: null, ...extra,
})
const st = (o = {}) => ({ candidates: [], mine: [], replyDrafts: [], ...o })

test('normalizeText 去网址、@账号、#号，压空白，转小写，NFKC', () => {
  assert.equal(normalizeText('  Hello  @karpathy   https://x.com/a/b?c=1 #AI  World  '), 'hello ai world')
  assert.equal(normalizeText('ＡＢＣ'), 'abc')
  assert.equal(normalizeText(null), '')
})

test('similarity 基本性质', () => {
  assert.equal(similarity('今天聊聊模型评测', '今天聊聊模型评测'), 1)
  assert.equal(similarity('今天聊聊模型评测', '今天聊聊模型评测 https://t.co/abc'), 1)
  assert.equal(similarity('今天聊聊模型评测', '@someone 今天聊聊模型评测'), 1)
  assert.ok(similarity(A, OTHER) < 0.2)
  assert.equal(similarity('', A), 0)
  assert.equal(similarity(A, ''), 0)
  assert.equal(similarity('', ''), 0)
  assert.equal(similarity('https://x.com/a', ''), 0)
  assert.equal(similarity('好', '好'), 1)
  assert.equal(similarity('好', '坏'), 0)
  assert.equal(similarity('😀😀', '😀😀'), 1)
  assert.ok(!Number.isNaN(similarity('😀', 'a')))
})

test('小改后仍配上，候选稿变 sent 并记下实发文字', () => {
  assert.ok(similarity(A, A_SMALL) > 0.7)
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T09:00:00+08:00', { status: 'approved' })],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00')],
  })
  const r = matchSent(s, { now: NOW })
  assert.equal(r.changed, 1)
  const c = s.candidates[0]
  assert.equal(c.status, 'sent')
  assert.equal(c.sentText, A_SMALL)
  assert.equal(c.sentPostId, 'm1')
  assert.equal(c.sentAt, s.mine[0].postedAt)
  assert.equal(c.decidedAt, s.mine[0].postedAt)
  assert.equal(s.mine[0].candidateId, 'c_1')
})

test('已有 decidedAt 保留；已是 sent 的候选稿仍记录实发内容', () => {
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T09:00:00+08:00', { status: 'sent', decidedAt: iso('2026-11-12T09:30:00+08:00') })],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00')],
  })
  matchSent(s, { now: NOW })
  assert.equal(s.candidates[0].decidedAt, iso('2026-11-12T09:30:00+08:00'))
  assert.equal(s.candidates[0].status, 'sent')
  assert.equal(s.candidates[0].sentPostId, 'm1')
})

test('改得面目全非不配对；无关内容保持 candidateId null', () => {
  const sim = similarity(A, A_REWRITE)
  assert.ok(sim > 0.2 && sim < 0.55, `sim=${sim}`)
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T09:00:00+08:00', { status: 'approved' })],
    mine: [mine('m1', A_REWRITE, '2026-11-12T10:00:00+08:00'), mine('m2', OTHER, '2026-11-12T10:30:00+08:00')],
  })
  const before = JSON.stringify(s.candidates)
  assert.equal(matchSent(s, { now: NOW }).changed, 0)
  assert.equal(JSON.stringify(s.candidates), before)
  assert.equal(s.mine[0].candidateId, null)
  assert.equal(s.mine[1].candidateId, null)
})

test('两条相似候选稿、一条实发：只配最像的', () => {
  const sa = similarity(A_SMALL, A)
  const sb = similarity(A_SMALL, B)
  assert.ok(sb >= 0.55 && sb < sa, `sa=${sa} sb=${sb}`)
  const s = st({
    candidates: [
      cand('c_b', B, '2026-11-12T08:00:00+08:00'),
      cand('c_a', A, '2026-11-12T09:00:00+08:00'),
    ],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00')],
  })
  assert.equal(matchSent(s, { now: NOW }).changed, 1)
  const byId = Object.fromEntries(s.candidates.map(c => [c.id, c]))
  assert.equal(byId.c_a.status, 'sent')
  assert.equal(byId.c_b.status, 'pending')
  assert.equal(byId.c_b.sentText, null)
  assert.equal(byId.c_b.sentPostId, null)
})

test('两条实发与两条候选稿交叉相似：按相似度从高到低贪心分配', () => {
  const m1c1 = similarity(A_SMALL, A)
  const m1c2 = similarity(A_SMALL, B)
  const m2c1 = similarity(B_SMALL, A)
  const m2c2 = similarity(B_SMALL, B)
  for (const v of [m1c1, m1c2, m2c1, m2c2]) assert.ok(v >= 0.55)
  assert.ok(m1c1 + m2c2 > m1c2 + m2c1, '同类配对的总和更高')
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T08:00:00+08:00'), cand('c_2', B, '2026-11-12T08:10:00+08:00')],
    mine: [mine('m_1', A_SMALL, '2026-11-12T10:00:00+08:00'), mine('m_2', B_SMALL, '2026-11-12T11:00:00+08:00')],
  })
  assert.equal(matchSent(s, { now: NOW }).changed, 2)
  assert.equal(s.mine[0].candidateId, 'c_1')
  assert.equal(s.mine[1].candidateId, 'c_2')
  assert.equal(s.candidates[0].sentPostId, 'm_1')
  assert.equal(s.candidates[1].sentPostId, 'm_2')
})

test('已丢弃、已过期不参与；时间窗口外不参与', () => {
  const s = st({
    candidates: [
      cand('c_d', A, '2026-11-12T09:00:00+08:00', { status: 'discarded' }),
      cand('c_e', A, '2026-11-12T09:00:00+08:00', { status: 'expired' }),
      cand('c_late', A, '2026-11-12T10:10:00+08:00'),        // 晚于发帖 10 分钟
      cand('c_old', A, '2026-11-08T09:59:00+08:00'),         // 早于发帖 96 小时之外
    ],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00')],
  })
  assert.equal(matchSent(s, { now: NOW }).changed, 0)
  assert.deepEqual(s.candidates.map(c => c.status), ['discarded', 'expired', 'pending', 'pending'])
  assert.equal(s.mine[0].candidateId, null)
})

test('时间窗口边界：发帖前 96 小时内、发帖后 5 分钟内的时钟误差都可配', () => {
  const s = st({
    candidates: [
      cand('c_edge', A, '2026-11-08T10:01:00+08:00'),
      cand('c_skew', B, '2026-11-12T10:04:00+08:00'),
    ],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00'), mine('m2', B_SMALL, '2026-11-12T10:00:00+08:00')],
  })
  assert.equal(matchSent(s, { now: NOW }).changed, 2)
})

test('同一状态连续调用两次，第二次 changed 为 0 且状态不变', () => {
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T09:00:00+08:00'), cand('c_2', B, '2026-11-12T09:05:00+08:00')],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00')],
    replyDrafts: [{ id: 'r_1', toHandle: 'k', toPostId: '10', drafts: ['好的', '收到'], notifiedAt: iso('2026-11-12T09:00:00+08:00'), sentText: null, sentAt: null }],
  })
  s.mine.push(mine('m2', '收到啦', '2026-11-12T09:30:00+08:00', { kind: 'reply', inReplyTo: { handle: 'k', postId: '10' } }))
  assert.equal(matchSent(s, { now: NOW }).changed, 2)
  const snap = structuredClone(s)
  assert.equal(matchSent(s, { now: NOW }).changed, 0)
  assert.deepEqual(s, snap)
})

test('同一条实发内容被重复读入（互动数不同）时只配一次', () => {
  // mine 以 id 去重后只有一条；即便调用方传入同 id 的新旧值，配对结果也不变
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T09:00:00+08:00')],
    mine: [mine('m1', A_SMALL, '2026-11-12T10:00:00+08:00', { likes: 3 })],
  })
  matchSent(s, { now: NOW })
  s.mine[0].likes = 99
  assert.equal(matchSent(s, { now: NOW }).changed, 0)
  assert.equal(s.candidates[0].sentPostId, 'm1')
})

test('回复按 toPostId 配对，同一帖子取 notifiedAt 最近且不晚于发出时间的草稿', () => {
  const draft = (id, post, at, extra = {}) => ({
    id, toHandle: 'karpathy', toPostId: post, drafts: [`${id} 草稿一`, `${id} 草稿二`],
    notifiedAt: iso(at), sentText: null, sentAt: null, ...extra,
  })
  const s = st({
    replyDrafts: [
      draft('r_old', '10', '2026-11-12T08:00:00+08:00'),
      draft('r_new', '10', '2026-11-12T09:00:00+08:00'),
      draft('r_future', '10', '2026-11-12T11:00:00+08:00'),
      draft('r_other', '20', '2026-11-12T09:30:00+08:00'),
      draft('r_used', '10', '2026-11-12T09:50:00+08:00', { sentText: 'x', sentAt: iso('2026-11-12T09:55:00+08:00') }),
    ],
    mine: [
      mine('m1', '完全重写的回复内容', '2026-11-12T10:00:00+08:00', { kind: 'reply', inReplyTo: { handle: 'karpathy', postId: '10' } }),
      mine('m2', '没有草稿的回复', '2026-11-12T10:00:00+08:00', { kind: 'reply', inReplyTo: { handle: 'karpathy', postId: '99' } }),
    ],
  })
  assert.equal(matchSent(s, { now: NOW }).changed, 1)
  const byId = Object.fromEntries(s.replyDrafts.map(d => [d.id, d]))
  assert.equal(byId.r_new.sentText, '完全重写的回复内容')
  assert.equal(byId.r_new.sentAt, s.mine[0].postedAt)
  assert.equal(s.mine[0].replyId, 'r_new')
  assert.equal(byId.r_old.sentText, null)
  assert.equal(byId.r_future.sentText, null)
  assert.equal(byId.r_other.sentText, null)
  assert.equal(s.mine[1].replyId, null)
})

test('editPairs：改过的候选稿与回复；未改动的不收', () => {
  const s = st({
    candidates: [
      cand('c_1', A, '2026-11-12T09:00:00+08:00', { status: 'sent', sentText: A_SMALL, sentPostId: 'm1', sentAt: iso('2026-11-12T12:00:00+08:00') }),
      cand('c_same', B, '2026-11-12T09:00:00+08:00', { status: 'sent', sentText: B, sentPostId: 'm2', sentAt: iso('2026-11-12T10:00:00+08:00') }),
      cand('c_none', A, '2026-11-12T09:00:00+08:00'),
    ],
    replyDrafts: [
      { id: 'r_1', toHandle: 'k', toPostId: '10', drafts: ['这个观点我同意，评测确实要看场景', '谢谢分享，学到了'], notifiedAt: iso('2026-11-12T08:00:00+08:00'), sentText: '这个观点我同意，评测确实要看自己的场景', sentAt: iso('2026-11-12T11:00:00+08:00') },
      { id: 'r_2', toHandle: 'k', toPostId: '11', drafts: ['哈哈'], notifiedAt: iso('2026-11-12T08:00:00+08:00'), sentText: null, sentAt: null },
      { id: 'r_3', toHandle: 'k', toPostId: '12', drafts: ['完全一样'], notifiedAt: iso('2026-11-12T08:00:00+08:00'), sentText: '完全一样', sentAt: iso('2026-11-12T09:00:00+08:00') },
    ],
  })
  const pairs = editPairs(s)
  assert.deepEqual(pairs, [
    { aiText: '这个观点我同意，评测确实要看场景', sentText: '这个观点我同意，评测确实要看自己的场景', kind: 'reply' },
    { aiText: A, sentText: A_SMALL, kind: 'post' },
  ])
})
