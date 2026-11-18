import assert from 'node:assert/strict'
import test from 'node:test'
import { ArticleWorkflow } from '../src/article-workflow.js'
import { articleImagesPrompts, articleSelectionPrompts, articleWritePrompts, chatPrompts } from '../src/ai.js'
import { articleWorkspace, creationFormat, markArticleDraftChanged, productionFor, selectCreationFormat } from '../src/workflow.js'

function fixture(callText = async () => ({ text: '# Generated title\n\nGenerated article.', model: 'test' })) {
  const state = { items: [{ id: 'article', title: 'An idea', body: '', creationFormat: 'article', status: 'idea' }], skills: [], styles: [], angles: [], people: [], metrics: [], accounts: [], chat: [], draftFormat: 'script' }
  const calls = [], images = []
  const service = new ArticleWorkflow({ store: { read: async () => state, mutate: async (_label, fn) => fn(state) }, settings: { read: async () => ({ voice: '', imageCount: 2 }) }, callText: async request => { calls.push(request); return callText(request) }, renderAsset: async (_id, target) => { images.push(target) }, ready: () => true })
  const item = () => state.items[0]
  const act = (action, data, options = {}) => service.act('article', action, { expectedRevision: articleWorkspace(item()).revision, data, ...options })
  return { state, service, calls, images, item, act }
}

test('format helpers preserve independent products and legacy script interpretation', () => {
  const item = { production: { article: 'Legacy script', cover: { src: 'video-cover' } } }
  assert.equal(creationFormat(item, 'article'), 'script')
  selectCreationFormat(item, 'article')
  assert.equal(item.production, undefined)
  assert.equal(productionFor(item, 'script').article, 'Legacy script')
  item.production = { format: 'article', article: 'An article', images: [{ src: 'article-image' }] }
  selectCreationFormat(item, 'script')
  item.production.article = 'Edited script'
  assert.equal(item.productions.script.article, 'Legacy script')
  selectCreationFormat(item, 'article')
  assert.equal(item.production.article, 'An article')
  assert.equal(item.productions.script.article, 'Edited script')
})

test('drafts-only articles remain readable without migration and retain their previous version on save', async () => {
  const f = fixture()
  delete f.item().creationFormat
  f.item().drafts = { article: { text: 'Legacy body.', aiText: 'Original AI body.' } }
  const before = structuredClone(f.item())
  assert.equal(creationFormat(f.item()), 'article')
  assert.equal(productionFor(f.item(), 'article').article, 'Legacy body.')
  assert.equal(articleWorkspace(f.item()).legacy, true)
  assert.deepEqual(f.item(), before)
  await f.act('save_draft', { title: 'Materialized', text: 'Updated body.' })
  assert.equal(articleWorkspace(f.item()).draftHistory[0].text, 'Legacy body.')
  assert.equal(f.item().drafts.article.text, 'Legacy body.')
  assert.equal(articleWorkspace(f.item()).pointConfirmed, false)
})

test('manual paste preserves whitespace and indentation, supports empty text, and ignores no-op saves', async () => {
  const f = fixture(), body = '\n  indented Markdown\n\n  ', title = '  A manual title  '
  await f.act('save_draft', { text: body, title })
  assert.equal(f.item().production.article, body)
  assert.equal(f.item().production.title, title)
  const revision = articleWorkspace(f.item()).revision
  await f.act('save_draft', { text: body, title })
  assert.equal(articleWorkspace(f.item()).revision, revision)
  await f.act('save_draft', { text: '', title: '' })
  assert.equal(f.item().production.article, '')
  assert.equal(f.item().production.title, '')
  assert.equal(articleWorkspace(f.item()).draftHistory.at(-1).text, body)
})

test('unconfirmed draft generation returns an unapplied candidate, carrying optional references and truthful chat history', async () => {
  const f = fixture(), context = '{"materials":[{"content":"OPTIONAL_REFERENCE_927341"}]}', mentions = [{ id: 'item:reference', label: 'Reference', trigger: '@' }]
  const result = await f.act('generate_draft', { instruction: 'Explain a practical idea.' }, { context, mentions })
  assert.equal(result.candidate.kind, 'draft')
  assert.equal(result.candidate.title, 'Generated title')
  assert.equal(result.candidate.text, 'Generated article.')
  assert.equal(result.candidate.baseRevision, 0)
  assert.equal(result.workflow.revision, 0)
  assert.equal(f.item().production, undefined)
  assert.match(f.calls[0].user, /OPTIONAL_REFERENCE_927341/)
  assert.match(f.calls[0].user, /Explain a practical idea/)
  assert.equal(f.state.chat.length, 2)
  assert.deepEqual(f.state.chat[0].mentions, mentions)
  assert.ok(!JSON.stringify(f.state.chat).includes('Generated article.'))
  const accepted = await f.act('accept_candidate', { candidateId: result.candidate.id, text: 'Forged client replacement' })
  assert.equal(accepted.candidate.status, 'accepted')
  assert.equal(f.item().production.article, 'Generated article.')
  assert.equal(accepted.workflow.revision, 1)
  assert.equal(accepted.workflow.pointConfirmed, false)
})

test('legacy write action delegates to a candidate without the former three-confirmation gate', async () => {
  const f = fixture(), result = await f.act('write')
  assert.equal(result.candidate.kind, 'draft')
  assert.equal(f.item().production, undefined)
  assert.equal(result.workflow.sourcesConfirmed, false)
})

test('second repeated paragraph is replaced at its exact UTF-16 range, preserving all surrounding bytes', async () => {
  const replacement = '\n  Precise replacement.  \n', f = fixture(async () => ({ text: replacement }))
  const repeated = 'Repeated paragraph 😀.', body = `Start\n\n${repeated}\n\nMiddle\n\n${repeated}\n\nEnd\n`
  await f.act('save_draft', { title: 'Keep title', text: body })
  const start = body.lastIndexOf(repeated), end = start + repeated.length
  const generated = await f.act('rewrite_selection', { instruction: 'Clarify only this occurrence.', selection: { start, end, text: repeated } })
  assert.equal(f.item().production.article, body)
  assert.equal(generated.candidate.text, replacement)
  assert.equal(generated.workflow.revision, 1)
  await f.act('accept_candidate', { candidateId: generated.candidate.id, selection: { start: 0, end: body.length, text: body }, text: 'Forged replacement' })
  assert.equal(f.item().production.article, body.slice(0, start) + replacement + body.slice(end))
  assert.equal(f.item().production.title, 'Keep title')
  assert.ok(f.item().production.article.includes(repeated))
  assert.equal(articleWorkspace(f.item()).draftHistory.at(-1).text, body)
})

test('selection guards reject mismatched text, invalid offsets and split emoji surrogate pairs before calling a model', async () => {
  const f = fixture(), body = 'A😀B\nText'
  await f.act('save_draft', { title: 'Title', text: body })
  const before = structuredClone(f.state)
  for (const selection of [{ start: 0, end: 1, text: 'wrong' }, { start: -1, end: 1, text: 'A' }, { start: 1, end: 2, text: body.slice(1, 2) }, { start: 2, end: 3, text: body.slice(2, 3) }, { start: 0, end: 0, text: '' }, { start: 0.5, end: 1, text: 'A' }]) {
    await assert.rejects(f.act('rewrite_selection', { instruction: 'Improve it.', selection }), error => [400, 409].includes(error.status))
  }
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.state, before)
  const valid = await f.act('rewrite_selection', { instruction: 'Replace emoji.', selection: { start: 1, end: 3, text: '😀' } })
  assert.deepEqual(valid.candidate.selection, { start: 1, end: 3, text: '😀' })
})

test('discard changes neither document nor revision and prevents subsequent acceptance', async () => {
  const f = fixture()
  await f.act('save_draft', { title: 'Title', text: 'Keep original.' })
  const before = structuredClone(f.item().production), revision = articleWorkspace(f.item()).revision
  const generated = await f.act('generate_draft', { instruction: 'Propose an alternative.' })
  const result = await f.act('discard_candidate', { candidateId: generated.candidate.id })
  assert.equal(result.candidate.status, 'discarded')
  assert.equal(result.workflow.revision, revision)
  assert.deepEqual(f.item().production, before)
  await assert.rejects(f.act('accept_candidate', { candidateId: generated.candidate.id }), error => error.status === 409)
})

test('accept rejects changed body/version and a corrupted range instead of modifying another passage', async () => {
  const f = fixture(), body = 'The selected sentence.\nKeep ending.', selected = 'The selected sentence.'
  await f.act('save_draft', { title: 'Title', text: body })
  const first = await f.act('rewrite_selection', { instruction: 'Improve it.', selection: { start: 0, end: selected.length, text: selected } })
  await f.act('save_draft', { title: 'Title', text: 'A prefix. ' + body })
  await assert.rejects(f.act('accept_candidate', { candidateId: first.candidate.id }), error => error.status === 409)
  const latest = f.item().production.article, start = latest.indexOf(selected)
  const second = await f.act('rewrite_selection', { instruction: 'Improve it.', selection: { start, end: start + selected.length, text: selected } })
  const stored = f.item().articleWorkflow.editCandidates.find(row => row.id === second.candidate.id)
  stored.selection.text = 'Mismatched stored selection'
  await assert.rejects(f.act('accept_candidate', { candidateId: second.candidate.id }), error => error.status === 409)
  stored.selection.text = selected
  f.item().production.article += ' Unversioned mutation.'
  await assert.rejects(f.act('accept_candidate', { candidateId: second.candidate.id }), error => error.status === 409)
})

test('generation failure preserves document, assets, candidates and chat history', async () => {
  const f = fixture(async () => { throw new Error('Provider offline') })
  await f.act('save_draft', { title: 'Title', text: 'Old article.' })
  f.item().production.images = [{ src: 'original-image' }]
  const before = structuredClone(f.state)
  await assert.rejects(f.act('generate_draft', { instruction: 'An alternative.' }), error => error.status === 502)
  assert.deepEqual(f.state, before)
  assert.equal(f.service.isBusy('article'), false)
})

test('an overlong selection replacement is rejected before an unusable candidate is stored', async () => {
  const f = fixture(async () => ({ text: 'aa', model: 'test' }))
  await f.act('save_draft', { text: 'x'.repeat(200000), title: 'Long article' })
  const before = structuredClone(f.state)
  await assert.rejects(f.act('rewrite_selection', { instruction: 'Expand this word.', selection: { start: 0, end: 1, text: 'x' } }), error => error.status === 502)
  assert.deepEqual(f.state, before)
})

test('late model output stays a stale candidate without overwriting a manual edit or advancing its revision', async () => {
  let release
  const pendingModel = new Promise(resolve => { release = resolve }), f = fixture(() => pendingModel)
  await f.act('save_draft', { title: 'Title', text: 'Old document.' })
  const pending = f.act('generate_draft', { instruction: 'An alternative.' })
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.act('generate_draft', { instruction: 'Duplicate.' }), error => error.status === 409)
  await f.act('save_draft', { title: 'New title', text: 'Newest edit.' })
  const revision = articleWorkspace(f.item()).revision
  release({ text: 'Old model response.', model: 'test' })
  await assert.rejects(pending, error => error.status === 409 && error.candidate.stale === true)
  assert.equal(f.item().production.article, 'Newest edit.')
  assert.equal(articleWorkspace(f.item()).revision, revision)
  const stale = articleWorkspace(f.item()).editCandidates.at(-1)
  assert.equal(stale.text, 'Old model response.')
  await assert.rejects(f.act('accept_candidate', { candidateId: stale.id }), error => error.status === 409)
})

test('candidate storage is bounded and accepting an edit invalidates but preserves existing illustrations', async () => {
  const f = fixture()
  await f.act('save_draft', { title: 'Title', text: 'Old article.' })
  f.item().production.cover = { src: 'old-cover' }
  f.item().production.images = [{ src: 'old-image' }]
  for (let index = 0; index < 10; index++) await f.act('generate_draft', { instruction: `Alternative ${index}` })
  const workspace = articleWorkspace(f.item())
  assert.equal(workspace.editCandidates.length, 8)
  assert.equal(workspace.revision, 1)
  await f.act('accept_candidate', { candidateId: workspace.editCandidates.at(-1).id })
  assert.equal(f.item().production.cover.src, 'old-cover')
  assert.equal(f.item().production.images[0].src, 'old-image')
  assert.equal(articleWorkspace(f.item()).imagesStale, true)
})

test('image planning uses any current nonempty draft without finalization and generation rejects an outdated plan', async () => {
  const f = fixture(async () => ({ text: JSON.stringify({ cover: { prompt: 'Cover', alt: 'Alt' }, images: [{ anchor: '## Section', caption: 'Figure', prompt: 'Diagram' }], shots: [{ visual: 'Discarded' }] }) }))
  await assert.rejects(f.act('plan_images'), error => error.status === 400)
  await f.act('save_draft', { title: 'Title', text: '## Section\nCurrent article.' })
  const planned = await f.act('plan_images')
  assert.equal(planned.workflow.draftFinalized, false)
  assert.equal(planned.workflow.imagesPlanned, true)
  assert.equal(f.item().production.shots, undefined)
  assert.equal(f.images.length, 0)
  await f.act('generate_images')
  assert.deepEqual(f.images, ['cover', 'image:0'])
  await f.act('save_draft', { title: 'Title', text: 'Updated text.' })
  await assert.rejects(f.act('generate_images'), error => error.status === 400)
  assert.equal(f.item().production.images[0].prompt, 'Diagram')
})

test('invalid requests cannot partially mutate the store and AI cannot promote source verification', async () => {
  const f = fixture(), before = structuredClone(f.item())
  await assert.rejects(f.service.act('article', 'save_draft', { data: { text: 'No version' } }), error => error.status === 400)
  await assert.rejects(f.service.act('article', 'save_draft', { expectedRevision: 9, data: { text: 'Old version' } }), error => error.status === 409)
  await assert.rejects(f.act('save_sources', { sources: [{ text: 'Bad URL', url: 'file:///private/path' }] }), error => error.status === 400)
  await assert.rejects(f.act('save_draft', { text: null }), error => error.status === 400)
  assert.deepEqual(f.item(), before)
  await f.act('save_sources', { sources: [{ id: 'one', text: 'A source', verified: false }] })
  await f.act('generate_draft', { instruction: 'Use sources cautiously.' })
  assert.equal(articleWorkspace(f.item()).sources[0].verified, false)
  f.item().articleWorkflow.draftStale = true
  markArticleDraftChanged(f.item())
  assert.equal(articleWorkspace(f.item()).draftStale, false)
})

test('prompts describe optional materials and selection-only edits instead of claiming prior confirmations', () => {
  const f = fixture(), workspace = articleWorkspace(f.item())
  f.item().production = { format: 'article', status: 'done', title: 'Title', article: 'Before\nSelected 😀\nAfter' }
  const prompts = [articleWritePrompts(f.state, f.item(), workspace, { instruction: 'A short article.' }), articleSelectionPrompts(f.state, f.item(), { instruction: 'Clarify.', selection: { start: 7, end: 18, text: 'Selected 😀' } }), articleImagesPrompts(f.state, f.item(), workspace)]
  assert.match(prompts[0].system, /文章写作助手/)
  assert.match(prompts[1].system, /只改写用户明确选中的文本/)
  assert.match(prompts[1].user, /Selected 😀/)
  assert.ok(prompts.every(row => !row.system.includes('已经由用户明确确认')))
  const chat = chatPrompts(f.state, 'Help with this article.', { focusId: 'article' })
  assert.match(chat.system, /没有确认步骤要求/)
  assert.match(chat.system, /不要通过聊天 ops\/revise 自动覆盖正文/)
  assert.doesNotMatch(chat.system, /必须遵守「资料与出处/)
})
