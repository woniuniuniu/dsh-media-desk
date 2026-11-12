// Immutable quantitative policy snapshots. BigInt stays internal; persisted
// fractions use decimal strings so no large midpoint or threshold is rounded.
const invalid = () => Object.assign(new Error('The frozen comparison policy is invalid or unsupported.'), { code: 'INVALID_ARGUMENT' })
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value)
function fraction(value) {
  if (!value || !integer(value.numerator) || !integer(value.denominator) || value.denominator === '0') throw invalid()
  return { n: BigInt(value.numerator), d: BigInt(value.denominator) }
}
function rational(n, d = 1n) {
  let a = n, b = d
  while (b) { const next = a % b; a = b; b = next }
  return { numerator: String(n / a), denominator: String(d / a) }
}
const compare = (a, b) => { const delta = a.n * b.d - b.n * a.d; return delta < 0n ? -1 : delta > 0n ? 1 : 0 }
export function exactMedian(sortedValues) {
  if (!sortedValues.length) return null
  if (sortedValues.some(v => !Number.isSafeInteger(v) || v < 0)) throw invalid()
  const count = sortedValues.length, middle = Math.floor(count / 2)
  const exact = count % 2 ? rational(BigInt(sortedValues[middle])) : rational(BigInt(sortedValues[middle - 1]) + BigInt(sortedValues[middle]), 2n)
  const { n, d } = fraction(exact)
  return { exact, display: Number(n) / Number(d), approximate: d !== 1n && n > BigInt(Number.MAX_SAFE_INTEGER) }
}
const RATIOS = [
  { numerator: '0', denominator: '1' },
  { numerator: '3', denominator: '10' },
  { numerator: '1', denominator: '1' },
  { numerator: '3', denominator: '1' },
  { numerator: '10', denominator: '1' },
]
const LABELS = ['<0.3x', '0.3x..<1x', '1x..<3x', '3x..<10x', '>=10x']
export function makeComparisonPolicy(baselineExact) {
  if (fraction(baselineExact).n <= 0n) throw invalid()
  return {
    id: 'relative-five-bucket-rational-v1', arithmetic: 'integer-rational-cross-multiplication', baselineExact: structuredClone(baselineExact), tiePolicy: 'unique-maximum-or-unscored-v1',
    intervals: LABELS.map((label, index) => ({ index, label, lowerRatio: { ...RATIOS[index] }, upperRatio: index < 4 ? { ...RATIOS[index + 1] } : null, lowerInclusive: true, upperInclusive: false })),
  }
}
function validatePolicy(policy) {
  if (policy?.id !== 'relative-five-bucket-rational-v1' || policy.arithmetic !== 'integer-rational-cross-multiplication' || policy.tiePolicy !== 'unique-maximum-or-unscored-v1' || !Array.isArray(policy.intervals) || policy.intervals.length !== 5) throw invalid()
  const baseline = fraction(policy.baselineExact)
  if (baseline.n <= 0n) throw invalid()
  let previous = { n: 0n, d: 1n }
  for (const [index, interval] of policy.intervals.entries()) {
    const lower = fraction(interval.lowerRatio), upper = interval.upperRatio === null ? null : fraction(interval.upperRatio)
    if (interval.index !== index || interval.lowerInclusive !== true || interval.upperInclusive !== false || compare(lower, previous) !== 0 || (index === 4 ? upper !== null : !upper || compare(lower, upper) >= 0)) throw invalid()
    previous = upper
  }
  return baseline
}
export function bucketForPolicy(views, policy) {
  if (!Number.isSafeInteger(views) || views < 0) throw invalid()
  const baseline = validatePolicy(policy), relative = { n: BigInt(views) * baseline.d, d: baseline.n }
  for (const interval of policy.intervals) {
    if (compare(relative, fraction(interval.lowerRatio)) >= 0 && (interval.upperRatio === null || compare(relative, fraction(interval.upperRatio)) < 0)) return interval.index
  }
  throw invalid()
}
export function topBuckets(probabilities) {
  if (probabilities === null) return { topBuckets: null, predictedBucket: null }
  if (!Array.isArray(probabilities) || probabilities.length !== 5 || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-8) throw invalid()
  const highest = Math.max(...probabilities), indices = probabilities.flatMap((p, i) => p === highest ? [i] : [])
  return { topBuckets: indices, predictedBucket: indices.length === 1 ? indices[0] : null }
}
export function compareForecast(forecast, views, manuscriptMatch) {
  const empty = { comparisonStatus: 'not-quantitatively-comparable', observedBucket: null, predictedBucket: null, topBuckets: null, bucketHit: null, assignedProbability: null }
  if (manuscriptMatch !== 'matching' || forecast.probabilities === null || views === null) return empty
  // Older archives with no frozen policy remain readable, but today's policy
  // must never be silently substituted for their missing comparison evidence.
  if (!forecast.comparisonPolicy) return { ...empty, comparisonStatus: 'missing-frozen-policy' }
  const observedBucket = bucketForPolicy(views, forecast.comparisonPolicy), top = topBuckets(forecast.probabilities)
  return { comparisonStatus: top.predictedBucket === null ? 'tied-top-probability' : 'unique-top-probability', observedBucket, ...top, bucketHit: top.predictedBucket === null ? null : observedBucket === top.predictedBucket, assignedProbability: forecast.probabilities[observedBucket] }
}
