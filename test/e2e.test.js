process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startMock } from '../scripts/mock-llm.mjs'
import { Composer } from '../src/compose.js'
import { Exchange } from '../src/exchange.js'
import { Lock } from '../src/lock.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const SAMPLES = fileURLToPath(new URL('../scripts/sample-exchange/posts/', import.meta.url))
const NOW = new Date('2026-11-11T11:05:00+08:00')

/** 把 callText 实现成对模拟模型的 HTTP 调用（OpenAI 兼容的流式接口）。 */
const httpCallText = port => async ({ system, user }) => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  let text = ''
  for (const line of (await res.text()).split('\n')) {
    if (line.startsWith('data: ') && !line.includes('[DONE]')) text += JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? ''
  }
  return { text, model: 'mock-model' }
}

test('端到端：示例帖子 → 成稿 → 通过和改稿 → 坏文件只留提示', async () => {
  const server = await startMock(0, { delay: 0 })
  try {
    const root = await mkdtemp(join(tmpdir(), 'e2e-'))
    const skew = { ms: 60_000 } // 交换文件夹只读 10 秒前写入的文件；用它把"现在"往后拨
    const clock = { t: NOW }
    const store = new Store(root)
    const settings = new Settings(root)
    const ex = new Exchange(join(root, 'exchange'), { now: () => Date.now() + skew.ms })
    await ex.ensure()
    const composer = new Composer({ store, settings, callText: httpCallText(server.address().port), now: () => clock.t })
    const lock = new Lock(join(root, 'worker.lock'), { now: () => clock.t.getTime() })
    const worker = new Worker({ store, settings, composer, lock, exchangeFor: () => ex, now: () => clock.t })

    const names = (await readdir(SAMPLES)).filter(f => f.endsWith('.json')).sort()
    for (const [i, name] of names.entries()) {
      const raw = JSON.parse(await readFile(join(SAMPLES, name), 'utf8'))
      raw.postedAt = new Date(NOW.getTime() - (i + 1) * 30 * 60_000).toISOString()
      raw.fetchedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString()
      await writeFile(join(ex.root, 'posts', name), JSON.stringify(raw))
    }

    assert.deepEqual(await worker.tick(), { ran: true })
    let state = await store.read()
    assert.ok(state.candidates.length >= 1, '应当出现候选稿')
    const drafts = await readdir(join(ex.root, 'drafts'))
    assert.equal(drafts.length, state.candidates.length)
    const draft = JSON.parse(await readFile(join(ex.root, 'drafts', drafts[0]), 'utf8'))
    assert.ok(draft.intentUrl.startsWith('https://x.com/intent/tweet?text='))
    assert.ok((await readFile(join(ex.root, 'voice', 'SKILL.md'), 'utf8')).includes('不代为发送'))

    const [first, second] = state.candidates.filter(c => c.status === 'pending')
    assert.ok(first && second, '至少要有两条待处理候选稿')
    const decide = (name, body) => writeFile(join(ex.root, 'decisions', name), JSON.stringify({ schema: 1, at: NOW.toISOString(), ...body }))

    await decide('a.json', { candidateId: first.id, action: 'approve' })
    skew.ms += 60_000
    clock.t = new Date(clock.t.getTime() + 60_000)
    await worker.tick()
    state = await store.read()
    const approved = state.candidates.find(c => c.id === first.id)
    assert.equal(approved.status, 'approved')
    assert.ok(approved.scheduledAt)

    await decide('b.json', { candidateId: second.id, action: 'view', text: '我觉得评测比模型大小更重要' })
    skew.ms += 60_000
    clock.t = new Date(clock.t.getTime() + 60_000)
    await worker.tick()
    state = await store.read()
    const revised = state.candidates.find(c => c.id === second.id)
    assert.equal(revised.revision, 1)
    assert.ok((await readdir(join(ex.root, 'drafts'))).includes(`${second.id}-r1.json`))

    await writeFile(join(ex.root, 'posts', 'oops.json'), '{oops')
    skew.ms += 60_000
    clock.t = new Date(clock.t.getTime() + 60_000)
    await worker.tick()
    state = await store.read()
    assert.ok(state.runs.notices.some(n => n.text.includes('posts/oops.json')))
    assert.equal(state.candidates.find(c => c.id === first.id).status, 'approved')
    assert.equal(state.candidates.find(c => c.id === second.id).revision, 1)
  } finally {
    server.close()
  }
})
