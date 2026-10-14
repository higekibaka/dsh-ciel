import { detectSensitiveText } from './sensitive-text.js'

import { JEV_MODEL, JEV_ENDPOINT, validJevEndpoint, validJevModel, validJevKey } from './jev-config.js'
export { JEV_MODEL } from './jev-config.js'
const RELATIONS = ['supports', 'contradicts', 'insufficient']
const MAX_RESPONSE_BYTES = 64 * 1024
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const safeModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) && !detectSensitiveText(value)
const failure = reason => Object.assign(new Error('Jev check unavailable'), { jevReason: reason })

export function parseJevResponse(body, ids) {
  if (!safeModel(body?.model) || !body?.answers || Object.keys(body.answers).length !== ids.length) throw failure('invalid-response')
  const answers = {}
  for (const id of ids) {
    const answer = body.answers[id], probabilities = answer?.probabilities
    if (answer?.type !== 'choice' || !RELATIONS.includes(answer.choice) || !probability(answer.confidence)
      || !probabilities || Object.keys(probabilities).length !== 3 || !RELATIONS.every(label => probability(probabilities[label]))
      || Math.abs(RELATIONS.reduce((sum, label) => sum + probabilities[label], 0) - 1) > 0.001
      || RELATIONS.some(label => probabilities[label] > probabilities[answer.choice] + 0.000001)) throw failure('invalid-response')
    answers[id] = { relation: answer.choice, confidence: answer.confidence, probabilities: Object.fromEntries(RELATIONS.map(label => [label, probabilities[label]])) }
  }
  if (!body.usage || !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(body.usage[key]) && body.usage[key] >= 0)) throw failure('invalid-response')
  return { model: body.model, answers, usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } }
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
  } catch (error) { throw error?.jevReason ? error : failure('invalid-response') }
  finally { reader.releaseLock() }
}

/** One bounded batch for advisor context checks. */
export async function checkJevBatch({ prepared, enabled, signal, timeoutMs = 10000,
  endpoint = JEV_ENDPOINT, model = JEV_MODEL,
  apiKey = endpoint === JEV_ENDPOINT ? process.env.TYPESAFE_API_KEY : '', fetchImpl = globalThis.fetch, beforeRequest = () => {} }) {
  const started = Date.now()
  const result = { mode: 'shadow', requestedModel: validJevModel(model) && !detectSensitiveText(model) ? model : JEV_MODEL, status: 'skipped', requestCount: 0, elapsedMs: 0, omittedChecks: prepared.omittedChecks || 0, checks: prepared.checks.map(row => ({ ...row })) }
  const pending = result.checks.filter(row => row.status === 'pending')
  const skip = reason => {
    result.reason = reason
    for (const row of pending) Object.assign(row, { status: 'skipped', reason })
    result.elapsedMs = Date.now() - started
    return result
  }
  if (!enabled) return skip('disabled')
  if (!pending.length) return skip('no-eligible-claims')
  if (!validJevEndpoint(endpoint) || !validJevModel(model) || detectSensitiveText(model)) return skip('invalid-config')
  if (typeof apiKey !== 'string' || !apiKey.trim()) return skip('missing-key')
  if (!validJevKey(apiKey.trim())) return skip('invalid-config')
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
      timer = setTimeout(() => stop('timeout'), Math.min(timeoutMs, 10000))
    })
    const request = async () => {
      beforeRequest()
      result.requestCount = 1
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + apiKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prepared.request, model }),
      })
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw failure('http-error') }
      return parseJevResponse(await boundedJson(response), pending.map(row => row.id))
    }
    const response = await Promise.race([interrupted, request()])
    if (signal?.aborted) throw failure('cancelled')
    result.model = response.model
    result.usage = response.usage
    for (const row of pending) {
      Object.assign(row, response.answers[row.id], { status: 'completed' })
    }
    result.status = pending.length === result.checks.length && result.omittedChecks === 0 ? 'completed' : 'partial'
  } catch (error) {
    result.status = error?.jevReason === 'cancelled' ? 'cancelled' : 'error'
    result.reason = ['cancelled', 'timeout', 'http-error', 'invalid-response'].includes(error?.jevReason) ? error.jevReason : 'transport-error'
    for (const row of pending) Object.assign(row, { status: 'skipped', reason: result.reason })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    controller.abort()
    result.elapsedMs = Date.now() - started
  }
  return result
}
