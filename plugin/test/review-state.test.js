import test from 'node:test'
import assert from 'node:assert/strict'
import { createReviewState } from '../src/review-state.js'
import { reviewMessageKey } from '../review-identity.js'
const row = sessionId => ({ sessionId, messageId: 'shared', reviewId: 'r-' + sessionId, createdAt: 1, status: 'completed', annotations: [] })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('inactive session payloads and feedback evict together, pins protect work, reopening rehydrates', async () => {
  const calls = []
  const state = createReviewState({ maxIdleSessions: 2, call: async (_, { sessionId }) => { calls.push(sessionId); return { reviews: [row(sessionId)] } } })
  const release = state.pin('pinned')
  await state.hydrate('pinned')
  await state.hydrate('s0')
  state.store.feedback.sel.set('r-s0', new Set([0]))
  state.store.collapsed.add('r-s0')
  for (let i = 1; i < 30; i++) await state.hydrate('s' + i)
  await flush()
  assert.equal(state.stats().sessions, 3)
  assert.equal(state.store.byMessage.has(reviewMessageKey('pinned', 'shared')), true)
  assert.equal(state.store.hydrated.has('s0'), false)
  assert.equal(state.store.feedback.sel.has('r-s0'), false)
  assert.equal(state.store.collapsed.has('r-s0'), false)
  await state.hydrate('s0')
  assert.equal(calls.filter(s => s === 's0').length, 2)
  release(); await flush()
  assert.equal(state.stats().sessions, 2)
  state.dispose()
  assert.equal(state.store.byMessage.size, 0)
})

test('byte pressure releases inactive results but never truncates a mounted session', async () => {
  const state = createReviewState({ maxIdleBytes: 100, maxIdleSessions: 8 })
  const release = state.pin('large')
  state.absorb({ ...row('large'), summary: 'x'.repeat(1000) })
  assert.equal(state.store.byMessage.size, 1)
  release(); await flush()
  assert.equal(state.store.byMessage.size, 0)
  assert.equal(state.stats().payloadBytes, 0)
})

test('many forced hydrations share one fresh follow-up and never commit after disposal', async () => {
  const pending = []; let calls = 0, emits = 0
  const state = createReviewState({ call: () => { calls++; return new Promise(resolve => pending.push(resolve)) }, emit: () => { emits++ } })
  const initial = state.hydrate('s')
  const forced = Array.from({ length: 50 }, () => state.hydrate('s', { force: true }))
  assert.equal(calls, 1)
  pending.shift()({ reviews: [row('s')] }); await initial; await flush()
  assert.equal(calls, 2)
  state.dispose(); const before = emits
  pending.shift()({ reviews: [{ ...row('s'), reviewId: 'late' }], triage: { late: { states: { 0: 'accept' } } }, sentKeys: ['late#0'] })
  await Promise.all(forced)
  assert.equal(emits, before)
  assert.equal(state.stats().sessions, 0)
  assert.equal(state.store.feedback.meta.size, 0)
  assert.equal(state.store.feedback.sent.size, 0)
  assert.equal(state.store.byMessage.size, 0)
})

test('late failed hydration after stop cannot recreate retry state', async () => {
  let reject
  const state = createReviewState({ call: () => new Promise((_, fail) => { reject = fail }) })
  const loading = state.hydrate('s'); state.dispose(); reject(new Error('offline')); await loading
  assert.equal(state.store.retrySessions.size, 0)
  assert.equal(state.store.loadErrors.size, 0)
})

test('scheduler disposal releases each mounted session pin once, including late unsubscribe', async () => {
  const { createReviewProgress } = await import('../src/review-progress.js')
  let pins = 0
  const scheduler = createReviewProgress({ reviewCall: async () => ({ inFlight: false }), store: { progressErrors: new Map(), hydrated: new Set() }, emit() {}, hydrate() {}, document: {}, pin: () => { pins++; return () => { pins-- } }, setInterval: () => 1, clearInterval() {} })
  const stop = scheduler.subscribeProgress({ sessionId: 's', messageId: 'm', idleRef: { current: false }, progRef: { current: null }, setProg() {} })
  assert.equal(pins, 1)
  scheduler.dispose(); stop(); await flush()
  assert.equal(pins, 0)
})
