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
      { id: 'article', title: 'Article idea', kind: 'note', status: 'idea', tags: [], body: SOURCE_FACT, creationFormat: 'article', drafts: {} },
      { id: 'legacy', title: 'Legacy article', kind: 'note', status: 'draft', tags: [], body: 'An old source', production: { format: 'article', status: 'done', title: 'Old article', article: 'Existing text in an old article.', cover: { src: 'old-cover', status: 'done' }, images: [{ src: 'old-figure', status: 'done' }] }, drafts: {} },
      { id: 'video', title: 'Video', kind: 'note', status: 'draft', tags: [], creationFormat: 'script', production: { format: 'script', status: 'done', title: 'Video script', article: 'Existing video script.', cover: { src: 'video-cover', status: 'done' }, images: [], shots: [] }, drafts: {} },
    ]
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
            } else if (request.system.includes('当前只提出一个')) {
              output = JSON.stringify({ thesis: 'The source supports one specific viewpoint.', audience: 'A reader', boundary: 'The source is not independently verified.' })
            } else if (request.system.includes('当前只根据用户已确认的观点')) {
              output = JSON.stringify({ title: 'An evidence-led article', text: '## Experience\nUse source initial.\n## Conclusion\nKeep the stated boundary.' })
            } else if (request.system.includes('现在只写文章正文')) {
              output = writeResult ? await writeResult(call) : `## Experience\nThe article uses ${SOURCE_FACT}.\n\n## Conclusion\nKeep the evidence boundary.`
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

async function confirmWriting(act) {
  assert.equal((await act('confirm_sources')).status, 200)
  assert.equal((await act('save_point', { thesis: 'An author-approved point' })).status, 200)
  assert.equal((await act('confirm_point')).status, 200)
  assert.equal((await act('save_outline', { title: 'An article', text: '## Experience\n## Conclusion' })).status, 200)
  assert.equal((await act('confirm_outline')).status, 200)
}

test('article workflow GET is authenticated, reports missing items, and never migrates a legacy article on disk', async () => {
  await sandbox(async ({ root, request, view }) => {
    const file = join(root, 'media-desk', 'state.json'), before = await readFile(file, 'utf8')
    assert.equal((await request('article-workflow?id=legacy', undefined, { 'x-reject': '1' })).status, 403)
    assert.equal((await request('article-workflow?id=missing')).status, 404)
    const workflow = await view('legacy')
    assert.equal(workflow.legacy, true)
    assert.equal(workflow.stage, 'writing')
    assert.equal(workflow.pointConfirmed, false)
    assert.equal(workflow.outlineConfirmed, false)
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal((await request('article-workflow', { id: 'legacy', action: 'finalize', revision: 0 }, { 'x-reject': '1' })).status, 403)
    assert.equal((await request('article-workflow', { id: 'legacy', action: 'finalize', revision: 0 }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  })
})

test('article produce only opens the staged workflow; chat produce cannot trigger the video producer', async () => {
  await sandbox(async ({ request, calls }) => {
    const direct = await request('produce', { id: 'article' })
    assert.equal(direct.status, 200)
    assert.equal(direct.body.started, false)
    assert.equal(direct.body.workflow, 'article')
    assert.equal(calls.length, 0)
    assert.equal(direct.body.state.items.find(item => item.id === 'article').production, undefined)
    const chat = await request('chat', { message: '成稿', focusId: 'article' })
    assert.equal(chat.status, 200)
    assert.deepEqual(chat.body.actions, [{ type: 'open', id: 'article', workflow: 'article' }])
    assert.equal(calls.length, 1)
    assert.match(calls[0].system, /不要用 actions: produce/)
    assert.equal(chat.body.state.items.find(item => item.id === 'article').production, undefined)
  })
})

test('real article routes enforce all confirmations and use four article model stages without a video plan', async () => {
  await sandbox(async ({ request, calls, act, view }) => {
    for (const action of ['suggest_point', 'suggest_outline', 'write', 'plan_images', 'generate_images']) assert.equal((await act(action)).status, 400)
    assert.equal(calls.length, 0)
    const saved = await act('save_sources', { sources: [{ id: 'initial', title: 'User source', text: SOURCE_FACT, url: 'https://example.com/source', kind: 'reference', verified: false }] })
    assert.equal(saved.status, 200)
    assert.equal((await act('confirm_sources')).status, 200)
    assert.equal((await act('suggest_point')).status, 200)
    assert.equal((await view()).pointConfirmed, false)
    assert.equal((await act('write')).status, 400)
    assert.equal((await act('confirm_point')).status, 200)
    assert.equal((await act('suggest_outline')).status, 200)
    assert.equal((await view()).outlineConfirmed, false)
    assert.equal((await act('write')).status, 400)
    assert.equal((await act('confirm_outline')).status, 200)
    const written = await act('write')
    assert.equal(written.status, 200)
    const production = written.body.state.items.find(item => item.id === 'article').production
    assert.equal(production.format, 'article')
    assert.match(production.article, /ARTICLE_SOURCE_FACT/)
    assert.equal(production.shots, undefined)
    assert.equal((await act('plan_images')).status, 400)
    assert.equal((await request('produce/regen', { id: 'article', target: 'cover' })).status, 409)
    assert.equal((await act('finalize')).status, 200)
    const planned = await act('plan_images')
    assert.equal(planned.status, 200)
    assert.equal(planned.body.workflow.imagesPlanned, true)
    assert.equal(planned.body.workflow.sources[0].verified, false)
    assert.equal(calls.length, 4)
    assert.ok(calls.every(call => !call.system.includes('你是内容主编、美术指导和分镜师')))
    assert.ok(calls.every(call => !/"shots"\s*:/.test(call.system)))
    assert.ok(calls.slice(0, 3).every(call => call.user.includes(SOURCE_FACT)))
    assert.match(calls[3].user, /Final|ARTICLE_SOURCE_FACT/)
    assert.equal((await act('generate_images')).status, 400, 'without an image provider no asset job can start')
    assert.equal(calls.length, 4)
  })
})

test('legacy article chat permits local edits but blocks full rewrites through revise or ops before confirmations', async () => {
  await sandbox(async ({ request, view }) => {
    const partial = await request('chat', { message: 'partial', focusId: 'legacy' })
    assert.equal(partial.status, 200)
    const body = partial.body.state.items.find(item => item.id === 'legacy').production.article
    assert.equal(body, 'Revised fragment in an old article.')
    assert.equal((await view('legacy')).pointConfirmed, false)
    for (const message of ['whole-revise', 'whole-op', 'whole-save-draft']) {
      const result = await request('chat', { message, focusId: 'legacy' })
      assert.equal(result.status, 200)
      assert.equal(result.body.state.items.find(item => item.id === 'legacy').production.article, body, message)
      assert.ok(result.body.answer.errors.length, 'blocked full writes must be visible to the user')
    }
  }, { chatPlan: message => message === 'partial'
    ? { reply: 'Changed a fragment.', ops: [], revise: { edits: [{ find: 'Existing text', replace: 'Revised fragment' }] } }
    : message === 'whole-revise' ? { reply: 'Whole rewrite.', ops: [], revise: { article: 'Do not overwrite the old article.' } }
      : message === 'whole-op' ? { reply: 'Whole rewrite.', ops: [{ op: 'update_production', id: 'legacy', article: 'Do not overwrite through ops.' }] }
        : { reply: 'Whole rewrite.', ops: [{ op: 'save_draft', id: 'legacy', format: 'article', text: 'Do not overwrite through save_draft.' }] } })
})

test('switching formats through the real ops route preserves independent article and video products', async () => {
  await sandbox(async ({ request }) => {
    const switched = await request('ops', { ops: [{ op: 'set_creation_format', id: 'video', format: 'article' }] })
    assert.equal(switched.status, 200)
    assert.deepEqual(switched.body.errors, [])
    let item = switched.body.state.items.find(row => row.id === 'video')
    assert.equal(item.production, undefined)
    assert.equal(item.productions.script.article, 'Existing video script.')
    const manual = await request('article-workflow', { id: 'video', action: 'save_draft', revision: 0, data: { title: 'Separate article', text: 'Separate article body.' } })
    assert.equal(manual.status, 200)
    const script = await request('ops', { ops: [{ op: 'set_creation_format', id: 'video', format: 'script' }] })
    item = script.body.state.items.find(row => row.id === 'video')
    assert.equal(item.production.article, 'Existing video script.')
    assert.equal(item.production.cover.src, 'video-cover')
    assert.equal(item.productions.article.article, 'Separate article body.')
    const article = await request('ops', { ops: [{ op: 'set_creation_format', id: 'video', format: 'article' }] })
    item = article.body.state.items.find(row => row.id === 'video')
    assert.equal(item.production.article, 'Separate article body.')
    assert.equal(item.productions.script.cover.src, 'video-cover')
  })
})

test('a live article model call blocks format switches and a late response cannot overwrite a later saved draft', async () => {
  let release, entered
  const pendingResult = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  await sandbox(async ({ request, act, view }) => {
    await confirmWriting(act)
    const before = await view()
    const pending = request('article-workflow', { id: 'article', action: 'write', revision: before.revision })
    await started
    assert.equal((await request('article-workflow?id=article')).body.busy, true)
    const blocked = await request('ops', { ops: [{ op: 'set_creation_format', id: 'article', format: 'script' }] })
    assert.equal(blocked.status, 409)
    const manual = await act('save_draft', { title: 'Newest user title', text: 'Newest user text.' })
    assert.equal(manual.status, 200)
    release('An obsolete model response.')
    const late = await pending
    assert.equal(late.status, 409)
    const state = await request('state')
    const item = state.body.state.items.find(row => row.id === 'article')
    assert.equal(item.creationFormat, 'article')
    assert.equal(item.production.title, 'Newest user title')
    assert.equal(item.production.article, 'Newest user text.')
    assert.ok((await view()).draftHistory.some(row => row.candidate && row.text === 'An obsolete model response.'))
  }, { writeResult: () => { entered(); return pendingResult } })
})
