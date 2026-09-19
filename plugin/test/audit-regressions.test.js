import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRuntime, mockTimers, flush } from './performance-review-ui.harness.js'
import { reviewHarness } from './host-harness.js'
import { readRecord } from '../record-store.js'
import { createReviewOperation } from '../review-operation.js'
import { reviewMessageKey } from '../review-identity.js'
import { reviewFailure } from '../review-errors.js'

const home = await mkdtemp('/tmp/ciel-regressions-')
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))

test('forked messages never inherit another session review, including delayed/misrouted results', async t => {
  const rt = await createRuntime({ list: ({ sessionId }) => ({ reviews: sessionId === 'parent'
    ? [{ sessionId, messageId: 'shared', reviewId: 'parent-review', createdAt: 10, status: 'sound' }] : [] }) })
  t.after(() => rt.dispose())
  await rt.runtime.hydrate('parent')
  await rt.runtime.hydrate('fork')
  const store = rt.runtime.store.byMessage
  assert.equal(store.has(reviewMessageKey('fork', 'shared')), false)
  let tree = rt.runner.render(rt.ReviewButton, { sessionId: 'fork', messageId: 'shared' })
  assert.doesNotMatch(tree.__element[2].__element[2], /无阻断|复审/)
  rt.runtime.absorb({ sessionId: 'fork', messageId: 'shared', reviewId: 'fork-review', createdAt: 20 })
  rt.runtime.absorb({ sessionId: 'parent', messageId: 'shared', reviewId: 'late-parent', createdAt: 30 }, 'fork')
  assert.equal(store.get(reviewMessageKey('parent', 'shared')).reviewId, 'parent-review')
  assert.equal(store.get(reviewMessageKey('fork', 'shared')).reviewId, 'fork-review')
})

for (const boundary of ['evidence', 'summary-prepared', 'reviews']) {
  test('cancel at ' + boundary + ' publication agrees with API and disk terminal state', async t => {
    const h = await reviewHarness(['## verdict: pass\nsummary: synthetic result'], { criticExploreEnabled: false })
    t.after(() => h.dispose())
    let release, arrived, intercepted = false
    const paused = new Promise(resolve => { release = resolve })
    const reached = new Promise(resolve => { arrived = resolve })
    const original = fs.promises.rename
    const originalOpen = fs.promises.open
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (boundary === 'summary-prepared' && !intercepted && String(args[0]).includes('/ciel/v1/reviews/') && args[1] === 'wx') {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); intercepted = true; arrived(); await paused }
      }
      return handle
    }
    fs.promises.rename = async (...args) => {
      if (!intercepted && String(args[1]).includes('/ciel/v1/' + boundary + '/')) {
        intercepted = true
        arrived()
        await paused
      }
      return original(...args)
    }
    syncBuiltinESMExports()
    try {
      const pending = h.start()
      await reached
      const cancelled = await h.cancel()
      release()
      const result = await pending
      const stored = await readRecord('reviews', h.sid, result.review.reviewId)
      assert.equal(cancelled.cancelled, boundary !== 'reviews')
      assert.equal(result.ok, boundary === 'reviews')
      assert.equal(result.review.status, boundary !== 'reviews' ? 'cancelled' : 'unverified')
      assert.equal(stored.status, result.review.status)
      assert.equal(result.review.sessionId, h.sid)
    } finally {
      release()
      fs.promises.rename = original
      fs.promises.open = originalOpen
      syncBuiltinESMExports()
    }
  })
}

test('timeout and cancellation cannot cross the synchronous terminal fence', () => {
  let now = 0
  const op = createReviewOperation({ timeoutMs: 10, now: () => now })
  op.beginCommit()
  now = 20
  assert.equal(op.cancel('review cancelled by user'), false)
  op.check()
  assert.equal(op.signal.aborted, false)
  assert.throws(() => op.beforeRequest(), /settled/)
  op.dispose()
  const late = createReviewOperation({ timeoutMs: 10, now: () => now })
  now = 40
  assert.throws(() => late.beginCommit(), /timeout/)
  assert.equal(late.signal.aborted, true)
  late.dispose()
})

test('progress failures back off, stop after four calls, and explicit retry recovers without starting a model', async t => {
  let healthy = false, calls = 0
  const rt = await createRuntime({ progress: () => { calls++; return healthy ? { inFlight: false } : { ok: false, error: 'offline' } } })
  t.after(() => rt.dispose())
  rt.runner.render(rt.ReviewButton, { sessionId: 's', messageId: 'm' })
  const timers = mockTimers()
  try {
    const cleanup = rt.runner.getEffects()[1].fn()
    await flush()
    for (let i = 0; i < 120; i++) { timers.fireTick(); await flush() }
    assert.equal(calls, 4)
    assert.equal(timers.intervalCount(), 0)
    assert.match(rt.runtime.store.progressErrors.get(reviewMessageKey('s', 'm')), /暂停/)
    healthy = true
    const tree = rt.runner.render(rt.ReviewButton, { sessionId: 's', messageId: 'm' })
    const retry = tree.__element.find(n => n?.__element?.[1]?.className === 'dsr-progress-retry')
    retry.__element[1].onClick()
    await flush()
    assert.equal(calls, 5)
    assert.equal(rt.runtime.store.progressErrors.size, 0)
    assert.equal(rt.rpcCalls.start.length, 0)
    cleanup()
  } finally { timers.restore() }
})

test('permanent capability failure pauses immediately and reconnect resumes once', async t => {
  const rt = await createRuntime({ progress: { ok: false, code: 'CIEL_REMOTE_INTERFACE_MISMATCH', error: 'incompatible', retryable: false } })
  t.after(() => rt.dispose())
  rt.runner.render(rt.ReviewButton, { sessionId: 's', messageId: 'm' })
  const timers = mockTimers()
  try {
    rt.runner.getEffects()[1].fn()
    await flush()
    assert.equal(timers.intervalCount(), 0)
    rt.fireConnectionReset()
    await flush()
    assert.equal(rt.rpcCalls.progress.length, 2)
    assert.equal(timers.intervalCount(), 0)
  } finally { timers.restore() }
})

test('backend failure code survives orchestration and persists without its original secret cause', async t => {
  const h = await reviewHarness([], { criticExploreEnabled: false })
  t.after(() => h.dispose())
  h.service.coordinator.ensureReviewBackend = async () => { throw reviewFailure('CIEL_REVIEW_MODULE_MISSING', 'dependencies') }
  const result = await h.start()
  assert.equal(result.code, 'CIEL_REVIEW_MODULE_MISSING')
  assert.equal(result.stage, 'dependencies')
  assert.equal(result.retryable, false)
  const stored = await readRecord('reviews', h.sid, result.review.reviewId)
  assert.equal(stored.code, result.code)
  assert.equal(stored.stage, result.stage)
  assert.equal(h.requests.length, 0)
})

test('a start finishing after session switch is cached only for its origin', async t => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const rt = await createRuntime({ start: () => pending })
  t.after(() => rt.dispose())
  const tree = rt.runner.render(rt.ReviewButton, { sessionId: 'parent', messageId: 'shared' })
  tree.__element[2].__element[1].onClick()
  await flush()
  rt.runner.render(rt.ReviewButton, { sessionId: 'fork', messageId: 'shared' })
  release({ ok: true, review: { sessionId: 'parent', messageId: 'shared', reviewId: 'late', status: 'sound', createdAt: 1 } })
  await flush()
  assert.equal(rt.runtime.store.byMessage.get(reviewMessageKey('parent', 'shared')).reviewId, 'late')
  assert.equal(rt.runtime.store.byMessage.has(reviewMessageKey('fork', 'shared')), false)
})
