import Ajv from 'ajv'
const id = { type: 'string', minLength: 1, maxLength: 200 }
const text = maxLength => ({ type: 'string', minLength: 1, maxLength })
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] })
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
export const labReadSchema = object({ accountId: nullable(id), view: { enum: ['records', 'list', 'detail', 'rubrics', 'queue'] }, recordId: id, queryRequestId: id, itemId: id, kind: { enum: ['evaluation', 'forecast', 'prediction', 'publication', 'retrospective'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 }, maxChars: { type: 'integer', minimum: 1, maximum: 100000 }, includeManuscript: { type: 'boolean' } }, [])
labReadSchema.allOf = [{ if: { properties: { view: { const: 'detail' } }, required: ['view'] }, then: { required: ['recordId'] } }]
const common = { accountId: nullable(id), requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } }
const action = (name, fields, required = Object.keys(fields)) => object({ ...common, action: { const: name }, ...fields }, ['accountId', 'requestId', 'action', ...required])
const actions = [
  action('evaluate', { itemId: id, versionId: id, rubricId: id, format: { enum: ['script', 'article'] }, materialMode: { enum: ['manuscript', 'body'] } }, ['itemId', 'versionId', 'rubricId', 'format']),
  action('forecast', { evaluationId: id, horizonDays: { type: 'integer', minimum: 1, maximum: 30, default: 3 } }, ['evaluationId']),
  action('lock', { forecastId: id }),
  action('publish', { predictionId: id, publishedAt: text(50), url: { type: 'string', minLength: 1, maxLength: 4000, pattern: '^https?://' } }, ['predictionId', 'publishedAt']),
  action('retro', { predictionId: id, metricId: id, notes: { type: 'string', maxLength: 4000 } }, ['predictionId', 'metricId']),
]
// Keep a normal strict object at the top for all discovery clients, with one
// complete additionalProperties:false branch per action.
export const labActionSchema = { type: 'object', properties: { ...Object.assign({}, ...actions.map(s => s.properties)), action: { enum: ['evaluate', 'forecast', 'lock', 'publish', 'retro'] } }, additionalProperties: false, required: ['accountId', 'requestId', 'action'], oneOf: actions }
const ajv = new Ajv({ strict: false })
const score = object({ id, score: { type: 'integer', minimum: 0, maximum: 5 }, reason: text(1200), evidence: { type: 'string', maxLength: 1200 }, confidence: { type: 'number', minimum: 0, maximum: 1 } })
const validators = {
  evaluate: ajv.compile(object({ dimensions: { type: 'array', minItems: 1, maxItems: 16, items: score } })),
  forecast: ajv.compile(object({ probabilities: nullable({ type: 'array', minItems: 5, maxItems: 5, items: { type: 'number', minimum: 0, maximum: 1 } }), bet: text(1200), reason: text(2000) })),
  retro: ajv.compile(object({ summary: text(2000), learning: text(2000) })),
}
export function validateModelReply(kind, reply, rubric, numeric = false) {
  const invalid = () => Object.assign(new Error('The model returned an invalid content-lab result; no record was saved.'), { code: 'INVALID_MODEL_RESULT' })
  if (typeof reply?.text !== 'string' || reply.text.length > 50000 || typeof reply.model !== 'string' || !reply.model.trim() || reply.model.length > 200 || reply.provider !== undefined && (typeof reply.provider !== 'string' || reply.provider.length > 200)) throw invalid()
  let result
  try { result = JSON.parse(reply.text) } catch { throw invalid() }
  if (!validators[kind](result)) throw invalid()
  if (kind === 'evaluate' && (result.dimensions.length !== rubric.dimensions.length || new Set(result.dimensions.map(d => d.id)).size !== result.dimensions.length || result.dimensions.some(d => !rubric.dimensions.some(r => r.id === d.id)))) throw invalid()
  if (kind === 'forecast') {
    if (numeric ? !Array.isArray(result.probabilities) || Math.abs(result.probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-8 : result.probabilities !== null) throw invalid()
  }
  return { value: result, model: { model: reply.model, ...(reply.provider ? { provider: reply.provider } : {}) } }
}
