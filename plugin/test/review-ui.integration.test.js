// Review-UI INTEGRATION tests: execute the actual apply() + hydrate() and the
// ReviewButton component effects against a fake Remote RPC and a hook runner.
// These prove the WIRING (RPC → store → component state → label / DOM attrs),
// which pure-helper assertions alone cannot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, mockTimers, flush } from './review-ui.harness.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ── hydrate wiring ────────────────────────────────────────────────────────
test('hydrate absorbs reviews + seeds sent/meta from the list result', async () => {
  const rt = await createRuntime({
    list: () => ({
      reviews: [{ messageId: 'm1', reviewId: 'r1', status: 'sound', createdAt: 100, annotations: [{ severity: 'nit', title: 't' }] }],
      sentKeys: ['r1#0'],
      triage: { r1: { states: { '0': 'dismiss' }, filter: 'blocker' } },
    }),
  })
  const { store, hydrate } = rt.runtime
  await hydrate('s1')
  assert.equal(store.byMessage.get('m1').reviewId, 'r1')
  assert.ok(store.hydrated.has('s1'))
  assert.ok(store.feedback.sent.get('r1').has(0))
  assert.equal(store.feedback.meta.get('r1').filter, 'blocker')
  assert.equal(store.feedback.meta.get('r1').triageStates['0'], 'dismiss')
})

test('hydrate does NOT mark loaded on error-shaped list result (retries on next call)', async () => {
  const rt = await createRuntime({ list: () => ({ ok: false, error: 'boom' }) })
  const { store, hydrate } = rt.runtime
  await hydrate('s1')
  assert.ok(!store.hydrated.has('s1'))
  assert.ok(store.retrySessions.has('s1'))
})

test('hydrate(force) while a load is pending chains a FRESH load (does not settle from stale)', async () => {
  const slow = deferred()
  let listCalls = 0
  const rt = await createRuntime({
    list: () => {
      listCalls += 1
      if (listCalls === 1) return slow.promise
      return { reviews: [{ messageId: 'm1', reviewId: 'r2', status: 'sound', createdAt: 200 }], sentKeys: [], triage: {} }
    },
  })
  const { store, hydrate } = rt.runtime
  const h1 = hydrate('s1')
  const h2 = hydrate('s1', { force: true })
  slow.resolve({ reviews: [{ messageId: 'm1', reviewId: 'r1', status: 'error', error: 'stale', createdAt: 50 }], sentKeys: [], triage: {} })
  await h1
  await h2
  await flush()
  assert.equal(listCalls, 2, 'forced hydrate must trigger a fresh list call')
  // The terminal (fresher) result wins, not the stale one the in-flight query returned.
  assert.equal(store.byMessage.get('m1').reviewId, 'r2')
  assert.ok(store.hydrated.has('s1'))
})

// ── absorb createdAt fence ────────────────────────────────────────────────
test('absorb fences by createdAt: newer wins; old list never clobbers a newer start result', async () => {
  const rt = await createRuntime({})
  const { store, absorb } = rt.runtime
  absorb({ messageId: 'm1', reviewId: 'old', status: 'error', error: 'x', createdAt: 100, annotations: [] })
  absorb({ messageId: 'm1', reviewId: 'new', status: 'sound', createdAt: 200, annotations: [] })
  assert.equal(store.byMessage.get('m1').reviewId, 'new')
  // an OLD list entry must not clobber the newer one
  absorb({ messageId: 'm1', reviewId: 'stale', status: 'sound', createdAt: 150, annotations: [] })
  assert.equal(store.byMessage.get('m1').reviewId, 'new')
})

test('absorb order: transient never overwrites durable; newer transient wins over older transient', async () => {
  const rt = await createRuntime({})
  const { store, absorb } = rt.runtime
  // a transient (marked) must NOT overwrite a durable reviewId entry
  absorb({ messageId: 'm2', reviewId: 'old2', status: 'sound', createdAt: 100, annotations: [] })
  absorb({ messageId: 'm2', status: 'error', error: 'failed', annotations: [], createdAt: Date.now(), transient: true })
  assert.equal(store.byMessage.get('m2').reviewId, 'old2', 'durable must survive a transient')
  // newer transient replaces an older transient (same low tier, time-based)
  absorb({ messageId: 'm3', status: 'error', error: 'first', annotations: [], createdAt: 100, transient: true })
  absorb({ messageId: 'm3', status: 'error', error: 'second', annotations: [], createdAt: 200, transient: true })
  assert.equal(store.byMessage.get('m3').error, 'second')
  // a durable replaces any transient regardless of timestamp
  absorb({ messageId: 'm4', status: 'error', error: 'e', annotations: [], createdAt: 200, transient: true })
  absorb({ messageId: 'm4', reviewId: 'real', status: 'sound', createdAt: 100, annotations: [] })
  assert.equal(store.byMessage.get('m4').reviewId, 'real', 'durable outranks transient regardless of wall clock')
})

// ── reconnect reconcile ───────────────────────────────────────────────────
test('connection/reset force-reconciles already-hydrated sessions (not only retrySessions)', async () => {
  const rt = await createRuntime({
    list: () => ({ reviews: [{ messageId: 'm1', reviewId: 'r1', status: 'sound', createdAt: 100 }], sentKeys: [], triage: {} }),
  })
  const { store, hydrate } = rt.runtime
  await hydrate('s1')
  assert.ok(store.hydrated.has('s1'))
  const before = rt.rpcCalls.list.length
  rt.fireConnectionReset()
  await flush()
  assert.ok(rt.rpcCalls.list.length > before, 'reconnect must re-fetch loaded sessions too')
})

test('rehydrate returning a committed durable result replaces a LATER transient error (lost RPC)', async () => {
  // host committed a durable result at t=100, but the RPC response was lost and
  // the browser recorded a transient error at t=200 (later wall clock). The
  // later transient must NOT outrank the durable result.
  const rt = await createRuntime({
    list: () => ({ reviews: [{ messageId: 'm1', reviewId: 'r1', status: 'sound', createdAt: 100 }], sentKeys: [], triage: {} }),
  })
  const { store, absorb, hydrate } = rt.runtime
  absorb({ messageId: 'm1', status: 'error', error: 'RPC lost', annotations: [], createdAt: 200, transient: true })
  assert.equal(store.byMessage.get('m1').status, 'error')
  await hydrate('s1')
  assert.equal(store.byMessage.get('m1').reviewId, 'r1', 'durable host result must outrank the later transient')
})

test('a transient error never overwrites an existing durable review', async () => {
  const rt = await createRuntime({})
  const { store, absorb } = rt.runtime
  absorb({ messageId: 'm1', reviewId: 'r1', status: 'sound', createdAt: 100 })
  absorb({ messageId: 'm1', status: 'error', error: 'transport', annotations: [], createdAt: Date.now(), transient: true })
  assert.equal(store.byMessage.get('m1').reviewId, 'r1', 'durable must survive a later transient')
})

test('plugin teardown clears the __test.runtime capture (no retained stopped runtime)', async () => {
  const rt = await createRuntime({})
  assert.ok(Object.keys(rt.runtime).length > 0, 'runtime populated after apply')
  rt.dispose()
  assert.equal(Object.keys(rt.runtime).length, 0, 'runtime cleared on teardown')
})

// ── ReviewButton progress wiring ──────────────────────────────────────────
test('mounting ReviewButton wires progress RPC → prog state → in-flight label', async () => {
  const rt = await createRuntime({
    progress: () => ({ inFlight: true, phase: 2, toolCalls: 0, budget: 5, suspects: 3, explore: true, action: { kind: 'thinking' } }),
    list: () => ({ reviews: [], sentKeys: [], triage: {} }),
  })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    effects[1].fn() // progress effect → probe()
    effects[2].fn() // hydrate effect
    await flush()
    assert.deepEqual(rt.rpcCalls.progress[0], { sessionId: 's1', messageId: 'm1' })
    // re-render reflects prog in the button label (phase 2 + zero tools → 核验)
    const el = runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
    const btnProps = el.__element[2].__element[1]
    const label = el.__element[2].__element[2]
    assert.match(label, /核验/, 'phase2 + zero tools must say verification')
    assert.equal(btnProps['data-ciel-session-id'], 's1')
    assert.equal(btnProps['data-ciel-message-id'], 'm1')
  } finally {
    timers.restore()
  }
})

test('malformed progress response ({}) is NOT treated as idle — polling continues', async () => {
  let progressCalls = 0
  const rt = await createRuntime({ progress: () => { progressCalls += 1; return {} } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    effects[1].fn()
    await flush()
    const initial = progressCalls
    timers.fireTick()
    timers.fireTick()
    await flush()
    assert.ok(progressCalls >= initial + 1, `expected continued polling, got ${progressCalls}`)
  } finally {
    timers.restore()
  }
})

test('progress inFlight->false triggers a force rehydrate (list refetched)', async () => {
  let listCalls = 0
  const rt = await createRuntime({
    progress: () => ({ inFlight: true, phase: 2, toolCalls: 1, budget: 5, explore: true, action: { kind: 'tool', name: 'read' } }),
    list: () => { listCalls += 1; return { reviews: [{ messageId: 'm1', reviewId: 'r1', status: 'sound', createdAt: 100 }], sentKeys: [], triage: {} } },
  })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    effects[1].fn()
    effects[2].fn()
    await flush()
    const before = listCalls
    rt.rpcImpl.progress = () => ({ inFlight: false })
    timers.fireTick()
    await flush()
    assert.ok(listCalls > before, 'inFlight->false must force-rehydrate')
  } finally {
    timers.restore()
  }
})

// ── cancel wiring ─────────────────────────────────────────────────────────
test('stop control is visible during in-flight and cancel() fires with session+message', async () => {
  const rt = await createRuntime({
    progress: () => ({ inFlight: true, phase: 2, toolCalls: 1, budget: 5, explore: true }),
    cancel: () => ({ ok: true, cancelled: true }),
  })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    effects[1].fn()
    await flush()
    const el = runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
    const stopBtn = el.__element[3]
    assert.ok(stopBtn, 'stop control must be present while in flight')
    stopBtn.__element[1].onClick()
    await flush()
    assert.equal(rt.rpcCalls.cancel.length, 1)
    assert.deepEqual(rt.rpcCalls.cancel[0], { sessionId: 's1', messageId: 'm1' })
  } finally {
    timers.restore()
  }
})

// ── AB / correlation data attributes ──────────────────────────────────────
test('review button carries data-ciel session/message + critic route attrs when snapshot ready', async () => {
  const rt = await createRuntime({}, { settingsValue: { criticProvider: 'google', criticModel: 'gemini-3.8-flash' } })
  const el = rt.runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const props = el.__element[2].__element[1]
  assert.equal(props['data-ciel-session-id'], 's1')
  assert.equal(props['data-ciel-message-id'], 'm1')
  assert.equal(props['data-ciel-critic-provider'], 'google')
  assert.equal(props['data-ciel-critic-model'], 'gemini-3.8-flash')
})

test('review button omits route attrs when scope has no getSnapshot (fail closed); id attrs stay', async () => {
  const rt = await createRuntime({}, { noGetSnapshot: true })
  const el = rt.runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const props = el.__element[2].__element[1]
  assert.equal(props['data-ciel-session-id'], 's1')
  assert.equal(props['data-ciel-message-id'], 'm1')
  assert.equal(props['data-ciel-critic-provider'], undefined)
  assert.equal(props['data-ciel-critic-model'], undefined)
})
