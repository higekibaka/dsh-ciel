import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from './review-ui.harness.js'

test('client hydration follows bounded host pages without dropping review or triage entries', async t => {
  const rt = await createRuntime(); t.after(() => rt.dispose())
  const seen = []
  const load = rt.moduleExports.__test.loadReviewPages
  const result = await load(async (method, request) => {
    seen.push([method, request])
    return request.cursor ? { reviews: [{ reviewId: 'r2' }], triage: { r2: { states: { 1: 'dismiss' } } }, nextCursor: null, limited: false }
      : { reviews: [{ reviewId: 'r1' }], triage: { r1: { states: { 0: 'accept' } } }, nextCursor: 'opaque-next', limited: true }
  }, 's')
  assert.deepEqual(result.reviews.map(r => r.reviewId), ['r1', 'r2'])
  assert.equal(result.triage.r2.states[1], 'dismiss')
  assert.deepEqual(seen, [['list', { sessionId: 's' }], ['list', { sessionId: 's', cursor: 'opaque-next' }]])
})
test('client rejects repeated cursor, missing cursor on limited page and cancellation', async t => {
  const rt = await createRuntime(); t.after(() => rt.dispose())
  const load = rt.moduleExports.__test.loadReviewPages
  await assert.rejects(load(async () => ({ reviews: [], nextCursor: 'same', limited: true }), 's'), /分页没有进展/)
  await assert.rejects(load(async () => ({ reviews: [], limited: true }), 's'), /缺少后续游标/)
  await assert.rejects(load(async () => { throw new Error('must not call') }, 's', () => false), /client stopped/)
  assert.deepEqual(await load(async () => ({ ok: false, error: 'offline' }), 's'), { ok: false, error: 'offline' })
})
