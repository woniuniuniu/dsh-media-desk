// 状态的形状。第 2 版起从空白开始，不带示例数据。
import { defaultTypes } from './voice.js'

/** 第 2 版的空状态。 */
export function emptyState() {
  return {
    version: 2,
    watch: [],
    posts: [],
    notes: [],
    candidates: [],
    voice: { core: null, types: defaultTypes() },
    rules: [],
    mine: [],
    replyDrafts: [],
    followers: [], // {day:'YYYY-MM-DD', count, at}：每天一条，at 是该值的读取时间（用来判断同一天哪个更晚）
    proposals: [],
    dismissedRules: [],
    longforms: [],
    runs: {
      lastComposeDay: null,
      lastComposeError: null,
      lastComposeAt: null,
      lastComposeOutcome: null,
      notices: [],
      imagesDay: null,
      imagesCount: 0,
      lastLearnDay: null,
      learnedPairs: 0,
      ownVoicePrompted: false,
      lastLongformWeek: null,
    },
  }
}

/** 旧版数据不迁移：不是第 2 版就直接从空状态开始。 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 2) return emptyState()
  const base = emptyState()
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map(c => (c && typeof c === 'object' ? { sentText: null, sentPostId: null, sentAt: null, ...c } : c))
    : raw.candidates
  return { ...base, ...raw, candidates, runs: { ...base.runs, ...(raw.runs ?? {}) }, voice: { ...base.voice, ...(raw.voice ?? {}) } }
}
