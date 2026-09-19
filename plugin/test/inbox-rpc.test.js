import { requestFixtures, resultFixtures } from './review-protocol.fixtures.js'
// Apply-level Typert declaration and production instance wiring for the inbox
// RPC (advisorReview.inboxList / inboxSetIntent). No server is started.
//
// Boundary: the real DSH Gateway and its validateBinding layer are not part of
// the offline dev dependencies, so this file verifies the two layers the repo
// can exercise here:
//   1. apply() registers the strict invocation descriptors with the live
//      `typert` registry (the payload the host consumes), and
//   2. the production AdvisorReviewService instance carries the Typert Remote
//      markers plus its gateway binding, and the wired methods route to the
//      real record store on a temporary home.
// It does NOT prove the Gateway accepts the payload end to end.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { AdvisorReviewService, Config, apply } from '../index.js'
import { RECORD_SCHEMA_VERSION, writeRecord } from '../record-store.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-inbox-rpc-'))
after(async () => { await rm(home, { recursive: true, force: true }) })

const INBOX_METHODS = ['inboxList', 'inboxSetIntent']

test('apply registers strict inbox invocations with the live typert registry', async (t) => {
  const ctx = new Context()
  const registered = []
  const provider = ctx.plugin({
    name: 'capture-typert',
    apply(c) {
      c.provide('typert', {
        register(payload) { registered.push(payload); return () => {} },
      })
    },
  })
  await provider.await()
  const owner = ctx.plugin({
    name: 'ciel-under-test',
    apply(c) { apply(c, Config({})) },
  })
  await owner.await()
  // ctx.inject callbacks run once the dependency is live; flush in case the
  // scheduler queued the registration.
  await new Promise((resolve) => setImmediate(resolve))
  t.after(async () => { await owner.dispose(); await provider.dispose() })

  assert.equal(registered.length, 1)
  const payload = registered[0]
  assert.equal(payload.package, 'dsh-advisor')
  assert.equal(payload.face, 'host')
  assert.ok(Array.isArray(payload.invocations))

  const byMethod = new Map(payload.invocations.map((descriptor) => [descriptor.method, descriptor]))
  assert.equal(byMethod.size, 13)
  for (const descriptor of payload.invocations) {
    for (const [codec, valid] of [[descriptor.parameters[0].codec, requestFixtures[descriptor.method]], [descriptor.result, resultFixtures[descriptor.method]]]) {
      assert.equal(typeof codec.create, 'function', descriptor.method + ' supports alpha.2 codecs')
      const schema = codec.create()
      assert.equal(schema.parse(valid), valid)
      assert.equal(codec.schema.parse(valid), valid, 'older adapter enforces the same shape')
      for (const value of [null, [], true]) assert.throws(() => schema.parse(value), /review protocol/)
    }
  }
  for (const method of INBOX_METHODS) {
    const descriptor = byMethod.get(method)
    assert.ok(descriptor, method + ' descriptor is registered')
    assert.equal(descriptor.id, 'dsh-advisor#advisorReview/' + method)
    assert.equal(descriptor.service, 'advisorReview')
    assert.equal(descriptor.namespace, 'advisorReview')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.parameters.length, 1)
    const parameter = descriptor.parameters[0]
    assert.equal(parameter.name, 'request')
    assert.equal(parameter.wire, 'request')
    assert.equal(parameter.source, 'json')
    assert.equal(parameter.codec.mode, 'strict')
    assert.equal(parameter.codec.typeSymbol, 'dsh-advisor/' + method + 'Request')
    assert.equal(typeof parameter.codec.schema.parse, 'function')
    const probe = requestFixtures[method]
    assert.equal(parameter.codec.schema.parse(probe), probe)
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(descriptor.result.typeSymbol, 'dsh-advisor/' + method + 'Result')
    assert.equal(typeof descriptor.result.schema.parse, 'function')
  }
  // The declaration is additive: the pre-existing review methods stay listed.
  for (const method of ['list', 'start', 'triage', 'readReview', 'readEvidence', 'readAdvice']) {
    assert.ok(byMethod.has(method), method + ' remains registered')
  }
})

test('the production service instance carries the Remote markers and routes inbox methods', async () => {
  const service = new AdvisorReviewService(new Context(), new Set(), () => Config({}), new Set(), { inboxHome: home })
  assert.equal(service.name, 'advisorReview')
  assert.equal(service.typertRemote.namespace, 'advisorReview')
  assert.equal(service.typertRemote.serviceKey, 'advisorReview')
  assert.equal(service.typertRemote.service, service)

  const markers = remoteMethods(service)
  const byMethod = new Map(markers.map((marker) => [marker.method, marker]))
  for (const method of INBOX_METHODS) {
    const marker = byMethod.get(method)
    assert.ok(marker, method + ' has a Remote marker on the live prototype')
    assert.equal(marker.invocation.kind, 'direct')
    assert.equal(typeof service[method], 'function')
  }

  // Wired behavior over a temporary home: list, then one CAS write. This is the
  // method body the Gateway would resolve, without starting a Gateway.
  const sessionId = 'rpc-wiring'
  await writeRecord('reviews', sessionId, 'r-1', {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sessionId,
    reviewId: 'r-1',
    messageId: 'm-1',
    anchorSeq: 4,
    status: 'completed',
    verdict: 'changes',
    createdAt: 1,
    annotations: [{ severity: 'nit', title: 't', anchor: 'a', comment: 'c', evidenceRefs: ['e1'] }],
  }, { home })

  const page = await service.inboxList({ sessionId })
  assert.equal(page.ok, true)
  assert.equal(page.sessionId, sessionId)
  assert.equal(page.limited, false)
  assert.equal(page.reviews[0].reviewId, 'r-1')
  assert.equal(page.reviews[0].anchorSeq, 4)
  assert.equal(page.reviews[0].revision, 0)
  assert.deepEqual(page.reviews[0].annotations[0].evidenceIds, ['e1'])

  const written = await service.inboxSetIntent({
    sessionId,
    reviewId: 'r-1',
    reviewFingerprint: page.reviews[0].reviewFingerprint,
    expectedRevision: 0,
    index: 0,
    intent: 'planned',
  })
  assert.equal(written.ok, true)
  assert.equal(written.revision, 1)
  assert.deepEqual(written.intents, { 0: 'planned' })

  const conflict = await service.inboxSetIntent({
    sessionId,
    reviewId: 'r-1',
    reviewFingerprint: page.reviews[0].reviewFingerprint,
    expectedRevision: 0,
    index: 0,
    intent: 'rejected',
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'revision_conflict')
})
