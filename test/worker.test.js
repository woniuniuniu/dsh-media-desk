process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { mock } from 'node:test'
import { Composer } from '../src/compose.js'
import { Exchange } from '../src/exchange.js'
import { Lock } from '../src/lock.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'
import { Worker, addNotice, countImage, imagesUsedToday, resolveExchangeDir } from '../src/worker.js'

const SAMPLES = fileURLToPath(new URL('../scripts/sample-exchange/posts/', import.meta.url))
const SAMPLE_FILES = ['01-karpathy-evals', '02-sama-release', '03-simonw-release', '04-simonw-tool', '05-karpathy-agents', '06-sama-repost'].map(n => `${n}.json`)
const ID1 = '1855000000000000001'
const ID2 = '1855000000000000002'
const TODAY = '2026-11-11'
const NOW = new Date('2026-11-11T11:05:00+08:00')

const TOPICS = JSON.stringify([
  { title: '评测先行', postIds: [ID1], fun: 2, info: 2, resonance: 0, form: 'post', reason: 'r1' },
  { title: '新版发布', postIds: [ID2], fun: 1, info: 2, resonance: 1, form: 'post', reason: 'r2' },
])

async function setup({ now = NOW, samples = true, failTopicsOnce = false, exchangeFor, exchangeNow, gate } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'worker-'))
  const clock = { t: now }
  const store = new Store(root)
  const settings = new Settings(root)
  const ex = new Exchange(join(root, 'exchange'), exchangeNow ? { now: exchangeNow } : {})
  await ex.ensure()
  if (samples) for (const f of SAMPLE_FILES) await copyFile(join(SAMPLES, f), join(ex.root, 'posts', f))
  let topicCalls = 0
  let failTopics = failTopicsOnce
  const callText = async req => {
    if (req.maxTokens === 3000) {
      topicCalls += 1
      if (failTopics) {
        failTopics = false
        throw new Error('假模型选题失败')
      }
      return { text: TOPICS, model: 'fake' }
    }
    if (gate) {
      gate.hit = true
      await gate.promise
    }
    return { text: '一条改好的推文。', model: 'fake' }
  }
  const composer = new Composer({ store, settings, callText, now: () => clock.t })
  const lock = new Lock(join(root, 'worker.lock'), { now: () => clock.t.getTime() })
  const worker = new Worker({ store, settings, composer, lock, exchangeFor: exchangeFor ?? (() => ex), now: () => clock.t })
  return { root, clock, store, settings, ex, worker, lock, composeCalls: () => topicCalls }
}

const decisionFile = (ex, name, body) => writeFile(join(ex.root, 'decisions', name), JSON.stringify({ schema: 1, at: NOW.toISOString(), ...body }))
const candidate = (id, extra = {}) => ({
  id, form: 'post', typeId: 't_model', text: '旧稿', aiText: '旧稿', title: '旧', sourcePostIds: [], sourceNoteId: null, quoteUrl: null,
  reason: '', score: 1, status: 'pending', createdAt: NOW.toISOString(), scheduledAt: null, decidedAt: null, discardReason: null, view: null, revision: 0, image: null, ...extra,
})

test('完整一轮：放入帖子文件 → 到点成稿 → drafts 和 voice 被写出', async () => {
  const { worker, store, ex } = await setup()
  assert.deepEqual(await worker.tick(), { ran: true })
  const s = await store.read()
  assert.equal(s.posts.length, 6)
  assert.ok(s.candidates.length >= 1)
  const files = await readdir(join(ex.root, 'drafts'))
  assert.equal(files.length, s.candidates.length)
  const draft = JSON.parse(await readFile(join(ex.root, 'drafts', files[0]), 'utf8'))
  assert.match(draft.intentUrl, /^https:\/\/x\.com\/intent\/tweet\?text=/)
  assert.ok((await readFile(join(ex.root, 'voice', 'SKILL.md'), 'utf8')).includes('不代为发送'))
  assert.equal(store.undo.length, 0)
})

test('没到成稿时间不成稿', async () => {
  const { worker, store } = await setup({ now: new Date('2026-11-11T06:59:00+08:00') })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.candidates.length, 0)
  assert.equal(s.posts.length, 6)
})

test('Review Focus 2：同一条帖子再次出现时只更新互动数，不重复、不清掉"已用过"', async () => {
  const { worker, store, ex } = await setup()
  await worker.tick()
  const original = structuredClone((await store.read()).posts.find(x => x.id === ID1))
  assert.equal(original.used, true)
  const raw = JSON.parse(await readFile(join(SAMPLES, SAMPLE_FILES[0]), 'utf8'))
  raw.fetchedAt = '2026-11-11T03:30:00Z'
  raw.metrics.likes = 2 * original.likes
  await writeFile(join(ex.root, 'posts', 'later.json'), JSON.stringify(raw))
  await worker.tick()
  const p = (await store.read()).posts.filter(x => x.id === ID1)
  assert.equal(p.length, 1)
  assert.equal(p[0].likes, 2 * original.likes)
  assert.equal(p[0].fetchedAt, '2026-11-11T03:30:00.000Z')
  assert.equal(p[0].used, true)
})

test('Review Focus 2：迟到的旧读取结果不覆盖较新的互动数', async () => {
  const { worker, store, ex } = await setup()
  await worker.tick()
  const original = structuredClone((await store.read()).posts.find(x => x.id === ID1))
  const raw = JSON.parse(await readFile(join(SAMPLES, SAMPLE_FILES[0]), 'utf8'))
  raw.fetchedAt = '2026-11-11T02:30:00Z'
  raw.metrics.likes = 1
  await writeFile(join(ex.root, 'posts', 'older.json'), JSON.stringify(raw))
  await worker.tick()
  const p = (await store.read()).posts.find(x => x.id === ID1)
  assert.equal(p.likes, original.likes)
  assert.equal(p.fetchedAt, original.fetchedAt)
})

test('只保留 14 天内发布的帖子', async () => {
  const { worker, store, ex } = await setup({ samples: false })
  const raw = JSON.parse(await readFile(join(SAMPLES, SAMPLE_FILES[0]), 'utf8'))
  raw.postedAt = '2026-10-20T01:00:00Z'
  raw.fetchedAt = '2026-10-20T03:00:00Z'
  await writeFile(join(ex.root, 'posts', 'old.json'), JSON.stringify(raw))
  await worker.tick()
  assert.equal((await store.read()).posts.length, 0)
})

test('Review Focus 4：停了三天后重新打开，只补一批稿，过期的旧稿被标记', async () => {
  const { worker, store, composeCalls } = await setup()
  await store.mutate('seed', s => {
    s.candidates.push(candidate('c_old1', { createdAt: '2026-11-08T08:00:00.000Z' }))
    s.runs.lastComposeDay = '2026-11-08'
  }, { undoable: false })
  await worker.tick()
  await worker.tick()
  const s = await store.read()
  assert.equal(s.candidates.filter(c => c.status === 'expired').length, 1)
  assert.equal(s.runs.lastComposeDay, TODAY)
  assert.equal(composeCalls(), 1)
})

test('Review Focus 3：成稿失败后 30 分钟内不重试，30 分钟后重试', async () => {
  const { worker, store, clock, composeCalls } = await setup({ failTopicsOnce: true })
  await worker.tick()
  assert.equal(composeCalls(), 1)
  assert.ok((await store.read()).runs.lastComposeError)
  clock.t = new Date(clock.t.getTime() + 60_000)
  await worker.tick()
  assert.equal(composeCalls(), 1)
  clock.t = new Date(NOW.getTime() + 31 * 60_000)
  await worker.tick()
  assert.equal(composeCalls(), 2)
  const s = await store.read()
  assert.equal(s.runs.lastComposeDay, TODAY)
  assert.ok(s.candidates.length >= 1)
})

test('Review Focus 5：处理结果指向不存在的候选稿时被忽略并留下一条提示，其余照常', async () => {
  const { worker, store, ex } = await setup({ samples: false })
  await store.mutate('seed', s => { s.candidates.push(candidate('c_real1')) }, { undoable: false })
  await decisionFile(ex, 'a.json', { candidateId: 'c_zzzz', action: 'approve' })
  await decisionFile(ex, 'b.json', { candidateId: 'c_real1', action: 'approve' })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.candidates.find(c => c.id === 'c_real1').status, 'approved')
  assert.ok(s.runs.notices.some(n => n.text.includes('c_zzzz')))
})

test('手机端发来一句看法：稿子被重写，新修订号的文件被写出', async () => {
  const { worker, store, ex } = await setup({ samples: false })
  await store.mutate('seed', s => {
    s.candidates.push(candidate('c_real1'))
    s.runs.lastComposeDay = TODAY
  }, { undoable: false })
  await decisionFile(ex, 'v.json', { candidateId: 'c_real1', action: 'view', text: '我觉得评测比模型大小更重要' })
  await worker.tick()
  const s = await store.read()
  const c = s.candidates[0]
  assert.equal(c.revision, 1)
  assert.equal(c.text, '一条改好的推文。')
  assert.equal(c.view, '我觉得评测比模型大小更重要')
  assert.ok((await readdir(join(ex.root, 'drafts'))).includes('c_real1-r1.json'))
  assert.equal(store.undo.length, 0)
})

test('需要模型的处理结果缺文字或改稿失败时记一条提示，其余照常', async () => {
  const { worker, store, ex } = await setup({ samples: false })
  await store.mutate('seed', s => {
    s.candidates.push(candidate('c_aaaa'), candidate('c_bbbb'))
    s.runs.lastComposeDay = TODAY
  }, { undoable: false })
  await decisionFile(ex, 'r.json', { candidateId: 'c_aaaa', action: 'revise' })
  await decisionFile(ex, 'd.json', { candidateId: 'c_bbbb', action: 'discard' })
  await worker.tick()
  const s = await store.read()
  assert.equal(s.candidates.find(c => c.id === 'c_bbbb').status, 'discarded')
  assert.ok(s.runs.notices.some(n => n.text.includes('c_aaaa')))
})

test('坏文件产生一条提示但不影响本轮', async () => {
  const { worker, store, ex } = await setup({ exchangeNow: () => Date.now() + 60_000 })
  await writeFile(join(ex.root, 'posts', 'b-broken.json'), '{not json')
  await worker.tick()
  const s = await store.read()
  assert.equal(s.posts.length, 6)
  assert.ok(s.runs.notices.some(n => n.text === '交换文件夹里的 posts/b-broken.json 无法读取：不是有效的 JSON'))
})

test('拿不到锁时什么都不做', async () => {
  const { worker, store, clock, root } = await setup()
  const other = new Lock(join(root, 'worker.lock'), { now: () => clock.t.getTime(), pid: 424242 })
  assert.equal(await other.acquire(), true)
  assert.deepEqual(await worker.tick(), { ran: false })
  assert.equal((await store.read()).posts.length, 0)
})

test('tick 抛出异常不会让后台停掉', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let calls = 0
    const holder = {}
    const { worker, store, ex } = await setup({
      exchangeFor: () => {
        calls += 1
        if (calls === 1) throw new Error('交换文件夹不可用')
        return holder.ex
      },
    })
    holder.ex = ex
    const stop = worker.start()
    await worker.inflight
    assert.ok((await store.read()).runs.notices.some(n => n.text.includes('交换文件夹不可用')))
    mock.timers.tick(60_000)
    await worker.inflight
    assert.equal(calls, 2)
    assert.equal((await store.read()).posts.length, 6)
    stop()
  } finally {
    mock.timers.reset()
  }
})

test('提示：相同文字不连续重复，最多保留 50 条', () => {
  const s = { runs: { notices: [] } }
  addNotice(s, 'a', NOW)
  addNotice(s, 'a', NOW)
  assert.equal(s.runs.notices.length, 1)
  for (let i = 0; i < 60; i += 1) addNotice(s, `n${i}`, NOW)
  assert.equal(s.runs.notices.length, 50)
  assert.equal(s.runs.notices.at(-1).text, 'n59')
})

test('图片额度按生成次数计，跨天归零', () => {
  const state = { runs: { imagesDay: null, imagesCount: 0 } }
  assert.equal(imagesUsedToday(state, NOW), 0)
  countImage(state, NOW)
  countImage(state, NOW)
  assert.equal(imagesUsedToday(state, NOW), 2)
  assert.equal(imagesUsedToday(state, new Date('2026-11-12T08:00:00+08:00')), 0)
  countImage(state, new Date('2026-11-12T08:00:00+08:00'))
  assert.equal(state.runs.imagesCount, 1)
})

test('resolveExchangeDir：留空用数据目录下的 exchange，绝对路径原样使用', () => {
  assert.equal(resolveExchangeDir({ exchangeDir: '' }, '/data/x-desk'), '/data/x-desk/exchange')
  assert.equal(resolveExchangeDir({ exchangeDir: '/Users/me/sync' }, '/data/x-desk'), '/Users/me/sync')
})

test('后台改稿期间用户自己的撤销记录不会被动：后台没有新增、用户的还在', async () => {
  let release
  const gate = { hit: false, promise: new Promise(r => { release = r }) }
  const { worker, store, ex } = await setup({ samples: false, gate })
  await store.mutate('seed', s => {
    s.candidates.push(candidate('c_real1'))
    s.runs.lastComposeDay = TODAY
  }, { undoable: false })
  await decisionFile(ex, 'v.json', { candidateId: 'c_real1', action: 'view', text: '我的看法' })
  const running = worker.tick()
  while (!gate.hit) await new Promise(r => setTimeout(r, 5))
  await store.mutate('改稿', s => { s.notes.push({ id: 'n_1', text: 'x', used: false }) })
  release()
  await running
  assert.equal(store.undo.length, 1)
  assert.equal(store.undo[0].label, '改稿')
  assert.equal((await store.read()).candidates[0].revision, 1)
})

test('续锁失败：本轮立即停止，不再写出 drafts，记一条提示', async () => {
  const { worker, store, ex } = await setup({ samples: false })
  await store.mutate('seed', s => {
    s.candidates.push(candidate('c_real1'))
    s.runs.lastComposeDay = TODAY
  }, { undoable: false })
  let n = 0
  worker.lock = { acquire: async () => (n += 1) === 1, release: async () => {} }
  assert.deepEqual(await worker.tick(), { ran: true, aborted: true })
  assert.deepEqual(await readdir(join(ex.root, 'drafts')), [])
  assert.ok((await store.read()).runs.notices.some(x => x.text === '后台处理被另一个进程接管，本轮已停止'))
})

test('合并失败时文件不算处理过，下一轮重新读入', async () => {
  const { worker, store, ex } = await setup()
  const original = store.mutate.bind(store)
  let failed = false
  store.mutate = (label, fn, opts) => {
    if (!failed && label === '后台处理') {
      failed = true
      return Promise.reject(new Error('写盘失败'))
    }
    return original(label, fn, opts)
  }
  await assert.rejects(worker.tick(), /写盘失败/)
  assert.equal((await store.read()).posts.length, 0)
  assert.ok(ex)
  await worker.tick()
  assert.equal((await store.read()).posts.length, 6)
})

test('停止函数等进行中的这一轮结束后才释放锁', async () => {
  const { worker, root } = await setup()
  const stop = worker.start()
  await stop()
  assert.equal(await readdir(root).then(f => f.includes('worker.lock')), false)
})

test('手动成稿记录尝试时间：30 分钟内后台不再自动成稿', async () => {
  const { worker, composeCalls } = await setup()
  worker.noteAttempt()
  await worker.tick()
  assert.equal(composeCalls(), 0)
})

test('一条候选稿写不出去不影响其他稿子，留一条点名的提示', async () => {
  const { worker, store, ex } = await setup({ samples: false })
  await store.mutate('seed', s => {
    s.candidates.push(candidate('c_bad1'), candidate('c_good1'))
    s.runs.lastComposeDay = TODAY
  }, { undoable: false })
  const write = ex.writeDraft.bind(ex)
  ex.writeDraft = async (c, ...rest) => {
    if (c.id === 'c_bad1') throw new Error('写坏了')
    return write(c, ...rest)
  }
  assert.deepEqual(await worker.tick(), { ran: true })
  assert.deepEqual(await readdir(join(ex.root, 'drafts')), ['c_good1-r0.json'])
  assert.ok((await store.read()).runs.notices.some(n => n.text.includes('c_bad1') && n.text.includes('写坏了')))
  assert.ok((await readFile(join(ex.root, 'voice', 'SKILL.md'), 'utf8')).length > 0)
})
