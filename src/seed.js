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
    runs: { lastComposeDay: null, lastComposeError: null, notices: [] },
  }
}

/** 旧版数据不迁移：不是第 2 版就直接从空状态开始。 */
export function migrateState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== 2) return emptyState()
  return { ...emptyState(), ...raw, runs: { ...emptyState().runs, ...(raw.runs ?? {}) }, voice: { ...emptyState().voice, ...(raw.voice ?? {}) } }
}
