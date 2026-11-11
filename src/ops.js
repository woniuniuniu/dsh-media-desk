// 工作台的唯一写入口：界面操作都走这里，统一校验字段并产出结果。
// 模型输出也是不可信输入，所以这里只放行白名单字段。
import { tr } from './i18n.js'
import { normalizeStyle } from './style.js'

const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const TIERS = ['engage', 'topic']
const RULE_STATUS = ['active', 'off']

let counter = 0
export function newId(prefix = 'x') {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

function cleanHandle(value) {
  const handle = String(value ?? '').trim().replace(/^@/, '')
  return HANDLE.test(handle) ? handle : null
}

const need = (list, id, what) => {
  const row = list.find(entry => entry.id === id)
  if (!row) throw new Error(tr('找不到{what}：{id}', { what, id: String(id) }))
  return row
}

const HANDLERS = {
  add_note(state, op) {
    const body = text(op.text, 4000)
    if (!body) throw new Error(tr('笔记内容不能为空'))
    let url = null
    if (op.url !== undefined && op.url !== null && op.url !== '') {
      url = text(op.url, 2000)
      if (!isHttpUrl(url)) throw new Error(tr('链接要以 http:// 或 https:// 开头'))
    }
    state.notes.push({ id: newId('n'), text: body, url, createdAt: new Date().toISOString(), used: false })
    return tr('已记下笔记')
  },
  delete_note(state, op) {
    need(state.notes, op.id, tr('笔记'))
    state.notes = state.notes.filter(row => row.id !== op.id)
    return tr('已删除笔记')
  },
  add_watch(state, op) {
    const handle = cleanHandle(op.handle)
    if (!handle) throw new Error(tr('账号名只能是 1 到 15 位字母、数字或下划线'))
    if (!TIERS.includes(op.tier)) throw new Error(tr('账号类型无效'))
    if (state.watch.some(row => row.handle.toLowerCase() === handle.toLowerCase())) throw new Error(tr('已经在关注列表里：{handle}', { handle }))
    state.watch.push({ id: newId('w'), handle, tier: op.tier, note: text(op.note, 200) })
    return tr('已加入关注：{handle}', { handle })
  },
  update_watch(state, op) {
    const row = need(state.watch, op.id, tr('关注账号'))
    if (op.tier !== undefined) {
      if (!TIERS.includes(op.tier)) throw new Error(tr('账号类型无效'))
      row.tier = op.tier
    }
    if (op.note !== undefined) row.note = text(op.note, 200)
    return tr('已更新关注：{handle}', { handle: row.handle })
  },
  delete_watch(state, op) {
    const row = need(state.watch, op.id, tr('关注账号'))
    state.watch = state.watch.filter(entry => entry.id !== op.id)
    return tr('已取消关注：{handle}', { handle: row.handle })
  },
  add_rule(state, op) {
    const name = text(op.name, 60)
    const rule = text(op.rule, 500)
    if (!name || !rule) throw new Error(tr('规则要有名字和内容'))
    state.rules.push({ id: newId('r'), name, rule, status: 'active', evidence: text(op.evidence, 300) })
    return tr('已添加规则：{name}', { name })
  },
  update_rule(state, op) {
    const row = need(state.rules, op.id, tr('规则'))
    if (op.name !== undefined) {
      const name = text(op.name, 60)
      if (!name) throw new Error(tr('规则要有名字和内容'))
      row.name = name
    }
    if (op.rule !== undefined) {
      const rule = text(op.rule, 500)
      if (!rule) throw new Error(tr('规则要有名字和内容'))
      row.rule = rule
    }
    if (op.status !== undefined) {
      if (!RULE_STATUS.includes(op.status)) throw new Error(tr('规则状态无效'))
      row.status = op.status
    }
    return tr('已更新规则：{name}', { name: row.name })
  },
  delete_rule(state, op) {
    const row = need(state.rules, op.id, tr('规则'))
    state.rules = state.rules.filter(entry => entry.id !== op.id)
    return tr('已删除规则：{name}', { name: row.name })
  },
  set_core(state, op) {
    if (op.source !== 'card') throw new Error(tr('核心风格只能用风格卡设置'))
    const card = normalizeStyle(op.card)
    state.voice.core = { id: 'core', name: card.name, source: 'card', card, skillText: null, condensed: null, updatedAt: new Date().toISOString() }
    return tr('已设置核心风格：{name}', { name: card.name })
  },
  clear_core(state) {
    state.voice.core = null
    return tr('已清除核心风格')
  },
  add_type(state, op) {
    const name = text(op.name, 20)
    if (!name) throw new Error(tr('类型要有名字'))
    state.voice.types.push({ id: newId('t'), name, source: 'card', card: normalizeStyle(op.card, name), skillText: null, condensed: null, updatedAt: new Date().toISOString() })
    return tr('已添加类型：{name}', { name })
  },
  update_type(state, op) {
    const row = need(state.voice.types, op.id, tr('内容类型'))
    if (op.name !== undefined) {
      const name = text(op.name, 20)
      if (!name) throw new Error(tr('类型要有名字'))
      row.name = name
    }
    if (op.card !== undefined) {
      row.card = normalizeStyle(op.card, row.name)
      row.source = 'card'
      row.skillText = null
      row.condensed = null
    }
    row.updatedAt = new Date().toISOString()
    return tr('已更新类型：{name}', { name: row.name })
  },
  delete_type(state, op) {
    const row = need(state.voice.types, op.id, tr('内容类型'))
    if (state.voice.types.length <= 1) throw new Error(tr('至少保留一个内容类型'))
    state.voice.types = state.voice.types.filter(entry => entry.id !== op.id)
    return tr('已删除类型：{name}', { name: row.name })
  },
}

/**
 * 逐条执行操作。某一条失败不影响其他条。
 * @param {object} state - 就地修改的状态。
 * @param {object[]} ops - 操作列表。
 * @returns {{applied: string[], errors: string[]}} 成功的说明和失败的原因。
 */
export function applyOps(state, ops) {
  const applied = []
  const errors = []
  if (!Array.isArray(ops)) return { applied, errors: [tr('操作列表无效')] }
  for (const op of ops) {
    const handler = op && typeof op === 'object' && Object.hasOwn(HANDLERS, op.op) ? HANDLERS[op.op] : null
    if (!handler) {
      errors.push(tr('不认识的操作：{op}', { op: String(op?.op) }))
      continue
    }
    try {
      applied.push(handler(state, op))
    } catch (err) {
      errors.push(err.message)
    }
  }
  return { applied, errors }
}
