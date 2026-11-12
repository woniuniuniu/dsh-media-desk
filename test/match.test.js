process.env.TZ = 'Asia/Shanghai'
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, similarity, matchSent, editPairs, STRONG, MIN, GAP, SHORT } from '../src/match.js'

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

test('配对后互动数变了再调用 matchSent：配对结果不变，changed 为 0', () => {
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

// ---- 阈值与误配防护 ----
const tailOf = (k) => Array.from(A).slice(0, k).join('') + '，所以我现在选模型先跑自己的十道题。'
const one = (c, m) => st({ candidates: c, mine: [m] })

test('常量', () => {
  assert.deepEqual([STRONG, MIN, GAP, SHORT], [0.8, 0.55, 0.1, 12])
})

test('阈值 0.55：略低于不配，略高于配', () => {
  const below = tailOf(30), above = tailOf(34)
  const sb = similarity(A, below), sa = similarity(A, above)
  assert.ok(sb >= 0.50 && sb <= 0.54, `below=${sb}`)
  assert.ok(sa >= 0.56 && sa <= 0.60, `above=${sa}`)
  const s1 = one([cand('c_1', below, '2026-11-12T09:00:00+08:00')], mine('m1', A, '2026-11-12T10:00:00+08:00'))
  assert.equal(matchSent(s1, { now: NOW }).changed, 0)
  assert.equal(s1.candidates[0].status, 'pending')
  const s2 = one([cand('c_1', above, '2026-11-12T09:00:00+08:00')], mine('m1', A, '2026-11-12T10:00:00+08:00'))
  assert.equal(matchSent(s2, { now: NOW }).changed, 1)
})

test('同模板的两条候选稿分数接近：一条都不配', () => {
  const x = tailOf(40), y = tailOf(36)
  const sx = similarity(A, x), sy = similarity(A, y)
  assert.ok(sx >= 0.55 && sx <= 0.75 && sx < STRONG, `sx=${sx}`)
  assert.ok(sx - sy > 0 && sx - sy < GAP, `sx=${sx} sy=${sy}`)
  for (const order of [[x, y], [y, x]]) {
    const cs = order.map((t, i) => cand(`c_${i}`, t, '2026-11-12T09:00:00+08:00'))
    const s = one(cs, mine('m1', A, '2026-11-12T10:00:00+08:00'))
    assert.equal(matchSent(s, { now: NOW }).changed, 0)
    assert.ok(s.candidates.every(c => c.status === 'pending' && c.sentText === null))
  }
})

test('最高分比第二名高出 0.1 以上：配上最高的，与数组顺序无关', () => {
  const x = tailOf(42), y = tailOf(34)
  const sx = similarity(A, x), sy = similarity(A, y)
  assert.ok(sx >= 0.55 && sx < STRONG && sx - sy >= GAP, `sx=${sx} sy=${sy}`)
  for (const order of [[['c_x', x], ['c_y', y]], [['c_y', y], ['c_x', x]]]) {
    const s = one(order.map(([id, t]) => cand(id, t, '2026-11-12T09:00:00+08:00')), mine('m1', A, '2026-11-12T10:00:00+08:00'))
    assert.equal(matchSent(s, { now: NOW }).changed, 1)
    const byId = Object.fromEntries(s.candidates.map(c => [c.id, c]))
    assert.equal(byId.c_x.status, 'sent')
    assert.equal(byId.c_y.status, 'pending')
    assert.equal(byId.c_y.sentPostId, null)
  }
})

test('短文字（不足 12 字）：0.6 左右不配，0.8 以上才配', () => {
  const short = '今天模型发布了新版本'
  const mid = '今天模型发布了新功能', hi = '今天模型发布了新版'
  assert.ok(Array.from(normalizeText(short)).length < SHORT)
  const sm = similarity(short, mid), sh = similarity(short, hi)
  assert.ok(sm >= 0.55 && sm < 0.7, `sm=${sm}`)
  assert.ok(sh >= STRONG, `sh=${sh}`)
  const s1 = one([cand('c_1', mid, '2026-11-12T09:00:00+08:00')], mine('m1', short, '2026-11-12T10:00:00+08:00'))
  assert.equal(matchSent(s1, { now: NOW }).changed, 0)
  const s2 = one([cand('c_1', hi, '2026-11-12T09:00:00+08:00')], mine('m1', short, '2026-11-12T10:00:00+08:00'))
  assert.equal(matchSent(s2, { now: NOW }).changed, 1)
})

test('Review Focus 3：同一稿的两个近似版本，最像的靠 STRONG 配上，另一条原样；与顺序无关', () => {
  const hi = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键是看自己的场景。'
  const lo = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键看自己的场景。'
  const sh = similarity(A, hi), sl = similarity(A, lo)
  assert.ok(sh > sl && sl >= 0.8 && sh >= 0.9, `hi=${sh} lo=${sl}`)
  for (const order of [[['c_hi', hi], ['c_lo', lo]], [['c_lo', lo], ['c_hi', hi]]]) {
    const s = one(order.map(([id, t]) => cand(id, t, '2026-11-12T09:00:00+08:00')), mine('m1', A, '2026-11-12T10:00:00+08:00'))
    assert.equal(matchSent(s, { now: NOW }).changed, 1)
    const byId = Object.fromEntries(s.candidates.map(c => [c.id, c]))
    assert.equal(byId.c_hi.status, 'sent')
    assert.equal(byId.c_lo.status, 'pending')
    assert.equal(byId.c_lo.sentText, null)
  }
})

test('editPairs：sentText 为空字符串的回复和候选稿都跳过', () => {
  const s = st({
    candidates: [cand('c_1', A, '2026-11-12T09:00:00+08:00', { status: 'sent', sentText: '', sentPostId: 'm1', sentAt: iso('2026-11-12T10:00:00+08:00') })],
    replyDrafts: [{ id: 'r_1', toHandle: 'k', toPostId: '10', drafts: ['好的'], notifiedAt: iso('2026-11-12T08:00:00+08:00'), sentText: '', sentAt: iso('2026-11-12T09:00:00+08:00') }],
  })
  assert.deepEqual(editPairs(s), [])
})

// 用共同的"核心"加上各自的尾巴，精确控制相似度
const seq = (start, n) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + start + i)).join('')
const CORE = seq(0, 29)
const withTail = (start, n) => CORE + seq(start, n)

test('两条实发内容抢同一条候选稿：第二名按最初的候选集合算，只有最高分的那条才可能被配', () => {
  const p1Text = withTail(100, 9) // 与 K1 完全相同
  const p2Text = withTail(300, 3)
  const run = k2Tail => {
    const k1 = cand('c_1', p1Text, '2026-11-12T09:00:00+08:00')
    const k2 = cand('c_2', withTail(200, k2Tail), '2026-11-12T09:05:00+08:00')
    const s = st({ candidates: [k1, k2], mine: [mine('m1', p1Text, '2026-11-12T10:00:00+08:00'), mine('m2', p2Text, '2026-11-12T10:05:00+08:00')] })
    return { s, r: matchSent(s, { now: NOW }), sims: [similarity(p2Text, k1.text), similarity(p2Text, k2.text)] }
  }
  // A：m2 的第一名 c_1 被 m1 抢走，它另一条候选 c_2 与第一名相差不到 GAP。
  // 如果第二名按"剩下的候选稿"重新算，c_2 会变成第一名而被误配。
  const a = run(13)
  assert.ok(a.sims[0] >= MIN && a.sims[1] >= MIN && a.sims[0] - a.sims[1] < GAP, a.sims.join())
  assert.equal(a.r.changed, 1)
  assert.equal(a.s.candidates[0].sentPostId, 'm1')
  assert.equal(a.s.candidates[1].status, 'pending')
  assert.equal(a.s.mine[1].candidateId, null)
  // B：c_2 比第一名低 GAP 以上、也不低于 MIN。只有"第一名"才能靠 MIN 配上，c_2 不行。
  const b = run(18)
  assert.ok(b.sims[1] >= MIN && b.sims[0] - b.sims[1] >= GAP, b.sims.join())
  assert.equal(b.r.changed, 1)
  assert.equal(b.s.candidates[1].status, 'pending')
  assert.equal(b.s.mine[1].candidateId, null)
})
