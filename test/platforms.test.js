import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chatPrompts } from '../src/ai.js'
import { localIntent } from '../src/intents.js'
import { platformName, withLang } from '../src/i18n.js'
import { buildSeed } from '../src/seed.js'
import { parseAccountsCsv } from '../src/accounts.js'

const platforms = ['公众号', '小红书', '抖音', 'B站', '视频号', '快手', 'TikTok', 'Instagram', 'YouTube', 'X']
const now = new Date('2026-11-12T10:00:00+08:00')

test('assistant prompt advertises the complete platform catalog including Kuaishou', () => {
  const prompt = chatPrompts(buildSeed(now), 'Help', { now }).system
  for (const name of platforms) assert.ok(prompt.includes(name), name)
})

test('Chinese and English scheduling recognize Kuaishou and Kwai without changing other platforms', () => {
  const state = buildSeed(now)
  for (const message of ['把这篇排到明晚8点 快手', 'Schedule this tomorrow 8pm on Kuaishou', 'Schedule this tomorrow 8pm on Kwai']) {
    assert.equal(localIntent(state, message, { focusId: 'seed_2', now }).ops[0].platform, '快手', message)
  }
  assert.equal(localIntent(state, 'Schedule this tomorrow 8pm on YouTube', { focusId: 'seed_2', now }).ops[0].platform, 'YouTube')
})

test('Kuaishou has an English display name and CSV aliases normalize to the canonical platform', () => {
  assert.equal(withLang('en', () => platformName('快手')), 'Kuaishou')
  for (const alias of ['Kuaishou', 'kwai', '快手']) assert.equal(parseAccountsCsv(`${alias},Example`).rows[0].op.platform, '快手')
})

test('a title containing Project X cannot override an explicit Chinese platform; on X remains supported', () => {
  const state = buildSeed(now)
  state.items = [{ id: 'project-x', title: 'Project X' }]
  for (const platform of ['快手', '抖音']) {
    const plan = localIntent(state, `把《Project X》排到明晚8点 ${platform}`, { focusId: 'project-x', now })
    assert.equal(plan.ops[0].platform, platform)
  }
  assert.equal(localIntent(state, 'Schedule this tomorrow 8pm on X', { focusId: 'project-x', now }).ops[0].platform, 'X')
})
