// Gemini Decisions connection, wire contract and response validation.
import { Config } from '../index.js'
import { resolvedConfig } from './config-fixture.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decisionConnection, resolveDecisionConnection, DECISION_ENDPOINT } from '../decision-config.js'
import { DECISION_MODEL, parseDecisionResponse, checkDecisionBatch } from '../decision-client.js'

test('Gemini Decision connection defaults, precedence and endpoint credential isolation are explicit', () => {
  const defaults = resolvedConfig({})
  assert.equal(defaults.decisionEndpoint, DECISION_ENDPOINT)
  assert.equal(defaults.decisionModel, DECISION_MODEL)
  assert.equal(defaults.decisionApiKey, undefined)
  assert.equal(defaults.advisorDecisionEnabled, false)
  assert.equal(Config.dict.decisionApiKey.meta.role, 'secret')
  assert.equal(decisionConnection({}, 'env-fixture').apiKey, 'env-fixture')
  assert.equal(decisionConnection({ decisionApiKey: 'saved-fixture' }, 'env-fixture').apiKey, 'saved-fixture')
  assert.equal(decisionConnection({ decisionEndpoint: 'https://proxy.invalid/decisions' }, 'env-fixture').apiKey, '')
  for (const config of [{ decisionEndpoint: 'http://proxy.invalid' }, { decisionEndpoint: 'https://user:password@proxy.invalid/' }, { decisionModel: 'bad model' }, { decisionApiKey: 'key with spaces' }]) {
    assert.throws(() => resolvedConfig(config))
  }
})

test('retired JEV configuration fields are gone from the host schema', () => {
  const keys = Object.keys(Config.dict)
  assert.equal(keys.some(key => /jev/i.test(key)), false)
  for (const key of ['advisorDecisionEnabled', 'decisionApiKey', 'decisionEndpoint', 'decisionModel']) assert.ok(keys.includes(key), key)
})

const answer = () => ({ type: 'choice', choice: 'supports', confidence: 0.8, probabilities: { supports: 0.8, contradicts: 0.1, insufficient: 0.1 } })
const body = () => ({ answers: { a1: answer() }, usage: { total_input_tokens: 20, total_output_tokens: 0, total_tokens: 20 } })
const prepared = {
  request: {
    model: DECISION_MODEL,
    input: '{"items":{"a1":{"advice":"Synthetic advice"}}}',
    questions: { a1: { type: 'choice', instructions: 'Compare', criteria: { supports: 's', contradicts: 'c', insufficient: 'i' } } },
  },
  checks: [{ id: 'a1', status: 'pending' }],
}

test('untrusted Decision distributions, optional model and usage cannot enter stored reports', () => {
  assert.equal(parseDecisionResponse(body(), ['a1']).answers.a1.relation, 'supports')
  const lean = body()
  delete lean.usage
  assert.equal(parseDecisionResponse(lean, ['a1']).usage, undefined)
  assert.equal(parseDecisionResponse(body(), ['a1']).usage.outputTokens, 0)
  assert.equal(parseDecisionResponse({ ...body(), model: 'gemini-decision-1' }, ['a1']).model, 'gemini-decision-1')
  for (const mutate of [
    b => { b.answers.a1.choice = 'true' },
    b => { b.answers.a1.probabilities.supports = 0 },
    b => { b.answers.a1.confidence = 2 },
    b => { b.model = 'unsafe model' },
    b => { b.usage.total_input_tokens = -1 },
    b => { b.usage.total_output_tokens = 1.5 },
    b => { b.usage.total_output_tokens = null },
    b => { b.answers.extra = answer() },
    b => { b.answers = null },
  ]) {
    const b = body()
    mutate(b)
    assert.throws(() => parseDecisionResponse(b, ['a1']), /unavailable/)
  }
})

test('Decision transport sends the Gemini wire contract without Authorization', async () => {
  let seen
  const result = await checkDecisionBatch({
    prepared, enabled: true, apiKey: ' fixture ', timeoutMs: 1000,
    fetchImpl: async (url, init) => { seen = { url, init }; return Response.json(body()) },
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.requestCount, 1)
  assert.equal(result.usage.inputTokens, 20)
  assert.equal(result.model, undefined)
  assert.equal(seen.url, DECISION_ENDPOINT)
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['x-goog-api-key'], 'fixture')
  assert.equal(Object.keys(seen.init.headers).includes('Authorization'), false)
  const payload = JSON.parse(seen.init.body)
  assert.deepEqual(Object.keys(payload).sort(), ['input', 'model', 'questions'])
  assert.equal(payload.model, DECISION_MODEL)
  assert.equal(payload.state, undefined)
  assert.equal(typeof payload.input, 'string')
})

test('Decision transport reports disabled, empty and missing-key skips without a request', async () => {
  const cases = [
    ['disabled', { enabled: false }],
    ['no-eligible-claims', { enabled: true, prepared: { ...prepared, checks: [{ id: 'a1', status: 'skipped', reason: 'sensitive-input' }] } }],
    ['missing-key', { enabled: true, apiKey: '' }],
    ['time-unavailable', { enabled: true, apiKey: 'fixture', timeoutMs: 0 }],
  ]
  for (const [reason, overrides] of cases) {
    let calls = 0
    const result = await checkDecisionBatch({ prepared, enabled: true, apiKey: 'fixture', fetchImpl: async () => { calls++; return Response.json(body()) }, ...overrides })
    assert.equal(result.reason, reason)
    assert.equal(calls, 0)
    assert.equal(result.requestCount, 0)
  }
})

test('Decision transport maps safety refusals, bounds bodies and never echoes upstream data', async () => {
  for (const options of [{ endpoint: 'http://invalid.test' }, { endpoint: 'https://u:p@invalid.test/' }, { endpoint: 'https://invalid.test/?key=x' }, { model: 'invalid model' }, { apiKey: 'invalid key' }]) {
    let calls = 0
    const result = await checkDecisionBatch({ prepared, enabled: true, apiKey: 'fixture', ...options, fetchImpl: async () => { calls++; return Response.json(body()) } })
    assert.equal(result.reason, 'invalid-config')
    assert.equal(calls, 0)
  }
  const cases = [
    ['safety-blocked', async () => new Response(JSON.stringify({ error: { code: 'safety', message: 'PRIVATE_BODY' } }), { status: 400 })],
    ['safety-blocked', async () => Response.json({ prompt_feedback: { block_reason: 'PRIVATE_BODY' }, answers: { a1: answer() } })],
    ['http-error', async () => new Response('PRIVATE_BODY', { status: 503 })],
    ['http-error', async () => new Response(JSON.stringify({ error: { code: 'invalid_argument' } }), { status: 400 })],
    ['invalid-response', async () => new Response('x'.repeat(70 * 1024))],
    ['timeout', async () => new Response(new ReadableStream({ start() {} }))],
  ]
  for (const [reason, fetchImpl] of cases) {
    let calls = 0
    const result = await checkDecisionBatch({ prepared, enabled: true, apiKey: 'fixture', timeoutMs: 10, fetchImpl: async (...args) => { calls++; return fetchImpl(...args) } })
    assert.equal(result.reason, reason)
    assert.equal(calls, 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|fixture/)
  }
})

test('host credential resolution shares the check deadline and degrades safely', async () => {
  const hanging = await checkDecisionBatch({
    prepared, enabled: true, timeoutMs: 10,
    resolveConnection: () => new Promise(() => {}),
    fetchImpl: async () => { throw new Error('must not request') },
  })
  assert.equal(hanging.status, 'error')
  assert.equal(hanging.reason, 'timeout')
  assert.equal(hanging.requestCount, 0)

  const failing = await checkDecisionBatch({
    prepared, enabled: true,
    resolveConnection: () => { throw new Error('vault PRIVATE_BODY') },
    fetchImpl: async () => { throw new Error('must not request') },
  })
  assert.equal(failing.status, 'skipped')
  assert.equal(failing.reason, 'missing-key')
  assert.equal(failing.requestCount, 0)
  assert.doesNotMatch(JSON.stringify(failing), /PRIVATE_BODY|vault/)

  const controller = new AbortController()
  const pending = checkDecisionBatch({
    prepared, enabled: true, timeoutMs: 5000, signal: controller.signal,
    resolveConnection: () => new Promise(() => {}),
    fetchImpl: async () => { throw new Error('must not request') },
  })
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reason, 'cancelled')

  let seen
  const resolved = await checkDecisionBatch({
    prepared, enabled: true,
    resolveConnection: async () => ({ endpoint: DECISION_ENDPOINT, model: DECISION_MODEL, apiKey: ' resolved-key ' }),
    fetchImpl: async (url, init) => { seen = { url, init }; return Response.json(body()) },
  })
  assert.equal(resolved.status, 'completed')
  assert.equal(seen.url, DECISION_ENDPOINT)
  assert.equal(seen.init.headers['x-goog-api-key'], 'resolved-key')
})

test('Decision transport cancels a hanging request without retrying', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = checkDecisionBatch({
    prepared, enabled: true, apiKey: 'fixture', timeoutMs: 5000, signal: controller.signal,
    fetchImpl: async (url, init) => {
      calls++
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.equal(result.reason, 'cancelled')
  assert.equal(calls, 1)
})
