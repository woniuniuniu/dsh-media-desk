// One catalog for the Host dispatcher, CLI discovery and MCP schemas.
import { PLATFORMS } from '../platforms.js'
export const PROTOCOL_VERSION = 1
export const PLUGIN_VERSION = '2.6.2-accounts.3'
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
const itemFields = { accountId, title: str(), body: str(), kind: { enum: ['image', 'video', 'web', 'quote', 'note'] }, url: nullable({ type: 'string', pattern: '^https?://', maxLength: 4000 }), source: str(), tags: strings, status, angleId: nullable(id), personaIds: strings, parentId: nullable(id), rel: str(), scheduledAt: nullable(str(50)), platform, pinned: { type: 'boolean' }, score: number, media: nullable(object({ src: localSrc, poster: localSrc, w: number, h: number }, ['src'])), pos: object({ x: number, y: number, r: number }, ['x', 'y']) }
const styleFields = Object.fromEntries(['name', 'icon', 'summary', 'tone', 'sentences', 'opening', 'structure'].map(k => [k, str()]))
Object.assign(styleFields, { words: strings, avoid: strings, samples: strings })
const skillFields = { accountId, name: str(), rule: str(), source: str(), status: str(), confidence: number, evidence: str() }
const metricFields = { accountId, itemId: nullable(id), platform, date: nullable(str(50)), ...Object.fromEntries(['views', 'likes', 'comments', 'shares', 'saves'].map(k => [k, number])) }
const operations = []
const op = (name, fields, required = []) => operations.push(object({ op: { const: name }, ...fields }, ['op', ...required]))
op('add_item', itemFields)
op('update_item', { id, ...itemFields }, ['id'])
for (const name of ['delete_item', 'delete_style', 'delete_skill']) op(name, { id }, ['id'])
op('set_status', { id, status }, ['id', 'status'])
op('schedule_item', { id, scheduledAt: itemFields.scheduledAt, platform }, ['id', 'scheduledAt'])
op('save_draft', { id, format: { enum: ['article', 'script'] }, text: str(200000), by: { enum: ['user', 'ai'] }, engine: str(200) }, ['id', 'text'])
op('update_production', { id, accountId, title: str(200), article: str(200000), coverText: str(40) }, ['id'])
op('add_style', styleFields, ['name'])
op('update_style', { id, ...styleFields }, ['id'])
op('set_style', { id: nullable(id), accountId }, ['id'])
op('add_skill', skillFields, ['name', 'rule'])
op('update_skill', { id, ...skillFields }, ['id'])
op('add_metric', metricFields, ['platform'])
const accountFields = {platform,handle:str(300),url:nullable({type:'string',pattern:'^https?://',maxLength:4000}),group:str(300),positioning:str(4000),audience:str(4000),defaultStyleId:nullable(id),archived:{type:'boolean'},note:str(4000),followers:number}
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
tool('get_item', 'Get one item. Opt into bounded body/article/production fields.', { id, accountId, fields: { type: 'array', items: { enum: ['body', 'article', 'production'] }, uniqueItems: true, maxItems: 3 }, maxChars: { type: 'integer', minimum: 1, maximum: 200000, default: 8000 } }, ['id'])
tool('apply_ops', 'Apply up to 100 whitelisted operations. Returns receipts and partial failures. scheduledAt requires an ISO8601 timezone; null cancels.', { accountId, ops: { type: 'array', items: { oneOf: operations }, minItems: 1, maxItems: 100 }, label: str(100) }, ['ops'], true)
const shot = object({ shot: str(12), visual: str(2000), voice: str(2000), seconds: { type: 'number', minimum: 1, maximum: 60 }, prompt: str(1200) })
tool('assist', 'Create or revise content with the workbench selected/subscription model. Executes production actions; may incur configured provider costs.', { message: { type: 'string', minLength: 1, maxLength: 40000 }, focusId: id, accountId }, ['message'], true)
tool('write_draft', 'Save externally authored text to studio/export without calling any model. Existing asset references are preserved.', { id, accountId, title: str(200), article: str(200000), coverText: str(40), characters: str(4000), facts: strings, outline: strings, shots: { type: 'array', items: shot, maxItems: 24 } }, ['id'], true)
tool('produce', 'Start the existing Producer once. May call configured models and incur charges.', item, ['id'], true)
tool('production_status', 'Compact production/job status for one item.', item, ['id'])
tool('cancel_production', 'Ask the existing Producer to cancel one job.', item, ['id'], true)
tool('regenerate_asset', 'Regenerate one existing asset once using configured image provider.', { id, accountId, target: { type: 'string', pattern: '^(cover|(image|shot):[0-9]{1,2})$' } }, ['id', 'target'], true)
tool('export', 'Save article, storyboard, assets and composited JPEG cover to the configured export location.', item, ['id'], true)
tool('get_insights', 'Compact insights for an explicit account, Unassigned or All, optionally filtered by canonical platform (including 快手). Kuaishou supports manual/CSV/API metrics; no automatic Monid fetch.', { accountId, platform: { enum: PLATFORMS } })
tool('list_styles', 'Bounded style cards and active style.', { accountId, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } })
tool('models', 'Configured provider and model identifiers; no credentials.')
tool('request_status', 'Inspect a durable mutation request. Pending recovery is never replayed.', { requestId }, ['requestId'])
export const catalog = tools
export const catalogFor = (readOnly = false) => catalog.filter(t => !readOnly || !t.mutation)
