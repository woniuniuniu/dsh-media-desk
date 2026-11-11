// 模型调用与提示词。用的是 DeepSeek Harness 当前默认模型，不单独配置密钥。
// 模型不可用时一律显式降级：engine 字段告诉界面这次结果来自哪里。
import { tr } from './i18n.js'
import { randomUUID } from 'node:crypto'

/**
 * 插件在会话之外调模型，自己带一个会话标识。有些网关（如 opencode-go）按会话路由，
 * 缺了 x-opencode-session 头会直接返回 400 MissingSessionID；DSH 会把 sessionId 映射成这类头。
 */
export const PLUGIN_SESSION_ID = `dsh-x-desk-${randomUUID()}`

/** 最近一次模型调用的结果。选了模型不等于能用，比如还没配密钥。 */
export const modelStatus = { ok: null, error: null }

// 工作台里用户自己指定的助手模型；null 表示跟随 DeepSeek Harness 默认模型
let assistantOverride = null

export function setAssistantModel(sel) {
  assistantOverride = sel?.provider && sel?.model ? { provider: sel.provider, model: sel.model } : null
}

export function assistantModelOverride() {
  return assistantOverride
}

export function defaultSelection(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null
  } catch {
    return null
  }
}

export function modelInfo(ctx) {
  if (!ctx.get('llm')) return null
  const route = assistantOverride ?? defaultSelection(ctx)
  if (!route) return null
  return { provider: route.provider, model: route.model, label: route.model }
}

/**
 * 调一次模型并流式回传文本。
 * @param {object} ctx - Cordis 上下文。
 * @param {{system: string, user: string, maxTokens?: number, signal?: AbortSignal, onText?: (delta: string) => void, light?: boolean, sessionId?: string}} request - 请求。
 * @returns {Promise<{text: string, model: string}>} 完整文本与模型名。
 */
export async function callModel(ctx, { system, user, maxTokens = 4000, signal, onText, light = false, sessionId = PLUGIN_SESSION_ID }) {
  const info = modelInfo(ctx)
  if (!info) throw new Error(tr('当前没有可用模型'))
  const llm = ctx.get('llm')
  try {
    const call = await llm.prepareCall(
      { provider: info.provider, model: info.model, maxTokens },
      signal,
      (controls, model) => {
        const effort = light ? model.reasoning?.efforts?.[0]?.id : undefined
        return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      },
    )
    let text = ''
    for await (const chunk of call.stream({
      ...call.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-x-desk' } }],
      sessionId,
      signal,
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        onText?.(chunk.text)
      } else if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        throw new Error(chunk.reason.failure?.message || tr('模型调用失败'))
      }
    }
    modelStatus.ok = true
    modelStatus.error = null
    return { text, model: info.label }
  } catch (err) {
    modelStatus.ok = false
    modelStatus.error = err.message
    throw err
  }
}

/** 从模型输出里取出 JSON，容忍外面包了代码块或前后有说明文字。 */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[{[]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error(tr('模型没有返回 JSON'))
  return JSON.parse(body.slice(start, end + 1))
}
