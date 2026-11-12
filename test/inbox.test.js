process.env.TZ = 'Asia/Shanghai'
import test from 'node:test'
import assert from 'node:assert/strict'
import { intentUrl, tweetLength, nextSlot, approve, discard, markSent, setText, expire, applyDecision, unapprove } from '../src/inbox.js'
import { applyOps } from '../src/ops.js'

const NOW = new Date('2026-11-12T10:00:00+08:00')
const SLOTS = ['09:00', '18:00']
const opts = { now: NOW, slots: SLOTS }
const cand = (id, status, extra = {}) => ({
  id, form: 'post', typeId: 't_1', text: '正文', aiText: '正文', title: '', sourcePostIds: [], sourceNoteId: null, quoteUrl: null,
  reason: '', score: 1, status, createdAt: NOW.toISOString(), scheduledAt: null, decidedAt: null, discardReason: null,
  view: null, revision: 0, image: null, ...extra,
})
const stateWith = list => ({ candidates: list })

test('发帖链接：中文、换行、# & ? 都被正确编码；引用转发带原帖链接', () => {
  const text = '第一行\n#AI & 模型？100% ?x=1 😀'
  const u = new URL(intentUrl({ form: 'post', text, quoteUrl: null }))
  assert.equal(u.origin + u.pathname, 'https://x.com/intent/tweet')
  assert.equal(u.searchParams.get('text'), text)
  assert.equal(u.searchParams.get('url'), null)
  const q = new URL(intentUrl({ form: 'quote', text: 'a', quoteUrl: 'https://x.com/karpathy/status/1855000000000000001' }))
  assert.equal(q.searchParams.get('url'), 'https://x.com/karpathy/status/1855000000000000001')
  assert.equal(q.searchParams.get('text'), 'a')
})

test('字数按 X 的方式算', () => {
  assert.equal(tweetLength('abc'), 3)
  assert.equal(tweetLength('你好'), 4)
  assert.equal(tweetLength('看 https://example.com/a/very/long/path?x=1'), 2 + 1 + 23)
  assert.equal(tweetLength('😀'), 2)
})

test('排期：依次占用时段，当天用完顺延到次日', () => {
  const s = stateWith([cand('c_aaaa', 'pending'), cand('c_bbbb', 'pending'), cand('c_cccc', 'pending')])
  for (const c of s.candidates) assert.equal(approve(s, c.id, opts), true)
  assert.deepEqual(s.candidates.map(c => c.scheduledAt), [
    new Date('2026-11-12T18:00:00+08:00').toISOString(),
    new Date('2026-11-13T09:00:00+08:00').toISOString(),
    new Date('2026-11-13T18:00:00+08:00').toISOString(),
  ])
})

test('排期：14 天内排满时仍给出第 14 天之后的第一个时段，不抛错', () => {
  const list = []
  for (let d = 0; d < 14; d++) for (const t of SLOTS) {
    const day = new Date(NOW.getTime() + d * 86400000)
    const [h, m] = t.split(':').map(Number)
    day.setHours(h, m, 0, 0)
    list.push(cand(`c_x${list.length}`, 'approved', { scheduledAt: day.toISOString() }))
  }
  const got = new Date(nextSlot(stateWith(list), SLOTS, NOW))
  assert.ok(got.getTime() > NOW.getTime() + 13 * 86400000)
  assert.equal(got.getHours(), 9)
})

test('Review Focus 5：重复通过不改排期；已丢弃的不能再通过；不存在的编号被忽略', () => {
  const s = stateWith([cand('c_aaaa', 'pending'), cand('c_bbbb', 'discarded')])
  assert.equal(approve(s, 'c_aaaa', opts), true)
  const when = s.candidates[0].scheduledAt
  assert.equal(approve(s, 'c_aaaa', opts), false)
  assert.equal(s.candidates[0].scheduledAt, when)
  assert.equal(approve(s, 'c_bbbb', opts), false)
  assert.equal(s.candidates[1].status, 'discarded')
  assert.equal(applyDecision(s, { candidateId: 'c_zzzz', action: 'approve', at: NOW.toISOString() }, opts), 'ignored')
  assert.equal(applyDecision(s, { candidateId: 'c_bbbb', action: 'approve', at: NOW.toISOString() }, opts), 'ignored')
})

test('已通过的稿子给了新时间才改排期', () => {
  const s = stateWith([cand('c_aaaa', 'pending')])
  approve(s, 'c_aaaa', opts)
  const later = new Date('2026-11-20T09:00:00+08:00').toISOString()
  assert.equal(approve(s, 'c_aaaa', { ...opts, scheduledAt: later }), true)
  assert.equal(s.candidates[0].scheduledAt, later)
  assert.equal(s.candidates[0].status, 'approved')
})

test('已发的稿子不能被丢弃或改文字', () => {
  const s = stateWith([cand('c_aaaa', 'approved')])
  assert.equal(markSent(s, 'c_aaaa', opts), true)
  assert.equal(s.candidates[0].status, 'sent')
  assert.equal(discard(s, 'c_aaaa', opts), false)
  assert.equal(setText(s, 'c_aaaa', '新的'), false)
  assert.equal(s.candidates[0].status, 'sent')
  assert.equal(s.candidates[0].text, '正文')
  assert.equal(s.candidates[0].revision, 0)
})

test('丢弃记录原因并清掉排期；改文字加修订号并截到 4000 字', () => {
  const s = stateWith([cand('c_aaaa', 'approved', { scheduledAt: NOW.toISOString() }), cand('c_bbbb', 'pending')])
  assert.equal(discard(s, 'c_aaaa', { now: NOW, reason: 'stale' }), true)
  assert.equal(s.candidates[0].discardReason, 'stale')
  assert.equal(s.candidates[0].scheduledAt, null)
  assert.equal(discard(s, 'c_bbbb', { now: NOW, reason: 'bogus' }), true)
  assert.equal(s.candidates[1].discardReason, null)
  const t = stateWith([cand('c_cccc', 'pending')])
  assert.equal(setText(t, 'c_cccc', 'x'.repeat(5000)), true)
  assert.equal(t.candidates[0].text.length, 4000)
  assert.equal(t.candidates[0].revision, 1)
})

test('48 小时未处理的候选稿过期，已通过的不受影响', () => {
  const ago = h => new Date(NOW.getTime() - h * 3600000).toISOString()
  const s = stateWith([cand('c_old1', 'pending', { createdAt: ago(49) }), cand('c_new1', 'pending', { createdAt: ago(47) }), cand('c_appr', 'approved', { createdAt: ago(60) })])
  assert.equal(expire(s, NOW), 1)
  assert.deepEqual(s.candidates.map(c => c.status), ['expired', 'pending', 'approved'])
  assert.equal(s.candidates[0].decidedAt, NOW.toISOString())
})

test('看法和修改要求交给模型处理', () => {
  const s = stateWith([cand('c_aaaa', 'pending')])
  assert.equal(applyDecision(s, { candidateId: 'c_aaaa', action: 'view', text: '我的看法' }, opts), 'needs_model')
  assert.equal(applyDecision(s, { candidateId: 'c_aaaa', action: 'revise', text: '短一点' }, opts), 'needs_model')
  assert.equal(applyDecision(s, { candidateId: 'c_zzzz', action: 'view', text: 'x' }, opts), 'ignored')
  assert.equal(s.candidates[0].status, 'pending')
})

test('操作：通过、撤回、改时间、标记已发；不允许的迁移报错且不改状态', () => {
  const s = stateWith([cand('c_aaaa', 'pending'), cand('c_bbbb', 'discarded')])
  const ctx = opts
  let r = applyOps(s, [{ op: 'approve_candidate', id: 'c_aaaa' }], ctx)
  assert.equal(r.errors.length, 0)
  assert.equal(s.candidates[0].status, 'approved')
  const when = new Date('2026-12-01T09:00:00+08:00').toISOString()
  r = applyOps(s, [{ op: 'reschedule_candidate', id: 'c_aaaa', scheduledAt: when }], ctx)
  assert.equal(s.candidates[0].scheduledAt, when)
  r = applyOps(s, [{ op: 'reschedule_candidate', id: 'c_aaaa', scheduledAt: 'nope' }], ctx)
  assert.equal(r.errors.length, 1)
  assert.equal(s.candidates[0].scheduledAt, when)
  r = applyOps(s, [{ op: 'unapprove_candidate', id: 'c_aaaa' }], ctx)
  assert.equal(s.candidates[0].status, 'pending')
  assert.equal(s.candidates[0].scheduledAt, null)
  assert.equal(s.candidates[0].decidedAt, null)
  r = applyOps(s, [{ op: 'mark_sent', id: 'c_aaaa' }], ctx)
  assert.deepEqual(r.errors, ['这条稿子现在不能这样处理'])
  r = applyOps(s, [{ op: 'approve_candidate', id: 'c_bbbb' }, { op: 'discard_candidate', id: 'c_zzzz' }], ctx)
  assert.deepEqual(r.errors, ['这条稿子现在不能这样处理', '找不到这条稿子'])
  assert.equal(s.candidates[1].status, 'discarded')
  r = applyOps(s, [{ op: 'edit_candidate', id: 'c_aaaa', text: '改过的' }, { op: 'edit_candidate', id: 'c_aaaa', text: '  ' }], ctx)
  assert.equal(s.candidates[0].text, '改过的')
  assert.equal(r.errors.length, 1)
  r = applyOps(s, [{ op: 'discard_candidate', id: 'c_aaaa', reason: 'not_me' }])
  assert.equal(s.candidates[0].discardReason, 'not_me')
})

test('safeText：按码点截断不拆开 emoji，孤立代理项换成 U+FFFD', async () => {
  const { safeText } = await import('../src/inbox.js')
  const text = 'a'.repeat(3999) + '😀' + 'tail'
  const cut = safeText(text, 4000)
  assert.equal([...cut].length, 4000)
  assert.ok(cut.endsWith('😀'))
  assert.equal(cut.isWellFormed(), true)
  assert.equal(safeText('x\ud800y'), 'x�y')
  assert.equal(safeText(null), '')
  const s = stateWith([cand('c_cccc', 'pending')])
  assert.equal(setText(s, 'c_cccc', 'b'.repeat(3999) + '😀😀'), true)
  assert.ok(s.candidates[0].text.endsWith('😀'))
  assert.equal(s.candidates[0].text.isWellFormed(), true)
})

test('intentUrl 对任何字符串都不抛错', () => {
  for (const text of ['\ud800', '\udc00x', 'a\ud83d', '😀'.slice(0, 1) + 'b', '']) {
    assert.doesNotThrow(() => intentUrl({ form: 'quote', text, quoteUrl: `https://x.com/a/status/1${text}` }), JSON.stringify(text))
  }
})

const STATUSES = ['pending', 'approved', 'discarded', 'sent', 'expired']
const LATER_SLOT = '2026-11-20T01:00:00.000Z'
const scheduledFor = status => (status === 'approved' ? NOW.toISOString() : null)

test('状态 × 迁移函数：不允许的组合返回 false 且稿子一字不变', () => {
  const table = [
    ['approve', s => approve(s, 'c_tbl1', opts), ['pending']],
    ['approve 改时间', s => approve(s, 'c_tbl1', { ...opts, scheduledAt: LATER_SLOT }), ['pending', 'approved']],
    ['discard', s => discard(s, 'c_tbl1', { now: NOW }), ['pending', 'approved']],
    ['markSent', s => markSent(s, 'c_tbl1', { now: NOW }), ['approved']],
    ['unapprove', s => unapprove(s, 'c_tbl1'), ['approved']],
    ['setText', s => setText(s, 'c_tbl1', '新文字'), ['pending', 'approved']],
  ]
  for (const [name, fn, allowed] of table) {
    for (const status of STATUSES) {
      const s = stateWith([cand('c_tbl1', status, { scheduledAt: scheduledFor(status) })])
      const before = structuredClone(s)
      const ok = fn(s)
      assert.equal(ok, allowed.includes(status), `${name} / ${status}`)
      if (!ok) assert.deepEqual(s, before, `${name} / ${status}`)
    }
  }
})

test('状态 × 处理结果：不允许的返回 ignored 且稿子不变；view/revise 只确认可改', () => {
  const allowed = { approve: ['pending'], discard: ['pending', 'approved'], sent: ['approved'], view: ['pending', 'approved'], revise: ['pending', 'approved'] }
  for (const [action, ok] of Object.entries(allowed)) {
    for (const status of STATUSES) {
      const s = stateWith([cand('c_tbl1', status, { scheduledAt: scheduledFor(status) })])
      const before = structuredClone(s)
      const result = applyDecision(s, { candidateId: 'c_tbl1', action, text: 'x', reason: null }, opts)
      const expected = ok.includes(status) ? (action === 'view' || action === 'revise' ? 'needs_model' : 'applied') : 'ignored'
      assert.equal(result, expected, `${action} / ${status}`)
      if (result !== 'applied') assert.deepEqual(s, before, `${action} / ${status}`)
    }
  }
})

test('状态 × 候选稿操作：不允许的报错且稿子不变', () => {
  const ops = [
    [{ op: 'approve_candidate', id: 'c_tbl1' }, ['pending']],
    [{ op: 'discard_candidate', id: 'c_tbl1' }, ['pending', 'approved']],
    [{ op: 'mark_sent', id: 'c_tbl1' }, ['approved']],
    [{ op: 'unapprove_candidate', id: 'c_tbl1' }, ['approved']],
    [{ op: 'edit_candidate', id: 'c_tbl1', text: '新文字' }, ['pending', 'approved']],
    [{ op: 'reschedule_candidate', id: 'c_tbl1', scheduledAt: LATER_SLOT }, ['approved']],
  ]
  for (const [op, allowed] of ops) {
    for (const status of STATUSES) {
      const s = stateWith([cand('c_tbl1', status, { scheduledAt: scheduledFor(status) })])
      const before = structuredClone(s)
      const { applied, errors } = applyOps(s, [op], opts)
      assert.equal(applied.length === 1, allowed.includes(status), `${op.op} / ${status}`)
      if (errors.length) assert.deepEqual(s, before, `${op.op} / ${status}`)
    }
  }
})
