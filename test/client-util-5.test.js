process.env.TZ = 'Asia/Shanghai'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { syncLine, syncAdvice, t } from '../client/util.js'

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

test('Final I3: loading is silent and either unsaved toggle shows save-first status', () => {
  assert.deepEqual(syncLine(null, now, { loaded: false }), { tone: 'off', text: '' })
  for (const enabled of [false, true]) {
    assert.deepEqual(syncLine({ ...connected, enabled }, now, { pending: true }), { tone: 'off', text: '保存后生效' })
  }
})

test('Final M9: missing folder advice matches the documented creation flow', () => {
  assert.equal(syncAdvice('交换文件夹还不存在'), '先打开一次工作台，等它创建交换文件夹（设置里能看到路径）')
})

test('Final I3: settings render hides initial status and exposes save-first button hints in both directions', async () => {
  const source = readFileSync(new URL('../client/settings.jsx', import.meta.url), 'utf8')
  const { code } = await transform(source.replace(/^import .*\n/gm, '').replace('export function', 'function'), { loader: 'jsx' })
  for (const enabled of [false, true]) {
    const desk = { settingsOpen: true, settings: { image: {}, sync: { enabled, intervalSec: 120 } } }
    const states = [], deps = [], effects = []
    let cursor = 0, effectCursor = 0, finish
    const request = new Promise(resolve => { finish = resolve })
    const React = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      useState: initial => {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
      useEffect: (fn, values) => {
        const index = effectCursor++
        if (!deps[index] || values.some((v, i) => v !== deps[index][i])) { deps[index] = values; effects.push(fn) }
      },
    }
    const component = runInNewContext(`${code}\nSettingsDialog`, {
      React, useDesk: fn => fn(desk), fetchSyncStatus: () => request,
      Dialog: 'dialog', Icon: 'icon', syncLine, syncAdvice, t,
    })
    const render = () => {
      cursor = 0; effectCursor = 0
      const tree = component()
      effects.splice(0).forEach(fn => fn())
      const nodes = []
      const walk = node => { if (node && typeof node === 'object') { nodes.push(node); node.children.forEach(walk) } }
      walk(tree)
      return nodes
    }
    render()
    let nodes = render()
    assert.ok(!nodes.some(node => node.props.role === 'status'))
    finish({ ...connected, enabled })
    await request
    nodes = render()
    assert.equal(nodes.find(node => node.props.role === 'status').children[0].children[0], enabled ? '已连接，分支 main，还没同步过' : '同步没有打开')
    nodes.find(node => node.props.type === 'checkbox').props.onChange({ target: { checked: !enabled } })
    nodes = render()
    assert.equal(nodes.find(node => node.props.role === 'status').children[0].children[0], '保存后生效')
    const button = nodes.find(node => node.props.className === 'md-btn md-sync-run')
    assert.equal(button.props.disabled, true)
    assert.equal(button.props.title, '先保存设置')
    assert.ok(nodes.some(node => node.type === 'small' && node.children.includes('先保存设置')))
  }
})
