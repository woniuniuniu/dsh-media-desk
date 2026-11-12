import assert from 'node:assert/strict'
import { readdir, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyOps } from '../src/ops.js'
import { emptyState, migrateState } from '../src/seed.js'
import { Settings } from '../src/settings.js'
import { tr } from '../src/i18n.js'

test('初始状态是空的第 2 版结构', () => {
  const s = emptyState()
  assert.equal(s.version, 2)
  for (const key of ['watch', 'posts', 'notes', 'candidates', 'rules']) assert.deepEqual(s[key], [])
  assert.equal(s.voice.core, null)
  assert.deepEqual(s.voice.types.map(t => [t.id, t.name]), [['t_product', '产品'], ['t_model', '模型'], ['t_tech', '技术底层'], ['t_society', '社会']])
  assert.deepEqual(s.runs, { lastComposeDay: null, lastComposeError: null, lastComposeAt: null, lastComposeOutcome: null, notices: [], imagesDay: null, imagesCount: 0 })
})
test('旧版数据不迁移，直接从空状态开始', () => {
  assert.deepEqual(migrateState({ version: 1, items: [{ id: 'a' }] }), emptyState())
})
test('目标账号：去掉 @、拒绝非法账号名、不重复', () => {
  const s = emptyState()
  applyOps(s, [{ op: 'add_watch', handle: '@karpathy', tier: 'engage' }, { op: 'add_watch', handle: 'karpathy', tier: 'topic' }])
  assert.equal(s.watch.length, 1)
  assert.equal(s.watch[0].handle, 'karpathy')
  const bad = applyOps(s, [{ op: 'add_watch', handle: 'a b; rm -rf', tier: 'topic' }, { op: 'add_watch', handle: 'ok_name', tier: 'vip' }])
  assert.equal(s.watch.length, 1)
  assert.equal(bad.errors.length, 2)
})
test('不认识的操作被拒绝', () => {
  const r = applyOps(emptyState(), [{ op: 'add_item', title: 'x' }])
  assert.equal(r.applied.length, 0)
  assert.equal(r.errors.length, 1)
})
test('原型链上的名字不算操作', () => {
  const r = applyOps(emptyState(), ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map(op => ({ op })))
  assert.deepEqual(r.applied, [])
  assert.equal(r.errors.length, 4)
  for (const message of r.errors) assert.match(message, /不认识的操作/)
})
test('设置：时间格式和数量被校验', async () => {
  const settings = new Settings(await mkdtemp(join(tmpdir(), 'xdesk-')))
  assert.equal((await settings.read()).composeAt, '07:00')
  await assert.rejects(settings.update({ composeAt: '25:00' }))
  await assert.rejects(settings.update({ slots: [] }))
  await assert.rejects(settings.update({ exchangeDir: 'relative/path' }))
  assert.equal((await settings.update({ dailyCandidates: 99 })).dailyCandidates, 12)
})
test('tr 只做占位符替换', () => {
  assert.equal(tr('共 {n} 条', { n: 3 }), '共 3 条')
})
test('源码里没有被禁止的东西', async () => {
  for (const dir of ['src', 'client', 'scripts']) {
    for (const file of await readdir(new URL(`../${dir}`, import.meta.url), { recursive: true })) {
      if (!/\.(js|jsx|mjs|sh)$/.test(file)) continue
      const text = await readFile(new URL(`../${dir}/${file}`, import.meta.url), 'utf8')
      assert.doesNotMatch(text, /monid|api\.x\.com|api\.twitter\.com|小红书|抖音|TikTok|shotCount/i, `${dir}/${file}`)
    }
  }
})
