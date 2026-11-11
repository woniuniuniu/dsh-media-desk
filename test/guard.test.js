import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { assertPublicUrl } from '../src/harvest.js'

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

// x.com 只允许出现在这些文件里：
// exchange.js 拼帖子链接，inbox.js 和 client/util.js（镜像 intentUrl）拼发帖链接，
// client/watch.jsx 只在输入框的提示文字里举例主页链接。
const X_ALLOWED = new Set(['src/exchange.js', 'src/inbox.js', 'client/util.js', 'client/watch.jsx'])
// 只有生图（下载图片）和链接校验两个模块可以碰网络。
const NETWORK_ALLOWED = new Set(['src/images.js', 'src/harvest.js'])

test('后台代码不向 X 或任何抓取服务发请求', async () => {
  for (const [file, text] of await sources(['src'])) {
    assert.doesNotMatch(text, /api\.x\.com|api\.twitter\.com|monid|tikhub|apify/i, file)
  }
})

test('x.com 链接只出现在约定的文件里', async () => {
  for (const [file, text] of await sources(['src', 'client', 'scripts'])) {
    if (!X_ALLOWED.has(file)) assert.doesNotMatch(text, /https:\/\/(x|twitter)\.com/, file)
  }
})

test('只有生图和链接校验两个模块可以发起网络请求或开子进程', async () => {
  for (const [file, text] of await sources(['src'])) {
    if (NETWORK_ALLOWED.has(file)) continue
    assert.doesNotMatch(text, /\bfetch\(|node:https?|node:net|node:dgram|node:child_process|XMLHttpRequest|WebSocket/, file)
  }
})

test('不读写原版插件的数据目录', async () => {
  for (const [file, text] of await sources(['src', 'client'])) assert.doesNotMatch(text, /media-desk/, file)
})

test('没有任何点赞、发帖、转发、关注的调用路径', async () => {
  for (const [file, text] of await sources(['src'])) {
    assert.doesNotMatch(text, /likeTweet|createTweet|retweet|\/2\/tweets|statuses\/update|favorites\/create|friendships\/create/i, file)
  }
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
