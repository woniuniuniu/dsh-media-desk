import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import plugin from '../src/host.js'
import { buildSeed } from '../src/seed.js'

const FACT = 'REFERENCE_FACT_927341'
const RULE = 'SELECTED_SKILL_271828'

// Exercise the registered, authenticated Host routes with an isolated DSH_HOME.
// The injected LLM records its actual requests; no provider or user data is used.
async function sandbox(run, { offline = false, legacyTargetChat = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-mentions-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const calls = []
  try {
    await mkdir(join(root, 'media-desk'), { recursive: true })
    await mkdir(join(root, 'skills', 'test-writing'), { recursive: true })
    await writeFile(join(root, 'skills', 'test-writing', 'SKILL.md'), `---\nname: test-writing\ndescription: Test writing instructions\n---\n${RULE}`)
    const state = buildSeed(new Date('2026-11-01T00:00:00Z'))
    state.items = [
      { id: 'target', title: 'Target', kind: 'note', status: 'idea', tags: [], createdAt: '2026-11-01T00:00:00Z', body: 'A new draft', drafts: {} },
      { id: 'reference', title: 'Source', kind: 'note', status: 'idea', tags: [], createdAt: '2026-11-01T00:00:00Z', body: FACT, drafts: {} },
    ]
    state.chat = legacyTargetChat ? [{ id: 'legacy', role: 'user', text: 'Old message without a timestamp', itemId: 'target' }] : []
    await writeFile(join(root, 'media-desk', 'state.json'), JSON.stringify(state))
    let handler
    const ctx = {
      get(name) {
        if (name === 'connection') return { requestRejection: ({ headers }) => headers['x-reject'] ? 403 : undefined }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'mock' }) }
        if (name === 'llm') return {
          prepareCall: async () => ({ config: {}, async* stream(request) {
            if (offline) throw new Error('mock model offline')
            const user = request.messages[0].content[0].text
            calls.push({ system: request.system, user })
            let text
            if (request.system.includes('判断用户想做什么')) {
              text = JSON.stringify({ reply: 'OK', ops: [], actions: user.split('用户说：').at(-1).includes('成稿') ? [{ type: 'produce', id: 'target' }] : [] })
            } else if (request.system.includes('策划案')) {
              text = JSON.stringify({ title: 'Test draft', coverText: 'Test', facts: [FACT], outline: ['Test'], cover: '', images: [], shots: [] })
            } else {
              text = '# Test draft\n\nTest article.'
            }
            yield { type: 'text-delta', text }
          } }),
        }
        return undefined
      },
      effect: fn => fn(),
      webServer: { register: options => { handler = options.handler } },
    }
    plugin.apply(ctx)
    const request = (path, body, extraHeaders = {}) => new Promise((resolve, reject) => {
      const req = {
        url: `/media-desk/${path}`, method: body === undefined ? 'GET' : 'POST',
        headers: { 'sec-fetch-site': 'same-origin', ...extraHeaders },
        async* [Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
      }
      const res = { statusCode: 0, headersSent: false, setHeader() {}, end(text) { resolve({ status: res.statusCode, body: JSON.parse(text) }) } }
      Promise.resolve(handler(req, res)).catch(reject)
    })
    await run({ root, calls, request })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}

test('mentions route uses existing authentication and reads the isolated catalog', async () => {
  await sandbox(async ({ request }) => {
    assert.equal((await request('mentions', undefined, { 'x-reject': '1' })).status, 403)
    const { status, body } = await request('mentions')
    assert.equal(status, 200)
    assert.ok(body.contexts.some(row => row.id === 'item:reference'))
    assert.ok(body.commands.some(row => row.id === 'cmd:insights'))
    assert.ok(body.commands.some(row => row.id === 'dsh-skill:test-writing'))
    assert.equal(body.limits.maxMentions, 8)
  })
})

test('references survive a follow-up and reload, but stay scoped to their conversation', async () => {
  await sandbox(async ({ request, calls, root }) => {
    const first = await request('chat', { message: 'Read this source', mentions: [{ id: 'item:reference', label: 'Source', trigger: '@' }] })
    assert.equal(first.status, 200)
    assert.ok(calls.at(-1).user.includes(FACT))
    const saved = JSON.parse(await readFile(join(root, 'media-desk', 'state.json'), 'utf8'))
    assert.deepEqual(saved.chat[0].mentions, [{ id: 'item:reference', label: 'Source', trigger: '@' }])
    assert.ok(!JSON.stringify(saved.chat).includes(FACT), 'store reference IDs instead of copying the source text')
    const reloaded = await request('state')
    assert.deepEqual(reloaded.body.state.chat[0].mentions, saved.chat[0].mentions)
    await request('chat', { message: 'What was that fact?', mentions: [] })
    assert.ok(calls.at(-1).user.includes(FACT))
    await request('chat', { message: 'An unrelated item conversation', focusId: 'target' })
    assert.ok(!calls.at(-1).user.includes(FACT))
    await request('chat/clear', {})
    await request('chat', { message: 'A fresh conversation' })
    assert.ok(!calls.at(-1).user.includes(FACT))
  })
})

test('chat actions carry references into production and its item conversation, including legacy history', async () => {
  await sandbox(async ({ request, calls }) => {
    const turn = await request('chat', {
      message: '成稿', mentions: [
        { id: 'cmd:produce', label: '成稿', trigger: '/' },
        { id: 'item:reference', label: 'Source', trigger: '@' },
        { id: 'dsh-skill:test-writing', label: 'test-writing', trigger: '/' },
      ],
    })
    const action = turn.body.actions[0]
    assert.equal(action.type, 'produce')
    assert.deepEqual(action.mentions.map(row => row.id), ['item:reference', 'dsh-skill:test-writing'])
    const started = await request('produce', { id: action.id, mentions: action.mentions, withImages: false })
    assert.equal(started.status, 200)
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await request('production?id=target')
      if (!result.body.live.running) {
        assert.equal(result.body.production.status, 'done')
        break
      }
      assert.ok(attempt < 199, 'production must finish')
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(calls.length, 3, 'chat, planning and article each invoke the model')
    for (const call of calls) {
      assert.ok(call.user.includes(FACT), 'reference text reaches the actual model request')
      assert.ok(call.user.includes(RULE), 'selected Skill reaches the actual model request')
    }
    // Opening a produced draft switches the browser from global chat to its item chat.
    await request('chat', { message: 'Follow-up', focusId: 'target' })
    assert.ok(calls.at(-1).user.includes(RULE))
    assert.ok(calls.at(-1).user.includes(FACT))
    assert.ok(!calls.at(-1).user.includes('用户主动选择了「成稿」'), 'commands must not be replayed in later turns')
    await request('chat/clear', {})
    await request('chat', { message: 'A new conversation', focusId: 'target' })
    assert.ok(!calls.at(-1).user.includes(RULE), 'clearing also removes production conversation references')
  }, { legacyTargetChat: true })
})

test('model failure does not apply local mutations to a request that needs references', async () => {
  await sandbox(async ({ request }) => {
    const result = await request('chat', { message: '记一下：do not save this as an idea', mentions: [{ id: 'item:reference' }] }, { 'x-media-desk-lang': 'en' })
    assert.equal(result.status, 200)
    assert.equal(result.body.state.items.length, 2)
    assert.deepEqual(result.body.actions, [])
    assert.match(result.body.answer.text, /text model/)
  }, { offline: true })
})
