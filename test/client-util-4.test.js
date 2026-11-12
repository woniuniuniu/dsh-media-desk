process.env.TZ = 'Asia/Shanghai'

import test from 'node:test'
import assert from 'node:assert/strict'
import { PLACEHOLDER, linePath, groupLongforms, splitPlaceholder, mineLink, pct, signed, insightLink, recentSent, num1 } from '../client/util.js'

test('recentSent：空列表、默认最多十条、倒序且不修改输入', () => {
  const now = new Date('2026-11-12T12:00:00Z')
  assert.deepEqual(recentSent([], now), [])
  const rows = Array.from({ length: 12 }, (_, id) => ({ id, status: 'sent', sentAt: new Date(now.getTime() - id * 3600000).toISOString() })).reverse()
  const before = structuredClone(rows)
  assert.deepEqual(recentSent(rows, now).map(row => row.id), Array.from({ length: 10 }, (_, id) => id))
  assert.deepEqual(recentSent(rows, now, { max: 2 }).map(row => row.id), [0, 1])
  assert.deepEqual(recentSent(rows, now, { max: 0 }), [])
  assert.deepEqual(rows, before)
})

test('recentSent：七天窗口含边界、实发时间优先、排除未来和无效日期', () => {
  const now = new Date('2026-11-12T12:00:00Z')
  const rows = [
    { id: 'bad', status: 'sent', sentAt: 'bad', decidedAt: now.toISOString() },
    { id: 'missing', status: 'sent' },
    { id: 'boundary', status: 'sent', sentAt: '2026-11-05T12:00:00Z' },
    { id: 'old', status: 'sent', sentAt: '2026-11-05T11:59:59Z', decidedAt: now.toISOString() },
    { id: 'future', status: 'sent', sentAt: '2026-11-12T12:00:01Z' },
    { id: 'fallback', status: 'sent', sentAt: null, decidedAt: now.toISOString() },
    { id: 'approved', status: 'approved', sentAt: now.toISOString() },
    { id: 'recent', status: 'sent', sentAt: '2026-11-11T12:00:00Z', decidedAt: '2026-11-01T00:00:00Z' },
  ]
  assert.deepEqual(recentSent(rows, now).map(row => row.id), ['fallback', 'recent', 'boundary'])
  assert.deepEqual(recentSent(rows, now, { days: 1 }).map(row => row.id), ['fallback', 'recent'])
})

test('num1：保留一位小数，非有限数显示破折号', () => {
  for (const [value, expected] of [[0, '0.0'], [12, '12.0'], [12.36, '12.4'], [-1.26, '-1.3'], [12345.67, '12345.7']]) assert.equal(num1(value), expected)
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '12']) assert.equal(num1(value), '—')
})

test('linePath：按日期排序、均匀横坐标、纵轴映射和一位小数', () => {
  const series = [{ day: '2026-11-03', count: 30 }, { day: '2026-11-01', count: 10 }, { day: '2026-11-02', count: 20 }]
  assert.equal(linePath(series, 101, 61), 'M 8,53 L 50.5,30.5 L 93,8')
  assert.equal(series[0].day, '2026-11-03')
  assert.equal(linePath([{ day: 'a', count: 0 }, { day: 'b', count: 1 }, { day: 'c', count: 3 }], 100, 60, 0), 'M 0,60 L 50,40 L 100,0')
  assert.equal(linePath([{ day: 'a', count: 0 }, { day: 'b', count: 1 }, { day: 'c', count: 3 }], 100, 100), 'M 8,92 L 50,64 L 92,8')
  assert.equal(linePath([{ day: 'a', count: 0 }, { day: 'b', count: 1 }, { day: 'c', count: 7 }], 100, 100), 'M 8,92 L 50,80 L 92,8')
})

test('linePath：空、单点、平线、非法值和极值均不产生 NaN', () => {
  assert.equal(linePath([], 100, 60), '')
  assert.equal(linePath([{ count: 3 }], 101, 61), 'M 50.5,30.5')
  assert.equal(linePath([{ day: 'a', count: 3 }, { day: 'b', count: 3 }], 100, 60), 'M 8,30 L 92,30')
  const invalid = [null, {}, { count: NaN }, { count: Infinity }, { count: -Infinity }, { count: '3' }]
  assert.equal(linePath(invalid, 100, 60), '')
  assert.equal(linePath([...invalid, { count: 2 }], 100, 60), 'M 50,30')
  for (const series of [undefined, null, {}, [{ day: 'a', count: -Number.MAX_VALUE }, { day: 'b', count: Number.MAX_VALUE }]]) {
    assert.doesNotMatch(linePath(series, NaN, Infinity, NaN), /NaN|Infinity/)
  }
  assert.equal(linePath([{ day: 'a', count: 0 }, { day: 'b', count: 1 }, { day: 'c', count: 3 }], 100, 99), 'M 8,91 L 50,63.3 L 92,8')
})

test('groupLongforms：分组、倒序、无效日期最后、忽略未知状态且不修改输入', () => {
  const rows = [
    { id: 'bad', status: 'idea', updatedAt: 'bad' }, { id: 'old', status: 'idea', updatedAt: '2026-11-01' },
    { id: 'new', status: 'idea', updatedAt: '2026-11-12' }, { id: 'draft', status: 'draft', updatedAt: '2026-11-11' },
    { id: 'done', status: 'done', updatedAt: '2026-11-10' }, { id: 'ignored', status: 'toString' },
  ]
  const before = structuredClone(rows)
  assert.deepEqual(Object.fromEntries(Object.entries(groupLongforms(rows)).map(([key, list]) => [key, list.map(row => row.id)])), { idea: ['new', 'old', 'bad'], draft: ['draft'], done: ['done'] })
  assert.deepEqual(rows, before)
  assert.deepEqual(groupLongforms([]), { idea: [], draft: [], done: [] })
})

test('splitPlaceholder：空文本、普通文本、首尾及连续多处标记', () => {
  assert.deepEqual(splitPlaceholder(''), [])
  assert.deepEqual(splitPlaceholder('<script>原样显示</script>'), [{ text: '<script>原样显示</script>', mark: false }])
  assert.deepEqual(splitPlaceholder(`${PLACEHOLDER}中间${PLACEHOLDER}${PLACEHOLDER}`), [
    { text: PLACEHOLDER, mark: true }, { text: '中间', mark: false }, { text: PLACEHOLDER, mark: true }, { text: PLACEHOLDER, mark: true },
  ])
  assert.deepEqual(splitPlaceholder(`前${PLACEHOLDER}后`), [{ text: '前', mark: false }, { text: PLACEHOLDER, mark: true }, { text: '后', mark: false }])
})

test('mineLink：优先合法 X 链接，否则严格校验账号和帖子 id', () => {
  assert.equal(mineLink({ url: 'https://x.com/a/status/12345' }, ''), 'https://x.com/a/status/12345')
  for (const url of [null, 12, 'javascript:alert(1)', 'https://x.com.evil/a', 'https://x.com@evil/a', 'http://x.com/a']) {
    assert.equal(mineLink({ url, id: '12345' }, 'a_B9'), 'https://x.com/a_B9/status/12345')
    assert.equal(mineLink({ url, id: '1234' }, 'a'), null)
  }
  for (const handle of ['', '@name', 'a/b', '中文', 'a'.repeat(16)]) assert.equal(mineLink({ id: '12345' }, handle), null)
  for (const id of ['1234', '1'.repeat(26), '1234x', '12345/evil']) assert.equal(mineLink({ id }, 'a'), null)
  assert.equal(mineLink({ id: '1'.repeat(25) }, 'a'.repeat(15)), `https://x.com/${'a'.repeat(15)}/status/${'1'.repeat(25)}`)
})

test('pct：百分比四舍五入，非有限数显示破折号', () => {
  for (const [value, expected] of [[0, '0%'], [1, '100%'], [0.125, '13%'], [0.999, '100%']]) assert.equal(pct(value), expected)
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '0.5']) assert.equal(pct(value), '—')
})

test('signed：正数带加号、负数和零保留，空或非有限数显示破折号', () => {
  for (const [value, expected] of [[12, '+12'], [-3, '-3'], [0, '0'], [-0, '0']]) assert.equal(signed(value), expected)
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '12']) assert.equal(signed(value), '—')
})

test('insightLink：只重建合法 X 帖子链接，不透传外部地址或查询参数', () => {
  assert.equal(insightLink('https://x.com/a_B9/status/12345?s=20#reply'), 'https://x.com/a_B9/status/12345')
  for (const value of [null, 12, 'javascript:alert(1)', 'https://x.com.evil/a/status/12345', 'https://x.com@evil/a/status/12345', 'https://x.com/a/status/12345/evil', 'https://x.com/a/status/1234', 'https://x.com/a/status/12345\n', 'http://x.com/a/status/12345']) assert.equal(insightLink(value), null)
})
