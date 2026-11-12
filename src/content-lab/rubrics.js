// Preset definitions are versioned and intentionally uncalibrated. Inspired by
// XBuilderLAB/cheat-on-content (MIT), d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89.
const dimension = (id, name, description, weight = 1) => ({ id, name, description, weight })
const general = [
  dimension('opening', 'Opening', 'Does the opening give a concrete reason to continue?'),
  dimension('clarity', 'Clarity', 'Is the main point understandable and focused?'),
  dimension('substance', 'Substance', 'Are claims supported with specific examples or evidence?'),
  dimension('structure', 'Structure', 'Does each part develop the point in a useful order?'),
  dimension('originality', 'Originality', 'Does the piece offer a distinct and useful perspective?'),
  dimension('payoff', 'Payoff', 'Does the ending deliver on the opening and leave something useful?'),
]
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
export const RUBRICS = freeze([
  { id: 'general-script-v1', version: 1, name: 'General spoken script', format: 'script', calibrated: false, scoring: 'integer-0-to-5-weighted-percent', dimensions: [...general, dimension('speakability', 'Speakability', 'Can the lines be spoken naturally without avoidable friction?')] },
  { id: 'general-article-v1', version: 1, name: 'General article', format: 'article', calibrated: false, scoring: 'integer-0-to-5-weighted-percent', dimensions: [...general, dimension('readability', 'Readability', 'Do paragraphs and transitions support reading?')] },
  { id: 'opinion-video-v1', version: 1, name: 'Opinion video (explicit choice)', format: 'script', calibrated: false, scoring: 'integer-0-to-5-weighted-percent', dimensions: [dimension('claim', 'Claim', 'Is there a clear debatable claim?'), dimension('tension', 'Tension', 'Is the disagreement relevant and specific?'), dimension('argument', 'Argument', 'Does the reasoning fairly support the claim?'), dimension('evidence', 'Evidence', 'Are examples credible and tied to the claim?'), dimension('delivery', 'Delivery', 'Does the spoken progression hold attention?'), dimension('payoff', 'Payoff', 'Does the conclusion resolve the stated tension?')] },
])
export function rubricFor(id, format) {
  const rubric = RUBRICS.find(r => r.id === id && r.format === format)
  if (!rubric) throw Object.assign(new Error('Select a preset matching the explicit manuscript format.'), { code: 'INVALID_ARGUMENT' })
  return structuredClone(rubric)
}
export function composite(rubric, dimensions) {
  const weight = rubric.dimensions.reduce((sum, d) => sum + d.weight, 0)
  return Math.round(rubric.dimensions.reduce((sum, d) => sum + d.weight * dimensions.find(row => row.id === d.id).score, 0) / (5 * weight) * 10000) / 100
}
