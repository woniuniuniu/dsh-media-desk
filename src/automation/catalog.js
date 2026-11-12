// One catalog for the Host dispatcher, CLI discovery and MCP schemas.
import { AVATAR_LOCAL_PATTERN, AVATAR_MAX_LENGTH } from '../avatar.js'
import { labReadSchema, labActionSchema } from '../content-lab/schemas.js'
import { PLATFORMS } from '../platforms.js'
export const PROTOCOL_VERSION = 1
export const PLUGIN_VERSION = '2.7.0-accounts.4'
const str = (maxLength = 40000) => ({ type: 'string', maxLength })
const id = { type: 'string', minLength: 1, maxLength: 200 }
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] })
const strings = { type: 'array', items: str(4000), maxItems: 24 }
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const status = { enum: ['idea', 'outline', 'draft', 'ready', 'published'] }
const platform = nullable({ enum: PLATFORMS })
const number = { type: 'number' }
const localSrc = { type: 'string', pattern: '^media-desk/(assets|files)/[\\w.-]+$', maxLength: 200 }
const accountId = nullable(id)
const format = { enum: ['script', 'article'] }
const itemFields = { accountId, title: str(), body: str(), kind: { enum: ['image', 'video', 'web', 'quote', 'note'] }, url: nullable({ type: 'string', pattern: '^https?://', maxLength: 4000 }), source: str(), tags: strings, status, angleId: nullable(id), personaIds: strings, parentId: nullable(id), rel: str(), scheduledAt: nullable(str(50)), platform, pinned: { type: 'boolean' }, score: number, media: nullable(object({ src: localSrc, poster: localSrc, w: number, h: number }, ['src'])), pos: object({ x: number, y: number, r: number }, ['x', 'y']) }
const styleFields = Object.fromEntries(['name', 'icon', 'summary', 'tone', 'sentences', 'opening', 'structure', 'logic', 'story', 'flow'].map(k => [k, str()]))
Object.assign(styleFields, { words: strings, avoid: strings, samples: strings })
const skillFields = { accountId, name: str(), rule: str(), source: str(), status: str(), confidence: number, evidence: str() }
const metricFields = { accountId, itemId: nullable(id), platform, date: nullable(str(50)), collectedAt: nullable(str(50)), source: str(300), ...Object.fromEntries(['views', 'likes', 'comments', 'shares', 'saves'].map(k => [k, nullable({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER })])) }
const operations = []
const op = (name, fields, required = []) => operations.push(object({ op: { const: name }, ...fields }, ['op', ...required]))
op('add_item', itemFields)
op('update_item', { id, ...itemFields }, ['id'])
for (const name of ['delete_item', 'delete_style', 'delete_skill']) op(name, { id }, ['id'])
op('set_status', { id, status }, ['id', 'status'])
op('schedule_item', { id, scheduledAt: itemFields.scheduledAt, platform }, ['id', 'scheduledAt'])
op('save_draft', { id, format: { enum: ['article', 'script'] }, text: str(200000), by: { enum: ['user', 'ai'] }, engine: str(200) }, ['id', 'text'])
op('update_production', { id, accountId, title: str(200), article: str(200000), coverText: str(40) }, ['id'])
op('save_version', { id, name: str(80) }, ['id'])
op('restore_version', { id, versionId: id }, ['id', 'versionId'])
op('add_style', styleFields, ['name'])
op('update_style', { id, ...styleFields }, ['id'])
op('set_style', { id: nullable(id), accountId }, ['id'])
op('set_format', { format, accountId }, ['format'])
op('add_skill', skillFields, ['name', 'rule'])
op('update_skill', { id, ...skillFields }, ['id'])
op('add_metric', metricFields, ['platform'])
const avatar = nullable({ type: 'string', maxLength: AVATAR_MAX_LENGTH, anyOf: [{ const: '' }, { pattern: '^[Hh][Tt][Tt][Pp][Ss]?://' }, { pattern: AVATAR_LOCAL_PATTERN }] })
const accountFields = {avatar,platform,handle:str(300),url:nullable({type:'string',pattern:'^https?://',maxLength:4000}),group:str(300),positioning:str(4000),audience:str(4000),defaultStyleId:nullable(id),draftFormat:nullable(format),archived:{type:'boolean'},note:str(4000),followers:number}
op('add_account',accountFields,['platform','handle'])
op('update_account',{id,...accountFields},['id'])
op('delete_account',{id},['id'])
op('assign_items',{ids:{type:'array',items:id,minItems:1,maxItems:100,uniqueItems:true},accountId,updatePlatform:{type:'boolean'}},['ids','accountId'])
const requestId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Durable unique mutation ID. Reuse only with identical arguments; inspect status after an uncertain outcome.' }
const tools = []
function tool(suffix, description, properties = {}, required = [], mutation = false) {
  tools.push({ name: `media_desk_${suffix}`, description, mutation, inputSchema: object({ ...properties, ...(mutation ? { requestId } : {}) }, [...required, ...(mutation ? ['requestId'] : [])]), annotations: { readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: true, openWorldHint: mutation && ['assist', 'produce', 'regenerate_asset'].includes(suffix) } })
}
const item = { id, accountId }
const pagination = {limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:1000000}}
tool('list_accounts','Search account profiles and counts; no credentials.',{query:str(500),platform,group:str(300),archived:{type:'boolean'},...pagination})
tool('get_account','Get one account profile, defaults and content counts.',{id},['id'])
tool('status', 'Local workbench availability and protocol version.')
tool('list_items', 'Compact item metadata; no body, chat or settings.', { accountId, query: str(500), status, platform, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } })
tool('get_item', 'Get one item. Opt into bounded body/article/production, compact media, or paged version metadata; versionId with versions opts into one bounded historical snapshot.', { id, accountId, fields: { type: 'array', items: { enum: ['body', 'article', 'production', 'media', 'versions'] }, uniqueItems: true, maxItems: 5 }, versionId: id, versionOffset: { type: 'integer', minimum: 0, maximum: 1000000 }, versionLimit: { type: 'integer', minimum: 1, maximum: 100 }, maxChars: { type: 'integer', minimum: 1, maximum: 200000, default: 8000 } }, ['id'])
tools.at(-1).inputSchema.allOf = [{ if: { required: ['versionId'] }, then: { required: ['fields'], properties: { fields: { contains: { const: 'versions' } } } } }]
tool('import_file', 'Import one host-local JPEG/PNG/WebP/GIF (25 MB) or MP4/MOV/WebM (250 MB), preserving exact bytes without model calls. Default destination item creates one idea, Unassigned when accountId is omitted. Destination avatar requires a concrete accountId, accepts images only and forbids title/body/tags. Returns metadata only.', { path: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^/' }, destination: { enum: ['item', 'avatar'], default: 'item' }, accountId, title: str(300), body: str(40000), tags: { type: 'array', items: str(100), maxItems: 24 } }, ['path'], true)
tools.at(-1).inputSchema.allOf = [{ if: { properties: { destination: { const: 'avatar' } }, required: ['destination'] }, then: { properties: { accountId: id }, required: ['accountId'], not: { anyOf: ['title', 'body', 'tags'].map(field => ({ required: [field] })) } } }]
tool('apply_ops', 'Apply up to 100 whitelisted operations. Returns receipts and partial failures. scheduledAt requires an ISO8601 timezone; null cancels.', { accountId, ops: { type: 'array', items: { oneOf: operations }, minItems: 1, maxItems: 100 }, label: str(100) }, ['ops'], true)
const shot = object({ shot: str(12), visual: str(2000), voice: str(2000), seconds: { type: 'number', minimum: 1, maximum: 60 }, prompt: str(1200) })
tool('assist', 'Create or revise content with the workbench selected/subscription model. Executes production actions; may incur configured provider costs.', { message: { type: 'string', minLength: 1, maxLength: 40000 }, focusId: id, accountId }, ['message'], true)
tool('write_draft', 'Save externally authored text to studio/export without calling any model. Existing asset references are preserved.', { id, accountId, format, title: str(200), article: str(200000), coverText: str(40), characters: str(4000), facts: strings, outline: strings, shots: { type: 'array', items: shot, maxItems: 24 } }, ['id'], true)
tool('produce', 'Start the existing Producer once. May call configured models and incur charges.', { ...item, withImages: { type: 'boolean' } }, ['id'], true)
tool('production_status', 'Compact production/job status for one item.', item, ['id'])
tool('cancel_production', 'Ask the existing Producer to cancel one job.', item, ['id'], true)
tool('regenerate_asset', 'Regenerate one existing asset once using configured image provider.', { id, accountId, target: { type: 'string', pattern: '^(cover|(image|shot):[0-9]{1,2})$' } }, ['id', 'target'], true)
tool('export', 'Seal a content version and export article, storyboard, assets and composited JPEG cover into a new non-overwriting folder with a traceable manifest.', item, ['id'], true)
tool('get_insights', 'Cumulative work/platform snapshots with coverage, nullable observed growth and field provenance. Arrays are limited to 30 with per-path total/truncation metadata. Optional account/platform filters; unidentified records excluded from work totals. No model or Monid call.', { accountId, platform: { enum: PLATFORMS } })
tool('list_styles', 'Bounded style cards and active style.', { accountId, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } })
tool('models', 'Configured provider and model identifiers; no credentials.')
tool('request_status', 'Inspect a durable mutation request. Pending recovery is never replayed.', { requestId }, ['requestId'])
tool('get_content_lab', 'Read bounded scoped review, preview, immutable prediction, publication and retrospective records; list metadata first. Manuscript detail is explicit opt-in. Rubric presets are uncalibrated. No model or platform calls.')
tools.at(-1).inputSchema = labReadSchema
tool('content_lab_action', 'Evaluate a saved version in an independent input context; preview then lock a prediction; register actual publication; retrospect against one timed local observation. Explicit accountId and requestId are required. Models may incur configured provider costs; publish registers a user claim and never posts to a platform.', {}, [], true)
tools.at(-1).inputSchema = labActionSchema
tools.at(-1).annotations.openWorldHint = true
export const catalog = tools
export const catalogFor = (readOnly = false) => catalog.filter(t => !readOnly || !t.mutation)
