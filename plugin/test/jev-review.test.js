import { resolvedConfig } from './config-fixture.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareJevReview, parseJevResponse, checkReviewWithJev, JEV_MODEL } from '../jev-review.js'
import { Config, parseSuspectResponse } from '../index.js'
import { jevConnection, JEV_ENDPOINT } from '../jev-config.js'
import { parseReviewResult } from '../review-protocol.js'
import { reviewHarness, SUSPECT, verdict } from './host-harness.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-jev-test-'))
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const claim = 'The file has 42 lines.'
const fixture = () => ({
  suspects: [{ id: 's1', block: 'b1', claim }], blocks: [{ id: 'b1', text: claim }],
  parsed: { outcomes: [{ id: 's1', outcome: 'cleared', evidenceRefs: ['e1'] }], annotations: [],
    evidenceRecords: [{ id: 'e1', kind: 'source', origin: 'review-tool', path: '/project/fixture.js', startLine: 1, endLine: 42,
      content: Array.from({ length: 42 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n', truncated: false, source: { hostPath: '/private/should-not-send' } }] },
})
const answer = (ids = ['s1'], choice = 'supports') => ({ model: JEV_MODEL,
  answers: Object.fromEntries(ids.map(id => [id, { type: 'choice', choice, confidence: 0.8,
    probabilities: { supports: choice === 'supports' ? 0.8 : 0.1, contradicts: choice === 'contradicts' ? 0.8 : 0.1, insufficient: choice === 'insufficient' ? 0.8 : 0.1 } }])),
  usage: { input_tokens: 200, output_tokens: 20 },
})
const check = options => checkReviewWithJev({ prepared: prepareJevReview(fixture()), enabled: true, apiKey: 'fixture-key', ...options })

test('Jev connection defaults, precedence and environment credential scope are explicit', () => {
  const defaults = resolvedConfig({})
  assert.equal(defaults.jevEndpoint, JEV_ENDPOINT)
  assert.equal(defaults.jevModel, JEV_MODEL)
  assert.equal(defaults.jevApiKey, undefined)
  assert.equal(Config.dict.jevApiKey.meta.role, 'secret')
  assert.equal(jevConnection({}, 'env-fixture').apiKey, 'env-fixture')
  assert.equal(jevConnection({ jevApiKey: 'saved-fixture' }, 'env-fixture').apiKey, 'saved-fixture')
  assert.equal(jevConnection({ jevEndpoint: 'https://proxy.invalid/systemone' }, 'env-fixture').apiKey, '')
  for (const config of [{ jevEndpoint: 'http://proxy.invalid' }, { jevEndpoint: 'https://user:password@proxy.invalid/' }, { jevModel: 'bad model' }, { jevApiKey: 'key with spaces' }]) {
    assert.throws(() => resolvedConfig(config))
  }
})

test('custom endpoint and model reach the wire but connection secrets never reach results', async () => {
  const endpoint = 'https://proxy.invalid/custom/systemone', model = 'jev-custom'
  const prepared = prepareJevReview(fixture())
  const result = await check({ prepared, endpoint, model, fetchImpl: async (url, options) => {
    assert.equal(url, endpoint)
    assert.equal(options.redirect, 'error')
    assert.equal(JSON.parse(options.body).model, model)
    return Response.json({ ...answer(), model: 'jev-resolved' })
  } })
  assert.equal(prepared.request.model, JEV_MODEL)
  assert.equal(result.requestedModel, model)
  assert.equal(result.model, 'jev-resolved')
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|proxy.invalid/)
})

test('invalid connection values fail closed before transport and do not echo input', async () => {
  for (const options of [{ endpoint: 'http://proxy.invalid' }, { endpoint: 'https://u:p@proxy.invalid' }, { endpoint: 'https://proxy.invalid/?key=private' }, { endpoint: 'https://proxy.invalid:99999/' }, { model: 'private invalid model' }, { apiKey: 'private invalid key' }]) {
    const result = await check({ ...options, fetchImpl: () => assert.fail('must not request') })
    assert.equal(result.reason, 'invalid-config')
    assert.equal(result.requestCount, 0)
    assert.doesNotMatch(JSON.stringify(result), /private|proxy.invalid/)
  }
})

test('default is off; nomination preserves only bounded optional claims', () => {
  assert.equal(resolvedConfig({}).jevEnabled, false)
  assert.equal(parseSuspectResponse(SUSPECT).suspects[0].claim, undefined)
  assert.equal(parseSuspectResponse(SUSPECT + ' | claim: ' + claim).suspects[0].claim, claim)
  assert.equal(parseSuspectResponse(SUSPECT + ' | claim: ' + 'a'.repeat(1001)).suspects[0].claim, undefined)
})

test('request carries exact original evidence and quotes without critic judgments or private paths', () => {
  const input = fixture(), prepared = prepareJevReview(input)
  assert.equal(prepared.checks[0].status, 'pending')
  assert.equal(prepared.request.state.items.s1.evidence[0].content, input.parsed.evidenceRecords[0].content)
  assert.equal(prepared.request.state.items.s1.claim, claim)
  assert.doesNotMatch(JSON.stringify(prepared.request), /should-not-send|cleared|criticOutcome/)
  assert.deepEqual(Object.keys(prepared.request.questions), ['s1'])
})

test('non-verbatim, missing, author-only, truncated, sensitive and oversized input is skipped, never clipped', () => {
  for (const [reason, mutate] of [
    ['no-exact-claim', f => { f.suspects[0].claim = 'Forty-two lines.' }],
    ['no-exact-claim', f => { f.suspects[0].block = 'b9' }],
    ['no-source-evidence', f => { f.parsed.evidenceRecords = [] }],
    ['no-source-evidence', f => { f.parsed.evidenceRecords[0].origin = 'author-tool' }],
    ['limited-evidence', f => { f.parsed.evidenceRecords[0].truncated = true }],
    ['sensitive-input', f => { f.parsed.evidenceRecords[0].content = 'api_key = "' + 's'.repeat(40) + '"' }],
    ['input-too-large', f => { f.parsed.evidenceRecords[0].content = '文'.repeat(9000) }],
  ]) {
    const input = fixture(); mutate(input)
    const prepared = prepareJevReview(input)
    assert.equal(prepared.checks[0].reason, reason)
    assert.deepEqual(prepared.request.state.items, {})
  }
  const input = fixture()
  delete input.suspects[0].claim
  input.parsed.annotations.push({ suspect: 's1', anchor: claim })
  assert.equal(prepareJevReview(input).checks[0].claim, claim, 'exact annotation anchor is a fallback')
})

test('batch limit explicitly accounts for additional checks', () => {
  const input = fixture()
  for (let i = 2; i <= 10; i++) {
    input.suspects.push({ ...input.suspects[0], id: 's' + i })
    input.parsed.outcomes.push({ ...input.parsed.outcomes[0], id: 's' + i })
  }
  const prepared = prepareJevReview(input)
  assert.equal(prepared.checks.length, 8)
  assert.equal(prepared.omittedChecks, 2)
  assert.equal(Object.keys(prepared.request.questions).length, 8)
})

test('off, missing key, no budget and no eligible evidence produce zero requests', async () => {
  for (const [reason, options] of [
    ['disabled', { enabled: false }], ['missing-key', { apiKey: '' }], ['time-unavailable', { timeoutMs: 0 }],
    ['no-eligible-claims', { prepared: prepareJevReview({ ...fixture(), suspects: [] }) }],
  ]) {
    const result = await check({ ...options, fetchImpl: () => assert.fail('must not request'), beforeRequest: () => assert.fail('must not count') })
    assert.equal(result.reason, reason)
    assert.equal(result.requestCount, 0)
    assert.ok(result.checks.every(row => row.status === 'skipped'))
  }
})

test('one typed batch records disagreements, usage and actual model with no credentials', async () => {
  let calls = 0, counted = 0
  const result = await check({ beforeRequest: () => counted++, fetchImpl: async (url, options) => {
    calls++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer fixture-key')
    assert.equal(JSON.parse(options.body).state.items.s1.claim, claim)
    return Response.json(answer(['s1'], 'insufficient'))
  } })
  assert.equal(calls, 1); assert.equal(counted, 1)
  assert.equal(result.status, 'completed')
  assert.equal(result.checks[0].disagreement, true)
  assert.equal(result.checks[0].relation, 'insufficient')
  assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 20 })
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|Authorization/)
})

test('untrusted response choices, distributions, model and usage are validated', () => {
  for (const mutate of [
    a => { a.answers = {} }, a => { a.answers.s1.choice = 'unknown' }, a => { a.answers.s1.confidence = NaN },
    a => { a.answers.s1.probabilities.supports = 0.2 }, a => { a.answers.s1.choice = 'contradicts' },
    a => { a.model = '<script>' }, a => { a.usage.input_tokens = -1 }, a => { a.answers.extra = a.answers.s1 },
  ]) { const body = answer(); mutate(body); assert.throws(() => parseJevResponse(body, ['s1']), /unavailable/) }
})

test('transport, HTTP and unbounded response failures have sanitized reports without retries', async () => {
  for (const [reason, fetchImpl] of [
    ['transport-error', async () => { throw new Error('PRIVATE_SERVER_ERROR') }],
    ['http-error', async () => new Response('PRIVATE_SERVER_ERROR', { status: 401 })],
    ['invalid-response', async () => new Response('PRIVATE_SERVER_ERROR')],
    ['invalid-response', async () => new Response('x'.repeat(65537))],
  ]) {
    let calls = 0
    const result = await check({ fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })
    assert.equal(result.status, 'error'); assert.equal(result.reason, reason); assert.equal(calls, 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SERVER_ERROR|fixture-key/)
  }
})

test('the deadline covers hung transports and bodies even when an adapter ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const result = await check({ timeoutMs: 15, fetchImpl })
    assert.equal(result.reason, 'timeout')
    assert.equal(result.requestCount, 1)
  }
})

const scripts = () => [SUSPECT + ' | claim: ' + claim, ({ tool }) => verdict({ evidence: tool().evidence_refs[0] })]
async function harness(t, config = {}) {
  const h = await reviewHarness(scripts(), config)
  t.after(() => h.dispose())
  return h
}

test('disabled integration keeps prompts, request counts and persisted main review unchanged', async t => {
  const h = await harness(t)
  h.service.coordinator.checkJev = () => assert.fail('disabled integration was called')
  const result = await h.start()
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.modelRequests, 2)
  assert.equal(result.review.jev, undefined)
  assert.doesNotMatch(JSON.stringify(h.requests[0]), /optional evidence check/)
})

test('review uses the current shared Jev connection at the optional stage', async t => {
  const h = await harness(t, { jevEnabled: true, jevApiKey: 'old-fixture', jevModel: 'jev-old' })
  h.service.coordinator.checkJev = options => {
    assert.equal(options.apiKey, 'new-fixture')
    assert.equal(options.endpoint, 'https://proxy.invalid/systemone')
    assert.equal(options.model, 'jev-new')
    return checkReviewWithJev({ ...options, fetchImpl: async () => Response.json(answer()) })
  }
  const pending = h.start()
  h.configure({ jevApiKey: 'new-fixture', jevModel: 'jev-new', jevEndpoint: 'https://proxy.invalid/systemone' })
  const result = await pending
  assert.equal(result.review.jev.requestedModel, 'jev-new')
  assert.doesNotMatch(JSON.stringify(await h.service.readReview({ sessionId: h.sid, reviewId: result.review.reviewId })), /new-fixture|old-fixture|proxy.invalid/)
})

test('enabled host persists shadow disagreement and evidence while preserving main verdict', async t => {
  const h = await harness(t, { jevEnabled: true })
  h.service.coordinator.checkJev = options => checkReviewWithJev({ ...options, apiKey: 'fixture-key', fetchImpl: async () => Response.json(answer(['s1'], 'contradicts')) })
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.verdict, 'pass')
  assert.equal(result.review.modelRequests, 3)
  assert.equal(result.review.jev.checks[0].disagreement, true)
  assert.match(JSON.stringify(h.requests[0]), /optional evidence check/)
  const saved = await h.service.readReview({ sessionId: h.sid, reviewId: result.review.reviewId })
  assert.deepEqual(saved.review.jev, result.review.jev)
  parseReviewResult('readReview', saved)
  const evidence = await h.service.readEvidence({ sessionId: h.sid, reviewId: result.review.reviewId, evidenceId: saved.review.jev.checks[0].evidenceRefs[0] })
  assert.match(evidence.evidence.content, /line 42/)
})

for (const failure of ['missing-key', 'http-error', 'timeout']) test('optional ' + failure + ' preserves a finished main review', async t => {
  const h = await harness(t, { jevEnabled: true })
  h.service.coordinator.checkJev = options => checkReviewWithJev({ ...options, apiKey: failure === 'missing-key' ? '' : 'fixture-key', timeoutMs: 15,
    fetchImpl: failure === 'timeout' ? () => new Promise(() => {}) : async () => new Response('', { status: 503 }),
  })
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.jev.reason, failure)
  assert.equal(result.review.modelRequests, failure === 'missing-key' ? 2 : 3)
})

for (const cancelMain of [false, true]) test(cancelMain ? 'main cancellation remains terminal during Jev' : 'turning off Jev aborts only its pending check', async t => {
  const h = await harness(t, { jevEnabled: true })
  let arrived, transportSignal
  const started = new Promise(resolve => { arrived = resolve })
  h.service.coordinator.checkJev = options => checkReviewWithJev({ ...options, apiKey: 'fixture-key', fetchImpl: (_url, options) => {
    transportSignal = options.signal; arrived(); return new Promise(() => {})
  } })
  const pending = h.start()
  await started
  if (cancelMain) await h.cancel()
  else { h.configure({ jevEnabled: false }); h.service.coordinator.cancelJevChecks() }
  const result = await pending
  assert.equal(transportSignal.aborted, true)
  assert.equal(result.review.status, cancelMain ? 'cancelled' : 'sound')
  if (!cancelMain) assert.equal(result.review.jev.status, 'cancelled')
  assert.equal(h.service.coordinator.jevControllers.size, 0)
})

test('switching off before the optional stage prevents its request', async t => {
  const h = await harness(t, { jevEnabled: true })
  h.service.coordinator.checkJev = options => checkReviewWithJev({ ...options, apiKey: 'fixture-key', fetchImpl: () => assert.fail('late request') })
  const pending = h.start()
  h.configure({ jevEnabled: false })
  const result = await pending
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.jev.reason, 'disabled')
  assert.equal(result.review.jev.requestCount, 0)
})
