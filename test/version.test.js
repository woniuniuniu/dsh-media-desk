// 版本检查：比版本号、registry 挂了换镜像、结果按 TTL 缓存。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createVersionCheck, currentVersion, isNewerRelease, parseVersion } from '../src/version.js'

const NPM = 'https://registry.npmjs.org/dsh-media-desk/latest'
const MIRROR = 'https://registry.npmmirror.com/dsh-media-desk/latest'

function fakeFetch(answers) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const answer = answers[url]
    if (answer === undefined) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => ({ version: answer }) }
  }
  impl.calls = calls
  return impl
}

test('parseVersion 认得正式版和 rc 版', () => {
  assert.deepEqual(parseVersion('2.7.1'), { major: 2, minor: 7, patch: 1, rank: 4, serial: 0 })
  assert.deepEqual(parseVersion('v0.2.1-rc.5'), { major: 0, minor: 2, patch: 1, rank: 3, serial: 5 })
  assert.deepEqual(parseVersion('2.8.0-beta.2+sha.abc'), { major: 2, minor: 8, patch: 0, rank: 2, serial: 2 })
  assert.equal(parseVersion('2.7'), null)
  assert.equal(parseVersion('latest'), null)
  assert.equal(parseVersion(null), null)
})

test('isNewerRelease 只在新版本更大时为真', () => {
  assert.equal(isNewerRelease('2.7.2', '2.7.1'), true)
  assert.equal(isNewerRelease('2.7.1', '2.7.1'), false)
  assert.equal(isNewerRelease('2.6.9', '2.7.1'), false)
  assert.equal(isNewerRelease('2.8.0-rc.1', '2.7.1'), true)
  assert.equal(isNewerRelease('2.7.1-rc.2', '2.7.1'), false)
  assert.equal(isNewerRelease('2.7.1-rc.3', '2.7.1-rc.2'), true)
  assert.equal(isNewerRelease('坏掉的版本号', '2.7.1'), false)
})

test('同一 x.y.z 时正式版比 rc 新（不许把 rc 当最新）', () => {
  assert.equal(isNewerRelease('2.7.1', '2.7.1-rc.2'), true)
  assert.equal(isNewerRelease('2.7.1-rc.2', '2.7.1'), false)
})

test('查挂了不抹掉上次查到的新版本', async () => {
  let now = 0
  let down = false
  const impl = async () => (down ? { ok: false } : { ok: true, json: async () => ({ version: '9.9.9' }) })
  const check = createVersionCheck({ fetchImpl: impl, now: () => now })
  assert.equal((await check.read()).updateAvailable, true)
  down = true
  now = 2 * 60 * 60 * 1000
  const after = await check.read()
  assert.equal(after.failed, true)
  assert.equal(after.latest, '9.9.9')
  assert.equal(after.updateAvailable, true)
})

test('同一时刻只问一轮 registry', async () => {
  const calls = []
  let release
  const gate = new Promise(done => { release = done })
  const impl = async (url) => {
    calls.push(url)
    await gate
    return { ok: true, json: async () => ({ version: '9.9.9' }) }
  }
  const check = createVersionCheck({ fetchImpl: impl, now: () => 1 })
  const pending = Promise.all([check.read(), check.read(), check.read()])
  await Promise.resolve()
  release()
  const results = await pending
  assert.equal(calls.length, 1)
  assert.equal(results[2].updateAvailable, true)
})

test('currentVersion 读得到自己的 package.json', () => {
  assert.match(currentVersion() ?? '', /^\d+\.\d+\.\d+/)
})

test('第一个 registry 就成了就用它，一小时内的第二次读走缓存', async () => {
  let now = 1_000
  const fetchImpl = fakeFetch({ [NPM]: '9.9.9' })
  const check = createVersionCheck({ fetchImpl, now: () => now })

  const info = await check.read()
  assert.equal(info.current, currentVersion())
  assert.equal(info.latest, '9.9.9')
  assert.equal(info.updateAvailable, true)
  assert.equal(info.failed, false)
  assert.equal(info.ready, true)
  assert.equal(typeof info.checkedAt, 'string')

  now += 30 * 60 * 1000
  await check.read()
  assert.equal(fetchImpl.calls.length, 1)
})

test('registry 挂了换镜像；全挂时标记失败，不冒充有新版本', async () => {
  const fallback = fakeFetch({ [MIRROR]: '9.9.9' })
  const info = await createVersionCheck({ fetchImpl: fallback, now: () => 1_000 }).read()
  assert.equal(info.latest, '9.9.9')
  assert.deepEqual(fallback.calls, [NPM, MIRROR])

  const down = fakeFetch({})
  const failed = await createVersionCheck({ fetchImpl: down, now: () => 1_000 }).read()
  assert.equal(failed.failed, true)
  assert.equal(failed.latest, null)
  assert.equal(failed.updateAvailable, null)
})

test('失败半分钟后才重试，成功一小时内不再问', async () => {
  let now = 0
  const down = fakeFetch({})
  const failing = createVersionCheck({ fetchImpl: down, now: () => now })
  await failing.read()
  assert.equal(down.calls.length, 2)
  now = 10_000
  await failing.read()
  assert.equal(down.calls.length, 2)
  now = 40_000
  await failing.read()
  assert.equal(down.calls.length, 4)

  now = 0
  let answer = '9.9.9'
  const calls = []
  const up = async (url) => {
    calls.push(url)
    return { ok: true, json: async () => ({ version: answer }) }
  }
  const ok = createVersionCheck({ fetchImpl: up, now: () => now })
  await ok.read()
  now = 61 * 60 * 1000
  answer = '9.9.9'
  const again = await ok.read()
  assert.equal(calls.length, 2)
  assert.equal(again.updateAvailable, true)
})
