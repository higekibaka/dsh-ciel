// Strict read-only advisor data contracts shared by Host and Client.
export const ADVISOR_METHODS = Object.freeze(['readAdvice', 'callModelUsage'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const session = value => string(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max
const array = (value, check, max) => Array.isArray(value) && value.length <= max && value.every(item => check(item))
const optional = (value, check) => value === undefined || check(value)
const enumOf = (...values) => value => values.includes(value)
const route = value => object(value) && string(value.provider, 256) && string(value.model, 256)
const usage = value => object(value) && optional(value.requested, route) && array(value.used, route, 32)
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1
const relation = enumOf('supports', 'contradicts', 'insufficient')
const jevReason = enumOf('disabled', 'no-eligible-claims', 'invalid-config', 'missing-key', 'time-unavailable', 'cancelled', 'timeout', 'http-error', 'invalid-response', 'transport-error', 'no-exact-claim', 'sensitive-input', 'no-source-evidence', 'limited-evidence', 'input-too-large')
const advisorJevCheck = value => object(value) && /^a[1-6]$/.test(value.id)
  && (value.status === 'skipped' ? jevReason(value.reason) : value.status === 'completed'
    && relation(value.relation) && probability(value.confidence) && object(value.probabilities)
    && Object.keys(value.probabilities).length === 3
    && ['supports', 'contradicts', 'insufficient'].every(key => probability(value.probabilities[key]))
    && Math.abs(Object.values(value.probabilities).reduce((a, b) => a + b, 0) - 1) <= 0.001)
export const isAdvisorJev = value => object(value) && value.mode === 'shadow' && value.scope === 'provided-context'
  && string(value.requestedModel, 128) && enumOf('completed', 'partial', 'skipped', 'error', 'cancelled')(value.status)
  && integer(value.requestCount, 1) && integer(value.elapsedMs) && integer(value.omittedChecks)
  && array(value.checks, advisorJevCheck, 6) && new Set(value.checks.map(row => row.id)).size === value.checks.length
  && optional(value.reason, jevReason) && optional(value.model, model => string(model, 128))
  && optional(value.usage, tokens => object(tokens) && integer(tokens.inputTokens) && integer(tokens.outputTokens))

// DSH's tool schema subset excludes numeric bounds, patterns and maxItems.
// Transport parsing and isAdvisorJev enforce those constraints at the boundary.
const jevCountSchema = { type: 'integer' }
const jevProbabilitySchema = { type: 'number' }
export const ADVISOR_JEV_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['mode', 'scope', 'requestedModel', 'status', 'requestCount', 'elapsedMs', 'omittedChecks', 'checks'],
  properties: {
    mode: { type: 'string', enum: ['shadow'] }, scope: { type: 'string', enum: ['provided-context'] },
    requestedModel: { type: 'string' }, model: { type: 'string' }, reason: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'partial', 'skipped', 'error', 'cancelled'] },
    requestCount: { ...jevCountSchema, enum: [0, 1] }, elapsedMs: jevCountSchema, omittedChecks: jevCountSchema,
    usage: { type: 'object', additionalProperties: false, required: ['inputTokens', 'outputTokens'],
      properties: { inputTokens: jevCountSchema, outputTokens: jevCountSchema } },
    checks: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'status'],
      properties: {
        id: { type: 'string', enum: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] }, status: { type: 'string', enum: ['completed', 'skipped'] },
        reason: { type: 'string' }, relation: { type: 'string', enum: ['supports', 'contradicts', 'insufficient'] },
        confidence: jevProbabilitySchema,
        probabilities: { type: 'object', additionalProperties: false, required: ['supports', 'contradicts', 'insufficient'],
          properties: { supports: jevProbabilitySchema, contradicts: jevProbabilitySchema, insufficient: jevProbabilitySchema } },
      },
    } },
  },
}
const shapes = {
 readAdvice: { sessionId: session, callId: string },
 callModelUsage: { sessionId: session, kind: enumOf('tool'), id: string },
}
function invalid(method, direction) {
  const error = new Error('Ciel ' + method + ' ' + direction + ' does not match the advisor protocol')
  error.code = direction === 'request' ? 'CIEL_PROTOCOL_REQUEST_INVALID' : 'CIEL_PROTOCOL_RESPONSE_INVALID'
  error.stack = 'Error: ' + error.message // Never echo the offending value.
  throw error
}

export function parseAdvisorRequest(method, value) {
  if (!ADVISOR_METHODS.includes(method) || !object(value)) invalid(method, 'request')
  const fields = shapes[method]
  if (Object.keys(value).some(key => !Object.hasOwn(fields, key)) || Object.entries(fields).some(([key, check]) => !check(value[key]))) invalid(method, 'request')
  return value
}

export function parseAdvisorResult(method, value) {
 if (!ADVISOR_METHODS.includes(method) || !object(value)) invalid(method, 'response')
 if (value.ok === false) {
  if (!string(value.error, 4096) || !optional(value.code, v => string(v, 128)) || !optional(value.retryable, v => typeof v === 'boolean')) invalid(method, 'response')
  return value
 }
 const valid = method === 'callModelUsage' ? value.modelUsage === null || usage(value.modelUsage)
  : value.ok === true && object(value.advice) && session(value.advice.sessionId) && string(value.advice.callId) && typeof value.advice.text === 'string' && optional(value.advice.modelUsage, usage) && optional(value.advice.jev, isAdvisorJev)
 if (!valid) invalid(method, 'response')
 return value
}
function advisorCodec(method, direction) {
  const schema = { parse: value => direction === 'request' ? parseAdvisorRequest(method, value) : parseAdvisorResult(method, value) }
  return { mode: 'strict', typeSymbol: `dsh-advisor/${method}${direction === 'request' ? 'Request' : 'Result'}`, schema, create: () => schema }
}
export function advisorInvocation(method) {
  if (!ADVISOR_METHODS.includes(method)) invalid(method, 'request')
  return {
    id: `dsh-advisor#cielAdvisor/${method}`, service: 'cielAdvisor', namespace: 'cielAdvisor', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: advisorCodec(method, 'request') }],
    result: advisorCodec(method, 'result'),
  }
}
export const ADVISOR_REMOTE = { package: 'dsh-advisor', descriptors: ADVISOR_METHODS.map(advisorInvocation) }

export function assertAdvisorResultIdentity(method, request, value) {
 if (!object(value)) invalid(method, 'response')
 if (value.advice && ['sessionId','callId'].some(key => value.advice[key] !== request[key])) invalid(method, 'response')
 return value
}
