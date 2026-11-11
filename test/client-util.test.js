process.env.TZ = 'Asia/Shanghai'
import test from 'node:test'
import assert from 'node:assert/strict'
import { intentUrl as hostIntentUrl, tweetLength as hostTweetLength } from '../src/inbox.js'
import { composeStatus, intentUrl, tweetLength } from '../client/util.js'

const TEXTS = [
  '', 'hello world', '今天写了一个小工具', 'emoji 😀 mixed 中文', 'see https://example.com/a?b=1&c=2 now',
  '两个网址 http://a.com/x https://b.com/y?z=%20 结束', 'line1\nline2 #tag & more? 100%', 'a'.repeat(300), 'ᄀჿ',
]

test('tweetLength 与 src/inbox.js 一致', () => {
  for (const text of [...TEXTS, 'x\ud800y']) assert.equal(tweetLength(text), hostTweetLength(text), JSON.stringify(text))
})

test('intentUrl 与 src/inbox.js 一致', () => {
  const rows = [
    { form: 'post', text: 'hello' },
    ...TEXTS.map(text => ({ form: 'post', text })),
    { form: 'quote', text: '评论 #1 & ?', quoteUrl: 'https://x.com/a/status/1?s=20&t=%' },
    { form: 'quote', text: '无链接', quoteUrl: null },
    { form: 'post', text: '不是引用', quoteUrl: 'https://x.com/a/status/2' },
  ]
  for (const row of rows) assert.equal(intentUrl(row), hostIntentUrl(row), JSON.stringify(row))
})

test('intentUrl 遇到孤立代理项不抛错，按 U+FFFD 处理', () => {
  assert.equal(intentUrl({ form: 'post', text: 'a\ud800b' }), hostIntentUrl({ form: 'post', text: 'a�b' }))
  assert.equal(intentUrl({ form: 'post', text: 'a\udc00' }), hostIntentUrl({ form: 'post', text: 'a�' }))
  assert.doesNotThrow(() => intentUrl({ form: 'quote', text: 'x', quoteUrl: 'https://x.com/\ud83d' }))
})

const AT = (hhmm, day = '2026-11-12') => `${day}T${hhmm}:00+08:00`
const NOW_LOCAL = new Date(AT('16:00'))
const status = runs => composeStatus({ lastComposeDay: null, lastComposeError: null, lastComposeAt: null, ...runs }, '07:00', NOW_LOCAL)

test('composeStatus：四种状态', () => {
  const table = [
    ['今天成功，按实际时间', { lastComposeDay: '2026-11-12', lastComposeAt: AT('07:00') }, { kind: 'done', at: AT('07:00') }],
    ['今天强制重跑 15:30', { lastComposeDay: '2026-11-12', lastComposeAt: AT('15:30') }, { kind: 'done', at: AT('15:30') }],
    ['成功但没有 lastComposeAt：回退', { lastComposeDay: '2026-11-12' }, { kind: 'done', at: null }],
    ['今天没有新素材', { lastComposeDay: '2026-11-12', lastComposeError: '今天没有新素材', lastComposeAt: AT('07:00') }, { kind: 'empty' }],
    ['今天失败', { lastComposeError: '选题失败：超时', lastComposeAt: AT('07:00') }, { kind: 'failed', error: '选题失败：超时' }],
    ['昨天失败、今天还没试', { lastComposeError: '选题失败：超时', lastComposeAt: AT('07:00', '2026-11-11') }, { kind: 'waiting', composeAt: '07:00' }],
    ['昨天失败且没有 lastComposeAt', { lastComposeError: '选题失败：超时' }, { kind: 'waiting', composeAt: '07:00' }],
    ['今天成功后又出现别的错误：算失败', { lastComposeDay: '2026-11-12', lastComposeError: '素材已被其他任务用掉', lastComposeAt: AT('15:30') }, { kind: 'failed', error: '素材已被其他任务用掉' }],
    ['昨天出过稿、今天没动静', { lastComposeDay: '2026-11-11', lastComposeAt: AT('07:00', '2026-11-11') }, { kind: 'waiting', composeAt: '07:00' }],
    ['全新状态', {}, { kind: 'waiting', composeAt: '07:00' }],
  ]
  for (const [name, runs, expected] of table) assert.deepEqual(status(runs), expected, name)
})
