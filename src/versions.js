// Immutable, lossless creative snapshots. No runtime settings, provider replies or binary data.
import { createHash, randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import { hasActiveProduction } from './accounts.js'
import { tr } from './i18n.js'

export const CREATIVE_FIELDS = ['title', 'body', 'tags', 'kind', 'url', 'source', 'media', 'angleId', 'personaIds', 'drafts', 'production']
const text = { type: 'string' }
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] })
const list = items => ({ type: 'array', items })
const object = properties => ({ type: 'object', properties, additionalProperties: false })
const media = object({ src: { type: 'string', pattern: '^(media-desk/(assets|files)/[\\w.-]+$|https?://)' }, poster: text, w: { type: 'number' }, h: { type: 'number' } })
const asset = object({ ...media.properties, no: { type: 'number' }, seconds: { type: 'number' }, ...Object.fromEntries(['shot', 'visual', 'voice', 'caption', 'anchor', 'prompt', 'status'].map(k => [k, text])) })
const production = object({ ...Object.fromEntries(['title', 'article', 'format', 'coverText', 'characters'].map(k => [k, text])), withImages: { type: 'boolean' }, facts: list(text), outline: list(text), cover: nullable(asset), images: list(asset), shots: list(asset) })
const draft = object({ text, by: { enum: ['user', 'ai'] }, aiText: text, at: text })
const contentSchema = object({ title: text, body: text, tags: list(text), kind: { enum: ['image', 'video', 'web', 'quote', 'note'] }, url: nullable(text), source: text, media: nullable(media), angleId: nullable(text), personaIds: list(text), drafts: object({ article: draft, script: draft }), production: nullable(production) })
const validateContent = new Ajv({ strict: false }).compile(contentSchema)
const own = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, structuredClone(value[key])]))
const fail = message => Object.assign(new Error(tr(message)), { code: 'INVALID_ARGUMENT', status: 400 })
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const contentSha256 = content => createHash('sha256').update(canonical(content)).digest('hex')

export function creativeContent(item, { validate = true } = {}) {
  const content = own(item, CREATIVE_FIELDS.filter(k => !['drafts', 'production', 'media'].includes(k)))
  if (item.media !== undefined) content.media = item.media === null ? null : own(item.media, Object.keys(media.properties))
  if (item.drafts !== undefined) content.drafts = Object.fromEntries(['article', 'script'].filter(k => item.drafts[k]).map(k => [k, own(item.drafts[k], Object.keys(draft.properties))]))
  if (item.production !== undefined) {
    const p = item.production
    content.production = p === null ? null : own(p, Object.keys(production.properties).filter(k => !['cover', 'images', 'shots'].includes(k)))
    if (p) for (const key of ['cover', 'images', 'shots']) if (p[key] !== undefined) content.production[key] = Array.isArray(p[key]) ? p[key].map(a => own(a, Object.keys(asset.properties))) : p[key] === null ? null : own(p[key], Object.keys(asset.properties))
  }
  if (validate && !validateContent(content)) throw fail('Creative content has an invalid structure; nothing was saved.')
  return content
}
export const creativeFingerprint = item => contentSha256(creativeContent(item))
export function assertVersionIdle(item, isBusy = () => false) {
  if (hasActiveProduction(item) || item.production?.status === 'pending' || isBusy(item.id)) throw Object.assign(new Error(tr('请等待成稿和图片任务结束后再操作版本。')), { code: 'BUSY', status: 409 })
}
export function versionMetadata(version) {
  return own(version, ['id', 'number', 'name', 'createdAt', 'source', 'sha256'])
}
export function selectedVersion(item, versionId) {
  const version = item.contentVersions?.find(v => v.id === versionId)
  if (!version) throw fail('找不到这个历史版本。')
  if (!validateContent(version.content) || !/^[a-f0-9]{64}$/.test(version.sha256 ?? '') || contentSha256(version.content) !== version.sha256 || !Number.isSafeInteger(version.number) || version.number < 1 || !/^[0-9a-f-]{36}$/.test(version.id)) throw fail('历史版本校验失败，当前内容未更改。')
  return version
}
export function saveVersion(item, { name, source = 'manual', deduplicate = false } = {}) {
  if (name !== undefined && (typeof name !== 'string' || name.length > 80)) throw fail('版本名称最多 80 个字符。')
  const content = creativeContent(item), sha256 = contentSha256(content)
  const history = item.contentVersions ?? []
  if (!Array.isArray(history) || history.some(v => !Number.isSafeInteger(v.number) || v.number < 1)) throw fail('历史版本目录无效，当前内容未更改。')
  if (deduplicate && history.at(-1)?.sha256 === sha256) return selectedVersion(item, history.at(-1).id)
  const number = history.reduce((max, v) => Math.max(max, v.number), 0) + 1
  if (!Number.isSafeInteger(number)) throw fail('版本编号超出范围。')
  const version = { id: randomUUID(), number, name: name?.trim() ?? '', createdAt: new Date().toISOString(), source, sha256, content }
  item.contentVersions = [...history, version]
  return version
}
export function backupMeaningful(item, source) {
  const meaningful = item.title?.trim() || item.body?.trim() || item.media?.src || item.production?.article?.trim() || [item.production?.cover, ...item.production?.images ?? [], ...item.production?.shots ?? []].some(a => a?.src || a?.visual || a?.prompt) || Object.values(item.drafts ?? {}).some(d => d?.text?.trim())
  return meaningful ? saveVersion(item, { source, deduplicate: true }) : null
}
export function restoreVersion(item, versionId) {
  // Validate everything before archiving or mutating the working content.
  const content = structuredClone(selectedVersion(item, versionId).content)
  const backup = saveVersion(item, { source: 'before_restore' })
  for (const key of CREATIVE_FIELDS) { if (Object.hasOwn(content, key)) item[key] = content[key]; else delete item[key] }
  item.contentRevision = randomUUID()
  if (item.production) item.production = { ...item.production, generationId: randomUUID(), status: 'done', stage: 'done', finishedAt: new Date().toISOString() }
  return backup
}
