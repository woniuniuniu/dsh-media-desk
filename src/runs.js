// 后台运行记录里的两个小工具：日期和提示。单独成文件，避免 worker 与 learn 互相引用。
import { safeText } from './inbox.js'
import { newId } from './ops.js'

/** 允许的时钟偏差：交换文件里的时间比现在晚不超过这个数就当作正常。 */
export const SKEW_MS = 5 * 60 * 1000
const MAX_NOTICES = 50
const MAX_NOTICE_CHARS = 200

const pad = n => String(n).padStart(2, '0')

/** 本地日，形如 '2026-11-12'。 */
export const localDay = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** 在 state.runs.notices 末尾追加一条提示（截到 200 字）；与上一条相同则不重复，最多留 50 条。 */
export function addNotice(state, raw, now) {
  const text = safeText(raw, MAX_NOTICE_CHARS)
  const notices = state.runs.notices
  if (notices.at(-1)?.text === text) return
  notices.push({ id: newId('n'), at: now.toISOString(), text })
  if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES)
}
