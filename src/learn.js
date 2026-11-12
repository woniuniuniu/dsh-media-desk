// 从负责人的真实修改里提出写作规则建议（永不自动生效），并在内容攒够后提醒他提炼自己的风格。
import { extractJson, rulePrompts } from './ai.js'
import { tr } from './i18n.js'
import { safeText } from './inbox.js'
import { editPairs } from './match.js'
import { newId } from './ops.js'
import { normalizeStyle, stylePrompts } from './style.js'
import { addNotice, localDay } from './worker.js'

const MIN_PAIRS = 5
const NEW_PAIRS = 5
const MAX_PROPOSALS = 10
const OWN_VOICE_POSTS = 30
const OWN_VOICE_MIN = 10
const OWN_VOICE_SAMPLES = 40
const count = text => Array.from(String(text ?? '').trim()).length

function median(values) {
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** 实发字数相对 AI 草稿明显变短或变长时，给出一条长度规则建议（不含 id 和时间）。 */
export function lengthProposal(pairs) {
  const posts = pairs.filter(p => p.kind === 'post' && count(p.aiText) > 0)
  if (posts.length < MIN_PAIRS) return null
  const ratio = median(posts.map(p => count(p.sentText) / count(p.aiText)))
  const n = Math.ceil(median(posts.map(p => count(p.sentText))) / 10) * 10
  const evidence = `${posts.length} 条改稿里，实发字数约为草稿的 ${Math.round(ratio * 100)}%`
  if (ratio < 0.8) return { name: '写短一点', rule: `正文控制在 ${n} 个字以内`, evidence, source: 'length' }
  if (ratio > 1.25) return { name: '可以写长一点', rule: `正文可以写到 ${n} 个字左右`, evidence, source: 'length' }
  return null
}

const clip = (value, max) => safeText(typeof value === 'string' ? value.trim() : '', max)

/** 让模型从最近的改稿里找反复出现的习惯；样本不足、模型失败或输出无法解析都返回 []。 */
export async function proposeFromEdits({ callText }, pairs) {
  if (pairs.length < MIN_PAIRS) return []
  try {
    const { system, user } = rulePrompts(pairs.slice(-10))
    const { text } = await callText({ system, user, maxTokens: 1000, light: true })
    const raw = extractJson(text)
    if (!Array.isArray(raw)) return []
    const out = []
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const rule = clip(item.rule, 60)
      if (!rule) continue
      out.push({ name: clip(item.name, 12), rule, evidence: clip(item.evidence, 60), source: 'edits' })
      if (out.length === 3) break
    }
    return out
  } catch {
    return []
  }
}

/** 每天一次：提出规则建议（追加到 proposals，不写 rules），并在内容够多时提醒一次提炼自己的风格。 */
export async function learnDaily({ store, callText, now = () => new Date() }) {
  const at = now()
  const today = localDay(at)
  const state = await store.read()
  if (state.runs.lastLearnDay === today) return { proposals: 0 }
  const pairs = editPairs(state)
  let fresh = []
  let ran = false
  if (pairs.length - state.runs.learnedPairs >= NEW_PAIRS) {
    ran = true
    const found = [lengthProposal(pairs), ...await proposeFromEdits({ callText }, pairs)].filter(Boolean)
    const known = new Set([...state.rules, ...state.proposals].map(r => String(r.rule).trim()))
    for (const p of found) {
      const key = p.rule.trim()
      if (known.has(key)) continue
      known.add(key)
      fresh.push(p)
    }
  }
  return store.mutate('规则建议', s => {
    const stamp = at.toISOString()
    if (ran) {
      const known = new Set([...s.rules, ...s.proposals].map(r => String(r.rule).trim()))
      fresh = fresh.filter(p => !known.has(p.rule.trim()))
      s.proposals.push(...fresh.map(p => ({ id: newId('p'), ...p, createdAt: stamp })))
      if (s.proposals.length > MAX_PROPOSALS) s.proposals.splice(0, s.proposals.length - MAX_PROPOSALS)
      s.runs.learnedPairs = pairs.length
    }
    s.runs.lastLearnDay = today
    if (!s.runs.ownVoicePrompted && s.mine.filter(m => m.kind === 'post').length >= OWN_VOICE_POSTS) {
      addNotice(s, tr('你自己发出的内容已有 30 条，可以到风格页提炼你自己的核心风格了'), at)
      s.runs.ownVoicePrompted = true
    }
    return { proposals: fresh.length }
  }, { undoable: false })
}

/** 从自己最近发出的内容里提炼一张风格卡。只返回卡片，不保存。 */
export async function extractOwnVoice({ callText, state }) {
  const posts = state.mine.filter(m => m.kind === 'post' && String(m.text ?? '').trim())
  if (posts.length < OWN_VOICE_MIN) {
    throw Object.assign(new Error(tr('自己发出的内容还不够，再攒 {n} 条再来提炼', { n: OWN_VOICE_MIN - posts.length })), { status: 400 })
  }
  const recent = [...posts].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt)).slice(0, OWN_VOICE_SAMPLES)
  const { system, user } = stylePrompts(recent.map(m => safeText(m.text, 400)).join('\n\n'), '')
  const { text } = await callText({ system, user, maxTokens: 2000 })
  return normalizeStyle(extractJson(text))
}
