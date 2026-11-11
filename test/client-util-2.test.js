process.env.TZ = 'Asia/Shanghai'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cardToForm, extractHandle, formToCard, isDue, moveToDay, upcomingList } from '../client/util.js'

test('extractHandle 接受 @name、name 和主页链接', () => {
  assert.equal(extractHandle('@alice_1'), 'alice_1')
  assert.equal(extractHandle(' alice '), 'alice')
  assert.equal(extractHandle('https://x.com/alice'), 'alice')
  assert.equal(extractHandle('https://twitter.com/alice/status/123?s=1'), 'alice')
  assert.equal(extractHandle('https://www.x.com/alice#top'), 'alice')
})

test('extractHandle 拒绝非法输入', () => {
  for (const bad of ['', '@', 'a b', 'this_is_way_too_long_name', 'a-b', 'https://example.com/alice', '@@a', null]) {
    assert.equal(extractHandle(bad), null, String(bad))
  }
})

test('upcomingList 只取已通过的并按时间升序；isDue 判断已过时间', () => {
  const rows = [
    { id: 'a', status: 'approved', scheduledAt: '2026-11-12T10:00:00.000Z' },
    { id: 'b', status: 'approved', scheduledAt: '2026-11-11T10:00:00.000Z' },
    { id: 'c', status: 'sent', scheduledAt: '2026-11-10T10:00:00.000Z' },
    { id: 'd', status: 'pending' },
  ]
  assert.deepEqual(upcomingList(rows).map(r => r.id), ['b', 'a'])
  const now = new Date('2026-11-11T12:00:00.000Z')
  assert.equal(isDue(rows[1], now), true)
  assert.equal(isDue(rows[0], now), false)
  assert.equal(isDue(rows[2], now), false)
})

test('moveToDay 保留几点几分', () => {
  const moved = moveToDay('2026-11-11T01:30:00.000Z', new Date(2026, 10, 20))
  assert.equal(moved, '2026-11-20T01:30:00.000Z') // 上海 11-20 09:30
})

test('风格卡与编辑表单互转，列表一行一项并丢掉空行', () => {
  const form = cardToForm({ name: 'n', words: ['a', 'b'], avoid: [], samples: ['x'] })
  assert.equal(form.words, 'a\nb')
  assert.equal(form.summary, '')
  const card = formToCard({ ...form, words: ' a \n\n b \n', avoid: '' })
  assert.deepEqual(card.words, ['a', 'b'])
  assert.deepEqual(card.avoid, [])
  assert.equal(card.name, 'n')
})
