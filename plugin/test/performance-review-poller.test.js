// Stage tests for the shared ReviewButton progress scheduler. Required
// behaviour (user-approved plan): one shared interval, per-session+message
// single-flight, the timer is DESTROYED once no work item wants a probe
// (confirmed idle / no local busy), hidden pages clear the timer and do no
// work, and returning to visible re-synchronizes with a single probe. The
// subscription survives idle so a remount or visibilitychange can probe once.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, mockTimers, flush } from './performance-review-ui.harness.js'

function visibleDoc(visibilityState = 'visible') {
  const listeners = []
  return {
    visibilityState,
    listeners,
    createElement: () => ({
      tagName: '', textContent: '', className: '', style: {},
      appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} }, contains: () => false,
    }),
    head: { appendChild() {} },
    body: {},
    addEventListener(name, fn) { if (name === 'visibilitychange') listeners.push(fn) },
    removeEventListener() {},
  }
}

const notify = (doc) => { for (const listener of doc.listeners) listener() }

function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

test('confirmed idle destroys the shared timer; the subscription stays for a later probe', async () => {
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return { inFlight: false } } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    const cleanup = effects[1].fn() // progress effect → subscribe
    await flush()
    assert.equal(calls, 1, 'mount probes once')
    assert.equal(timers.intervalCount(), 0, 'inFlight:false destroys the shared timer')
    timers.fireTick()
    await flush()
    assert.equal(calls, 1, 'no timer means no idle tick work')
    cleanup()
    assert.equal(timers.intervalCount(), 0)
  } finally {
    timers.restore()
  }
})

test('the same session+message is single-flighted across subscribers and ticks', async () => {
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return { inFlight: true } } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const first = runner.getEffects()
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const second = runner.getEffects()
  const timers = mockTimers()
  try {
    first[1].fn()
    second[1].fn()
    await flush()
    assert.equal(calls, 1, 'two subscribers for one key share one in-flight probe')
    assert.equal(timers.intervalCount(), 1, 'one interval serves both subscribers while in flight')
    timers.fireTick()
    await flush()
    assert.equal(calls, 2, 'one shared tick probes the deduped key exactly once')
  } finally {
    timers.restore()
  }
})

test('an orphaned in-flight probe is not adopted by a new mount; it settles, then re-probes', async () => {
  const pending = deferred()
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return pending.promise } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const first = runner.getEffects()
  const timers = mockTimers()
  try {
    const cleanup = first[1].fn()
    await flush()
    assert.equal(calls, 1, 'the first generation probes once')
    cleanup() // unmount while the probe is still in flight
    runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
    const second = runner.getEffects()
    second[1].fn()
    await flush()
    assert.equal(calls, 1, 'the new mount does not attach to the orphaned probe')
    pending.resolve({ inFlight: false })
    await flush()
    assert.equal(calls, 2, 'once the orphaned probe settles the new generation probes fresh')
    assert.equal(timers.intervalCount(), 0, 'the fresh probe decided idle for the new generation')
  } finally {
    timers.restore()
  }
})

test('overlapping ticks on one in-flight probe issue one RPC and attach one delivery', async () => {
  const pending = deferred()
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return pending.promise } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    effects[1].fn()
    await flush()
    assert.equal(calls, 1, 'the mount probe is pending')
    timers.fireTick()
    timers.fireTick()
    await flush()
    assert.equal(calls, 1, 'ticks while the probe is pending never duplicate the RPC')
    pending.resolve({ inFlight: true, phase: 2 })
    await flush()
    assert.equal(timers.intervalCount(), 1, 'in-flight work keeps the timer armed')
    timers.fireTick()
    await flush()
    assert.equal(calls, 2, 'exactly one effective probe per completed cycle')
  } finally {
    timers.restore()
  }
})

test('an orphan wait that settles while hidden starts no RPC', async () => {
  const pending = deferred()
  let calls = 0
  const doc = visibleDoc('visible')
  const rt = await createRuntime({ progress: () => { calls += 1; return pending.promise } }, { document: doc })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const first = runner.getEffects()
  const timers = mockTimers()
  try {
    const cleanup = first[1].fn()
    await flush()
    assert.equal(calls, 1, 'the first generation probes once')
    cleanup()
    runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
    const second = runner.getEffects()
    second[1].fn()
    await flush()
    assert.equal(calls, 1, 'the new mount waits on the orphaned probe without a new RPC')
    timers.fireTick()
    timers.fireTick()
    await flush()
    assert.equal(calls, 1, 'repeated ticks never start a duplicate orphan wait RPC')
    doc.visibilityState = 'hidden'
    notify(doc)
    pending.resolve({ inFlight: false })
    await flush()
    assert.equal(calls, 1, 'a settle while hidden must not start an RPC')
    assert.equal(timers.intervalCount(), 0, 'and must not re-arm the timer')
    doc.visibilityState = 'visible'
    notify(doc)
    await flush()
    assert.equal(calls, 2, 'regaining visibility probes exactly once')
  } finally {
    timers.restore()
  }
})

test('poller disposal deactivates subscriptions so a late orphan settle cannot resume work', async () => {
  const pending = deferred()
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return pending.promise } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const first = runner.getEffects()
  const timers = mockTimers()
  try {
    const cleanup = first[1].fn()
    await flush()
    assert.equal(calls, 1)
    cleanup()
    runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
    const second = runner.getEffects()
    second[1].fn()
    await flush()
    assert.equal(calls, 1, 'the orphan wait is attached without a new RPC')
    rt.dispose()
    pending.resolve({ inFlight: true })
    await flush()
    assert.equal(calls, 1, 'no RPC after disposal')
    assert.equal(timers.intervalCount(), 0, 'no timer after disposal')
    timers.fireTick()
    await flush()
    assert.equal(calls, 1, 'a cleared interval cannot poll after disposal')
  } finally {
    timers.restore()
  }
})

test('a hidden page clears the timer and does no work; becoming visible re-synchronizes once', async () => {
  let calls = 0
  const doc = visibleDoc('hidden')
  const rt = await createRuntime({ progress: () => { calls += 1; return { inFlight: true } } }, { document: doc })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const effects = runner.getEffects()
  const timers = mockTimers()
  try {
    const cleanup = effects[1].fn()
    await flush()
    assert.equal(calls, 0, 'hidden mount performs no probe')
    assert.equal(timers.intervalCount(), 0, 'no timer while hidden')
    doc.visibilityState = 'visible'
    notify(doc)
    await flush()
    assert.equal(calls, 1, 'becoming visible re-synchronizes with one probe')
    assert.equal(timers.intervalCount(), 1, 'in-flight work re-arms the shared timer')
    rt.rpcImpl.progress = () => { calls += 1; return { inFlight: false } }
    timers.fireTick()
    await flush()
    assert.equal(calls, 2)
    assert.equal(timers.intervalCount(), 0, 'the idle transition destroys the timer again')
    doc.visibilityState = 'hidden'
    notify(doc)
    doc.visibilityState = 'visible'
    notify(doc)
    await flush()
    assert.equal(calls, 3, 'a later visibilitychange still probes the idle subscription once')
    assert.equal(timers.intervalCount(), 0, 'the one-shot re-sync does not re-arm an idle timer')
    timers.fireTick()
    await flush()
    assert.equal(calls, 3, 'and no idle ticks follow')
    cleanup()
    assert.equal(timers.intervalCount(), 0)
  } finally {
    timers.restore()
  }
})

test('a failed/malformed probe is never completion and a remount re-probes the new session', async () => {
  let calls = 0
  const sessions = []
  const rt = await createRuntime({ progress: (req) => { calls += 1; sessions.push(req.sessionId); return {} } })
  const runner = rt.runner
  runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const first = runner.getEffects()
  const timers = mockTimers()
  try {
    first[1].fn()
    await flush()
    const afterMount = calls
    assert.equal(timers.intervalCount(), 0, 'a protocol mismatch pauses synchronization')
    timers.fireTick()
    await flush()
    assert.equal(calls, afterMount, 'a protocol mismatch cannot form a retry loop')
    runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's2' })
    const second = runner.getEffects()
    second[1].fn()
    await flush()
    assert.ok(sessions.includes('s2'), 'the remounted button probes the new session')
  } finally {
    timers.restore()
  }
})
