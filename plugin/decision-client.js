import { detectSensitiveText } from './sensitive-text.js'

import { DECISION_MODEL, DECISION_ENDPOINT, validDecisionEndpoint, validDecisionModel, validDecisionKey } from './decision-config.js'
export { DECISION_MODEL } from './decision-config.js'

const RELATIONS = ['supports', 'contradicts', 'insufficient']
// HTTP 400 codes the Decisions API returns when input filters block a call.
const SAFETY_CODES = ['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked']
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 10000
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const safeModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) && !detectSensitiveText(value)
const failure = reason => Object.assign(new Error('Gemini Decision check unavailable'), { decisionReason: reason })

/**
 * Gemini Decisions response: one typed answer per question, no top-level
 * `model` field, and an optional `usage` object whose output tokens are always
 * zero (the model generates no text). Only `choice` answers are consumed here.
 */
export function parseDecisionResponse(body, ids) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('invalid-response')
  // A missing model is normal; a malformed one is still a protocol violation.
  if (body.model !== undefined && !safeModel(body.model)) throw failure('invalid-response')
  if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)
    || Object.keys(body.answers).length !== ids.length) throw failure('invalid-response')
  const answers = {}
  for (const id of ids) {
    const answer = body.answers[id], probabilities = answer?.probabilities
    if (answer?.type !== 'choice' || !RELATIONS.includes(answer.choice) || !probability(answer.confidence)
      || !probabilities || Object.keys(probabilities).length !== 3 || !RELATIONS.every(label => probability(probabilities[label]))
      || Math.abs(RELATIONS.reduce((sum, label) => sum + probabilities[label], 0) - 1) > 0.001
      || RELATIONS.some(label => probabilities[label] > probabilities[answer.choice] + 0.000001)) throw failure('invalid-response')
    answers[id] = { relation: answer.choice, confidence: answer.confidence, probabilities: Object.fromEntries(RELATIONS.map(label => [label, probabilities[label]])) }
  }
  const parsed = { answers }
  if (body.model !== undefined) parsed.model = body.model
  if (body.usage !== undefined && body.usage !== null) {
    const usage = body.usage
    if (typeof usage !== 'object' || Array.isArray(usage)
      || !Number.isSafeInteger(usage.total_input_tokens) || usage.total_input_tokens < 0) throw failure('invalid-response')
    const outputTokens = usage.total_output_tokens === undefined ? 0 : usage.total_output_tokens
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) throw failure('invalid-response')
    parsed.usage = { inputTokens: usage.total_input_tokens, outputTokens }
  }
  return parsed
}

async function boundedJson(response) {
  if (!response.body) throw failure('invalid-response')
  const reader = response.body.getReader(), parts = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('invalid-response') }
      parts.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
  } catch (error) { throw error?.decisionReason ? error : failure('invalid-response') }
  finally { reader.releaseLock() }
}

/** Safety blocks surface as HTTP 400 with one of five error codes. */
async function safetyBlocked(response) {
  if (response.status !== 400) return false
  try {
    const body = await boundedJson(response)
    return SAFETY_CODES.includes(body?.error?.code)
  } catch { return false }
}

/**
 * One bounded batch for advisor context checks. The supplied `resolveConnection`
 * runs inside the same deadline and cancellation boundary as the request, so a
 * hanging or throwing host credential lookup can neither outlive the optional
 * check nor turn a provider refusal into a consultation failure.
 */
export async function checkDecisionBatch({ prepared, enabled, signal, timeoutMs = MAX_TIMEOUT_MS,
  endpoint = DECISION_ENDPOINT, model = DECISION_MODEL, apiKey = '', resolveConnection,
  fetchImpl = globalThis.fetch, beforeRequest = () => {} }) {
  const started = Date.now()
  const result = { mode: 'shadow', requestedModel: validDecisionModel(model) && !detectSensitiveText(model) ? model : DECISION_MODEL, status: 'skipped', requestCount: 0, elapsedMs: 0, omittedChecks: prepared.omittedChecks || 0, checks: prepared.checks.map(row => ({ ...row })) }
  const pending = result.checks.filter(row => row.status === 'pending')
  const skip = reason => {
    result.reason = reason
    for (const row of pending) Object.assign(row, { status: 'skipped', reason })
    result.elapsedMs = Date.now() - started
    return result
  }
  if (!enabled) return skip('disabled')
  if (!pending.length) return skip('no-eligible-claims')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return skip('time-unavailable')
  if (signal?.aborted) return skip('cancelled')
  const controller = new AbortController()
  let timer, onAbort
  try {
    // Race the entire transport + body read, not only fetch's response headers.
    // This also bounds adapters that fail to honour AbortSignal.
    const interrupted = new Promise((_, reject) => {
      const stop = reason => { controller.abort(); reject(failure(reason)) }
      onAbort = () => stop('cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => stop('timeout'), Math.min(timeoutMs, MAX_TIMEOUT_MS))
    })
    // Host credential reads are optional dependencies: a throwing resolver
    // degrades to no key (-> missing-key skip) and never surfaces its error.
    let connection = { endpoint, model, apiKey }
    if (typeof resolveConnection === 'function') {
      const resolved = await Promise.race([Promise.resolve().then(resolveConnection).catch(() => null), interrupted])
      if (resolved !== null && resolved !== undefined) connection = resolved
    }
    result.requestedModel = validDecisionModel(connection.model) && !detectSensitiveText(connection.model) ? connection.model : DECISION_MODEL
    if (!validDecisionEndpoint(connection.endpoint) || !validDecisionModel(connection.model) || detectSensitiveText(connection.model)) return skip('invalid-config')
    if (typeof connection.apiKey !== 'string' || !connection.apiKey.trim()) return skip('missing-key')
    if (!validDecisionKey(connection.apiKey.trim())) return skip('invalid-config')
    const request = async () => {
      beforeRequest()
      result.requestCount = 1
      // Gemini Developer API: POST /v1beta/decisions with the API key in a
      // header (never `Authorization: Bearer`, never a `?key=` query).
      const response = await fetchImpl(connection.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'x-goog-api-key': connection.apiKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prepared.request, model: connection.model }),
      })
      if (!response.ok) {
        const blocked = await safetyBlocked(response)
        void response.body?.cancel?.().catch?.(() => {})
        throw failure(blocked ? 'safety-blocked' : 'http-error')
      }
      const payload = await boundedJson(response)
      if (payload?.prompt_feedback?.block_reason !== undefined && payload?.prompt_feedback?.block_reason !== null) throw failure('safety-blocked')
      return parseDecisionResponse(payload, pending.map(row => row.id))
    }
    const response = await Promise.race([interrupted, request()])
    if (signal?.aborted) throw failure('cancelled')
    if (response.model !== undefined) result.model = response.model
    if (response.usage !== undefined) result.usage = response.usage
    for (const row of pending) {
      Object.assign(row, response.answers[row.id], { status: 'completed' })
    }
    result.status = pending.length === result.checks.length && result.omittedChecks === 0 ? 'completed' : 'partial'
  } catch (error) {
    result.status = error?.decisionReason === 'cancelled' ? 'cancelled' : 'error'
    result.reason = ['cancelled', 'timeout', 'http-error', 'invalid-response', 'safety-blocked'].includes(error?.decisionReason) ? error.decisionReason : 'transport-error'
    for (const row of pending) Object.assign(row, { status: 'skipped', reason: result.reason })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
    result.elapsedMs = Date.now() - started
  }
  return result
}
