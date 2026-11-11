process.env.TZ = 'Asia/Shanghai'
import test from 'node:test'
import assert from 'node:assert/strict'
import { intentUrl as hostIntentUrl, tweetLength as hostTweetLength } from '../src/inbox.js'
import { intentUrl, tweetLength } from '../client/util.js'

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
