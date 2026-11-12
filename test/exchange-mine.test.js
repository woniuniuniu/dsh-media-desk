import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Exchange, parseMine, parseReplyDraft } from '../src/exchange.js'
import { emptyState, migrateState } from '../src/seed.js'
import { Settings } from '../src/settings.js'

const MINE = { schema: 1, postId: '1856000000000000001', kind: 'post', text: 'hello', postedAt: '2026-11-11T02:30:00Z', fetchedAt: '2026-11-11T14:00:00Z', metrics: { likes: 8, replies: 1, reposts: 2, quotes: 0, views: 900 }, followers: 1204 }
const REPLY = { schema: 1, toHandle: 'karpathy', toPostId: '1855000000000000001', drafts: ['a', 'b'], notifiedAt: '2026-11-11T03:10:00Z' }
const LATER = () => Date.now() + 60_000
async function fresh(opts) { const ex = new Exchange(await mkdtemp(join(tmpdir(), 'xdesk-mine-')), opts); await ex.ensure(); return ex }
const plain = ({ items, skipped }) => ({ items, skipped })

test('mine：每个字段', () => {
  const r = parseMine(MINE, { ownHandle: 'me_x' })
  assert.deepEqual(r, {
    mine: { id: '1856000000000000001', kind: 'post', text: 'hello', url: 'https://x.com/me_x/status/1856000000000000001', postedAt: '2026-11-11T02:30:00.000Z', fetchedAt: '2026-11-11T14:00:00.000Z', likes: 8, replies: 1, reposts: 2, quotes: 0, views: 900, inReplyTo: null, candidateId: null, replyId: null },
    followers: 1204,
  })
})
test('mine：未设置 ownHandle 时链接为 null；kind 缺省按 post', () => {
  const { kind, ...rest } = MINE
  const r = parseMine(rest)
  assert.equal(r.mine.url, null)
  assert.equal(r.mine.kind, 'post')
  assert.equal(parseMine(MINE, { ownHandle: '' }).mine.url, null)
  assert.equal(parseMine(MINE, { ownHandle: 'bad handle' }).mine.url, null)
})
test('mine：非法 postId / kind / schema / 时间 / 正文返回 null', () => {
  assert.equal(parseMine({ ...MINE, postId: 'abc' }), null)
  assert.equal(parseMine({ ...MINE, kind: 'retweet' }), null)
  assert.equal(parseMine({ ...MINE, schema: 2 }), null)
  assert.equal(parseMine({ ...MINE, postedAt: 'x' }), null)
  assert.equal(parseMine({ ...MINE, text: 5 }), null)
  assert.equal(parseMine(null), null)
})
test('mine：正文截到 4000，互动数缺失记 0', () => {
  const r = parseMine({ ...MINE, text: 'a'.repeat(9000), metrics: { likes: -3 } })
  assert.equal(r.mine.text.length, 4000)
  assert.equal(r.mine.likes, 0)
  assert.equal(parseMine({ ...MINE, metrics: undefined }).mine.views, 0)
})
test('mine：inReplyTo 只在 reply 且两个字段都合法时保留', () => {
  const inReplyTo = { handle: 'karpathy', postId: '1855000000000000001' }
  assert.deepEqual(parseMine({ ...MINE, kind: 'reply', inReplyTo }).mine.inReplyTo, inReplyTo)
  assert.equal(parseMine({ ...MINE, kind: 'post', inReplyTo }).mine.inReplyTo, null)
  assert.equal(parseMine({ ...MINE, kind: 'quote', inReplyTo }).mine.inReplyTo, null)
  assert.equal(parseMine({ ...MINE, kind: 'reply', inReplyTo: { handle: 'bad handle', postId: '1855000000000000001' } }).mine.inReplyTo, null)
  assert.equal(parseMine({ ...MINE, kind: 'reply', inReplyTo: { handle: 'karpathy', postId: 'x' } }).mine.inReplyTo, null)
  assert.equal(parseMine({ ...MINE, kind: 'reply' }).mine.inReplyTo, null)
})
test('mine：followers 只接受 0 到 1e9 的整数', () => {
  for (const bad of [-1, 1.5, '1204', 2e9, null, NaN]) assert.equal(parseMine({ ...MINE, followers: bad }).followers, null, String(bad))
  assert.equal(parseMine({ ...MINE, followers: 0 }).followers, 0)
  assert.equal(parseMine({ ...MINE, followers: undefined }).followers, null)
})

test('回复草稿：每个字段，且不带 id', () => {
  assert.deepEqual(parseReplyDraft(REPLY), { toHandle: 'karpathy', toPostId: '1855000000000000001', drafts: ['a', 'b'], notifiedAt: '2026-11-11T03:10:00.000Z', sentText: null, sentAt: null })
})
test('回复草稿：非法字段返回 null', () => {
  assert.equal(parseReplyDraft({ ...REPLY, toPostId: 'x' }), null)
  assert.equal(parseReplyDraft({ ...REPLY, toHandle: 'bad handle' }), null)
  assert.equal(parseReplyDraft({ ...REPLY, schema: 2 }), null)
  assert.equal(parseReplyDraft({ ...REPLY, notifiedAt: 'x' }), null)
  assert.equal(parseReplyDraft({ ...REPLY, drafts: [] }), null)
  assert.equal(parseReplyDraft({ ...REPLY, drafts: ['  ', ''] }), null)
  assert.equal(parseReplyDraft({ ...REPLY, drafts: 'a' }), null)
  assert.equal(parseReplyDraft(null), null)
})
test('回复草稿：4 个取前 3 个，非字符串和空串被丢掉，每个截到 1000', () => {
  assert.deepEqual(parseReplyDraft({ ...REPLY, drafts: ['1', '2', '3', '4'] }).drafts, ['1', '2', '3'])
  assert.deepEqual(parseReplyDraft({ ...REPLY, drafts: [5, ' x ', null, '', 'y'] }).drafts, ['x', 'y'])
  assert.equal(parseReplyDraft({ ...REPLY, drafts: ['a'.repeat(3000)] }).drafts[0].length, 1000)
})

test('readNew(mine) 带 ownHandle 并返回 {mine, followers}', async () => {
  const ex = await fresh()
  await writeFile(join(ex.root, 'mine', 'a.json'), JSON.stringify(MINE))
  const r = await ex.readNew('mine', { ownHandle: 'me_x' })
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].mine.url, 'https://x.com/me_x/status/1856000000000000001')
  assert.equal(r.items[0].followers, 1204)
  await r.commit()
  assert.deepEqual(plain(await ex.readNew('mine', { ownHandle: 'me_x' })), { items: [], skipped: [] })
})
test('readNew(replies) 读入草稿', async () => {
  const ex = await fresh()
  await writeFile(join(ex.root, 'replies', 'a.json'), JSON.stringify(REPLY))
  const r = await ex.readNew('replies')
  assert.equal(r.items[0].toHandle, 'karpathy')
})
for (const kind of ['mine', 'replies']) {
  const good = kind === 'mine' ? MINE : REPLY
  test(`readNew(${kind})：坏文件、半成品、已读与 posts 一致`, async () => {
    let t = Date.now()
    const ex = await fresh({ now: () => t })
    const dir = join(ex.root, kind)
    await writeFile(join(dir, 'bad.json'), '{oops')
    await writeFile(join(dir, 'wrong.json'), JSON.stringify({ schema: 1 }))
    await writeFile(join(dir, 'good.json'), JSON.stringify(good))
    const r1 = await ex.readNew(kind)
    assert.equal(r1.items.length, 1)
    assert.deepEqual(r1.skipped, []) // 刚写入的坏文件先不报
    t += 11_000
    const r2 = await ex.readNew(kind)
    assert.deepEqual(r2.skipped.map(s => [s.file, s.why]).sort(), [['bad.json', '不是有效的 JSON'], ['wrong.json', '内容不符合格式']])
    await r2.commit()
    assert.deepEqual(plain(await ex.readNew(kind)), { items: [], skipped: [] })
  })
}

test('新样例文件都能解析，followers 递增，回复指向 replies 样例', async () => {
  const base = new URL('../scripts/sample-exchange/', import.meta.url)
  const mineFiles = (await readdir(new URL('mine/', base))).sort()
  const replyFiles = (await readdir(new URL('replies/', base))).sort()
  assert.equal(mineFiles.length, 5)
  assert.equal(replyFiles.length, 2)
  const mine = []
  for (const f of mineFiles) mine.push(parseMine(JSON.parse(await readFile(new URL(`mine/${f}`, base), 'utf8')), { ownHandle: 'me' }))
  assert.ok(mine.every(Boolean))
  const fol = mine.map(m => m.followers)
  assert.deepEqual([...fol].sort((a, b) => a - b), fol)
  assert.equal(new Set(fol).size, 5)
  assert.deepEqual(mine.map(m => m.mine.kind).sort(), ['post', 'post', 'post', 'quote', 'reply'])
  const replies = []
  for (const f of replyFiles) replies.push(parseReplyDraft(JSON.parse(await readFile(new URL(`replies/${f}`, base), 'utf8'))))
  assert.ok(replies.every(Boolean))
  const reply = mine.find(m => m.mine.kind === 'reply').mine
  assert.ok(replies.some(r => r.toPostId === reply.inReplyTo.postId && r.toHandle === reply.inReplyTo.handle))
  assert.ok(mine.every(m => m.mine.id >= '1856000000000000001'))
})

test('migrateState：旧的第 2 版数据补齐新字段，原有数据不变', () => {
  const old = emptyState()
  for (const k of ['mine', 'replyDrafts', 'followers', 'proposals', 'longforms']) delete old[k]
  for (const k of ['lastLearnDay', 'learnedPairs', 'ownVoicePrompted', 'lastLongformWeek']) delete old.runs[k]
  old.runs.lastComposeDay = '2026-11-10'
  old.candidates = [{ id: 'c_abc1', text: 'x', status: 'sent', sentText: 'kept' }, { id: 'c_abc2', text: 'y', status: 'pending' }]
  old.posts = [{ id: '1' }]
  const m = migrateState(structuredClone(old))
  for (const k of ['mine', 'replyDrafts', 'followers', 'proposals', 'longforms']) assert.deepEqual(m[k], [])
  assert.deepEqual([m.runs.lastLearnDay, m.runs.learnedPairs, m.runs.ownVoicePrompted, m.runs.lastLongformWeek], [null, 0, false, null])
  assert.equal(m.runs.lastComposeDay, '2026-11-10')
  assert.deepEqual(m.candidates[0], { id: 'c_abc1', text: 'x', status: 'sent', sentText: 'kept', sentPostId: null, sentAt: null })
  assert.deepEqual(m.candidates[1], { id: 'c_abc2', text: 'y', status: 'pending', sentText: null, sentPostId: null, sentAt: null })
  assert.deepEqual(m.posts, [{ id: '1' }])
  assert.deepEqual(migrateState(m), m)
})

test('设置 ownHandle：去掉开头 @，可清空，非法 400', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xdesk-set-'))
  try {
    const s = new Settings(root)
    assert.equal((await s.read()).ownHandle, '')
    assert.equal((await s.update({ ownHandle: '@me_x' })).ownHandle, 'me_x')
    assert.equal((await s.read()).ownHandle, 'me_x')
    assert.equal((await s.update({ ownHandle: '' })).ownHandle, '')
    assert.equal((await s.update({ ownHandle: '@' })).ownHandle, '')
    for (const bad of ['a b', '@@me', 'x'.repeat(16), 'é', 5, null]) {
      await assert.rejects(s.update({ ownHandle: bad }), e => e.status === 400 && /账号名/.test(e.message), String(bad))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
