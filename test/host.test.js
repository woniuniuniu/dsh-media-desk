process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { withTimeout } from '../src/ai.js'
import { Composer } from '../src/compose.js'
import { Longform } from '../src/longform.js'
import { createHandler } from '../src/host.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'
import { localDay } from '../src/worker.js'

const candidate = (id, extra = {}) => ({
  id, form: 'post', typeId: 't_model', text: '一条稿子', aiText: '一条稿子', title: '标题', sourcePostIds: [], sourceNoteId: null, quoteUrl: null,
  reason: '', score: 1, status: 'pending', createdAt: new Date().toISOString(), scheduledAt: null, decidedAt: null, discardReason: null, view: null, revision: 0, image: null, ...extra,
})

/**
 * 起一个只挂 x-desk 处理函数的本地服务。rejection 决定鉴权结果；callText 是假模型。
 */
async function serve({ rejection = () => undefined, connection = true, callText = async () => ({ text: '[]' }) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'host-'))
  const store = new Store(root)
  const settings = new Settings(root)
  const composer = new Composer({ store, settings, callText })
  const desk = { settings, composer, longform: new Longform({ store, callText }), worker: { noteAttempt() {} } }
  const ctx = { get: name => (name === 'connection' && connection ? { requestRejection: rejection } : undefined) }
  const server = createServer(createHandler({ ctx, store, desk, callText }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  // 原样发出路径，不让客户端先把 ../ 规范化掉
  const call = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = JSON.parse(text) } catch { data = text }
        resolve({ status: res.statusCode, data, text })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
  return { root, store, settings, composer, desk, call, close: () => new Promise(r => server.close(r)) }
}

test('鉴权：拒绝时用鉴权服务给的状态码；拿不到鉴权服务一律 403', async () => {
  const denied = await serve({ rejection: () => 401 })
  try {
    const r = await denied.call('GET', '/x-desk/state')
    assert.equal(r.status, 401)
    assert.equal(r.data.error, '未授权')
  } finally { await denied.close() }
  const none = await serve({ connection: false })
  try {
    assert.equal((await none.call('GET', '/x-desk/state')).status, 403)
  } finally { await none.close() }
})

test('跨站的写请求被拒绝', async () => {
  const h = await serve()
  try {
    const r = await h.call('POST', '/x-desk/ops', { body: { ops: [] }, headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(r.status, 403)
    assert.equal((await h.call('POST', '/x-desk/ops', { body: { ops: [] }, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200)
  } finally { await h.close() }
})

test('files/ 只能取 files 目录里的图片，路径穿越都拿不到目录外的文件', async () => {
  const h = await serve()
  try {
    await h.store.read()
    await writeFile(join(h.root, 'secret.png'), 'SECRET')
    await writeFile(join(h.store.filesDir, 'ok.png'), 'PNGDATA')
    assert.equal((await h.call('GET', '/x-desk/files/ok.png')).text, 'PNGDATA')
    for (const path of ['/x-desk/files/../secret.png', '/x-desk/files/%2e%2e/secret.png', '/x-desk/files/..%2fsecret.png', '/x-desk/files/%2e%2e%2fsecret.png', `/x-desk/files/${encodeURIComponent(join(h.root, 'secret.png'))}`, '/x-desk/files//etc/passwd', '/x-desk/files/nope.png', '/x-desk/files/state.json']) {
      const r = await h.call('GET', path)
      assert.ok(r.status === 400 || r.status === 404, `${path} → ${r.status}`)
      assert.ok(!r.text.includes('SECRET'), path)
    }
  } finally { await h.close() }
})

test('请求体不是 JSON 对象时回 400', async () => {
  const h = await serve()
  try {
    for (const body of ['null', '[1,2]', '"text"', '42', '{bad']) {
      const r = await h.call('POST', '/x-desk/ops', { body })
      assert.equal(r.status, 400, body)
    }
  } finally { await h.close() }
})

test('出稿：同时点两次，一个出稿、一个 409；状态里能看到正在出稿', async () => {
  let release
  const gate = new Promise(r => { release = r })
  let started
  const hit = new Promise(r => { started = r })
  const now = new Date()
  const posts = ['1855000000000000001', '1855000000000000002'].map((id, i) => ({
    id, handle: 'karpathy', text: `素材 ${i}`, url: null, postedAt: new Date(now - 3600e3).toISOString(), fetchedAt: now.toISOString(),
    likes: 100 * (i + 1), replies: 1, reposts: 1, quotes: 1, views: 10, isRepost: false, used: false,
  }))
  const callText = async () => {
    started()
    await gate
    return { text: JSON.stringify([{ title: '选题', postIds: [posts[0].id], fun: 2, info: 2, resonance: 0, form: 'post', reason: 'r' }]) }
  }
  const h = await serve({ callText })
  try {
    await h.store.mutate('seed', s => { s.posts = posts }, { undoable: false })
    const first = h.call('POST', '/x-desk/compose/run', { body: {} })
    await hit
    assert.equal((await h.call('GET', '/x-desk/state')).data.composing, true)
    const second = await h.call('POST', '/x-desk/compose/run', { body: { force: true } })
    assert.equal(second.status, 409)
    assert.equal(second.data.error, '正在出稿，请稍等')
    assert.equal(second.data.busy, true)
    release()
    const done = await first
    assert.equal(done.status, 200)
    assert.equal(done.data.composing, false)
    assert.equal((await h.call('GET', '/x-desk/state')).data.composing, false)
  } finally { release(); await h.close() }
})

test('出稿：今天已经成功过，不带 force 回 409', async () => {
  const h = await serve()
  try {
    await h.store.mutate('seed', s => { s.runs.lastComposeDay = localDay(new Date()) }, { undoable: false })
    const r = await h.call('POST', '/x-desk/compose/run', { body: {} })
    assert.equal(r.status, 409)
    assert.notEqual(r.data.busy, true)
  } finally { await h.close() }
})

test('配图：没通过的稿子不能配图；额度用完回 429；配图不占撤销位', async () => {
  const h = await serve()
  try {
    await h.store.mutate('seed', s => { s.candidates.push(candidate('c_pend1'), candidate('c_appr1', { status: 'approved', scheduledAt: new Date().toISOString() })) }, { undoable: false })
    const notApproved = await h.call('POST', '/x-desk/candidate/image', { body: { id: 'c_pend1' } })
    assert.equal(notApproved.status, 400)
    await h.settings.update({ image: { baseUrl: 'https://img.example/v1', model: 'm', apiKey: 'k-secret' }, dailyImages: 0 })
    const quota = await h.call('POST', '/x-desk/candidate/image', { body: { id: 'c_appr1' } })
    assert.equal(quota.status, 429)
  } finally { await h.close() }
})

test('配图成功后撤销不会退回额度，也不占用户的撤销位', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  const images = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })) })
  await new Promise(resolve => images.listen(0, '127.0.0.1', resolve))
  const h = await serve()
  try {
    await h.store.mutate('seed', s => { s.candidates.push(candidate('c_appr1', { status: 'approved', scheduledAt: new Date().toISOString() })) }, { undoable: false })
    await h.settings.update({ image: { baseUrl: `http://127.0.0.1:${images.address().port}/v1`, model: 'm', apiKey: 'k' }, dailyImages: 1 })
    const op = await h.call('POST', '/x-desk/ops', { body: { ops: [{ op: 'add_note', text: '用户自己的一步' }], label: '记笔记' } })
    assert.deepEqual([op.data.applied, op.data.canUndo], [['已记下笔记'], true])
    const r = await h.call('POST', '/x-desk/candidate/image', { body: { id: 'c_appr1' } })
    assert.equal(r.status, 200)
    assert.equal(r.data.state.runs.imagesCount, 1)
    assert.equal(h.store.undo.length, 1)
    assert.equal((await h.call('POST', '/x-desk/undo', { body: {} })).data.label, '记笔记')
    const s = await h.store.read()
    assert.equal(s.runs.imagesCount, 1)
    assert.ok(s.candidates[0].image)
    assert.equal(s.notes.length, 0)
  } finally { await h.close(); await new Promise(r => images.close(r)) }
})

test('内部错误只回固定文字，不带本机路径', async () => {
  const h = await serve()
  try {
    h.desk.settings.read = async () => { throw new Error(`EACCES: permission denied, open '${h.root}/settings.json'`) }
    const r = await h.call('GET', '/x-desk/state')
    assert.equal(r.status, 500)
    assert.deepEqual(r.data, { error: '内部错误' })
    assert.ok(!r.text.includes(h.root))
  } finally { await h.close() }
})

test('模型失败回 502 并带上原因，不算内部错误', async () => {
  const h = await serve({ callText: async () => { throw Object.assign(new Error('模型超过 2 分钟没有响应'), { status: 502 }) } })
  try {
    await h.store.mutate('seed', s => { s.notes.push({ id: 'n_1', text: '一条笔记', url: null, createdAt: new Date().toISOString(), used: false }) }, { undoable: false })
    const r = await h.call('POST', '/x-desk/note/compose', { body: { id: 'n_1' } })
    assert.equal(r.status, 502)
    assert.match(r.data.error, /2 分钟/)
  } finally { await h.close() }
})

test('文字模型调用超过时限按普通错误报告，并中止底层调用', async () => {
  let seen
  const hang = withTimeout(({ signal }) => { seen = signal; return new Promise(() => {}) }, 20)
  await assert.rejects(hang({ system: 's', user: 'u' }), { message: '模型超过 2 分钟没有响应' })
  assert.equal(seen.aborted, true)
  const outer = new AbortController()
  const pending = withTimeout(() => new Promise(() => {}), 60_000)({ signal: outer.signal })
  outer.abort(new Error('用户取消'))
  await assert.rejects(pending, { message: '用户取消' })
  assert.deepEqual(await withTimeout(async req => ({ text: req.user }), 1000)({ user: 'ok' }), { text: 'ok' })
})

test('GET insights：已鉴权返回复盘数据，未鉴权被拒绝', async () => {
  const h = await serve()
  try {
    const r = await h.call('GET', '/x-desk/insights')
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.data).sort(), ['byType', 'edits', 'followers', 'funnel', 'replies', 'top', 'totals'])
  } finally { await h.close() }
  const denied = await serve({ rejection: () => 401 })
  try {
    assert.equal((await denied.call('GET', '/x-desk/insights')).status, 401)
  } finally { await denied.close() }
})

test('长文路由：没有素材时建议返回原因且不调用模型；未知选题 404；空修改要求 400；说一句来改可以撤销', async () => {
  let calls = 0
  const h = await serve({ callText: async () => { calls += 1; return { text: `第${calls}版` } } })
  try {
    const r = await h.call('POST', '/x-desk/longform/suggest', { body: {} })
    assert.equal(r.status, 200)
    assert.equal(r.data.created, 0)
    assert.equal(r.data.error, '还没有足够的内容来建议长文选题')
    assert.deepEqual(r.data.state.longforms, [])
    assert.equal((await h.call('POST', '/x-desk/longform/draft', { body: { id: 'l_nope' } })).status, 404)
    await h.store.mutate('seed', s => {
      s.longforms.push({ id: 'l_1', title: 't', angle: '', typeId: 't_model', body: '正文', aiBody: '正文', status: 'draft', createdAt: '', updatedAt: '', revision: 1, error: null })
    }, { undoable: false })
    assert.equal((await h.call('POST', '/x-desk/longform/revise', { body: { id: 'l_1', instruction: '  ' } })).status, 400)
    assert.equal(calls, 0)
    assert.equal(h.store.undo.length, 0)
    await h.store.mutate('seed', s => {
      s.longforms.push({ ...s.longforms[0], id: 'l_2', body: '', aiBody: '', status: 'idea', revision: 0 })
    }, { undoable: false })
    const draft = await h.call('POST', '/x-desk/longform/draft', { body: { id: 'l_2' } })
    assert.equal(draft.status, 200)
    assert.deepEqual([draft.data.state.longforms[1].body, draft.data.state.longforms[1].status, draft.data.state.longforms[1].revision], ['第1版', 'draft', 1])
    assert.equal(h.store.undo.length, 0)
    const revise = await h.call('POST', '/x-desk/longform/revise', { body: { id: 'l_2', instruction: '简短一点' } })
    assert.equal(revise.status, 200)
    assert.deepEqual([revise.data.state.longforms[1].body, revise.data.state.longforms[1].revision], ['第2版', 2])
    // 改稿会替换负责人手改过的正文，所以可以撤销
    assert.equal(h.store.undo.length, 1)
    assert.equal(revise.data.canUndo, true)
    const undone = await h.call('POST', '/x-desk/undo', { body: {} })
    assert.equal(undone.status, 200)
    assert.deepEqual([undone.data.state.longforms[1].body, undone.data.state.longforms[1].revision], ['第1版', 1])
    assert.equal(calls, 2)
  } finally { await h.close() }
})

const CARD = JSON.stringify({ name: '我的', summary: '短', tone: 't', sentences: 's', opening: 'o', structure: 'x', words: ['a'], avoid: [], samples: ['q'] })
const ownPosts = n => Array.from({ length: n }, (_, i) => ({
  id: `185600000000000${String(i).padStart(4, '0')}`, kind: 'post', text: `第${i}条`, url: null, postedAt: new Date(Date.now() - (i + 1) * 3600e3).toISOString(),
  fetchedAt: new Date().toISOString(), likes: i, replies: 0, reposts: 0, quotes: 0, views: 10, inReplyTo: null, candidateId: null, replyId: null,
}))

test('POST voice/extract-own：不足 10 条返回 400 和还差几条；成功返回风格卡，状态不变', async () => {
  let calls = 0
  const h = await serve({ callText: async () => { calls += 1; return { text: CARD } } })
  try {
    await h.store.mutate('seed', s => { s.mine = ownPosts(7) }, { undoable: false })
    const few = await h.call('POST', '/x-desk/voice/extract-own', { body: {} })
    assert.equal(few.status, 400)
    assert.equal(few.data.error, '自己发出的内容还不够，再攒 3 条再来提炼')
    assert.equal(calls, 0)
    await h.store.mutate('seed', s => { s.mine = ownPosts(12) }, { undoable: false })
    const before = JSON.stringify(await h.store.read())
    const ok = await h.call('POST', '/x-desk/voice/extract-own', { body: {} })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.style.name, '我的')
    assert.deepEqual(Object.keys(ok.data), ['style'])
    assert.equal(JSON.stringify(await h.store.read()), before)
    assert.equal(h.store.undo.length, 0)
  } finally { await h.close() }
})

test('POST voice/extract-own：模型失败或返回乱码按 502，状态不变；跨站请求 403', async () => {
  let reply = () => { throw new Error('模型挂了') }
  const h = await serve({ callText: async () => reply() })
  try {
    await h.store.mutate('seed', s => { s.mine = ownPosts(12) }, { undoable: false })
    const failed = await h.call('POST', '/x-desk/voice/extract-own', { body: {} })
    assert.equal(failed.status, 502)
    assert.equal(failed.data.error, '模型挂了')
    reply = () => ({ text: '不是 JSON' })
    assert.equal((await h.call('POST', '/x-desk/voice/extract-own', { body: {} })).status, 502)
    const cross = await h.call('POST', '/x-desk/voice/extract-own', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(cross.status, 403)
  } finally { await h.close() }
})

test('GET state 带上 ownHandle，GET insights 在显示时拼链接；存下来的数据一个字都不改', async () => {
  const h = await serve()
  try {
    await h.store.mutate('seed', s => { s.mine = ownPosts(2) }, { undoable: false })
    const stored = JSON.stringify(await h.store.read())
    assert.equal((await h.call('GET', '/x-desk/state')).data.ownHandle, '')
    assert.equal((await h.call('GET', '/x-desk/insights')).data.top[0].url, null)
    await h.settings.update({ ownHandle: 'me_x' })
    const state = await h.call('GET', '/x-desk/state')
    assert.equal(state.data.ownHandle, 'me_x')
    assert.ok(state.data.state.mine.every(m => m.url === null))
    const top = (await h.call('GET', '/x-desk/insights')).data.top
    assert.ok(top.length > 0)
    for (const t of top) assert.equal(t.url, `https://x.com/me_x/status/${t.id}`)
    assert.equal(JSON.stringify(await h.store.read()), stored)
  } finally { await h.close() }
})

test('同步默认关闭，手动同步被拒绝，状态返回默认间隔', async () => {
  const h = await serve()
  try {
    const run = await h.call('POST', '/x-desk/sync/run', { body: {} })
    assert.equal(run.status, 400)
    assert.equal(run.data.error, '同步还没打开')
    const status = await h.call('GET', '/x-desk/sync/status')
    assert.equal(status.status, 200)
    assert.equal(status.data.enabled, false)
    assert.equal(status.data.intervalSec, 120)
    assert.equal(status.data.lastSyncAt, null)
    assert.equal(status.data.lastSyncError, null)
  } finally { await h.close() }
})

test('M4/M5: manual sync route uses worker and returns busy 409 without recording failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-sync-')), store = new Store(root), settings = new Settings(root)
  await settings.update({ sync: { enabled: true } })
  await store.mutate('seed', s => { s.runs.lastSyncError = 'previous' }, { undoable: false })
  const before = structuredClone((await store.read()).runs)
  let calls = 0
  const busy = { ok: false, pulled: 0, pushed: 0, error: '上一轮同步还没结束' }
  const desk = { settings, worker: { syncNow: async () => { calls++; return busy } } }
  const handler = createHandler({ ctx: { get: () => ({ requestRejection: () => undefined }) }, store, desk })
  const req = Object.assign(Readable.from([]), { method: 'POST', url: '/x-desk/sync/run', headers: {} })
  const res = { setHeader() {}, end(body) { this.body = JSON.parse(body) } }
  await handler(req, res)
  assert.equal(calls, 1)
  assert.equal(res.statusCode, 409)
  assert.deepEqual(res.body, busy)
  assert.deepEqual((await store.read()).runs, before)
})
