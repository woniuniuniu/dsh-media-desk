import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { publicSettings, Settings } from '../src/settings.js'
import { Store } from '../src/store.js'

const row = (id, extra = {}) => ({ id, text: '原文', score: 1, status: 'pending', revision: 0, ...extra })
const fresh = async () => new Store(await mkdtemp(join(tmpdir(), 'xdesk-store-')))

test('撤销用户操作时，后台之后对同一行别的字段的写入保留', async () => {
  const store = await fresh()
  await store.mutate('seed', s => { s.candidates.push(row('c_1')) }, { undoable: false })
  await store.mutate('改了正文', s => { s.candidates[0].text = '用户改的'; s.candidates[0].revision = 1 })
  await store.mutate('后台', s => { s.candidates[0].score = 9 }, { undoable: false })
  assert.equal(await store.undoLast(), '改了正文')
  const [c] = (await store.read()).candidates
  assert.deepEqual([c.text, c.revision, c.score], ['原文', 0, 9])
})

test('撤销栈为空时撤销什么都不改', async () => {
  const store = await fresh()
  await store.mutate('后台', s => { s.notes.push({ id: 'n_1', text: 'x' }) }, { undoable: false })
  const before = JSON.stringify(await store.read())
  assert.equal(await store.undoLast(), null)
  assert.equal(JSON.stringify(await store.read()), before)
})

test('settings.json 创建时权限是 600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xdesk-settings-'))
  await new Settings(root).update({ image: { apiKey: 'k-secret' } })
  assert.equal((await stat(join(root, 'settings.json'))).mode & 0o777, 0o600)
})

test('读设置只保留已知字段，旧版留下的字段不会传给浏览器', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xdesk-settings-'))
  await writeFile(join(root, 'settings.json'), JSON.stringify({ composeAt: '08:00', legacyToken: 'x', activeFrom: '08:00', image: { model: 'm', oldField: 1 }, assistant: { provider: '', model: '', extra: 2 } }))
  const value = await new Settings(root).read()
  assert.equal(value.composeAt, '08:00')
  assert.equal(value.image.model, 'm')
  for (const key of ['legacyToken', 'activeFrom', 'activeTo']) assert.ok(!(key in value), key)
  assert.ok(!('oldField' in value.image))
  assert.ok(!('extra' in value.assistant))
  assert.ok(!('legacyToken' in publicSettings(value)))
})

test('交换文件夹不能放在原版插件的数据目录里', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xdesk-dsh-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const settings = new Settings(await mkdtemp(join(tmpdir(), 'xdesk-settings-')))
    const old = join(home, 'media' + '-desk')
    for (const dir of [old, join(old, 'exchange'), `${old}/sub/../x`]) {
      await assert.rejects(settings.update({ exchangeDir: dir }), { status: 400 }, dir)
    }
    assert.equal((await settings.update({ exchangeDir: join(home, 'media-desk-sync') })).exchangeDir, join(home, 'media-desk-sync'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})
