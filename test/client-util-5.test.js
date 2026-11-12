process.env.TZ = 'Asia/Shanghai'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { syncLine, syncAdvice } from '../client/util.js'

const now = new Date('2026-11-12T04:00:00Z')
const connected = { enabled: true, ok: true, branch: 'main', lastSyncAt: null, lastSyncError: null }

test('syncLine：缺失状态和关闭同步优先显示 off', () => {
  for (const status of [null, undefined]) assert.deepEqual(syncLine(status, now), { tone: 'off', text: '读不到同步状态' })
  assert.deepEqual(syncLine({ ...connected, enabled: false, ok: false, reason: '配置问题', lastSyncError: '拉取失败' }, now), { tone: 'off', text: '同步没有打开' })
})

test('syncLine：配置拒绝优先于上次错误，错误原样返回', () => {
  const reason = '<img src=x onerror=alert(1)>'
  assert.deepEqual(syncLine({ ...connected, ok: false, reason, lastSyncError: '拉取失败' }, now), { tone: 'warn', text: reason })
  assert.deepEqual(syncLine({ ...connected, lastSyncError: '推送失败：权限不足' }, now), { tone: 'warn', text: '上次同步失败：推送失败：权限不足' })
})

test('syncLine：已连接未同步、上海本地时间和输入不变', () => {
  assert.deepEqual(syncLine(connected, now), { tone: 'ok', text: '已连接，分支 main，还没同步过' })
  const status = Object.freeze({ ...connected, branch: 'exchange', lastSyncAt: '2026-11-11T17:05:00Z' })
  assert.deepEqual(syncLine(status, now), { tone: 'ok', text: '已连接，分支 exchange，上次同步 01:05' })
})

test('syncAdvice：覆盖源码所有 refused 原因，未知原因使用搭建说明', () => {
  const fallback = '请按 docs/grok-bot/README.md 的搭建步骤检查'
  const source = readFileSync(new URL('../src/sync.js', import.meta.url), 'utf8')
  const reasons = new Set([...source.matchAll(/\brefused\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map(match => match[2]))
  assert.ok(reasons.size >= 7, '应当提取到同步拒绝原因')
  for (const reason of reasons) {
    const advice = syncAdvice(reason)
    assert.equal(typeof advice, 'string', reason)
    assert.ok(advice.length > 0, reason)
    assert.doesNotMatch(advice, /[\r\n]/, reason)
    assert.notEqual(advice, fallback, reason)
    assert.notEqual(advice, reason, reason)
  }
  assert.equal(syncAdvice('交换文件夹还不是一个 git 仓库'), '交换文件夹还不是一个 git 仓库。请按 docs/grok-bot/README.md 的第 2 步操作。')
  for (const reason of ['未知原因', 'toString', '__proto__', '', null, undefined]) assert.equal(syncAdvice(reason), fallback)
})
