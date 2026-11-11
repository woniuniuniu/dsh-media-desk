process.env.TZ = 'Asia/Shanghai'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withTimeout } from '../src/ai.js'
import { Composer } from '../src/compose.js'
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
  const desk = { settings, composer, worker: { noteAttempt() {} } }
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

test('出稿：今天已经成功过，不带 force 回 409', async () => {
  const h = await serve()
  try {
    await h.store.mutate('seed', s => { s.runs.lastComposeDay = localDay(new Date()) }, { undoable: false })
    const r = await h.call('POST', '/x-desk/compose/run', { body: {} })
    assert.equal(r.status, 409)
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
    await h.call('POST', '/x-desk/ops', { body: { ops: [{ op: 'add_note', text: '用户自己的一步' }], label: '记笔记' } })
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
