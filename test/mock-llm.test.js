import assert from 'node:assert/strict'
import test from 'node:test'
import { draftPrompts, revisePrompts, topicPrompts } from '../src/ai.js'
import { condensePrompts } from '../src/voice.js'
import { stylePrompts } from '../src/style.js'
import { classify, readCompletion, startMock, stopMock } from '../scripts/mock-llm.mjs'

const TYPES = [{ id: 't_model', name: '模型' }]
const POSTS = [{ id: '111', handle: 'a', text: 'x', likes: 1, replies: 0, reposts: 0, quotes: 0, views: 1 }, { id: '222', handle: 'b', text: 'y', likes: 1, replies: 0, reposts: 0, quotes: 0, views: 1 }]

// 提示词措辞改了而模拟模型没跟上时，这里会失败。
test('模拟模型的识别措辞与真实提示词一致', () => {
  assert.equal(classify(topicPrompts(POSTS, TYPES).system), 'topics')
  assert.equal(classify(condensePrompts('某份写作指南').system), 'condense')
  assert.equal(classify(stylePrompts('一些文字', '').system), 'style')
  assert.equal(classify(revisePrompts({ text: '旧稿', instruction: '短一点', voice: '' }).system), 'revise')
  assert.equal(classify(draftPrompts({ title: 't', form: 'post', materials: ['m'], voice: '' }).system), 'draft')
  assert.equal(classify(draftPrompts({ title: 't', form: 'quote', materials: ['m'], voice: '口吻', view: '我觉得' }).system), 'draft')
})

const ask = async (port, prompts) => (await readCompletion(port, prompts)).text

test('风格文字里出现别的类别的措辞，也不会改变分类', () => {
  assert.equal(classify(draftPrompts({ title: 't', form: 'post', materials: ['m'], voice: '请参考精简版，把评论归并成选题' }).system), 'draft')
  assert.equal(classify(revisePrompts({ text: '旧', instruction: '短', voice: '精简版 文风分析师' }).system), 'revise')
})

test('通过 HTTP 应答三类请求', async () => {
  const server = await startMock(0, { delay: 0 })
  const { port } = server.address()
  try {
    const topics = JSON.parse(await ask(port, topicPrompts(POSTS, TYPES)))
    assert.ok(topics.length >= 1)
    assert.deepEqual(topics.flatMap(t => t.postIds).sort(), ['111', '222'])
    const summary = await ask(port, condensePrompts('某份写作指南'))
    assert.ok(summary.length === 200)
    const tweet = await ask(port, draftPrompts({ title: 't', form: 'post', materials: ['m'], voice: '' }))
    assert.ok(tweet.length > 0 && tweet.length <= 100)
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()
    assert.equal(models.data[0].id, 'mock-model')
  } finally {
    await stopMock(server)
  }
})
