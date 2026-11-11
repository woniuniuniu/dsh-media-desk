import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import { parsePost } from '../src/exchange.js'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/seed-sandbox.sh', import.meta.url))
const SAMPLES = fileURLToPath(new URL('../scripts/sample-exchange/posts/', import.meta.url))

test('seed-sandbox.sh 把示例帖子复制到沙盒交换文件夹，时间改成最近，目录不存在时自动创建', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'sandbox-'))
  try {
    await run('sh', [SCRIPT], { env: { ...process.env, DSH_SANDBOX: sandbox } })
    const dir = join(sandbox, 'x-desk', 'exchange', 'posts')
    const copied = (await readdir(dir)).sort()
    assert.deepEqual(copied, (await readdir(SAMPLES)).sort())
    assert.ok(copied.length >= 6)
    const posted = []
    for (const name of copied) {
      const post = parsePost(JSON.parse(await readFile(join(dir, name), 'utf8')))
      assert.ok(post, name)
      const age = Date.now() - Date.parse(post.postedAt)
      assert.ok(age > 0 && age <= 36 * 3600e3, `${name} 的发布时间不在最近 36 小时内`)
      assert.ok(Date.parse(post.fetchedAt) >= Date.parse(post.postedAt) && Date.parse(post.fetchedAt) <= Date.now(), name)
      posted.push([name, Date.parse(post.postedAt)])
    }
    // 保持原来的先后顺序
    const original = []
    for (const name of copied) original.push([name, Date.parse(JSON.parse(await readFile(join(SAMPLES, name), 'utf8')).postedAt)])
    const order = rows => rows.slice().sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(r => r[0])
    assert.deepEqual(order(posted), order(original))
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('dev-sandbox.sh 找不到 dsh 时给出中文提示并以非零状态退出', async () => {
  const script = fileURLToPath(new URL('../scripts/dev-sandbox.sh', import.meta.url))
  await assert.rejects(run('/bin/sh', [script], { env: { PATH: '/nonexistent' } }), err => {
    assert.notEqual(err.code, 0)
    assert.match(err.stderr, /找不到 dsh 命令。请先在 DeepSeek Harness 桌面版菜单里选择「管理 dsh 命令」开启。/)
    return true
  })
})
