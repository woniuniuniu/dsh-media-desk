import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Exchange, parseDecision, parseMine, parsePost, parseReplyDraft } from '../src/exchange.js'
import { emptyState } from '../src/seed.js'
import { watchlistJson } from '../src/voice.js'

// README 里每个带 <!-- example: 名字 --> 标记的 json 代码块都要和代码对得上，文档不能悄悄过期。
async function examples() {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const out = []
  for (const m of text.matchAll(/<!-- example: (\w+) -->\s*```json\n([\s\S]*?)```/g)) out.push([m[1], JSON.parse(m[2])])
  return out
}
const of = async name => (await examples()).filter(([n]) => n === name).map(([, v]) => v)

test('README 的帖子示例能被 parsePost 读入', async () => {
  const list = await of('posts')
  assert.ok(list.length >= 1)
  for (const raw of list) assert.ok(parsePost(raw))
})

test('README 的处理结果示例能被 parseDecision 读入，且覆盖文字和原因', async () => {
  const list = await of('decisions')
  assert.ok(list.length >= 3)
  for (const raw of list) assert.ok(parseDecision(raw), JSON.stringify(raw))
  assert.ok(list.some(r => r.action === 'view' && parseDecision(r).text))
  assert.ok(list.some(r => r.action === 'discard' && parseDecision(r).reason))
})

test('README 的候选稿示例与 writeDraft 写出的字段完全一致', async () => {
  const [example] = await of('drafts')
  const root = await mkdtemp(join(tmpdir(), 'readme-'))
  try {
    const ex = new Exchange(root)
    await ex.ensure()
    const c = { id: 'c_sample1', revision: 0, form: 'post', title: 't', text: 'x', quoteUrl: null, status: 'pending', scheduledAt: null, createdAt: '2026-11-11T00:00:00.000Z' }
    const name = await ex.writeDraft(c, '模型', { intentUrl: 'https://x.com/intent/tweet?text=x' })
    const written = JSON.parse(await readFile(join(root, 'drafts', (await readdir(join(root, 'drafts')))[0]), 'utf8'))
    assert.equal(name, 'c_sample1-r0.json')
    assert.deepEqual(Object.keys(example).sort(), Object.keys(written).sort())
    assert.ok(example.intentUrl.startsWith('https://x.com/intent/tweet?text='))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('README 的账号名单示例与 watchlistJson 的字段完全一致', async () => {
  const [example] = await of('watchlist')
  assert.deepEqual(Object.keys(example).sort(), Object.keys(watchlistJson(emptyState())).sort())
})

test('README 的自己发出内容示例能被 parseMine 读入，且是回复', async () => {
  const list = await of('mine')
  assert.ok(list.length >= 1)
  for (const raw of list) assert.ok(parseMine(raw, { ownHandle: 'me' }), JSON.stringify(raw))
  assert.ok(parseMine(list[0]).mine.inReplyTo)
})

test('README 的回复草稿示例能被 parseReplyDraft 读入', async () => {
  const list = await of('replies')
  assert.ok(list.length >= 1)
  for (const raw of list) assert.ok(parseReplyDraft(raw), JSON.stringify(raw))
})

test('Final I2: README states commits exclude unrelated staged files', async () => {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(text, /不会夹带其他已暂存文件/)
  assert.doesNotMatch(text, /已有暂存改动也可能随同步一起提交/)
})
