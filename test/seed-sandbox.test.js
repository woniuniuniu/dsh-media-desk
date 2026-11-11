import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/seed-sandbox.sh', import.meta.url))
const SAMPLES = fileURLToPath(new URL('../scripts/sample-exchange/posts/', import.meta.url))

test('seed-sandbox.sh 把示例帖子复制到沙盒交换文件夹，目录不存在时自动创建', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'sandbox-'))
  await run('sh', [SCRIPT], { env: { ...process.env, DSH_SANDBOX: sandbox } })
  const copied = (await readdir(join(sandbox, 'x-desk', 'exchange', 'posts'))).sort()
  assert.deepEqual(copied, (await readdir(SAMPLES)).sort())
  assert.ok(copied.length >= 6)
})

test('dev-sandbox.sh 找不到 dsh 时给出中文提示并以非零状态退出', async () => {
  const script = fileURLToPath(new URL('../scripts/dev-sandbox.sh', import.meta.url))
  await assert.rejects(run('/bin/sh', [script], { env: { PATH: '/nonexistent' } }), err => {
    assert.notEqual(err.code, 0)
    assert.match(err.stderr, /找不到 dsh 命令。请先在 DeepSeek Harness 桌面版菜单里选择「管理 dsh 命令」开启。/)
    return true
  })
})
