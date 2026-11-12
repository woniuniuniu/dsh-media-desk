import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeInsights, proposeRules } from '../src/learn.js'
import { applyOps } from '../src/ops.js'
import { importPosts, normalizePosts } from '../src/monid.js'
import { scopeState } from '../src/accounts.js'

const fields = ['views', 'likes', 'comments', 'shares', 'saves']
const item = (id, platform = '抖音', extra = {}) => ({ id, title: `Work ${id}`, platform, status: 'published', ...extra })
const metric = (itemId, views, extra = {}) => ({ itemId, platform: '抖音', views, ...extra })
const state = (items, metrics) => ({ items, metrics, accounts: [], skills: [], chat: [] })
const timed = (time, views, extra = {}) => metric('a', views, { collectedAt: `2026-01-01T${time}:00Z`, ...extra })

test('historical full counters reduce to the latest snapshot, without inventing collection provenance', () => {
  const s = state(Array.from({ length: 20 }, (_, i) => item(String(i))), [])
  for (let i = 0; i < 15; i++) s.metrics.push(metric(String(i), [1060, 797, 116][i % 3], { date: '2026-01-01T08:13:13Z', likes: 0, comments: 0, shares: 0, saves: 0 }))
  for (let i = 0; i < 3; i++) s.metrics.push(metric(String(i), [1063, 803, 116][i], { date: '2026-01-01T08:16:14Z', likes: 0, comments: 0, shares: 0, saves: 0 }))
  const before = structuredClone(s)
  const d = computeInsights(s)
  assert.equal(d.views, 5 * (1060 + 797 + 116) + 9)
  assert.equal(d.top.find(r => r.id === '0').views, 1063)
  assert.deepEqual(d.daily, [])
  assert.equal(d.coverage.published, 20)
  assert.equal(d.coverage.withData, 15)
  assert.equal(d.coverage.withViews, 15)
  assert.equal(d.coverage.complete, 15)
  assert.equal(d.coverage.rawRecords, 18)
  assert.equal(d.coverage.uniqueWorks, 15)
  assert.equal(d.coverage.latestCollectedAt, null)
  assert.equal(d.coverage.unknownTimeRecords, 18)
  assert.equal(d.coverage.unknownSourceRecords, 18)
  assert.equal(d.coverage.legacyZeroRecords, 18)
  assert.equal(d.coverage.missingWorks.length, 5)
  assert.ok(d.coverage.missingWorks.every(r => r.reason === 'no linked snapshot' && r.missingFields.length === 5 && r.source === null && r.latestCollectedAt === null))
  assert.equal(d.top[0].provenance.views.collectedAt, null)
  assert.ok(d.top[0].warnings.includes('legacy-zero-provenance'))
  assert.deepEqual(s, before)
  assert.deepEqual(computeInsights({ ...s, metrics: [...s.metrics].reverse() }), d)
})

test('latest valid per-field values retain their own provenance and allow real downward corrections', () => {
  const d = computeInsights(state([item('a')], [
    timed('08:00', 100, { id: 'first', likes: 2, source: 'manual' }),
    timed('09:00', 90, { id: 'last', likes: -1, comments: 0, source: 'api' }),
  ]))
  assert.equal(d.views, 90)
  assert.equal(d.top[0].likes, 2)
  assert.equal(d.top[0].comments, 0)
  assert.equal(d.top[0].shares, null)
  assert.equal(d.top[0].provenance.likes.collectedAt, '2026-01-01T08:00:00.000Z')
  assert.equal(d.engaged, 2)
  assert.equal(d.engagedPartial, true)
  assert.equal(d.engagementRate, null)
  assert.equal(d.coverage.missingWorks[0].reason, 'missing/invalid fields')
  assert.deepEqual(d.coverage.missingWorks[0].missingFields, ['likes', 'shares', 'saves'])
  assert.deepEqual(d.coverage.missingWorks[0].retainedFields, ['likes'])
})

test('unknown counters stay null, known zeros stay zero and rates use matched complete snapshots', () => {
  const d = computeInsights(state([item('a'), item('b'), item('c')], [
    metric('a', 0, { likes: 0 }),
    metric('b', 100, { likes: 10, comments: 2, shares: 1, saves: 2 }),
    metric('c', NaN, { likes: 500, comments: Infinity, shares: 1.5, saves: Number.MAX_SAFE_INTEGER + 1 }),
  ]))
  assert.equal(d.views, 100)
  assert.equal(d.top.find(r => r.id === 'a').views, 0)
  assert.equal(d.top.find(r => r.id === 'c').views, null)
  assert.equal(d.engagementRate, .15)
  assert.equal(d.rateCoverage.matchedWorks, 1)
  assert.equal(d.rateCoverage.views, 100)
  assert.equal(d.rateCoverage.partial, true)
  assert.equal(computeInsights(state([], [])).views, null)
  assert.equal(computeInsights(state([], [])).engagementRate, null)
})

test('identity excludes standalone and ambiguous external IDs, keeps platforms separate and never title matches', () => {
  const d = computeInsights(state([item('a', '抖音', { externalId: 'external' }), item('b', '快手'), item('c', '抖音', { externalId: 'ambiguous' }), item('d', '抖音', { externalId: 'ambiguous' })], [
    metric('a', 10), metric('a', 20, { platform: '快手' }), metric(null, 999, { title: 'Work b' }),
    metric(null, 3, { externalId: 'external' }), metric(null, 888, { externalId: 'ambiguous' }),
  ]))
  assert.equal(d.top.length, 2)
  assert.equal(d.coverage.uniqueWorks, 2)
  assert.equal(d.coverage.excludedRecords, 2)
  assert.ok(d.coverage.excludedReasons.some(r => r.reason === 'ambiguous externalId'))
  assert.equal(computeInsights(state([item('a')], [metric('a', 10), metric('a', 20, { platform: '快手' })]), { platform: '快手' }).views, 20)
})

test('timed and untimed ordering is deterministic but explicitly uncertain, with no inferred collection time', () => {
  const s = state([item('a')], [timed('08:00', 10), metric('a', 999, { date: '2030-01-01', id: 'legacy' })])
  const d = computeInsights(s)
  assert.equal(d.views, 10)
  assert.equal(d.top[0].orderUncertain, true)
  assert.equal(d.coverage.latestCollectedAtScope, 'known subset')
  assert.equal(d.coverage.unknownTimeRecords, 1)
  assert.deepEqual(computeInsights({ ...s, metrics: [...s.metrics].reverse() }), d)
})

test('daily contains only observed same-day increments, first baselines and cross-day gaps are null', () => {
  const d = computeInsights(state([item('a')], [
    timed('08:00', 1060), timed('08:01', 1063), timed('08:01', 1063),
    metric('a', 1070, { collectedAt: '2026-01-02T01:00:00Z' }),
    metric('a', 1080, { collectedAt: '2026-01-02T02:00:00Z' }),
    metric('a', 1100, { collectedAt: '2026-01-04T02:00:00Z' }),
  ]))
  assert.equal(d.views, 1100)
  assert.equal(d.daily.find(r => r.date === '2026-01-01').views, 3)
  assert.equal(d.daily.find(r => r.date === '2026-01-02').views, 10)
  assert.equal(d.daily.find(r => r.date === '2026-01-04').views, null)
  assert.ok(d.daily.every(r => r.partial === true))
  assert.equal(d.timeline.reasons['cross-day'], 2)
  assert.equal(d.timeline.intervals.filter(r => r.crossDay).length, 2)
  assert.ok(d.timeline.intervals.filter(r => r.crossDay).every(r => r.views !== null))
  assert.equal(d.timeline.reasons.baseline, 1)
})

test('missing, invalid, decreasing and equal-time conflicting counters break adjacent growth intervals', () => {
  const d = computeInsights(state([item('a')], [
    timed('08:00', 10), timed('09:00', null), timed('10:00', 30), timed('11:00', -1),
    timed('12:00', 50), timed('13:00', 40), timed('14:00', 42), timed('14:00', 43), timed('15:00', 45),
  ]))
  assert.equal(d.daily[0].views, null)
  assert.ok(d.timeline.reasons.missing > 0)
  assert.ok(d.timeline.reasons.invalid > 0)
  assert.ok(d.timeline.reasons.decrease > 0)
  assert.ok(d.timeline.reasons['equal-time-conflict'] > 0)
  assert.ok(d.top[0].warnings.includes('equal-time-conflict'))
})

test('a later unambiguous full snapshot restores completeness and rate eligibility after a historical conflict', () => {
  const interactions = { likes: 1, comments: 0, shares: 0, saves: 0 }
  const conflicted = state([item('a')], [timed('08:00', 10, interactions), timed('08:00', 11, interactions)])
  const before = computeInsights(conflicted)
  assert.equal(before.coverage.complete, 0)
  assert.equal(before.engagementRate, null)
  const d = computeInsights({ ...conflicted, metrics: [...conflicted.metrics, timed('09:00', 20, interactions)] })
  assert.equal(d.coverage.complete, 1)
  assert.equal(d.coverage.missingWorksCount, 0)
  assert.equal(d.rateCoverage.matchedWorks, 1)
  assert.equal(d.engagementRate, .05)
  assert.ok(d.top[0].warnings.includes('equal-time-conflict'))
  assert.equal(d.daily[0].views, null)
  assert.deepEqual(d.top[0].selectedConflictFields, [])
})

test('platform filtering retains exact external-ID cross-platform links within account scope only', () => {
  const s = state([item('a', '抖音', { accountId: 'account-a', externalId: 'shared' }), item('b', '抖音', { accountId: 'account-b', externalId: 'shared', title: 'SECRET B' })], [
    metric(null, 25, { accountId: 'account-a', externalId: 'shared', platform: '快手' }),
    metric(null, 999, { accountId: 'account-b', externalId: 'shared', platform: '快手' }),
  ])
  s.accounts = [{ id: 'account-a', platform: '抖音' }, { id: 'account-b', platform: '抖音' }]
  const all = computeInsights(s, { platform: '快手' })
  assert.equal(all.views, 1024)
  const scoped = computeInsights(scopeState(s, 'account-a'), { platform: '快手' })
  assert.equal(scoped.views, 25)
  assert.equal(scoped.coverage.excludedRecords, 0)
  assert.equal(scoped.top[0].id, 'a')
  assert.doesNotMatch(JSON.stringify(scoped), /SECRET/)
  const foreign = computeInsights({ ...s, items: s.items.filter(row => row.accountId === 'account-a'), metrics: s.metrics.filter(row => row.accountId === 'account-b') }, { platform: '快手' })
  assert.equal(foreign.views, null)
  assert.equal(foreign.coverage.excludedRecords, 1)
})

test('platform filtering cannot turn an ambiguous external ID into a unique identity by hiding another candidate', () => {
  const s = state([item('a', '抖音', { externalId: 'shared' }), item('b', '快手', { externalId: 'shared' })], [metric(null, 25, { externalId: 'shared', platform: '快手' })])
  assert.equal(computeInsights(s).views, null)
  const d = computeInsights(s, { platform: '快手' })
  assert.equal(d.views, null)
  assert.equal(d.coverage.excludedReasons[0].reason, 'ambiguous externalId')
})

test('legacy fetchedAt is only weak import-time provenance and never supplies daily collection instants', () => {
  const d = computeInsights(state([item('a')], [metric('a', 10, { fetchedAt: '2026-01-01T08:00:00Z' }), metric('a', 15, { fetchedAt: '2026-01-01T09:00:00Z' })]))
  assert.equal(d.views, 15)
  assert.deepEqual(d.daily, [])
  assert.equal(d.coverage.latestCollectedAt, null)
  assert.equal(d.coverage.unknownTimeRecords, 2)
  assert.equal(d.top[0].provenance.views.ordering, 'legacy-import-time')
  assert.equal(d.top[0].provenance.views.collectedAt, null)
  assert.ok(d.top[0].warnings.includes('legacy-import-time-only'))
})

test('public field provenance excludes internal snapshot fingerprints while retaining same-snapshot rate matching', () => {
  const d = computeInsights(state([item('a')], [timed('08:00', 20, { likes: 1, comments: 0, shares: 0, saves: 0 })]))
  assert.equal(d.engagementRate, .05)
  assert.doesNotMatch(JSON.stringify(d), /recordKey/)
  assert.equal(d.top[0].provenance.views.collectedAt, '2026-01-01T08:00:00.000Z')
})

test('future and invalid or unzoned collection dates do not enter the growth timeline', () => {
  const d = computeInsights(state([item('a')], [timed('08:00', 10), metric('a', 20, { collectedAt: '2999-01-01T00:00:00Z' }), metric('a', 30, { collectedAt: 'bad' }), metric('a', 40, { collectedAt: '2026-01-01T09:00:00' })]))
  assert.equal(d.daily[0].views, null)
  assert.equal(d.coverage.latestCollectedAt, '2026-01-01T08:00:00.000Z')
  assert.equal(d.timeline.reasons['future-timestamp'], 1)
  assert.equal(d.timeline.reasons['invalid-timestamp'], 2)
  assert.equal(d.coverage.unknownTimeRecords, 3)
})

test('large safe integer growth is accepted without an arbitrary cap', () => {
  const d = computeInsights(state([item('a')], [timed('08:00', 0), timed('09:00', 1_000_000_000_000)]))
  assert.equal(d.daily[0].views, 1_000_000_000_000)
})

test('arithmetic beyond exact numeric range is unknown with an explicit overflow reason, never rounded or zero', () => {
  const large = Number.MAX_SAFE_INTEGER
  const d = computeInsights(state([item('a'), item('b')], [timed('08:00', 0), timed('09:00', large), metric('b', 0, { collectedAt: '2026-01-01T08:00:00Z' }), metric('b', large, { collectedAt: '2026-01-01T09:00:00Z' })]))
  assert.equal(d.views, null)
  assert.ok((d.overflowFields ?? []).includes('views'))
  assert.equal(d.daily[0].views, null)
  assert.ok(d.timeline.reasons['aggregate-overflow'] > 0)
  const engagement = computeInsights(state([item('a')], [timed('08:00', 10, { likes: large, comments: large, shares: 0, saves: 0 })]))
  assert.equal(engagement.rateCoverage.matchedWorks, 0)
})

test('an overflowing interval interaction sum keeps its own day and timeline diagnostics after a later clean snapshot', () => {
  const zero = { likes: 0, comments: 0, shares: 0, saves: 0 }
  const d = computeInsights(state([item('a')], [
    timed('08:00', 0, zero),
    timed('09:00', 0, { ...zero, likes: Number.MAX_SAFE_INTEGER, comments: Number.MAX_SAFE_INTEGER }),
    metric('a', 10, { ...zero, likes: 1, collectedAt: '2026-01-02T10:00:00Z' }),
  ]))
  assert.deepEqual(d.overflowFields, [])
  assert.equal(d.engaged, 1)
  const interval = d.timeline.intervals[0]
  assert.equal(interval.engaged, null)
  assert.equal(interval.reasons.engaged, 'aggregate-overflow')
  assert.equal(d.daily[0].engaged, null)
  assert.ok(d.daily[0].overflowFields.includes('engaged'))
  assert.ok(d.timeline.reasons['aggregate-overflow'] > 0)
})

test('rule proposals use the same snapshot reducer and exclude unidentified rows', () => {
  const s = state([item('a'), item('b', '快手')], [metric('a', 100), metric('b', 120, { platform: '快手' })])
  for (let i = 0; i < 20; i++) s.metrics.push(metric('a', 100))
  s.metrics.push(metric(null, 9999999, { platform: '快手' }))
  assert.deepEqual(proposeRules(s), [])
})

test('publication-hour rules exclude invalid publication dates rather than inventing an hour', () => {
  const s = state([item('a', '抖音', { publishedAt: 'invalid' }), item('b', '抖音', { publishedAt: 'invalid' }), item('c', '抖音', { publishedAt: '2026-01-01T08:00:00Z' })], [metric('a', 1000), metric('b', 1000), metric('c', 10)])
  assert.deepEqual(proposeRules(s), [])
})

test('retained full counters do not claim a complete latest snapshot or mix a stale numerator into a new rate', () => {
  const d = computeInsights(state([item('a')], [timed('08:00', 100, { likes: 10, comments: 0, shares: 0, saves: 0 }), timed('09:00', 200)]))
  assert.equal(d.top[0].likes, 10)
  assert.equal(d.engagementRate, null)
  assert.equal(d.coverage.complete, 0)
  assert.equal(d.coverage.completeCounters, 1)
  assert.equal(d.coverage.missingWorksCount, 1)
  assert.deepEqual(d.coverage.missingWorks[0].retainedFields, fields.slice(1))
  assert.equal(d.coverage.missingWorks[0].latestCollectedAt, '2026-01-01T09:00:00.000Z')
})

test('collection timestamps accept explicitly zoned minute precision and missing followers stay unknown', () => {
  const s = state([], [])
  assert.deepEqual(applyOps(s, [{ op: 'add_metric', platform: '抖音', collectedAt: '2026-01-01T08:00+08:00', views: 0 }]).errors, [])
  assert.equal(s.metrics[0].collectedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(computeInsights(s).followers, null)
})

test('coverage counts missing published works separately from stream entries and dates only selected valid fields', () => {
  const d = computeInsights(state([item('a')], [
    timed('08:00', 10), timed('09:00', null),
    metric('a', 20, { platform: '快手', collectedAt: '2026-01-01T07:00:00Z' }),
    metric(null, 999, { collectedAt: '2026-01-01T12:00:00Z' }),
  ]))
  assert.equal(d.coverage.missingWorksCount, 1)
  assert.equal(d.coverage.missingEntriesCount, 2)
  assert.equal(d.coverage.missingWorks.length, 2)
  assert.equal(d.coverage.latestCollectedAt, '2026-01-01T08:00:00.000Z')
  assert.equal(d.top.find(row => row.platform === '抖音').latestCollectedAt, '2026-01-01T08:00:00.000Z')
  assert.equal(d.coverage.rawLatestCollectedAt, '2026-01-01T12:00:00.000Z')
  assert.equal(d.coverage.latestCollectedAtScope, 'known subset')
})

test('new metric operations preserve omissions and collection provenance; invalid counters and times reject atomically', () => {
  const s = state([item('a')], [])
  const result = applyOps(s, [{ op: 'add_metric', itemId: 'a', platform: '抖音', views: 0, source: 'manual', collectedAt: '2026-01-01T09:00:00+08:00' }])
  assert.deepEqual(result.errors, [])
  assert.equal(s.metrics[0].likes, undefined)
  assert.equal(s.metrics[0].semantics, 'cumulative')
  assert.equal(s.metrics[0].collectedAt, '2026-01-01T01:00:00.000Z')
  assert.equal(s.metrics[0].source, 'manual')
  assert.ok(s.metrics[0].recordedAt)
  for (const invalid of [-1, 1.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(applyOps(s, [{ op: 'add_metric', platform: '抖音', views: invalid }]).errors.length, 1)
  }
  for (const collectedAt of ['bad', '2026-01-01T00:00:00', '2026-02-30T00:00:00Z']) assert.equal(applyOps(s, [{ op: 'add_metric', platform: '抖音', collectedAt }]).errors.length, 1)
  assert.equal(s.metrics.length, 1)
})

test('saving a likes-only snapshot reports missing views clearly without template placeholders', () => {
  const s = state([], [])
  const result = applyOps(s, [{ op: 'add_metric', platform: '抖音', likes: 2 }])
  assert.deepEqual(result.errors, [])
  assert.doesNotMatch(result.receipts[0].text, /\{views\}|undefined|null/)
  assert.equal(s.metrics[0].views, undefined)
})

test('Monid stores immutable timed snapshots and deduplicates exact replay, preserving unknown fields', () => {
  const s = state([], [])
  const input = { account: { platform: '抖音', id: 'external', url: 'https://www.douyin.com/user/external' }, profile: {}, posts: [{ id: 'post', title: 'Post', publishedAt: '2025-01-01T00:00:00Z', views: 1060 }] }
  importPosts(s, { ...input, collectedAt: '2026-01-01T08:00:00Z', now: '2026-01-01T08:05:00Z' })
  const first = structuredClone(s.metrics[0])
  importPosts(s, { ...input, collectedAt: '2026-01-01T08:00:00Z', now: '2026-01-01T08:06:00Z' })
  assert.equal(s.metrics.length, 1)
  importPosts(s, { ...input, posts: [{ ...input.posts[0], views: 1063 }], collectedAt: '2026-01-01T09:00:00Z', now: '2026-01-01T09:05:00Z' })
  assert.equal(s.metrics.length, 2)
  assert.deepEqual(s.metrics[0], first)
  assert.equal(s.metrics[1].collectedAt, '2026-01-01T09:00:00Z')
  assert.equal(s.metrics[1].semantics, 'cumulative')
  assert.equal(s.metrics[1].source, 'monid')
  assert.equal(s.metrics[1].likes, null)
  assert.equal(computeInsights(s).views, 1063)
  const normalized = normalizePosts('抖音', { status_code: 0, aweme_list: [{ aweme_id: '1', statistics: { play_count: 0, digg_count: -1 } }] })[0]
  assert.equal(normalized.views, 0)
  assert.equal(normalized.likes, null)
  assert.equal(normalized.comments, null)
})

test('import save time never backfills collection time and unknown publication time stays unknown', () => {
  const s = state([], [])
  const posts = normalizePosts('抖音', { status_code: 0, aweme_list: [{ aweme_id: '1', statistics: { play_count: 10 } }] })
  assert.equal(posts[0].publishedAt, null)
  const x = normalizePosts('X', { timeline: [{ tweet_id: '1', text: 'Post', created_at: 'invalid' }] })
  assert.equal(x[0].publishedAt, null)
  importPosts(s, { account: { platform: '抖音', id: 'external' }, profile: {}, posts, now: '2026-01-02T00:10:00Z' })
  assert.equal(s.metrics[0].collectedAt, null)
  assert.equal(s.metrics[0].recordedAt, '2026-01-02T00:10:00Z')
  assert.equal(s.items[0].publishedAt, null)
  assert.equal(s.items[0].createdAt, '2026-01-02T00:10:00Z')
  assert.equal(computeInsights(s).coverage.latestCollectedAt, null)
})

test('Host carries the posts response observation across midnight while profile, cover preparation and saving finish later', async t => {
  const { importAccountRoute } = await import('../src/host.js')
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T23:59:00Z') })
  const s = state([], [])
  let reads = 0
  const store = {
    filesDir: '/unused-test-covers',
    read: async () => { reads++; if (reads === 2) t.mock.timers.setTime(Date.parse('2026-01-02T00:05:00Z')); return s },
    mutate: async (label, fn) => { t.mock.timers.setTime(Date.parse('2026-01-02T00:10:00Z')); return fn(s) },
  }
  const desk = { importing: false, monid: async args => {
    if (args.includes('/api/v1/douyin/app/v3/fetch_user_post_videos')) {
      t.mock.timers.setTime(Date.parse('2026-01-01T23:59:59Z'))
      return { status: 'COMPLETED', output: { status_code: 0, aweme_list: [{ aweme_id: '1', desc: 'Short post', statistics: { play_count: 10 } }] } }
    }
    t.mock.timers.setTime(Date.parse('2026-01-02T00:01:00Z'))
    return { status: 'COMPLETED', output: { user: { nickname: 'Profile', follower_count: 0 } } }
  } }
  await importAccountRoute({}, store, desk, { text: 'https://www.douyin.com/user/MS4wLjABAAAAabcdefghijklmnopqrstuvwxyz' })
  assert.equal(s.metrics[0].collectedAt, '2026-01-01T23:59:59.000Z')
  assert.equal(s.metrics[0].recordedAt, '2026-01-02T00:10:00.000Z')
  assert.equal(s.metrics[0].collectionTimeBasis, 'local-response-observed')
  assert.equal(s.accounts[0].followers, 0)
  assert.equal(desk.importing, false)
})

test('Monid retains measured zero followers and preserves absent followers as unknown', () => {
  const s = state([], [])
  const input = { account: { platform: '抖音', id: 'external', url: 'https://www.douyin.com/user/external' }, profile: { followers: 0 }, posts: [], now: '2026-01-01T08:00:00Z' }
  importPosts(s, input)
  assert.equal(s.accounts[0].followers, 0)
  assert.equal(computeInsights(s).followers, 0)
  importPosts(s, { ...input, profile: {} })
  assert.equal(s.accounts[0].followers, null)
})
