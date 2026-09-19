#!/usr/bin/env node
// Current built DSH Registry + Gateway, production Ciel service and transport.
// In-memory carrier; no HTTP server, network access, keys or model adapter.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { REVIEW_REMOTE, REVIEW_METHODS } from '../plugin/review-protocol.js'
import { createReviewTransport } from '../plugin/src/review-transport.js'
import { AdvisorReviewService, Config, apply } from '../plugin/index.js'
import { writeRecord } from '../plugin/record-store.js'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to the current built DSH checkout')
const requireTarget = createRequire(join(checkout, 'packages/core/tools/package.json'))
const { Context } = await import(pathToFileURL(requireTarget.resolve('@deepseek-ai/cordis')).href)
const { default: Registry } = await import(pathToFileURL(join(checkout, 'packages/typert/registry/lib/index.js')).href)
const { default: Gateway } = await import(pathToFileURL(join(checkout, 'packages/api/gateway/lib/index.js')).href)
const home = await mkdtemp('/tmp/ciel-protocol-dsh-')
const beforeHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const ctx = new Context(), owned = [], outcomes = []
const invoke = (method, request) => ctx.typertGateway.invoke({ namespace: 'advisorReview', method, args: { request } })
try {
  owned.push(ctx.plugin(Registry)); await owned.at(-1).await()
  owned.push(ctx.plugin(Gateway)); await owned.at(-1).await()
  owned.push(ctx.plugin({ name: 'ciel-protocol-under-test', apply: c => apply(c, Config({})) })); await owned.at(-1).await()
  const pkg = ctx.typert.getPackage('dsh-advisor', 'host')
  assert.ok(pkg)
  assert.equal(REVIEW_REMOTE.descriptors.length, REVIEW_METHODS.length)
  assert.deepEqual((await invoke('list', { sessionId: 's' })).reviews, [])
  outcomes.push('current DSH Registry/Gateway discovers production Ciel list')
  for (const method of ['start', 'prepareFeedback', 'inboxSetIntent']) {
    await assert.rejects(invoke(method, { sessionId: 's', messageId: { invalid: true } }), { code: 'gateway/input-invalid' })
  }
  assert.equal(ctx.advisorReview.coordinator.inFlight.size, 0)
  outcomes.push('malformed requests refused before model or storage writes')
  await writeRecord('reviews', 's', 'r', { schemaVersion: 1, sessionId: 's', reviewId: 'r', messageId: 'm', createdAt: 1, status: 'completed', annotations: [{ severity: 'nit', title: 'synthetic annotation', anchor: 'fixture', comment: 'fixture comment' }] })
  const remote = { $mount: async descriptor => { assert.equal(descriptor, REVIEW_REMOTE); return () => {} } }
  let malformed = false, calls = 0
  const api = Object.fromEntries(REVIEW_METHODS.map(method => [method, async request => {
    calls++
    if (malformed) return { ok: true, value: { reviews: 'invalid-wire-shape' } }
    try { return { ok: true, value: await invoke(method, request) } }
    catch (error) { return { ok: false, error: { code: error.code, message: error.message } } }
  }]))
  const transport = createReviewTransport({ getRemote: () => remote, getApi: () => api, descriptor: REVIEW_REMOTE })
  try {
    const page = await transport.call('inboxList', { sessionId: 's' })
    assert.equal(page.ok, true); assert.equal(page.reviews[0].reviewId, 'r')
    const fingerprint = page.reviews[0].reviewFingerprint
    const result = await transport.call('inboxSetIntent', { sessionId: 's', reviewId: 'r', reviewFingerprint: fingerprint, expectedRevision: 0, index: 0, intent: 'planned' })
    assert.equal(result.ok, true); assert.equal(result.revision, 1)
    const prepared = await transport.call('prepareFeedback', { sessionId: 's', messageId: 'm', reviewId: 'r', items: [{ index: 0 }] })
    assert.equal(prepared.ok, true); assert.equal(prepared.count, 1)
    assert.equal((await transport.call('feedback', {})).ok, false)
    outcomes.push('inbox CAS, draft preparation and stale-client tombstone through real Gateway')
    malformed = true
    const invalid = await transport.call('list', { sessionId: 's' })
    assert.equal(invalid.code, 'CIEL_PROTOCOL_RESPONSE_INVALID'); assert.equal(invalid.retryable, false)
    const before = calls
    assert.equal((await transport.call('start', { sessionId: 's', messageId: [] })).code, 'CIEL_PROTOCOL_REQUEST_INVALID')
    assert.equal(calls, before)
    outcomes.push('Ciel Client explicitly validates response (DSH alpha.2 does not), invalid request never dispatched')
  } finally { await transport.dispose() }
  console.log(JSON.stringify({ ok: true, mode: 'actual DSH Registry/Gateway, synthetic carrier and records', outcomes, networkRequests: 0, modelCalls: 0 }))
} finally {
  for (const scope of owned.reverse()) await scope.dispose()
  if (beforeHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = beforeHome
  await rm(home, { recursive: true, force: true })
}
