// 输入框的提及规则；不依赖 React，便于单独验证光标、替换和数量边界。
export const DEFAULT_MAX_MENTIONS = 8

export function mentionToken(text, caret, selectionEnd = caret) {
  if (caret !== selectionEnd || !Number.isInteger(caret) || caret < 0 || caret > text.length) return null
  const match = text.slice(0, caret).match(/(^|[\s(（,，])([@/])([^\s@/()（）]{0,80})$/u)
  if (!match) return null
  const start = caret - match[2].length - match[3].length
  const suffix = text.slice(caret).match(/^[^\s@/()（）]*/u)[0]
  const end = caret + suffix.length
  return { start, end, caret, trigger: match[2], query: text.slice(start + 1, end), token: text.slice(start, end), index: 0 }
}

/** 只替换打开候选时的 token，不能用后来移动到的光标作为删除终点。 */
export function removeMentionToken(text, token) {
  if (!token || text.slice(token.start, token.end) !== token.token) return null
  const before = text.slice(0, token.start)
  const after = text.slice(token.end)
  const gap = before && after && !/\s$/u.test(before) && !/^\s/u.test(after) ? ' ' : ''
  return { text: before + gap + after, caret: (before + gap).length }
}

export function mentionOptions(catalog, picker, picked = []) {
  if (!picker) return []
  const query = picker.query.toLocaleLowerCase()
  const selected = new Set(picked.map(row => row.id))
  const pool = picker.trigger === '@' ? catalog.contexts : catalog.commands
  return (pool || []).filter(row => !selected.has(row.id) && (!query || [row.name, row.hint, row.group].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))).slice(0, 40)
}

export function mentionLimit(catalog) {
  const value = catalog?.limits?.maxMentions
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_MENTIONS
}

export function addMention(picked, option, trigger, max = DEFAULT_MAX_MENTIONS) {
  if (picked.some(row => row.id === option.id)) return { picked, error: 'duplicate' }
  if (picked.length >= max) return { picked, error: 'limit' }
  return { picked: [...picked, { id: option.id, label: option.name || option.id, trigger }], error: null }
}

/** 没有额外正文时，命令和引用本身也构成一条可读、可持久化的消息。 */
export function mentionMessage(text, picked = []) {
  return String(text || '').trim() || picked.map(row => `${row.trigger || '@'}${row.label || row.name || row.id}`).join(' ')
}

export function isComposing(event, composing = false) {
  return composing || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229
}
