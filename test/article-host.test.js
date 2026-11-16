import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import plugin from '../src/host.js'
import { buildSeed } from '../src/seed.js'

const SOURCE_FACT = 'ARTICLE_SOURCE_FACT_104729'

// Register the real routes against an isolated store and a deterministic mock LLM.
async function sandbox(run, { chatPlan, writeResult } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'media-desk-article-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const calls = []
  try {
    await mkdir(join(root, 'media-desk'), { recursive: true })
    const state = buildSeed(new Date('2026-11-01T00:00:00Z'))
    state.items = [
      { id: 'article', title: 'Article idea', kind: 'note', status: 'idea', tags: [], body: '', creationFormat: 'article', drafts: {} },
      { id: 'legacy', title: 'Legacy article', kind: 'note', status: 'draft', tags: [], body: 'An old source', production: { format: 'article', status: 'done', title: 'Old article', article: 'Existing text in an old article.', cover: { src: 'old-cover', status: 'done' }, images: [{ src: 'old-figure', status: 'done' }] }, drafts: {} },
      { id: 'video', title: 'Video', kind: 'note', status: 'draft', tags: [], creationFormat: 'script', production: { format: 'script', status: 'done', title: 'Video script', article: 'Existing video script.', cover: { src: 'video-cover', status: 'done' }, images: [], shots: [] }, drafts: {} },
    ]
    state.items.push({ id: 'material', title: 'A source', kind: 'note', body: SOURCE_FACT, status: 'idea', tags: [] })
    state.chat = []
    await writeFile(join(root, 'media-desk', 'state.json'), JSON.stringify(state))
    let handler
    const ctx = {
      get(name) {
        if (name === 'connection') return { requestRejection: ({ headers }) => headers['x-reject'] ? 403 : undefined }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'mock' }) }
        if (name === 'llm') return {
          prepareCall: async () => ({ config: {}, async* stream(request) {
            const user = request.messages[0].content[0].text
            const call = { system: request.system, user }
            calls.push(call)
            let output
            if (request.system.includes('判断用户想做什么')) {
              output = JSON.stringify(chatPlan ? await chatPlan(user.split('用户说：').at(-1), call) : { reply: 'Open the article workflow.', ops: [], actions: [{ type: 'produce', id: 'article' }] })
            } else if (request.system.includes('你是文章局部编辑助手')) {
              output = '仅修改选中这一处。'
            } else if (request.system.includes('你是文章写作助手')) {
              output = writeResult ? await writeResult(call) : '# An evidence-led article\n\nA candidate based on the writing request. Keep the stated boundary.'
            } else if (request.system.includes('你是文章插画编辑')) {
              output = JSON.stringify({ cover: { prompt: 'An explanatory editorial illustration', alt: 'Article cover' }, images: [{ anchor: '## Experience', caption: 'An explanation', alt: 'Article figure', prompt: 'A diagram of the finalized article' }] })
            } else throw new Error('Unexpected model stage')
            yield { type: 'text-delta', text: output }
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
    const view = async (id = 'article') => (await request(`article-workflow?id=${id}`)).body.workflow
    const act = async (action, data = {}, id = 'article') => request('article-workflow', { id, action, data, revision: (await view(id)).revision })
    await run({ root, calls, request, act, view })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}

test('article editor routes authenticate every action and never migrate an old article on read', async () => {
  await sandbox(async ({ root, request, view }) => {
    const file = join(root, 'media-desk', 'state.json'), before = await readFile(file, 'utf8')
    assert.equal((await request('article-workflow?id=legacy', undefined, { 'x-reject': '1' })).status, 403)
    assert.equal((await request('article-workflow?id=missing')).status, 404)
    assert.equal((await view('legacy')).sourcesConfirmed, false)
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal((await request('article-workflow', { id: 'legacy', action: 'generate_draft', revision: 0, data: { instruction: 'Write' } }, { 'x-reject': '1' })).status, 403)
    assert.equal((await request('article-workflow', { id: 'legacy', action: 'generate_draft', revision: 0, data: { instruction: 'Write' } }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  })
})

test('article produce opens its editor without starting the video planner', async () => {
  await sandbox(async ({ request, calls }) => {
    const direct = await request('produce', { id: 'article' })
    assert.equal(direct.status, 200)
    assert.equal(direct.body.started, false)
    assert.equal(direct.body.workflow, 'article')
    assert.equal(calls.length, 0)
    const chat = await request('chat', { message: '成稿', focusId: 'article' })
    assert.equal(chat.status, 200)
    assert.deepEqual(chat.body.actions, [{ type: 'open', id: 'article', workflow: 'article' }])
    assert.equal(chat.body.state.items.find(item => item.id === 'article').production, undefined)
  })
})

test('a blank article can generate a reviewable draft without sources, a point, or an outline', async () => {
  await sandbox(async ({ request, act, calls, view }) => {
    const generated = await act('generate_draft', { instruction: 'Write a clear article about checking one source.' })
    assert.equal(generated.status, 200)
    const candidate = generated.body.candidate
    assert.equal(candidate.kind, 'draft')
    assert.equal(generated.body.state.items.find(item => item.id === 'article').production, undefined)
    assert.equal(calls.length, 1)
    assert.match(calls[0].system, /你是文章写作助手/)
    assert.ok(!calls[0].system.includes('你是内容主编、美术指导和分镜师'))
    assert.equal((await view()).sourcesConfirmed, false)
    const accepted = await act('accept_candidate', { candidateId: candidate.id, text: 'Do not trust client text.' })
    assert.equal(accepted.status, 200)
    const product = accepted.body.state.items.find(item => item.id === 'article').production
    assert.match(product.article, /A candidate based/)
    assert.notEqual(product.article, 'Do not trust client text.')
    assert.equal(product.format, 'article')
    assert.equal(product.shots, undefined)
    assert.equal((await request('produce/regen', { id: 'article', target: 'cover' })).status, 409)
    assert.equal((await act('plan_images')).status, 200, 'there is no finalization step')
    assert.equal((await act('generate_images')).status, 400, 'no image provider was configured')
    assert.equal(calls.length, 2)
  })
})

test('@ references reach generation and continue into a subsequent selection rewrite', async () => {
  await sandbox(async ({ request, act, view, calls }) => {
    const made = await request('article-workflow', { id: 'article', action: 'generate_draft', revision: 0, data: { instruction: 'Use this source.' }, mentions: [{ id: 'item:material', label: 'A source', trigger: '@' }] })
    assert.equal(made.status, 200)
    assert.match(calls[0].user, new RegExp(SOURCE_FACT))
    const accepted = await act('accept_candidate', { candidateId: made.body.candidate.id })
    const text = accepted.body.state.items.find(item => item.id === 'article').production.article
    const selected = await request('article-workflow', { id: 'article', action: 'rewrite_selection', revision: (await view()).revision, data: { instruction: 'Make only this phrase shorter.', selection: { start: 0, end: 11, text: text.slice(0, 11) } }, mentions: [] })
    assert.equal(selected.status, 200)
    assert.match(calls.at(-1).user, new RegExp(SOURCE_FACT))
    assert.equal(selected.body.state.items.find(item => item.id === 'article').production.article, text)
  })
})

test('a global @ command opening an article retains its selected material for later drafting', async () => {
  await sandbox(async ({ request, calls, act }) => {
    const opened = await request('chat', { message: 'Write the article.', mentions: [{ id: 'item:material', label: 'A source' }] })
    assert.equal(opened.status, 200)
    assert.deepEqual(opened.body.actions, [{ type: 'open', id: 'article', workflow: 'article' }])
    const drafted = await act('generate_draft', { instruction: 'Write using the source I selected.' })
    assert.equal(drafted.status, 200)
    assert.match(calls.at(-1).user, new RegExp(SOURCE_FACT))
  })
})

test('selection acceptance changes only the exact second occurrence, and discarding changes no draft', async () => {
  await sandbox(async ({ act, request }) => {
    const repeated = '相同段落。'
    const original = `  😀开头\n${repeated}\n中间不变\n${repeated}\n结尾  `
    assert.equal((await act('save_draft', { title: 'Repeat', text: original }, 'legacy')).status, 200)
    const start = original.lastIndexOf(repeated), selection = { start, end: start + repeated.length, text: repeated }
    const first = await act('rewrite_selection', { instruction: 'Make this specific occurrence clearer.', selection }, 'legacy')
    assert.equal(first.status, 200)
    assert.equal(first.body.state.items.find(item => item.id === 'legacy').production.article, original)
    assert.equal((await act('discard_candidate', { candidateId: first.body.candidate.id }, 'legacy')).status, 200)
    const second = await act('rewrite_selection', { instruction: 'Change just this occurrence.', selection }, 'legacy')
    const accepted = await act('accept_candidate', { candidateId: second.body.candidate.id, text: 'Untrusted replacement' }, 'legacy')
    assert.equal(accepted.status, 200)
    const item = accepted.body.state.items.find(item => item.id === 'legacy')
    assert.equal(item.production.article, original.slice(0, start) + '仅修改选中这一处。' + original.slice(selection.end))
    assert.equal(item.production.images[0].src, 'old-figure')
    assert.ok(item.articleWorkflow.draftHistory.some(record => record.text === original))
    assert.equal(item.articleWorkflow.imagesStale, true)
    const state = await request('state')
    assert.equal(state.body.state.items.find(item => item.id === 'legacy').production.article, item.production.article)
  })
})

test('generic legacy chat directs article modifications to candidate review without overwriting text', async () => {
  await sandbox(async ({ request }) => {
    const result = await request('chat', { message: 'Rewrite this.', focusId: 'legacy' })
    assert.equal(result.status, 200)
    assert.equal(result.body.state.items.find(item => item.id === 'legacy').production.article, 'Existing text in an old article.')
    assert.ok(result.body.actions.some(action => action.type === 'open' && action.id === 'legacy'))
    assert.ok(!result.body.answer.text.includes('确认资料'))
  }, { chatPlan: () => ({ reply: 'Rewritten.', ops: [{ op: 'update_production', id: 'legacy', article: 'Do not overwrite.' }], revise: { article: 'Do not overwrite either.' } }) })
})

test('format switching preserves independent article and video products', async () => {
  await sandbox(async ({ request }) => {
    const switched = await request('ops', { ops: [{ op: 'set_creation_format', id: 'video', format: 'article' }] })
    assert.equal(switched.status, 200)
    const manual = await request('article-workflow', { id: 'video', action: 'save_draft', revision: 0, data: { title: 'Separate article', text: 'Separate article body.' } })
    assert.equal(manual.status, 200)
    const script = await request('ops', { ops: [{ op: 'set_creation_format', id: 'video', format: 'script' }] })
    let item = script.body.state.items.find(row => row.id === 'video')
    assert.equal(item.production.article, 'Existing video script.')
    assert.equal(item.production.cover.src, 'video-cover')
    assert.equal(item.productions.article.article, 'Separate article body.')
    const article = await request('ops', { ops: [{ op: 'set_creation_format', id: 'video', format: 'article' }] })
    item = article.body.state.items.find(row => row.id === 'video')
    assert.equal(item.production.article, 'Separate article body.')
    assert.equal(item.productions.script.cover.src, 'video-cover')
  })
})

test('busy generation blocks mode switches while late results become stale candidates instead of overwriting', async () => {
  let release, entered
  const pendingResult = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  await sandbox(async ({ request, act, view }) => {
    const pending = request('article-workflow', { id: 'article', action: 'generate_draft', revision: 0, data: { instruction: 'Write a draft.' } })
    await started
    assert.equal((await request('article-workflow?id=article')).body.busy, true)
    assert.equal((await request('ops', { ops: [{ op: 'set_creation_format', id: 'article', format: 'script' }] })).status, 409)
    assert.equal((await act('save_draft', { title: 'Newest user title', text: 'Newest user text.' })).status, 200)
    release('An obsolete model response.')
    const late = await pending
    assert.equal(late.status, 409)
    const state = await request('state'), item = state.body.state.items.find(item => item.id === 'article')
    assert.equal(item.production.title, 'Newest user title')
    assert.equal(item.production.article, 'Newest user text.')
    const candidate = (await view()).editCandidates.find(row => row.text === 'An obsolete model response.')
    assert.ok(candidate)
    assert.equal((await act('accept_candidate', { candidateId: candidate.id })).status, 409)
    assert.equal((await request('state')).body.state.items.find(item => item.id === 'article').production.article, 'Newest user text.')
  }, { writeResult: () => { entered(); return pendingResult } })
})
