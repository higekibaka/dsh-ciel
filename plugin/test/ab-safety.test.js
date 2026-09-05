import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import safety from '../../scripts/ab-safety.cjs'

test('paid AB driver exits before browser loading without explicit opt-in', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/ab-harness.js', import.meta.url))], { encoding: 'utf8', env: { ...process.env, CIEL_ALLOW_PAID_TESTS: '' } })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Paid A\/B testing is disabled/)
})

test('paid AB driver still refuses an implicit author or critic model route', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/ab-harness.js', import.meta.url))], { encoding: 'utf8', env: { ...process.env, CIEL_ALLOW_PAID_TESTS: '1', CIEL_AB_MODEL: '', CIEL_AB_CRITIC_PROVIDER: '' } })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Set CIEL_AB_MODEL/)
})

test('AB identity checks reject unknown or mismatched routes and unsafe paths', () => {
  const id = { sessionId: 's-1', messageId: 'm-1', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
  assert.doesNotThrow(() => safety.assertReviewIdentity(id, id.provider, id.model))
  assert.throws(() => safety.assertReviewIdentity({ ...id, provider: 'google' }, id.provider, id.model), /NOT started/)
  assert.throws(() => safety.assertReviewIdentity({}, id.provider, id.model), /NOT started/)
  assert.throws(() => safety.reviewFileName('../escape'), /unsafe/)
})

test('AB selects only the exact fresh message and ignores unrelated newest records', () => {
  const text = [
    { messageId: 'target', createdAt: 50, reviewId: 'old' },
    { messageId: 'target', createdAt: 110, reviewId: 'wanted' },
    { messageId: 'unrelated', createdAt: 120, reviewId: 'wrong' },
  ].map(JSON.stringify).join('\n') + '\n{"torn"'
  assert.equal(safety.matchingReview(text, 'target', 100).reviewId, 'wanted')
  assert.throws(() => safety.matchingReview(text, 'missing', 100), /exact message/)
  assert.throws(() => safety.matchingReview(text, 'target', 111), /exact message/)
})
