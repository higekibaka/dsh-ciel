import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_METHODS, reviewInvocation, parseReviewRequest, parseReviewResult } from '../review-protocol.js'
import { requestFixtures, resultFixtures } from './review-protocol.fixtures.js'
test('optional Jev reports preserve legacy results and reject malformed persisted data', () => {
  const valid = { ...resultFixtures.readReview, review: { ...resultFixtures.readReview.review, jev: {
    mode: 'shadow', requestedModel: 'jev-1.13.0', status: 'skipped', requestCount: 0, elapsedMs: 0,
    reason: 'missing-key', checks: [{ suspectId: 's1', criticOutcome: 'cleared', status: 'skipped', reason: 'missing-key', evidenceRefs: ['e1'] }],
  } } }
  assert.equal(parseReviewResult('readReview', valid), valid)
  for (const mutate of [
    j => { j.requestCount = 2 }, j => { j.status = 'pending' }, j => { j.reason = 'SECRET_SERVER_BODY' },
    j => { j.checks[0].evidenceRefs = ['../../file'] }, j => { j.checks = Array(9).fill(j.checks[0]) },
    j => { j.checks[0].status = 'completed'; j.checks[0].confidence = 2 },
  ]) {
    const bad = structuredClone(valid); mutate(bad.review.jev)
    assert.throws(() => parseReviewResult('readReview', bad), { code: 'CIEL_PROTOCOL_RESPONSE_INVALID' })
  }
})
test('optional per-suspect investigations are bounded, identity-unique and backwards compatible', () => {
  const valid = { ...resultFixtures.readReview, review: { ...resultFixtures.readReview.review, investigations: [{
    id: 's1', suspect: 'model identity', status: 'unresolved', outcome: 'unchecked',
    reason: 'Runtime model selection is not in the project snapshot.', toolCalls: 0, modelRequests: 1, elapsedMs: 123, evidenceRefs: [],
  }] } }
  assert.equal(parseReviewResult('readReview', valid), valid)
  assert.equal(parseReviewResult('readReview', resultFixtures.readReview), resultFixtures.readReview)
  for (const mutate of [
    rows => { rows.push({ ...rows[0] }) }, rows => { rows[0].status = 'settled' },
    rows => { rows[0].reason = '' }, rows => { rows[0].toolCalls = -1 },
    rows => { rows[0].evidenceRefs = ['../e1'] }, rows => { rows[0].id = 's9' },
  ]) {
    const bad = structuredClone(valid); mutate(bad.review.investigations)
    assert.throws(() => parseReviewResult('readReview', bad), { code: 'CIEL_PROTOCOL_RESPONSE_INVALID' })
  }
})
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
