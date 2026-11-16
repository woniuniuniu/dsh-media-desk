// Explicit references for the assistant. Resolving references only reads local data.
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { byLang } from './i18n.js'
import { computeInsights } from './learn.js'
import { productionFor } from './workflow.js'

const MAX_MENTIONS = 8
const MAX_TEXT = 12000
const MAX_TOTAL = 32000
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KEY = /^[\w.-]{1,200}$/
const AGGREGATES = new Set(['insights', 'schedule', 'drafts', 'rules', 'accounts'])

const COMMANDS = [
  { id: 'cmd:produce', name: ['成稿', 'Produce'], hint: ['撰写文章或生成视频脚本和画面', 'Write an article or produce a video script and visuals'], prompt: '用户选择「成稿」：文章条目使用 actions: open 打开正文编辑器；可直接输入写作要求并用 @ 引用素材，无观点或提纲确认关卡。视频条目使用 actions: produce。不要把正文塞进 reply。' },
  { id: 'cmd:schedule', name: ['排期', 'Schedule'], hint: ['安排内容的时间和平台', 'Schedule content on a platform'], prompt: '用户选择「排期」：使用 schedule_item；时间或平台不明确时先询问。' },
  { id: 'cmd:insights', name: ['复盘', 'Review'], hint: ['附带统计，区分真实与示例', 'Review attached real and sample statistics'], prompt: '用户选择「复盘」：依据附带的统计先说明真实/示例样本构成；真实已发布或真实指标为 0 时，不给平均阅读量、爆款率、最佳发布时间等真实效果结论。' },
  { id: 'cmd:rules', name: ['提炼规则', 'Propose rules'], hint: ['从真实成稿修改痕迹提出规则', 'Propose rules from actual draft edits'], prompt: '用户选择「提炼规则」：只基于附带的真实草稿修改依据提出待确认规则，说明依据，不直接生效；没有修改依据时明确说明，不拿示例数据或已有规则充当依据。' },
  { id: 'cmd:style', name: ['切换风格', 'Change style'], hint: ['列出可用风格并选择', 'List available writing styles'], prompt: '用户选择「切换风格」：列出当前激活风格及可用风格，等待用户选择后再 set_style。' },
  { id: 'cmd:export', name: ['导出', 'Export'], hint: ['说明可导出的内容和入口', 'Explain available exports'], prompt: '用户选择「导出」：说明可导出的内容和工作台导出入口，不声称已经导出，不编造路径。' },
]
const COMMAND_IDS = new Set(COMMANDS.map(row => row.id))

function clip(value, max = MAX_TEXT) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  const suffix = '\n…（已截断 / truncated）'
  return max <= suffix.length ? suffix.slice(0, max) : text.slice(0, max - suffix.length) + suffix
}

function validId(id) {
  if (typeof id !== 'string' || id.length > 220) return false
  const split = id.indexOf(':')
  if (split < 1) return false
  const kind = id.slice(0, split), key = id.slice(split + 1)
  if (kind === 'cmd') return COMMAND_IDS.has(id)
  if (kind === 'agg') return AGGREGATES.has(key)
  if (kind === 'dsh-skill') return key.length <= 100 && SKILL_NAME.test(key)
  if (!['item', 'style', 'skill', 'account', 'file'].includes(kind)) return false
  return KEY.test(key) && key !== '.' && key !== '..'
}

/** Keep only safe, serializable reference IDs and short display labels. */
export function normalizeMentions(mentions) {
  if (!Array.isArray(mentions)) return []
  const result = [], seen = new Set()
  for (const entry of mentions) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (!validId(id) || seen.has(id)) continue
    seen.add(id)
    const label = typeof entry?.label === 'string'
      ? entry.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : id
    const trigger = entry?.trigger === '@' || entry?.trigger === '/' ? entry.trigger : undefined
    result.push({ id, label: label || id, ...(trigger ? { trigger } : {}) })
    if (result.length === MAX_MENTIONS) break
  }
  return result
}

function inside(root, file) {
  const path = relative(root, file)
  return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

async function skillRoot(home) {
  try { return await realpath(join(home, 'skills')) } catch { return null }
}

// Both directories and flat .md skills are supported; links outside the skill root are not.
async function readSkill(root, name) {
  if (!root || !SKILL_NAME.test(name)) return null
  for (const candidate of [join(root, name, 'SKILL.md'), join(root, `${name}.md`)]) {
    let file
    try {
      file = await realpath(candidate)
      if (!inside(root, file) || !(await stat(file)).isFile()) continue
      const handle = await open(file, 'r')
      try {
        const buffer = Buffer.alloc(64 * 1024)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        return clip(buffer.subarray(0, bytesRead).toString('utf8'), 10000)
      } finally { await handle.close() }
    } catch { /* Missing or unreadable skills are not references. */ }
  }
  return null
}

async function listSkills(home) {
  const root = await skillRoot(home)
  if (!root) return []
  const result = [], seen = new Set()
  let entries
  try { entries = await readdir(root) } catch { return [] }
  for (const entry of entries.sort()) {
    const name = entry.endsWith('.md') ? entry.slice(0, -3) : entry
    if (!SKILL_NAME.test(name) || name.length > 100 || seen.has(name)) continue
    seen.add(name)
    const text = await readSkill(root, name)
    if (text === null) continue
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    const description = frontmatter?.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || ''
    result.push({ name, description: clip(description, 160) })
  }
  return result
}

/** Candidates are refreshed from the current state; account IDs remain stable after deletion. */
export async function listMentions(state, home) {
  const contexts = [
    { id: 'agg:insights', name: byLang('真实复盘数据', 'Performance data'), group: byLang('汇总', 'Summary'), hint: byLang('统计及真实/示例样本构成', 'Statistics and real/sample composition') },
    { id: 'agg:schedule', name: byLang('全部排期', 'All schedules'), group: byLang('汇总', 'Summary') },
    { id: 'agg:drafts', name: byLang('全部成稿', 'All drafts'), group: byLang('汇总', 'Summary'), hint: byLang('长内容会明确标注截断', 'Long content is marked when truncated') },
    { id: 'agg:rules', name: byLang('全部写作规则', 'All writing rules'), group: byLang('汇总', 'Summary') },
    { id: 'agg:accounts', name: byLang('账号档案', 'Accounts'), group: byLang('汇总', 'Summary') },
  ]
  const items = [...(state.items || [])].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
  for (const it of items) contexts.push({ id: `item:${it.id}`, name: it.title || byLang('(无标题)', '(Untitled)'), group: byLang(it.sample ? '示例内容' : '内容', it.sample ? 'Sample content' : 'Content'), hint: [it.status, it.platform].filter(Boolean).join(' · '), sample: Boolean(it.sample) })
  for (const style of state.styles || []) contexts.push({ id: `style:${style.id}`, name: style.name || style.id, group: byLang('风格', 'Style'), hint: clip(style.summary || style.category || '', 160), sample: Boolean(style.sample) })
  for (const rule of state.skills || []) contexts.push({ id: `skill:${rule.id}`, name: rule.name || rule.id, group: byLang('写作规则', 'Writing rule'), hint: clip(rule.rule || '', 160), sample: Boolean(rule.sample) })
  for (const account of state.accounts || []) contexts.push({ id: `account:${account.id}`, name: `${account.platform || ''} ${account.handle || account.title || account.id}`.trim(), group: byLang('账号', 'Account'), sample: Boolean(account.sample) })
  try {
    const root = await realpath(join(home, 'media-desk', 'files'))
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !validId(`file:${entry.name}`)) continue
      contexts.push({ id: `file:${entry.name}`, name: entry.name, group: byLang('上传文件', 'Uploaded file'), hint: byLang('仅文件信息，不会读取图片或视频内容', 'File metadata only; no image/video analysis') })
    }
  } catch { /* Uploads may not exist yet. */ }
  const skills = await listSkills(home)
  for (const skill of skills) contexts.push({ id: `dsh-skill:${skill.name}`, name: skill.name, group: 'DSH Skill', hint: skill.description })
  const commands = COMMANDS.map(command => ({ id: command.id, name: byLang(...command.name), hint: byLang(...command.hint), group: byLang('指令', 'Command') }))
  commands.push(...skills.map(skill => ({ id: `dsh-skill:${skill.name}`, name: skill.name, group: 'DSH Skill', hint: skill.description })))
  return { contexts: contexts.filter(row => validId(row.id)), commands, limits: { maxMentions: MAX_MENTIONS, maxChars: MAX_TOTAL } }
}

function insightData(state) {
  const metrics = state.metrics || [], published = (state.items || []).filter(row => row.status === 'published')
  return { sampleCounts: { metrics: { real: metrics.filter(row => !row.sample).length, sample: metrics.filter(row => row.sample).length }, published: { real: published.filter(row => !row.sample).length, sample: published.filter(row => row.sample).length } }, statistics: computeInsights(state) }
}

function editEvidence(state) {
  const rows = []
  for (const item of state.items || []) {
    if (item.sample) continue
    const candidates = [{ format: 'production', before: item.production?.aiArticle, after: item.production?.article }, ...['article', 'script'].filter(format => item.drafts?.[format]?.by === 'user').map(format => ({ format, before: item.drafts[format].aiText, after: item.drafts[format].text }))]
    for (const row of candidates) {
      if (typeof row.before !== 'string' || typeof row.after !== 'string' || !row.before || row.before === row.after) continue
      rows.push({ id: item.id, title: clip(item.title, 160), format: row.format, before: clip(row.before, 2000), after: clip(row.after, 2000) })
      if (rows.length === 20) return rows
    }
  }
  return rows
}

// Escape delimiters so source text cannot close <context> or impersonate its envelope.
const encoded = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

function fitContext(envelope) {
  const fields = [...envelope.materials.map(row => [row, 'content']), ...envelope.instructions.map(row => [row, 'text'])]
  const original = fields.map(([row, key]) => row[key])
  for (const [row, key] of fields) row[key] = ''
  const allowance = Math.max(0, Math.floor((MAX_TOTAL - encoded(envelope).length) / Math.max(1, fields.length)))
  fields.forEach(([row, key], index) => {
    const text = original[index]
    let low = 0, high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (encoded(clip(text, middle)).length - 2 <= allowance) low = middle
      else high = middle - 1
    }
    row[key] = clip(text, low)
  })
  return encoded(envelope)
}

/** The envelope separates trusted built-in commands, explicitly selected skills, and data. */
export async function resolveMentions(state, mentions, home) {
  const picked = normalizeMentions(mentions)
  if (!picked.length) return ''
  const envelope = { commands: [], instructions: [], materials: [] }
  const addMaterial = (entry, kind, data) => envelope.materials.push({ id: entry.id, label: entry.label, kind, content: clip(typeof data === 'string' ? data : JSON.stringify(data)) })
  const items = state.items || []
  for (const entry of picked) {
    const split = entry.id.indexOf(':'), kind = entry.id.slice(0, split), key = entry.id.slice(split + 1)
    if (kind === 'cmd') {
      const command = COMMANDS.find(row => row.id === entry.id)
      envelope.commands.push({ id: command.id, name: byLang(...command.name), prompt: command.prompt })
      if (key === 'insights') addMaterial(entry, 'insights', insightData(state))
      if (key === 'rules') addMaterial(entry, 'edit-evidence', { edits: editEvidence(state) })
    } else if (kind === 'dsh-skill') {
      const text = await readSkill(await skillRoot(home), key)
      if (text !== null) envelope.instructions.push({ id: entry.id, name: key, text })
    } else if (kind === 'item') {
      const item = items.find(row => row.id === key)
      if (item) addMaterial(entry, kind, { id: item.id, title: clip(item.title, 160), body: clip(item.body, 6000), status: item.status, platform: item.platform, scheduledAt: item.scheduledAt, tags: item.tags, sample: Boolean(item.sample), article: clip(productionFor(item, 'article')?.article, 6000), script: clip(productionFor(item, 'script')?.article, 3000), media: item.media, url: item.url })
    } else if (kind === 'style' || kind === 'skill' || kind === 'account') {
      const rows = kind === 'style' ? state.styles : kind === 'skill' ? state.skills : state.accounts
      const row = (rows || []).find(value => String(value.id) === key)
      if (row) addMaterial(entry, kind, row)
    } else if (kind === 'file') {
      try {
        const root = await realpath(join(home, 'media-desk', 'files')), file = await realpath(join(root, key))
        if (!inside(root, file)) continue
        const info = await stat(file)
        if (info.isFile()) addMaterial(entry, 'file-metadata', { name: key, size: info.size, modifiedAt: info.mtime.toISOString(), contentAvailable: false })
      } catch { /* A deleted file is no longer a reference. */ }
    } else if (kind === 'agg') {
      if (key === 'insights') addMaterial(entry, key, insightData(state))
      if (key === 'schedule') addMaterial(entry, key, items.filter(row => row.scheduledAt).map(row => ({ id: row.id, title: row.title, status: row.status, platform: row.platform, scheduledAt: row.scheduledAt, sample: Boolean(row.sample) })))
      if (key === 'drafts') addMaterial(entry, key, items.filter(row => productionFor(row, 'article')?.article || productionFor(row, 'script')?.article).map(row => ({ id: row.id, title: row.title, sample: Boolean(row.sample), article: clip(productionFor(row, 'article')?.article, 6000), script: clip(productionFor(row, 'script')?.article, 3000) })))
      if (key === 'rules') addMaterial(entry, key, state.skills || [])
      if (key === 'accounts') addMaterial(entry, key, state.accounts || [])
    }
  }
  if (!envelope.commands.length && !envelope.instructions.length && !envelope.materials.length) return ''
  return fitContext(envelope)
}
