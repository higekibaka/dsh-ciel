import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceRequest, readAnswer, runExperiment, MODEL } from '../../scripts/jev-evidence-shadow.mjs'
import { cases, diagnosticCases } from '../../scripts/fixtures/jev-evidence-cases.mjs'

const response = (overrides = {}) => ({
  model: MODEL, usage: { input_tokens: 30, output_tokens: 0 },
  answers: { relation: { type: 'choice', choice: 'insufficient', probabilities: { supports: 0.1, contradicts: 0.2, insufficient: 0.7 }, confidence: 0.5, ...overrides } },
})

test('dry run cannot spend or claim measured accuracy; requests do not leak expected labels', async () => {
  const report = await runExperiment({ fetchImpl: () => { throw new Error('network forbidden') } })
  assert.equal(report.networkRequests, 0)
  assert.equal(report.summary.completed, 0)
  assert.equal(report.results.length, cases.length)
  assert.ok(report.results.every(row => row.status === 'not-run'))
  assert.deepEqual(evidenceRequest(cases[0]).state, { claim: cases[0].claim, evidence: cases[0].evidence })
})

test('diagnostic mode selects only the six labelled scope cases and preserves exact requests', async () => {
  let calls = 0
  const report = await runExperiment({ live: true, diagnostic: true, apiKey: 'fixture-only', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body)
    assert.deepEqual(request.state, evidenceRequest(diagnosticCases[calls++]).state)
    assert.equal(Object.hasOwn(request.state, 'expected'), false)
    return { ok: true, json: async () => response() }
  } })
  assert.equal(calls, 6)
  assert.equal(report.dataset, 'scope-diagnostic-v1')
  assert.equal(report.summary.planned, 6)
  assert.deepEqual(report.results.map(row => row.request), diagnosticCases.map(evidenceRequest))
})

test('shadow transport validates protocol, records actual model, and never changes review verdicts', async () => {
  let requests = 0
  const report = await runExperiment({ live: true, apiKey: 'fixture-only', fetchImpl: async (url, options) => {
    requests++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(options.redirect, 'error')
    assert.equal(JSON.parse(options.body).model, MODEL)
    return { ok: true, json: async () => response() }
  } })
  assert.equal(report.summary.completed, cases.length)
  assert.equal(requests, cases.length)
  assert.equal(report.changesReviewVerdicts, false)
  assert.equal(report.summary.disagreements, cases.filter(sample => sample.expected !== 'insufficient').length)
  assert.equal(JSON.stringify(report).includes('fixture-only'), false)
  for (const invalid of [
    { choice: 'invented' }, { confidence: NaN }, { choice: 'supports' },
    { probabilities: { supports: 0, contradicts: 0, insufficient: 0 } },
    { probabilities: { supports: 0, contradicts: 0, insufficient: 1, extra: 0 } },
  ]) assert.throws(() => readAnswer(response(invalid)), /Invalid Jev/)
})

test('missing key or endpoint failure cannot yield a judgement or repeated paid calls', async () => {
  await assert.rejects(runExperiment({ live: true, apiKey: '' }), /TYPESAFE_API_KEY/)
  let requests = 0
  const report = await runExperiment({ live: true, apiKey: 'fixture-only', fetchImpl: async () => {
    requests++
    throw new Error('private response fixture-only')
  } })
  assert.equal(requests, 1)
  assert.equal(report.summary.completed, 0)
  assert.equal(report.summary.errors, 1)
  assert.equal(JSON.stringify(report).includes('private response'), false)
})
