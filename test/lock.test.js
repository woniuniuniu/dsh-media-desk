import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Lock } from '../src/lock.js'

const tmpLockFile = async () => join(await mkdtemp(join(tmpdir(), 'xdesk-lock-')), 'worker.lock')

test('同一时刻只有一个进程拿到锁；心跳超时后可以被接管', async () => {
  const file = await tmpLockFile()
  let clock = 1_000_000
  const a = new Lock(file, { pid: 1, now: () => clock })
  const b = new Lock(file, { pid: 2, now: () => clock })
  assert.equal(await a.acquire(), true)
  assert.equal(await b.acquire(), false)
  assert.equal(await a.acquire(), true)      // 自己续期
  clock += 180_001
  assert.equal(await b.acquire(), true)      // a 的心跳过期，b 接管
  assert.equal(await a.acquire(), false)
  await a.release()                          // 不是自己的锁，不能删
  assert.equal(await a.acquire(), false)
  await b.release()
  assert.equal(await a.acquire(), true)
})

test('锁文件损坏（不是 JSON 或缺字段）视为没有锁，直接接管', async () => {
  const file = await tmpLockFile()
  const a = new Lock(file, { pid: 1, now: () => 1_000_000 })
  await writeFile(file, 'not json{{')
  assert.equal(await a.acquire(), true)
  await writeFile(file, JSON.stringify({ pid: 9 }))
  const b = new Lock(file, { pid: 2, now: () => 1_000_000 })
  assert.equal(await b.acquire(), true)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, 2)
})

test('release 时锁文件不存在不报错；锁所在目录不存在时 acquire 会创建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdesk-lock-'))
  const a = new Lock(join(dir, 'sub', 'deep', 'worker.lock'), { pid: 1 })
  await a.release()
  assert.equal(await a.acquire(), true)
  await a.release()
  await a.release()
})

const contenders = (file, n, opts = {}) =>
  Array.from({ length: n }, (_, i) => new Lock(file, { pid: 100 + i, ...opts }))
const holder = async (file) => JSON.parse(await readFile(file, 'utf8')).pid

test('20 个进程同时抢一把新锁，只有一个成功（重复 25 轮）', async () => {
  for (let round = 0; round < 25; round++) {
    const file = await tmpLockFile()
    const results = await Promise.all(contenders(file, 20).map((l) => l.acquire()))
    assert.equal(results.filter(Boolean).length, 1, `第 ${round} 轮`)
    assert.equal(await holder(file), 100 + results.indexOf(true))
  }
})

test('20 个进程同时接管一把过期锁，只有一个成功（重复 25 轮）', async () => {
  for (let round = 0; round < 25; round++) {
    const file = await tmpLockFile()
    await writeFile(file, JSON.stringify({ pid: 999, at: 1 }))
    const results = await Promise.all(contenders(file, 20, { now: () => 10_000_000 }).map((l) => l.acquire()))
    assert.equal(results.filter(Boolean).length, 1, `第 ${round} 轮`)
    assert.equal(await holder(file), 100 + results.indexOf(true))
  }
})

test('接管时发现主人刚续了期：不抢，锁还给主人', async () => {
  const file = await tmpLockFile()
  const now = () => 10_000_000
  await writeFile(file, JSON.stringify({ pid: 1, at: 1 }))
  const hooks = { afterStaleRead: () => writeFile(file, JSON.stringify({ pid: 1, at: now() })) }
  const b = new Lock(file, { pid: 2, now, hooks })
  assert.equal(await b.acquire(), false)
  assert.equal(await holder(file), 1)
})

test('非主人 release 不会动主人的锁', async () => {
  const file = await tmpLockFile()
  const a = new Lock(file, { pid: 1 })
  const b = new Lock(file, { pid: 2 })
  assert.equal(await a.acquire(), true)
  await b.release()
  assert.equal(await holder(file), 1)
  assert.equal(await b.acquire(), false)
})

test('心跳时间在未来超过 ttl 的锁视为过期，可被接管', async () => {
  const file = await tmpLockFile()
  const now = () => 1_000_000
  await writeFile(file, JSON.stringify({ pid: 9, at: now() + 180_000 + 1 }))
  assert.equal(await new Lock(file, { pid: 2, now }).acquire(), true)
  assert.equal(await holder(file), 2)
})
