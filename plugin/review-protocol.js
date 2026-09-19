// Shared Host/Client wire boundary. No DSH, Node, DOM or schema-library state.
// Unknown response fields are retained for additive evolution; request fields
// and action-critical identities/types are checked before dispatch.
export const REVIEW_METHODS = Object.freeze(['list', 'start', 'feedback', 'prepareFeedback', 'triage', 'progress', 'cancel', 'callModelUsage', 'readReview', 'readEvidence', 'readAdvice', 'inboxList', 'inboxSetIntent'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const session = value => string(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max
const array = (value, check, max) => Array.isArray(value) && value.length <= max && value.every(item => check(item))
const optional = (value, check) => value === undefined || check(value)
const enumOf = (...values) => value => values.includes(value)
const intent = enumOf('pending', 'planned', 'rejected')
const fingerprint = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const index = value => integer(value, 7)
const cursor = value => value === null || string(value, 4096)
const recordOf = (value, check) => object(value) && Object.entries(value).every(([key, item]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && check(item, key))
const route = value => object(value) && string(value.provider, 256) && string(value.model, 256)
const usage = value => object(value) && optional(value.requested, route) && array(value.used, route, 32)
const annotation = value => object(value) && enumOf('blocker', 'nit')(value.severity)
  && ['title', 'anchor', 'comment', 'block', 'evidence'].every(key => optional(value[key], item => typeof item === 'string'))
const review = value => object(value) && session(value.sessionId) && string(value.reviewId) && string(value.messageId)
  && string(value.status, 64) && Number.isFinite(value.createdAt) && array(value.annotations, annotation, 64)
  && optional(value.modelUsage, usage)
const triage = value => recordOf(value, row => object(row) && recordOf(row.states, (state, key) => /^(0|[1-9][0-9]*)$/.test(key) && index(Number(key)) && enumOf('accept', 'dismiss')(state)) && optional(row.filter, enumOf('all', 'blocker')))
const shapes = {
  list: { sessionId: session, cursor: value => optional(value, cursor), limit: value => optional(value, v => integer(v, 100) && v > 0) },
  start: { sessionId: session, messageId: string },
  progress: { sessionId: session, messageId: string },
  cancel: { sessionId: session, messageId: string },
  readReview: { sessionId: session, reviewId: string },
  readEvidence: { sessionId: session, reviewId: string, evidenceId: value => typeof value === 'string' && /^[ea][1-9][0-9]*$/.test(value) },
  readAdvice: { sessionId: session, callId: string },
  callModelUsage: { sessionId: session, kind: enumOf('tool', 'command'), id: string },
  prepareFeedback: { sessionId: session, reviewId: string, messageId: value => optional(value, string), items: value => array(value, row => object(row) && Object.keys(row).length === 1 && index(row.index), 8) && value.length > 0 },
  triage: { sessionId: session, reviewId: string, changes: value => optional(value, v => array(v, row => object(row) && index(row.index) && enumOf('accept', 'dismiss')(row.state) && Object.keys(row).every(k => ['index', 'state'].includes(k)), 8)), filter: value => optional(value, enumOf('all', 'blocker')) },
  inboxList: { sessionId: session, cursor: value => optional(value, cursor), limit: value => optional(value, v => integer(v, 25) && v > 0) },
  inboxSetIntent: { sessionId: session, reviewId: string, reviewFingerprint: fingerprint, expectedRevision: integer, index: value => integer(value, 63), intent },
}

function invalid(method, direction) {
  const error = new Error('Ciel ' + method + ' ' + direction + ' does not match the review protocol')
  error.code = direction === 'request' ? 'CIEL_PROTOCOL_REQUEST_INVALID' : 'CIEL_PROTOCOL_RESPONSE_INVALID'
  error.stack = 'Error: ' + error.message // Never echo the offending value.
  throw error
}

export function parseReviewRequest(method, value) {
  if (!REVIEW_METHODS.includes(method) || !object(value)) invalid(method, 'request')
  // Old feedback requests reach the explicit tombstone, never a model dispatch.
  if (method === 'feedback') return value
  const fields = shapes[method]
  if (Object.keys(value).some(key => !Object.hasOwn(fields, key)) || Object.entries(fields).some(([key, check]) => !check(value[key]))) invalid(method, 'request')
  return value
}

export function parseReviewResult(method, value) {
  if (!REVIEW_METHODS.includes(method) || !object(value)) invalid(method, 'response')
  if (value.ok === false) {
    if (typeof value.error !== 'string' || value.error.length === 0 || !optional(value.code, v => string(v, 128)) || !optional(value.retryable, v => typeof v === 'boolean') || !optional(value.review, review)) invalid(method, 'response')
    return value
  }
  let valid = false
  switch (method) {
    case 'list': valid = array(value.reviews, review, 100) && optional(value.sentKeys, v => array(v, string, 1000)) && optional(value.triage, triage) && optional(value.nextCursor, cursor) && optional(value.limited, v => typeof v === 'boolean'); break
    case 'start': valid = value.ok === true && review(value.review); break
    case 'progress': valid = typeof value.inFlight === 'boolean' && ['remainingMs', 'modelRequests', 'toolCalls', 'elapsedMs', 'timeoutSeconds', 'suspects'].every(key => optional(value[key], v => Number.isFinite(v) && v >= 0)) && optional(value.phase, enumOf(1, 2)); break
    case 'cancel': valid = value.ok === true && typeof value.cancelled === 'boolean' && optional(value.phase, enumOf('running', 'cancelled', 'committing', 'finished')); break
    case 'triage': valid = value.ok === true; break
    case 'callModelUsage': valid = value.modelUsage === null || usage(value.modelUsage); break
    case 'readReview': valid = value.ok === true && review(value.review); break
    case 'readEvidence': valid = value.ok === true && object(value.evidence) && typeof value.evidence.content === 'string' && string(value.evidence.id) && fingerprint(value.evidence.contentSha256); break
    case 'readAdvice': valid = value.ok === true && object(value.advice) && session(value.advice.sessionId) && string(value.advice.callId) && typeof value.advice.text === 'string'; break
    case 'prepareFeedback': valid = value.ok === true && session(value.sessionId) && string(value.reviewId) && string(value.messageId) && typeof value.text === 'string' && integer(value.count, 8) && value.count > 0; break
    case 'inboxList': valid = value.ok === true && session(value.sessionId) && array(value.reviews, row => review(row) && row.sessionId === value.sessionId && fingerprint(row.reviewFingerprint) && integer(row.revision) && row.annotations.every((a, i) => a.index === i && intent(a.intent)), 25) && cursor(value.nextCursor) && typeof value.limited === 'boolean'; break
    case 'inboxSetIntent': valid = value.ok === true && session(value.sessionId) && string(value.reviewId) && fingerprint(value.reviewFingerprint) && integer(value.revision) && recordOf(value.intents, (v, k) => /^(0|[1-9][0-9]*)$/.test(k) && integer(Number(k), 63) && intent(v)); break
  }
  if (!valid) invalid(method, 'response')
  return value
}

function reviewCodec(method, direction) {
  const schema = { parse: value => direction === 'request' ? parseReviewRequest(method, value) : parseReviewResult(method, value) }
  return { mode: 'strict', typeSymbol: `dsh-advisor/${method}${direction === 'request' ? 'Request' : 'Result'}`, schema, create: () => schema }
}
export function reviewInvocation(method) {
  if (!REVIEW_METHODS.includes(method)) invalid(method, 'request')
  return {
    id: `dsh-advisor#advisorReview/${method}`, service: 'advisorReview', namespace: 'advisorReview', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: reviewCodec(method, 'request') }],
    result: reviewCodec(method, 'result'),
  }
}
export const REVIEW_REMOTE = { package: 'dsh-advisor', descriptors: REVIEW_METHODS.map(reviewInvocation) }

export function assertReviewResultIdentity(method, request, value) {
  if (!object(value)) invalid(method, 'response')
  const same = (row, keys) => keys.every(key => request[key] === undefined || row[key] === request[key])
  if (value.review && !same(value.review, ['sessionId', 'messageId', 'reviewId'])) invalid(method, 'response')
  if (Array.isArray(value.reviews) && value.reviews.some(row => row.sessionId !== request.sessionId)) invalid(method, 'response')
  if (value.ok === true && ['prepareFeedback', 'inboxList', 'inboxSetIntent'].includes(method) && !same(value, ['sessionId', 'messageId', 'reviewId'])) invalid(method, 'response')
  if (value.advice && !same(value.advice, ['sessionId', 'callId'])) invalid(method, 'response')
  if (value.evidence && value.evidence.id !== request.evidenceId) invalid(method, 'response')
  return value
}
