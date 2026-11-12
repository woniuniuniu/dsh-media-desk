import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { Exchange } from '../src/exchange.js'
import { createHandler } from '../src/host.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'
import { Sync } from '../src/sync.js'
import { Worker, localDay } from '../src/worker.js'

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'sync-test-'))
const tempRoot = await realpath(root)
// 所有子进程只用临时 HOME，不读取开发者的 Git 配置或凭证。
process.env.HOME = root
const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' }
async function git(cwd, ...args) {
  const rel = relative(tempRoot, await realpath(cwd))
  assert.ok(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)), `git cwd outside fixture: ${cwd}`)
  return (await exec('git', args, { cwd, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}
let gitAvailable = true
try { await git(root, '--version') } catch { gitAvailable = false }
const integration = (name, fn) => test(name, { skip: !gitAvailable && '本机 git 不可用，跳过本地仓库集成测试' }, fn)
const put = async (dir, file, text = '{}') => {
  await mkdir(dirname(join(dir, file)), { recursive: true })
  await writeFile(join(dir, file), text)
}
async function fixture() {
  const base = await mkdtemp(join(root, 'repo-'))
  const remote = join(base, 'remote.git')
  await git(base, 'init', '--bare', '-b', 'main', remote)
  for (const name of ['a', 'b']) {
    await git(base, 'clone', remote, name)
    await git(join(base, name), 'config', 'user.name', 'test')
    await git(join(base, name), 'config', 'user.email', 'test@localhost')
  }
  const a = join(base, 'a'), b = join(base, 'b')
  await put(b, 'README', 'fixture')
  await git(b, 'add', 'README')
  await git(b, 'commit', '-m', 'initial')
  await git(b, 'push', '-u', 'origin', 'main')
  await git(a, 'pull')
  const projectDir = await mkdtemp(join(root, 'project-'))
  const sync = new Sync({ dir: a, projectDir }), run = sync.run
  sync.run = async (argv, options) => {
    const rel = relative(tempRoot, await realpath(options.cwd))
    assert.ok(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    assert.ok(allowed.includes(commandArgs(argv)[0]))
    return run(argv, { ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' } })
  }
  return { a, b, remote, projectDir, sync }
}
async function publish(b, file, text) {
  await put(b, file, text)
  await git(b, 'add', '-A')
  await git(b, 'commit', '-m', 'cloud')
  await git(b, 'push')
}

integration('1. Round trip: drafts outbound, posts inbound and pulled count', async () => {
  const { a, b, sync } = await fixture()
  await put(a, 'drafts/x.json', '{"draft":true}')
  assert.equal((await sync.syncOnce()).ok, true)
  await git(b, 'pull')
  assert.equal(await readFile(join(b, 'drafts/x.json'), 'utf8'), '{"draft":true}')
  await publish(b, 'posts/y.json')
  const result = await sync.syncOnce()
  assert.deepEqual(result, { ok: true, pulled: 1, pushed: 0, error: null })
  assert.equal(await readFile(join(a, 'posts/y.json'), 'utf8'), '{}')
})
integration('2. Seen lists stay local and initial gitignore has exactly two lines', async () => {
  const { a, sync } = await fixture()
  await put(a, '.seen-posts.json', '[]')
  await put(a, 'drafts/pending.tmp', 'partial')
  assert.equal((await sync.syncOnce()).ok, true)
  assert.equal(await readFile(join(a, '.gitignore'), 'utf8'), '.seen-*.json\n*.tmp\n')
  assert.equal(await git(a, 'ls-files', '.seen-posts.json', 'drafts/pending.tmp'), '')
  assert.equal(await git(a, 'ls-files', '.gitignore'), '.gitignore')
})

test('3. Every refusal stops before any mutation', async t => {
  const projectDir = await mkdtemp(join(root, 'project-'))
  const dir = await mkdtemp(join(root, 'exchange-'))
  await mkdir(join(dir, '.git'))
  const inside = join(projectDir, 'inside')
  await mkdir(inside)
  const cases = [
    [join(root, 'missing'), '交换文件夹还不存在', 0],
    [inside, '交换文件夹在代码仓库里面，不能同步', 0],
    [projectDir, '交换文件夹在代码仓库里面，不能同步', 0],
    [dir, '交换文件夹还不是一个 git 仓库', 1, { code: 128 }],
    [dir, '交换文件夹不是一个独立的 git 仓库', 1, { stdout: root }],
    [dir, '这个仓库没有配置远端', 3],
    [dir, '当前分支没有上游分支', 5],
    [dir, '没有安装 git', 1, { code: 127 }],
  ]
  for (const [folder, reason, count, first] of cases) await t.test(reason, async () => {
    const calls = []
    const sync = new Sync({ dir: folder, projectDir, run: async argv => {
      const args = commandArgs(argv)
      calls.push(args)
      if (calls.length === 1) return { code: 0, stdout: dir, stderr: '', ...first }
      if (args[1] === '--absolute-git-dir') return { code: 0, stdout: `${join(dir, '.git')}\n.git`, stderr: '' }
      if (args[0] === 'remote') return { code: 0, stdout: count === 3 ? '' : 'origin', stderr: '' }
      if (calls.length === 4) return { code: 0, stdout: 'main', stderr: '' }
      return { code: 128, stdout: '', stderr: '' }
    } })
    assert.equal((await sync.status()).reason, reason)
    assert.equal(calls.length, count)
    calls.length = 0
    assert.equal((await sync.syncOnce()).error, reason)
    assert.equal(calls.length, count)
    assert.ok(calls.every(args => ['rev-parse', 'remote', 'status'].includes(args[0])))
  })
})

integration('4. Unreachable remote keeps local commit and retries successfully', async () => {
  const { a, b, remote, sync } = await fixture()
  await put(a, 'drafts/offline.json')
  await rename(remote, `${remote}.offline`)
  const failed = await sync.syncOnce()
  assert.equal(failed.ok, false)
  assert.ok(failed.error.length <= 200)
  assert.equal(await git(a, 'show', 'HEAD:drafts/offline.json'), '{}')
  await rename(`${remote}.offline`, remote)
  assert.equal((await sync.syncOnce()).pushed, 1)
  await git(b, 'pull')
  assert.equal(await readFile(join(b, 'drafts/offline.json'), 'utf8'), '{}')
})
integration('5. Conflicting voice keeps local content and other remote files arrive', async () => {
  const { a, b, sync } = await fixture()
  await put(a, 'voice/watchlist.json', '{"version":"base"}\n')
  assert.equal((await sync.syncOnce()).ok, true)
  await git(b, 'pull')
  await put(a, 'voice/watchlist.json', '{"version":"local"}\n')
  await put(b, 'posts/other.json')
  await publish(b, 'voice/watchlist.json', '{"version":"cloud"}\n')
  const result = await sync.syncOnce()
  assert.equal(result.ok, true, result.error)
  assert.equal(result.pushed, 2)
  assert.equal(await readFile(join(a, 'voice/watchlist.json'), 'utf8'), '{"version":"local"}\n')
  assert.equal(await readFile(join(a, 'posts/other.json'), 'utf8'), '{}')
  assert.equal(await git(a, 'status', '--porcelain'), '')
  for (const file of (await git(a, 'ls-files')).split('\n')) assert.ok(!(await readFile(join(a, file), 'utf8')).includes('<<<<<<<'))
})
integration('6. Concurrent sync returns immediately without queuing', async () => {
  const { sync } = await fixture()
  const first = sync.syncOnce()
  assert.deepEqual(await sync.syncOnce(), { ok: false, pulled: 0, pushed: 0, error: '上一轮同步还没结束' })
  assert.equal((await first).ok, true)
  assert.equal((await sync.syncOnce()).ok, true)
})
integration('7. Foreign root binary and nested posts sync but are never ingested', async () => {
  const { a, b, sync } = await fixture()
  assert.equal((await sync.syncOnce()).ok, true)
  await git(b, 'pull')
  await put(b, 'big.bin', Buffer.alloc(1024 * 1024))
  await publish(b, 'posts/sub/dir/z.json')
  assert.equal((await sync.syncOnce()).ok, true)
  assert.equal((await readFile(join(a, 'big.bin'))).length, 1024 * 1024)
  assert.equal(await readFile(join(a, 'posts/sub/dir/z.json'), 'utf8'), '{}')
  assert.deepEqual((await new Exchange(a).readNew('posts')).items, [])
})

const allowed = ['rev-parse', 'status', 'add', 'commit', 'fetch', 'merge', 'push', 'remote', 'diff']
const globalArgs = ['-c', 'user.name=x-desk', '-c', 'user.email=x-desk@localhost', '-c', 'core.quotepath=false',
  '-c', 'core.symlinks=false', '-c', 'push.default=upstream',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false']
test('8. Wrapper allow-list, fixed options, bounded failures and merge abort', async t => {
  for (const fail of [null, 'merge', 'push', 'fetch', 'add', 'commit']) await t.test(fail ?? 'success', async () => {
    const dir = await mkdtemp(join(root, 'recording-'))
    const projectDir = await mkdtemp(join(root, 'project-'))
    await mkdir(join(dir, '.git'))
    const calls = []
    let merged = false
    const sync = new Sync({ dir, projectDir, now: () => 0, run: async (argv, options) => {
      assert.deepEqual(argv.slice(0, globalArgs.length), globalArgs)
      assert.equal(options.cwd, dir)
      assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
      assert.equal(options.timeout, 60000)
      const args = commandArgs(argv)
      calls.push(args)
      assert.ok(allowed.includes(args[0]))
      assert.ok(args.every(arg => !arg.startsWith('--force') && !['reset', 'rebase', 'clean', 'checkout', '-f'].includes(arg)))
      if (args[0] === fail && args[1] !== '--abort') return { code: 1, stdout: '', stderr: '失败'.repeat(200) }
      let stdout = ''
      if (args[0] === 'rev-parse') stdout = args[1] === '--show-toplevel' ? dir : args[1] === '--absolute-git-dir' ? `${join(dir, '.git')}\n.git` : 'main'
      if (args[0] === 'remote') stdout = 'origin'
      if (args[0] === 'status') stdout = `# branch.ab +2 -${merged ? 0 : 1}\n`
      if (args[0] === 'merge') merged = true
      if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'HEAD@{1}') stdout = 'posts/a.json\nvoice/watchlist.json\n'
      return { code: args[1] === '--cached' ? 1 : 0, stdout, stderr: '' }
    } })
    assert.deepEqual(await sync.status(), { ok: true, reason: null, branch: 'main', ahead: 2, behind: 1 })
    const result = await sync.syncOnce()
    if (fail) {
      assert.equal(result.ok, false)
      assert.ok(result.error.length <= 200)
      if (fail === 'merge') assert.deepEqual(calls.at(-1), ['merge', '--abort'])
      else assert.equal(calls.at(-1)[0], fail)
    } else {
      assert.deepEqual(result, { ok: true, pulled: 2, pushed: 2, error: null })
      assert.ok(calls.some(args => args[0] === 'commit' && args[2] === 'x-desk sync 1970-01-01T00:00:00.000Z'))
    }
  })
  for (const args of [['reset'], ['rebase'], ['clean'], ['checkout'], ['status', '-f'], ['merge', '--force-with-lease'], ['push', 'origin'], ['push', 'main:other'], ['config', 'user.name', 'x'], ['config', '--get', 'a', 'b'], ['-c', 'alias.x=reset'], ['rev-list']]) {
    assert.throws(() => Sync.checkArgs(args), /不允许的 git 命令/)
  }
  for (const args of [['push'], ['push', '--porcelain'], ['merge', '--abort']]) assert.doesNotThrow(() => Sync.checkArgs(args))
})

test('9. Worker sync is opt-in, interval gated, after exports, once per tick and records failures', async () => {
  const base = await mkdtemp(join(root, 'worker-'))
  const store = new Store(base), settings = new Settings(base)
  const ex = new Exchange(join(base, 'exchange'))
  let ms = Date.parse('2026-11-12T10:00:00Z'), calls = 0, failure = false, mutate = false
  const originalMutate = store.mutate.bind(store)
  store.mutate = async (...args) => { mutate = true; try { return await originalMutate(...args) } finally { mutate = false } }
  const worker = new Worker({ store, settings, exchangeFor: () => ex, now: () => new Date(ms),
    composer: { composeDaily: async () => {} }, lock: { acquire: async () => true },
    sync: { syncOnce: async () => {
      assert.equal(mutate, false)
      calls++
      if (calls === 1) assert.ok((await readdir(join(ex.root, 'drafts'))).includes('c_test1-r0.json'))
      if (failure) throw new Error('失败'.repeat(200))
      return { ok: true, error: null }
    } },
  })
  await store.mutate('seed', s => { s.runs.lastComposeDay = localDay(new Date(ms)) }, { undoable: false })
  await worker.tick()
  assert.equal(calls, 0)
  await settings.update({ sync: { enabled: true, intervalSec: 120 } })
  worker.lastSyncMs = ms
  await worker.tick()
  assert.equal(calls, 0)
  await store.mutate('draft', s => { s.candidates.push({ id: 'c_test1', status: 'pending', revision: 0, text: 'draft', createdAt: new Date(ms).toISOString(), form: 'post' }) }, { undoable: false })
  await worker.tick()
  assert.equal(calls, 1)
  assert.equal((await store.read()).runs.lastSyncAt, new Date(ms).toISOString())
  await worker.tick()
  assert.equal(calls, 1)
  ms += 120000
  await store.mutate('revision', s => { s.candidates[0].revision++ }, { undoable: false })
  await worker.tick()
  assert.equal(calls, 2)
  failure = true
  for (let i = 0; i < 2; i++) { ms += 120000; await worker.tick() }
  const { runs } = await store.read()
  assert.equal(calls, 4)
  assert.equal(runs.lastSyncError.length, 200)
  assert.equal(runs.notices.filter(n => n.text.startsWith('同步失败：')).length, 1)
  assert.equal(worker.lastSyncMs, ms)
  assert.equal(store.undo.length, 0)
  worker.stopped = true
  ms += 120000
  await worker.tick()
  assert.equal(calls, 4)
})

integration('10. Host real HTTP routes: disabled 400, fixture main status, run and root change', async t => {
  const { a } = await fixture()
  const base = await mkdtemp(join(root, 'host-'))
  const store = new Store(base), settings = new Settings(base), desk = { settings }
  desk.worker = manualWorker(store, settings)
  await store.read()
  await settings.update({ exchangeDir: a })
  const server = createServer(createHandler({ ctx: { get: () => ({ requestRejection: () => undefined }) }, store, desk }))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const call = (method, path) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, method, path: `/x-desk/${path}` }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.deepEqual(await call('POST', 'sync/run'), { code: 400, body: { error: '同步还没打开' } })
  const status = await call('GET', 'sync/status')
  assert.equal(status.body.ok, true)
  assert.equal(status.body.branch, 'main')
  assert.deepEqual([status.body.enabled, status.body.intervalSec, status.body.lastSyncAt, status.body.lastSyncError], [false, 120, null, null])
  await settings.update({ sync: { enabled: true } })
  assert.equal((await call('POST', 'sync/run')).body.ok, true)
  assert.ok((await store.read()).runs.lastSyncAt)
  await settings.update({ exchangeDir: join(base, 'missing') })
  assert.equal((await call('GET', 'sync/status')).body.reason, '交换文件夹还不存在')
  assert.equal((await call('POST', 'sync/run')).body.ok, false)
  assert.equal((await store.read()).runs.lastSyncError, '交换文件夹还不存在')
  assert.equal(store.undo.length, 0)
})

test('Settings sync defaults, validation, nested filtering and unrelated settings preserved', async () => {
  const base = await mkdtemp(join(root, 'settings-'))
  const settings = new Settings(base)
  const initial = await settings.read()
  assert.deepEqual(initial.sync, { enabled: false, intervalSec: 120 })
  for (const enabled of ['true', 1, null]) await assert.rejects(settings.update({ sync: { enabled } }), { status: 400 })
  for (const [value, expected] of [[1, 60], ['125.6', 126], [9999, 3600]]) {
    assert.equal((await settings.update({ sync: { intervalSec: value } })).sync.intervalSec, expected)
  }
  const result = await settings.update({ sync: { enabled: true, extra: 'drop' } })
  const { sync, ...other } = result
  const { sync: defaults, ...before } = initial
  assert.deepEqual(other, before)
  await writeFile(settings.file, JSON.stringify({ ...result, sync: { ...sync, unknown: true } }))
  assert.deepEqual((await settings.read()).sync, { enabled: true, intervalSec: 3600 })
})


integration('Host handler without sockets: current root, status and manual sync records', async () => {
  const { a } = await fixture()
  const base = await mkdtemp(join(root, 'handler-'))
  const store = new Store(base), settings = new Settings(base)
  await store.read()
  await settings.update({ exchangeDir: a })
  const handler = createHandler({ ctx: { get: () => ({ requestRejection: () => undefined }) }, store, desk: { settings, worker: manualWorker(store, settings) } })
  const call = async (method, path) => {
    const req = Object.assign(Readable.from([]), { method, url: `/x-desk/${path}`, headers: {} })
    const res = { setHeader() {}, end(body) { this.body = JSON.parse(body) } }
    await handler(req, res)
    return { code: res.statusCode, body: res.body }
  }
  assert.deepEqual(await call('POST', 'sync/run'), { code: 400, body: { error: '同步还没打开' } })
  assert.deepEqual((await call('GET', 'sync/status')).body, {
    ok: true, reason: null, branch: 'main', ahead: 0, behind: 0,
    enabled: false, intervalSec: 120, lastSyncAt: null, lastSyncError: null,
  })
  await settings.update({ sync: { enabled: true } })
  assert.equal((await call('POST', 'sync/run')).body.ok, true)
  assert.ok((await store.read()).runs.lastSyncAt)
  await settings.update({ exchangeDir: join(base, 'missing') })
  assert.equal((await call('GET', 'sync/status')).body.reason, '交换文件夹还不存在')
  assert.equal((await call('POST', 'sync/run')).body.ok, false)
  const { runs } = await store.read()
  assert.equal(runs.lastSyncError, '交换文件夹还不存在')
  assert.equal(runs.notices.at(-1).text, '同步失败：交换文件夹还不存在')
  assert.equal(store.undo.length, 0)
})

test('Worker renews lock before sync and stops if ownership or stop state changes', async () => {
  for (const stopped of [false, true]) {
    const base = await mkdtemp(join(root, 'gate-'))
    const store = new Store(base), settings = new Settings(base)
    await store.read()
    await settings.update({ sync: { enabled: true } })
    let locks = 0, calls = 0, reads = 0
    const ex = new Exchange(join(base, 'exchange'))
    ex.readNew = async () => { reads++; throw new Error('不应读入') }
    const worker = new Worker({ store, settings, composer: {}, exchangeFor: () => ex,
      sync: { syncOnce: async () => { calls++ } },
      lock: { acquire: async () => {
        locks++
        if (locks === 1) return true
        worker.stopped = stopped
        return stopped
      } },
    })
    const result = await worker.tick()
    assert.equal(result[stopped ? 'stopped' : 'aborted'], true)
    assert.equal(calls, 0)
    assert.equal(reads, 0)
  }
})

const commandArgs = argv => {
  let i = 0
  while (argv[i] === '-c') i += 2
  return argv.slice(i)
}

integration('I1: committed directory symlinks become files and block push', async () => {
  const { a, b, sync } = await fixture()
  await put(a, 'drafts/base.json')
  assert.equal((await sync.syncOnce()).ok, true)
  await git(b, 'pull')
  const outside = await mkdtemp(join(root, 'outside-'))
  await git(b, 'rm', '-r', 'drafts')
  await symlink(outside, join(b, 'drafts'))
  await git(b, 'add', 'drafts')
  await git(b, 'commit', '-m', 'directory symlink')
  await git(b, 'push')
  await put(a, 'posts/local.json')
  const calls = [], run = sync.run
  sync.run = (argv, options) => { calls.push(commandArgs(argv)); return run(argv, options) }
  const result = await sync.syncOnce()
  assert.equal(result.ok, false)
  assert.equal(result.error, '交换文件夹里的 drafts 不是普通文件夹，已停止同步，请检查仓库')
  assert.equal((await lstat(join(a, 'drafts'))).isFile(), true)
  assert.ok(!calls.some(args => args[0] === 'push'))
  await assert.rejects(new Exchange(a).writeDraft({ id: 'c_probe', revision: 0, text: 'probe' }, ''), { code: 'ENOTDIR' })
  assert.deepEqual(await readdir(outside), [])
})

integration('I2: worktree and foreign gitfile are refused before mutations', async t => {
  for (const kind of ['worktree', 'gitfile']) await t.test(kind, async () => {
    const { a, projectDir } = await fixture()
    const dir = join(await mkdtemp(join(root, 'linked-')), 'exchange')
    if (kind === 'worktree') await git(a, 'worktree', 'add', '-b', 'linked', dir)
    else { await mkdir(dir); await writeFile(join(dir, '.git'), `gitdir: ${join(a, '.git')}\n`) }
    const sync = new Sync({ dir, projectDir }), calls = [], run = sync.run
    sync.run = (argv, options) => { calls.push(commandArgs(argv)); return run(argv, options) }
    assert.equal((await sync.status()).reason, '交换文件夹不是一个独立的 git 仓库')
    assert.equal((await sync.syncOnce()).error, '交换文件夹不是一个独立的 git 仓库')
    assert.deepEqual(calls, Array(2).fill([
      ['rev-parse', '--show-toplevel'], ['rev-parse', '--absolute-git-dir', '--git-common-dir'],
    ]).flat())
  })
})

integration('I3: matching local push config cannot publish another branch', async () => {
  const { a, remote, sync } = await fixture()
  await git(a, 'switch', '-c', 'other')
  await git(a, 'push', '-u', 'origin', 'other')
  const before = await git(remote, 'rev-parse', 'refs/heads/other')
  await put(a, 'README', 'other branch change')
  await git(a, 'add', 'README')
  await git(a, 'commit', '-m', 'private branch change')
  await git(a, 'switch', 'main')
  await git(a, 'config', 'push.default', 'matching')
  await put(a, 'drafts/main.json')
  assert.equal((await sync.syncOnce()).ok, true)
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/other'), before)
})

integration('I4: status polling during ten sync rounds uses no optional locks', async () => {
  const { a, sync } = await fixture()
  const run = sync.run
  let polling = true, polls = 0
  sync.run = (argv, options) => {
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0')
    return run(argv, options)
  }
  const poll = (async () => {
    while (polling) { const result = await sync.status(); assert.equal(result.ok, true, result.reason); polls++ }
  })()
  // 立即处理拒绝，等主循环结束后再报告轮询断言。
  const polled = poll.then(() => null, error => error)
  try {
    for (let i = 0; i < 10; i++) {
      await put(a, `drafts/round-${i}.json`)
      const result = await sync.syncOnce()
      assert.equal(result.ok, true, result.error)
    }
  } finally { polling = false; const error = await polled; if (error) throw error }
  assert.ok(polls >= 10)
})

integration('I5: modify/delete conflict reports reason and aborts merge cleanly', async () => {
  const { a, b, sync } = await fixture()
  await put(a, 'voice/watchlist.json', 'base\n')
  assert.equal((await sync.syncOnce()).ok, true)
  await git(b, 'pull')
  await put(a, 'voice/watchlist.json', 'local\n')
  await git(b, 'rm', 'voice/watchlist.json')
  await git(b, 'commit', '-m', 'delete voice')
  await git(b, 'push')
  const result = await sync.syncOnce()
  assert.equal(result.ok, false)
  assert.match(result.error, /^和远端合并失败：.*(?:CONFLICT|冲突)/s)
  assert.ok(!result.error.includes('-c user.name'))
  assert.ok(result.error.length <= 200)
  assert.equal(await git(a, 'status', '--porcelain'), '')
  await assert.rejects(readFile(join(a, '.git', 'MERGE_HEAD')), { code: 'ENOENT' })
  assert.equal(await readFile(join(a, 'voice/watchlist.json'), 'utf8'), 'local\n')
})

integration('I6: remote protected files are refused and local seen state survives', async t => {
  for (const file of ['.seen-posts.json', '.gitignore', '.gitattributes']) await t.test(file, async () => {
    const { a, b, sync } = await fixture()
    assert.equal((await sync.syncOnce()).ok, true)
    await git(b, 'pull')
    await put(a, '.seen-posts.json', '["local"]')
    await put(b, file, file === '.seen-posts.json' ? '[]' : '# remote change\n')
    await git(b, 'add', '-f', '--', file)
    await git(b, 'commit', '-m', 'protected change')
    await git(b, 'push')
    const calls = [], run = sync.run
    sync.run = (argv, options) => { calls.push(commandArgs(argv)); return run(argv, options) }
    const result = await sync.syncOnce()
    assert.equal(result.error, `远端改动了不该改的文件（${file}），已停止同步`)
    assert.equal(await readFile(join(a, '.seen-posts.json'), 'utf8'), '["local"]')
    assert.ok(!calls.some(args => ['merge', 'push'].includes(args[0])))
  })
})

integration('M1: local pre-commit hook never runs', async () => {
  const { a, sync } = await fixture()
  const marker = join(a, 'hook-ran')
  const hook = join(a, '.git', 'hooks', 'pre-commit')
  await writeFile(hook, '#!/bin/sh\nprintf hooked > hook-ran\n')
  await chmod(hook, 0o700)
  await put(a, 'drafts/hook.json')
  assert.equal((await sync.syncOnce()).ok, true)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('M2: child environment preserves SSH_AUTH_SOCK but excludes inherited GIT variables', async t => {
  const dir = await mkdtemp(join(root, 'env-')), projectDir = await mkdtemp(join(root, 'project-'))
  const overrides = { SSH_AUTH_SOCK: join(root, 'test-agent.sock'), GIT_DIR: '/must-not-inherit', GIT_CONFIG_COUNT: '9' }
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key]
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
    process.env[key] = value
  }
  const sync = new Sync({ dir, projectDir, run: async (argv, { env: child }) => {
    assert.equal(child.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK)
    assert.deepEqual(Object.keys(child).filter(key => key.startsWith('GIT_')).sort(), ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'])
    return { code: 128, stdout: '', stderr: '' }
  } })
  assert.equal((await sync.status()).ok, false)
})

test('M3/I5: git failure text is redacted before truncation with stdout and code fallbacks', async () => {
  const dir = await mkdtemp(join(root, 'text-')), projectDir = await mkdtemp(join(root, 'project-'))
  await mkdir(join(dir, '.git'))
  const sample = `https://test:${'x'.repeat(240)}@example.invalid/repo`
  for (const [failure, expected] of [
    [{ code: 1, stderr: `  denied ${sample}  `, stdout: 'ignored' }, 'denied https://***@example.invalid/repo'],
    [{ code: 1, stderr: ' \n', stdout: `old\n\none\n${sample}\nthree\n` }, 'one\nhttps://***@example.invalid/repo\nthree'],
    [{ code: 42, stderr: '', stdout: '\n' }, 'git 退出码 42'],
  ]) {
    const sync = new Sync({ dir, projectDir, run: async argv => {
      const args = commandArgs(argv)
      if (args[0] === 'status') return failure
      return { code: 0, stderr: '', stdout: args[1] === '--show-toplevel' ? dir : args[1] === '--absolute-git-dir' ? `${join(dir, '.git')}\n.git` : 'main' }
    } })
    assert.equal((await sync.status()).reason, expected)
  }
})

test('M4: worker busy result preserves sync records and notices', async () => {
  const base = await mkdtemp(join(root, 'busy-')), store = new Store(base), settings = new Settings(base)
  await settings.update({ sync: { enabled: true } })
  await store.mutate('seed', s => { s.runs.lastSyncError = 'previous'; s.runs.lastComposeDay = localDay(new Date()) }, { undoable: false })
  const before = structuredClone((await store.read()).runs)
  const worker = new Worker({ store, settings, composer: {}, lock: { acquire: async () => true },
    exchangeFor: () => new Exchange(join(base, 'exchange')),
    sync: { syncOnce: async () => ({ ok: false, pulled: 0, pushed: 0, error: '上一轮同步还没结束' }) },
  })
  await worker.tick()
  assert.deepEqual((await store.read()).runs, before)
  assert.equal(worker.lastSyncMs, 0)
})

test('M5: manual sync and tick exclude each other, acquire lock and recover after errors', async () => {
  const base = await mkdtemp(join(root, 'exclusive-')), store = new Store(base), settings = new Settings(base)
  await store.mutate('seed', s => { s.runs.lastComposeDay = localDay(new Date()) }, { undoable: false })
  await settings.update({ sync: { enabled: true } })
  const ex = new Exchange(join(base, 'exchange'))
  let unlock, entered, calls = 0, locks = 0, permit = true
  const atExport = new Promise(resolve => { entered = resolve })
  const exporting = new Promise(resolve => { unlock = resolve })
  ex.writeVoice = async () => { entered(); await exporting }
  const worker = new Worker({ store, settings, composer: {}, exchangeFor: () => ex,
    lock: { acquire: async () => { locks++; return permit } },
    sync: { syncOnce: async () => { calls++; return { ok: true, pulled: 0, pushed: 0, error: null } } },
  })
  worker.lastSyncMs = Date.now()
  const tick = worker.tick()
  await atExport
  const busy = { ok: false, pulled: 0, pushed: 0, error: '上一轮同步还没结束' }
  try { assert.deepEqual(await worker.syncNow(), busy); assert.equal(calls, 0) } finally { unlock(); await tick }
  let releaseSync, syncEntered
  const waiting = new Promise(resolve => { syncEntered = resolve })
  worker.sync.syncOnce = async () => { syncEntered(); return new Promise(resolve => { releaseSync = resolve }) }
  const priorLocks = locks, manual = worker.syncNow()
  await waiting
  assert.equal(locks, priorLocks + 1)
  assert.deepEqual(await worker.tick(), { ran: false })
  assert.deepEqual(await worker.syncNow(), busy)
  releaseSync({ ok: true, pulled: 0, pushed: 0, error: null })
  assert.equal((await manual).ok, true)
  permit = false
  assert.deepEqual(await worker.syncNow(), busy)
  permit = true
  worker.sync.syncOnce = async () => { throw new Error('sync failed') }
  assert.equal((await worker.syncNow()).error, 'sync failed')
  worker.sync.syncOnce = async () => ({ ok: true, pulled: 0, pushed: 0, error: null })
  assert.equal((await worker.syncNow()).ok, true)
  worker.stopped = true
  assert.deepEqual(await worker.syncNow(), busy)
})

test('M6: settings read validates persisted sync values', async () => {
  const base = await mkdtemp(join(root, 'read-settings-')), settings = new Settings(base)
  for (const [enabled, intervalSec, expected] of [['true', 1, 60], [1, 99999, 3600], [null, 'bad', 120], [false, '125.6', 126], [true, 120, 120]]) {
    await writeFile(settings.file, JSON.stringify({ sync: { enabled, intervalSec, extra: true } }))
    assert.deepEqual((await settings.read()).sync, { enabled: enabled === true, intervalSec: expected })
  }
})

test('M8: unused commands are outside the allow-list', () => {
  for (const args of [['ls-files'], ['log'], ['config', '--get', 'user.name']]) assert.throws(() => Sync.checkArgs(args), /不允许的 git 命令/)
})

function manualWorker(store, settings) {
  return new Worker({ store, settings, lock: { acquire: async () => true },
    sync: { syncOnce: async () => new Sync({ dir: (await settings.read()).exchangeDir, projectDir: store.root }).syncOnce() },
  })
}

integration('I6: first sync refuses local-only gitignore when upstream has advanced', async () => {
  const { a, b, sync } = await fixture()
  await publish(b, 'posts/new.json')
  const result = await sync.syncOnce()
  assert.equal(result.error, '远端改动了不该改的文件（.gitignore），已停止同步')
  assert.equal(await readFile(join(a, '.gitignore'), 'utf8'), '.seen-*.json\n*.tmp\n')
  await assert.rejects(readFile(join(a, 'posts/new.json')), { code: 'ENOENT' })
})
