process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { classify, readCompletion, startMock, stopMock } from '../scripts/mock-llm.mjs'
import { Composer } from '../src/compose.js'
import { Exchange } from '../src/exchange.js'
import { learnDaily } from '../src/learn.js'
import { Lock } from '../src/lock.js'
import { Longform } from '../src/longform.js'
import { similarity } from '../src/match.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'
import { Worker } from '../src/worker.js'

const SAMPLES = fileURLToPath(new URL('../scripts/sample-exchange/posts/', import.meta.url))
const NOW = new Date('2026-11-11T11:05:00+08:00')

/** 把 callText 实现成对模拟模型的 HTTP 调用。 */
const httpCallText = port => prompts => readCompletion(port, prompts)

test('端到端：示例帖子 → 成稿 → 通过和改稿 → 坏文件只留提示', async () => {
  const server = await startMock(0, { delay: 0 })
  const root = await mkdtemp(join(tmpdir(), 'e2e-'))
  try {
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
    await stopMock(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('端到端（计划 2）：自己发出的内容 → 候选稿被识别为已发，回复配上起草，粉丝数记一条，不再为它写新的草稿文件', async () => {
  const server = await startMock(0, { delay: 0 })
  const root = await mkdtemp(join(tmpdir(), 'e2e2-'))
  try {
    const skew = { ms: 60_000 }
    const clock = { t: NOW }
    const store = new Store(root)
    const settings = new Settings(root)
    const ex = new Exchange(join(root, 'exchange'), { now: () => Date.now() + skew.ms })
    await ex.ensure()
    const composer = new Composer({ store, settings, callText: httpCallText(server.address().port), now: () => clock.t })
    const lock = new Lock(join(root, 'worker.lock'), { now: () => clock.t.getTime() })
    const worker = new Worker({ store, settings, composer, lock, exchangeFor: () => ex, now: () => clock.t })
    const next = async () => {
      skew.ms += 60_000
      clock.t = new Date(clock.t.getTime() + 60_000)
      await worker.tick()
    }

    for (const [i, name] of (await readdir(SAMPLES)).filter(f => f.endsWith('.json')).sort().entries()) {
      const raw = JSON.parse(await readFile(join(SAMPLES, name), 'utf8'))
      raw.postedAt = new Date(NOW.getTime() - (i + 1) * 30 * 60_000).toISOString()
      raw.fetchedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString()
      await writeFile(join(ex.root, 'posts', name), JSON.stringify(raw))
    }
    await worker.tick()
    let state = await store.read()
    assert.ok(state.candidates.length >= 1)
    // 再放两条还没写出过草稿文件的候选稿：一条会被配上，一条保持待处理
    const seeded = (id, text) => ({
      id, form: 'post', typeId: 't_model', text, aiText: text, title: id, sourcePostIds: [], sourceNoteId: null, quoteUrl: null, reason: '', score: 1,
      status: 'pending', createdAt: clock.t.toISOString(), scheduledAt: null, decidedAt: null, discardReason: null, view: null, revision: 0, image: null,
      sentText: null, sentPostId: null, sentAt: null,
    })
    const textA = '今天聊聊模型评测：榜单分数越来越高，但真实任务里的表现差距并没有那么大，关键是看你自己的场景。'
    const textB = '周末去爬山，天气很好，拍了很多照片，晚上和朋友吃了火锅，回家路上还下了一点小雨。'
    await store.mutate('seed', s => { s.candidates.push(seeded('c_e2eaaaa', textA), seeded('c_e2ebbbb', textB)) }, { undoable: false })
    const target = { id: 'c_e2eaaaa', text: textA }
    const filesBefore = (await readdir(join(ex.root, 'drafts'))).sort()
    assert.ok(!filesBefore.some(f => f.startsWith('c_e2e')))

    const edited = `${target.text}。`
    assert.ok(similarity(target.text, edited) >= 0.8)
    const at = minutes => new Date(clock.t.getTime() + minutes * 60_000).toISOString()
    await writeFile(join(ex.root, 'mine', 'p.json'), JSON.stringify({
      schema: 1, postId: '1856000000000000001', kind: 'post', text: edited, postedAt: at(2), fetchedAt: at(3),
      metrics: { likes: 3, replies: 0, reposts: 0, quotes: 0, views: 120 }, followers: 1234,
    }))
    await writeFile(join(ex.root, 'replies', 'r.json'), JSON.stringify({
      schema: 1, toHandle: 'karpathy', toPostId: '1855000000000000001', drafts: ['谢谢分享，这点我很认同', '有意思'], notifiedAt: at(1),
    }))
    await writeFile(join(ex.root, 'mine', 'q.json'), JSON.stringify({
      schema: 1, postId: '1856000000000000002', kind: 'reply', text: '谢谢分享，这点我非常认同', postedAt: at(3), fetchedAt: at(4),
      metrics: { likes: 1, replies: 0, reposts: 0, quotes: 0, views: 20 }, inReplyTo: { handle: 'karpathy', postId: '1855000000000000001' }, followers: 1234,
    }))
    await next()
    state = await store.read()
    const sent = state.candidates.find(c => c.id === target.id)
    assert.equal(sent.status, 'sent')
    assert.equal(sent.sentText, edited)
    assert.equal(sent.sentPostId, '1856000000000000001')
    assert.equal(state.replyDrafts.length, 1)
    assert.equal(state.replyDrafts[0].sentText, '谢谢分享，这点我非常认同')
    assert.equal(state.mine.length, 2)
    assert.equal(state.followers.length, 1)
    assert.equal(state.followers[0].count, 1234)
    assert.ok(state.candidates.filter(c => c.id !== target.id).every(c => c.status !== 'sent'))
    assert.equal(state.candidates.find(c => c.id === 'c_e2ebbbb').status, 'pending')
    // 配上的那条没有草稿文件；仍待处理的那条有（对照）
    const files = (await readdir(join(ex.root, 'drafts'))).sort()
    assert.ok(!files.some(f => f.startsWith('c_e2eaaaa')))
    assert.ok(files.includes('c_e2ebbbb-r0.json'))

    await next()
    assert.deepEqual((await readdir(join(ex.root, 'drafts'))).sort(), files)
    state = await store.read()
    assert.equal(state.candidates.find(c => c.id === target.id).status, 'sent')
    assert.equal(state.mine.length, 2)
  } finally {
    await stopMock(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('端到端（计划 2）：攒够自己的内容和改稿后，新的一天出规则建议、提醒只一次；周一成稿后建议一次长文选题', async () => {
  const server = await startMock(0, { delay: 0 })
  const root = await mkdtemp(join(tmpdir(), 'e2e3-'))
  try {
    const kinds = []
    const port = server.address().port
    const callText = prompts => {
      kinds.push(classify(prompts.system))
      return readCompletion(port, prompts)
    }
    const monday = new Date('2026-11-16T10:00:00+08:00')
    assert.equal(monday.getDay(), 1)
    const skew = { ms: 60_000 }
    const clock = { t: monday }
    const store = new Store(root)
    const settings = new Settings(root)
    const ex = new Exchange(join(root, 'exchange'), { now: () => Date.now() + skew.ms })
    await ex.ensure()
    const composer = new Composer({ store, settings, callText, now: () => clock.t })
    const lock = new Lock(join(root, 'worker.lock'), { now: () => clock.t.getTime() })
    const longform = new Longform({ store, callText, now: () => clock.t })
    const worker = new Worker({
      store, settings, composer, lock, exchangeFor: () => ex, now: () => clock.t, longform,
      learn: { learnDaily: () => learnDaily({ store, callText, now: () => clock.t }) },
    })
    const next = async () => {
      skew.ms += 60_000
      clock.t = new Date(clock.t.getTime() + 60_000)
      await worker.tick()
    }

    // 30 条自己发出的内容（近 3 天内，文字各不相同）
    for (let i = 0; i < 30; i++) {
      await writeFile(join(ex.root, 'mine', `m${i}.json`), JSON.stringify({
        schema: 1, postId: `18560000000000001${String(i).padStart(2, '0')}`, kind: 'post', text: `第 ${i} 条：今天想到的第 ${i * 7 + 3} 件小事，写下来备忘。`,
        postedAt: new Date(monday.getTime() - (i + 1) * 2 * 3600e3).toISOString(), fetchedAt: new Date(monday.getTime() - 60_000).toISOString(),
        metrics: { likes: i, replies: 0, reposts: 0, quotes: 0, views: 100 + i },
      }))
    }
    // 5 组明显改过的稿子：AI 草稿和实发文字几乎没有共同片段
    await store.mutate('seed', s => {
      for (let i = 0; i < 5; i++) {
        s.candidates.push({
          id: `c_e2e3${i}`, form: 'post', typeId: 't_model', text: 'x', aiText: `模型评测要先做，榜单只能参考，第${i}版草稿一二三四五六七八九十。`, title: 't', sourcePostIds: [],
          sourceNoteId: null, quoteUrl: null, reason: '', score: 1, status: 'sent', createdAt: monday.toISOString(), scheduledAt: null, decidedAt: null, discardReason: null,
          view: null, revision: 0, image: null, sentText: `我自己的话${i}：周末爬山拍了照片，天气不错。`, sentPostId: null, sentAt: monday.toISOString(),
        })
      }
    }, { undoable: false })

    await worker.tick()
    let state = await store.read()
    assert.equal(state.mine.length, 30)
    assert.ok(state.proposals.length >= 1, '应当出现规则建议')
    assert.deepEqual(state.rules, [], '规则建议不自动生效')
    assert.equal(state.runs.lastLearnDay, '2026-11-16')
    const voiceNotices = () => state.runs.notices.filter(n => n.text.includes('提炼你自己的核心风格'))
    assert.equal(voiceNotices().length, 1)
    assert.ok(state.longforms.filter(l => l.status === 'idea').length >= 1, '周一成稿后应当建议长文选题')
    assert.equal(state.runs.lastLongformWeek, '2026-W47')
    assert.equal(kinds.filter(k => k === 'longform_ideas').length, 1)
    assert.equal(kinds.filter(k => k === 'rules').length, 1)

    await next()
    state = await store.read()
    assert.equal(voiceNotices().length, 1)
    assert.equal(kinds.filter(k => k === 'longform_ideas').length, 1)
    assert.equal(kinds.filter(k => k === 'rules').length, 1)
  } finally {
    await stopMock(server)
    await rm(root, { recursive: true, force: true })
  }
})
