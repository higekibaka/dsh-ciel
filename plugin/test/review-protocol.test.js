import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_METHODS, reviewInvocation, parseReviewRequest, parseReviewResult } from '../review-protocol.js'
import { requestFixtures, resultFixtures } from './review-protocol.fixtures.js'
for (const method of REVIEW_METHODS) test(method + ' shares strict factories and legacy schema adapter', () => {
  const d = reviewInvocation(method)
  for (const [codec, valid] of [[d.parameters[0].codec, requestFixtures[method]], [d.result, resultFixtures[method]]]) {
    assert.equal(codec.create().parse(valid), valid)
    assert.equal(codec.schema.parse(valid), valid)
    for (const bad of [null, [], true, 'secret-sentinel']) assert.throws(() => codec.create().parse(bad), error => !error.message.includes('secret-sentinel') && /^CIEL_PROTOCOL_/.test(error.code))
  }
  assert.deepEqual(parseReviewResult(method, { ok: false, code: 'fixture', error: 'retry', retryable: false }), { ok: false, code: 'fixture', error: 'retry', retryable: false })
})
test('unknown fields, unbounded pages, malformed indices and model routes are refused', () => {
  for (const [method, bad] of [
    ['start', { sessionId: 's', messageId: 'm', unrestricted: true }],
    ['list', { sessionId: '../x' }], ['list', { sessionId: 's', limit: 101 }],
    ['triage', { sessionId: 's', reviewId: 'r', changes: [{ index: 8, state: 'accept' }] }],
    ['prepareFeedback', { ...requestFixtures.prepareFeedback, items: [{ index: 0, text: 'forged annotation' }] }],
    ['inboxSetIntent', { ...requestFixtures.inboxSetIntent, expectedRevision: -1 }],
  ]) assert.throws(() => parseReviewRequest(method, bad), { code: 'CIEL_PROTOCOL_REQUEST_INVALID' })
  for (const [method, bad] of [
    ['progress', { inFlight: 'no' }], ['list', { reviews: [{}] }],
    ['callModelUsage', { modelUsage: { used: [{ provider: 'p', model: 1 }] } }],
    ['inboxList', { ...resultFixtures.inboxList, nextCursor: {} }],
  ]) assert.throws(() => parseReviewResult(method, bad), { code: 'CIEL_PROTOCOL_RESPONSE_INVALID' })
})
