import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { assertPublicUrl } from '../src/harvest.js'
import { violations } from './helpers/guard.js'

const cache = new Map()
async function sources(dirs) {
  const key = dirs.join()
  if (!cache.has(key)) cache.set(key, scan(dirs))
  return cache.get(key)
}

async function scan(dirs) {
  const out = []
  for (const dir of dirs) {
    for (const file of await readdir(new URL(`../${dir}`, import.meta.url), { recursive: true })) {
      if (/\.(js|jsx|mjs)$/.test(file)) out.push([`${dir}/${file}`, await readFile(new URL(`../${dir}/${file}`, import.meta.url), 'utf8')])
    }
  }
  return out
}

test('全部源码没有违反防护规则', async () => {
  for (const [file, text] of await sources(['src', 'client', 'scripts'])) assert.deepEqual(violations(file, text), [], file)
})

test('不新增运行时依赖，开发依赖只有 esbuild', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), ['esbuild'])
})

test('链接校验拒绝本机和内网地址', async () => {
  for (const url of ['http://localhost/a.png', 'http://127.0.0.1/a.png', 'http://10.0.0.5/a.png', 'http://192.168.1.1/a.png', 'http://[::1]/a.png', 'ftp://example.com/a.png']) {
    await assert.rejects(assertPublicUrl(url), url)
  }
  assert.equal((await assertPublicUrl('http://8.8.8.8/a.png')).hostname, '8.8.8.8')
})

test('防护规则自测：违规的写法都会被抓到', () => {
  for (const source of ["const c = require('child_process')", "import http from 'http'", "import('node:tls')", "import net from 'net'", "const w = require('worker_threads')", 'const f = fetch', 'globalThis.fetch(u)', "import('node:https')", "import {lookup} from 'node:dns'"]) {
    assert.ok(violations('src/host.js', source).length > 0, source)
  }
  assert.ok(violations('src/harvest.js', 'await fetch(url)').length > 0)
  assert.ok(violations('src/harvest.js', "import http from 'node:http'").length > 0)
  assert.deepEqual(violations('src/harvest.js', "import { lookup } from 'node:dns/promises'\nimport { isIP } from 'node:net'"), [])
  assert.deepEqual(violations('src/images.js', 'await fetchImpl(u); const f = fetch'), [])
  assert.deepEqual(violations('src/host.js', "const site = req.headers['sec-fetch-site']"), [])
  assert.ok(violations('src/store.js', "join(home, 'media-desk')").length > 0)
  assert.deepEqual(violations('src/settings.js', "join(dshHome(), 'media-desk')"), [])
})

test('防护规则自测：x.com 的各种写法都会被抓到', () => {
  for (const source of ["'http://x.com/a'", "'//x.com/a'", "'https://www.x.com/a'", "'https://mobile.twitter.com/a'"]) {
    assert.ok(violations('src/host.js', source).length > 0, source)
    assert.deepEqual(violations('src/exchange.js', source), [], source)
  }
})

test('同步只放行 execFile 的命名导入，不放行其他子进程或网络调用', () => {
  for (const source of ['exec("git")', 'execSync("git")', 'spawn("git")', 'spawnSync("git")', 'fork("git")', '{ shell: true }',
    "import { execFile, exec } from 'node:child_process'", "import cp from 'child_process'", "import('node:child_process')", 'fetch(url)']) {
    assert.ok(violations('src/sync.js', source).length > 0, source)
  }
  for (const spec of ['node:child_process', 'child_process']) {
    const source = `import { execFile } from '${spec}'`
    assert.deepEqual(violations('src/sync.js', source), [])
    assert.ok(violations('src/worker.js', source).length > 0)
  }
})

test('M7: execFile requires literal git and regex exec remains allowed', () => {
  for (const source of ["execFile('sh', args)", 'execFile(command, args)', 'execFile(`git`, args)', "execFile('git' + suffix, args)"]) {
    assert.ok(violations('src/sync.js', source).length > 0, source)
  }
  for (const source of ["execFile('git', args)", 'execFile("git", args)', 're.exec(s)']) {
    assert.deepEqual(violations('src/sync.js', source), [], source)
  }
})
