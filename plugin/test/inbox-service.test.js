// Inbox service — backend contract tests.
//
// Every store call is bound to a private temp `home`; this file never reads or
// writes the real DSH_HOME and never mutates process.env.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AdvisorReviewService, Config } from '../index.js'
import { RECORD_SCHEMA_VERSION, listRecords, readRecord, recordRoot, writeRecord } from '../record-store.js'
import { INBOX_PAGE_MAX_LIMIT, listInbox, reviewFingerprint, setInboxIntent } from '../inbox-service.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-inbox-'))
after(async () => { await rm(home, { recursive: true, force: true }) })

const baseAnnotations = () => [
  { severity: 'blocker', title: 't0', anchor: 'a0', comment: 'c0', evidenceRefs: ['e1'] },
  { severity: 'nit', title: 't1', anchor: 'a1', comment: 'c1' },
  { severity: 'nit', title: 't2', anchor: 'a2', comment: 'c2' },
]

async function seedReview(sessionId, reviewId, overrides = {}) {
  const value = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sessionId,
    reviewId,
    messageId: 'm-' + reviewId,
    status: 'completed',
    verdict: 'changes',
    summary: 'summary for ' + reviewId,
    coverage: 'complete',
    createdAt: 1_700_000_000_000,
    annotations: baseAnnotations(),
    ...overrides,
  }
  await writeRecord('reviews', sessionId, reviewId, value, { home })
  return value
}

async function fingerprint(sessionId, reviewId) {
  return reviewFingerprint(await readRecord('reviews', sessionId, reviewId, { home }))
}

function makeService() {
  return new AdvisorReviewService(new Context(), new Set(), () => Config({}), new Set(), { inboxHome: home })
}

test('record store persists the inbox kind as its own small record', async () => {
  const value = { reviewId: 'r-1', reviewFingerprint: 'a'.repeat(64), revision: 1, intents: { 0: 'planned' }, updatedAt: 1 }
  await writeRecord('inbox', 'kinds', 'r-1', value, { home })
  assert.deepEqual(await readRecord('inbox', 'kinds', 'r-1', { home }), value)
})

test('inboxList pages 25 reviews per page in stable filename order to exhaustion', async () => {
  const sessionId = 'page'
  for (let i = 0; i < 60; i += 1) await seedReview(sessionId, 'r-' + String(i).padStart(2, '0'))
  const service = makeService()
  const seen = []
  const sizes = []
  let cursor
  do {
    const page = await service.inboxList({ sessionId, cursor })
    assert.equal(page.ok, true)
    assert.equal(page.sessionId, sessionId)
    sizes.push(page.reviews.length)
    seen.push(...page.reviews.map((review) => review.reviewId))
    assert.equal(page.limited, page.nextCursor !== null)
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(sizes, [INBOX_PAGE_MAX_LIMIT, INBOX_PAGE_MAX_LIMIT, 10])
  assert.equal(new Set(seen).size, 60)
  const first = (await service.inboxList({ sessionId })).reviews[0]
  assert.deepEqual(
    Object.keys(first).sort(),
    ['annotations', 'coverage', 'createdAt', 'messageId', 'reviewFingerprint', 'reviewId', 'revision', 'sessionId', 'status', 'summary', 'verdict'],
  )
  assert.equal(first.revision, 0)
  assert.deepEqual(first.annotations.map((a) => a.intent), ['pending', 'pending', 'pending'])
})

test('inboxList rejects bad cursors and limits and accepts the 25 boundary', async () => {
  const sessionId = 'bounds'
  await seedReview(sessionId, 'r-1')
  for (const limit of [0, -1, INBOX_PAGE_MAX_LIMIT + 1, 25.5, '25', 200, NaN]) {
    const result = await listInbox({ sessionId, limit }, { home })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_limit')
  }
  for (const cursor of ['../bad', 'nope', '', 7]) {
    const result = await listInbox({ sessionId, cursor }, { home })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid_cursor')
  }
  assert.equal((await listInbox({ sessionId }, { home })).code, undefined)
  assert.equal((await listInbox({ sessionId: '../escape' }, { home })).code, 'invalid_session')
  assert.deepEqual((await listInbox({ sessionId: 'never-written' }, { home })).reviews, [])
})

test('inboxList enforces session ownership and fails explicitly on bad review records', async () => {
  await seedReview('owner', 'r-a')
  assert.deepEqual((await listInbox({ sessionId: 'intruder' }, { home })).reviews, [])

  await writeRecord('reviews', 'foreign-value', 'r-b', {
    sessionId: 'somewhere-else', reviewId: 'r-b', messageId: 'm', status: 'completed', createdAt: 1, annotations: [],
  }, { home })
  let result = await listInbox({ sessionId: 'foreign-value' }, { home })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'review_identity')

  await writeRecord('reviews', 'wrong-id', 'r-env', {
    sessionId: 'wrong-id', reviewId: 'r-other', messageId: 'm', status: 'completed', createdAt: 1, annotations: [],
  }, { home })
  result = await listInbox({ sessionId: 'wrong-id' }, { home })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'review_identity')

  await writeRecord('reviews', 'bad-annotations', 'r-x', {
    sessionId: 'bad-annotations', reviewId: 'r-x', messageId: 'm', status: 'completed', createdAt: 1, annotations: 'nope',
  }, { home })
  result = await listInbox({ sessionId: 'bad-annotations' }, { home })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'record_corrupt')

  const dir = join(recordRoot(home), 'reviews', 'corrupt')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, createHash('sha256').update('r-c').digest('base64url') + '.json'), '{not json', { mode: 0o600 })
  result = await listInbox({ sessionId: 'corrupt' }, { home })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'record_corrupt')
})

test('setInboxIntent requires the exact request shape, ownership and current fingerprint', async () => {
  const sessionId = 'validate'
  await seedReview(sessionId, 'r-v')
  const current = await fingerprint(sessionId, 'r-v')
  const base = { sessionId, reviewId: 'r-v', reviewFingerprint: current, expectedRevision: 0, index: 0, intent: 'planned' }
  const cases = [
    [{ ...base, reviewId: '' }, 'invalid_review_id'],
    [{ ...base, reviewFingerprint: 'not-hex' }, 'invalid_fingerprint'],
    [{ ...base, reviewFingerprint: 'f'.repeat(64) }, 'fingerprint_mismatch'],
    [{ ...base, expectedRevision: -1 }, 'invalid_revision'],
    [{ ...base, expectedRevision: '0' }, 'invalid_revision'],
    [{ ...base, index: '0' }, 'invalid_index'],
    [{ ...base, index: 99 }, 'invalid_index'],
    [{ ...base, intent: 'accept' }, 'invalid_intent'],
    [{ ...base, intent: 'dismiss' }, 'invalid_intent'],
    [{ ...base, reviewId: 'missing' }, 'review_not_found'],
    [{ ...base, sessionId: 'someone-else' }, 'review_not_found'],
  ]
  for (const [request, code] of cases) {
    const result = await setInboxIntent(request, { home })
    assert.equal(result.ok, false, JSON.stringify(request))
    assert.equal(result.code, code, JSON.stringify(request))
  }
  assert.deepEqual(await listRecords('inbox', sessionId, { home }), [])
  assert.deepEqual(await listRecords('inbox', 'someone-else', { home }), [])
})

test('setInboxIntent keeps a sparse intent map, increments revision and omits pending', async () => {
  const sessionId = 'life'
  await seedReview(sessionId, 'r-l')
  const current = await fingerprint(sessionId, 'r-l')
  const first = await setInboxIntent({ sessionId, reviewId: 'r-l', reviewFingerprint: current, expectedRevision: 0, index: 1, intent: 'planned' }, { home })
  assert.deepEqual(first, { ok: true, sessionId, reviewId: 'r-l', reviewFingerprint: current, revision: 1, intents: { 1: 'planned' } })
  const second = await setInboxIntent({ sessionId, reviewId: 'r-l', reviewFingerprint: current, expectedRevision: 1, index: 0, intent: 'rejected' }, { home })
  assert.deepEqual(second.intents, { 0: 'rejected', 1: 'planned' })
  assert.equal(second.revision, 2)
  const third = await setInboxIntent({ sessionId, reviewId: 'r-l', reviewFingerprint: current, expectedRevision: 2, index: 1, intent: 'pending' }, { home })
  assert.deepEqual(third.intents, { 0: 'rejected' })
  assert.equal(third.revision, 3)
  const page = await listInbox({ sessionId }, { home })
  assert.equal(page.reviews[0].revision, 3)
  assert.equal(page.reviews[0].annotations[0].intent, 'rejected')
  assert.equal(page.reviews[0].annotations[1].intent, 'pending')
  assert.equal(page.reviews[0].annotations[2].intent, 'pending')
})

test('same-review concurrent CAS at one revision yields exactly one success across instances', async () => {
  const sessionId = 'race'
  await seedReview(sessionId, 'r-c')
  const current = await fingerprint(sessionId, 'r-c')
  const request = (intent) => ({ sessionId, reviewId: 'r-c', reviewFingerprint: current, expectedRevision: 0, index: 0, intent })
  const a = makeService()
  const b = makeService()
  const [x, y] = await Promise.all([a.inboxSetIntent(request('planned')), b.inboxSetIntent(request('rejected'))])
  const winners = [x, y].filter((result) => result.ok)
  const losers = [x, y].filter((result) => !result.ok)
  assert.equal(winners.length, 1)
  assert.equal(losers.length, 1)
  assert.equal(losers[0].code, 'revision_conflict')
  assert.equal(winners[0].revision, 1)
  const page = await a.inboxList({ sessionId })
  assert.equal(page.reviews[0].revision, 1)
  assert.equal(page.reviews[0].annotations[0].intent, winners[0].intents[0])
})

test('a failed inbox write is explicit and never advances revision', async () => {
  const sessionId = 'wfail'
  await seedReview(sessionId, 'r-w')
  const current = await fingerprint(sessionId, 'r-w')
  const request = { sessionId, reviewId: 'r-w', reviewFingerprint: current, expectedRevision: 0, index: 0, intent: 'planned' }
  const diskFull = async () => { const error = new Error('no space'); error.code = 'ENOSPC'; throw error }
  const failed = await setInboxIntent(request, { home, writeRecord: diskFull })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'write_failed')
  assert.deepEqual(await listRecords('inbox', sessionId, { home }), [])
  const page = await listInbox({ sessionId }, { home })
  assert.equal(page.reviews[0].revision, 0)
  assert.equal(page.reviews[0].annotations[0].intent, 'pending')
  const retried = await setInboxIntent(request, { home })
  assert.equal(retried.ok, true)
  assert.equal(retried.revision, 1)
})

test('intent state survives a new service instance', async () => {
  const sessionId = 'restart'
  await seedReview(sessionId, 'r-r')
  const current = await fingerprint(sessionId, 'r-r')
  assert.equal((await makeService().inboxSetIntent({ sessionId, reviewId: 'r-r', reviewFingerprint: current, expectedRevision: 0, index: 2, intent: 'planned' }, { home })).ok, true)

  const restarted = makeService()
  const page = await restarted.inboxList({ sessionId })
  assert.equal(page.ok, true)
  assert.equal(page.reviews[0].revision, 1)
  assert.equal(page.reviews[0].annotations[2].intent, 'planned')
  assert.equal(page.reviews[0].reviewFingerprint, current)
})

test('a stored fingerprint that no longer matches fails list and writes explicitly', async () => {
  const sessionId = 'stale'
  await seedReview(sessionId, 'r-s')
  const firstFingerprint = await fingerprint(sessionId, 'r-s')
  const first = await setInboxIntent({ sessionId, reviewId: 'r-s', reviewFingerprint: firstFingerprint, expectedRevision: 0, index: 2, intent: 'planned' }, { home })
  assert.equal(first.ok, true)

  await seedReview(sessionId, 'r-s', { summary: 'changed summary' })
  const nextFingerprint = await fingerprint(sessionId, 'r-s')
  assert.notEqual(nextFingerprint, firstFingerprint)

  // The list must fail loudly; an empty-intent success would mask the conflict.
  const page = await listInbox({ sessionId }, { home })
  assert.equal(page.ok, false)
  assert.equal(page.code, 'fingerprint_mismatch')
  assert.equal('reviews' in page, false)

  // Both the new and the old fingerprint are refused: no implicit re-base.
  const withCurrent = await setInboxIntent({ sessionId, reviewId: 'r-s', reviewFingerprint: nextFingerprint, expectedRevision: 1, index: 2, intent: 'rejected' }, { home })
  assert.equal(withCurrent.ok, false)
  assert.equal(withCurrent.code, 'fingerprint_mismatch')
  const withStale = await setInboxIntent({ sessionId, reviewId: 'r-s', reviewFingerprint: firstFingerprint, expectedRevision: 1, index: 2, intent: 'rejected' }, { home })
  assert.equal(withStale.ok, false)
  assert.equal(withStale.code, 'fingerprint_mismatch')

  const stored = await readRecord('inbox', sessionId, 'r-s', { home })
  assert.equal(stored.revision, 1)
  assert.equal(stored.reviewFingerprint, firstFingerprint)
  assert.deepEqual(stored.intents, { 2: 'planned' })
})

test('inbox intents never read or write the legacy feedback WAL', async () => {
  const sessionId = 'isolate'
  await seedReview(sessionId, 'r-i')
  const legacy = { reviewId: 'r-i', states: { 0: 'accept' } }
  await writeRecord('feedback', sessionId, 'review:r-i', legacy, { home })
  const current = await fingerprint(sessionId, 'r-i')

  let page = await listInbox({ sessionId }, { home })
  assert.equal(page.reviews[0].revision, 0)
  assert.equal(page.reviews[0].annotations[0].intent, 'pending')

  const written = await setInboxIntent({ sessionId, reviewId: 'r-i', reviewFingerprint: current, expectedRevision: 0, index: 0, intent: 'planned' }, { home })
  assert.equal(written.ok, true)
  assert.deepEqual(await readRecord('feedback', sessionId, 'review:r-i', { home }), legacy)
  assert.equal((await listRecords('inbox', sessionId, { home })).length, 1)
  page = await listInbox({ sessionId }, { home })
  assert.equal(page.reviews[0].annotations[0].intent, 'planned')
})

test('a corrupt stored inbox state is an explicit failure, never masked as pending', async () => {
  const sessionId = 'badbox'
  await seedReview(sessionId, 'r-b')
  const current = await fingerprint(sessionId, 'r-b')
  const cases = [
    { reviewId: 'r-b', reviewFingerprint: current, revision: 1, intents: { 0: 'accept' } },
    { reviewId: 'r-b', reviewFingerprint: current, revision: 1.5, intents: { 0: 'planned' } },
    { reviewId: 'r-b', reviewFingerprint: 'not-hex', revision: 1, intents: {} },
    { reviewId: 'r-b', reviewFingerprint: current, revision: -1, intents: {} },
    { reviewId: 'r-b', reviewFingerprint: current, revision: 1, intents: 'nope' },
    { reviewId: 'r-other', reviewFingerprint: current, revision: 1, intents: {} },
    { reviewId: 'r-b', reviewFingerprint: current, revision: 1, intents: { bad: 'planned' } },
  ]
  for (const value of cases) {
    await writeRecord('inbox', sessionId, 'r-b', value, { home })
    const page = await listInbox({ sessionId }, { home })
    assert.equal(page.ok, false, JSON.stringify(value))
    assert.equal(page.code, 'record_corrupt', JSON.stringify(value))
    const write = await setInboxIntent({ sessionId, reviewId: 'r-b', reviewFingerprint: current, expectedRevision: 1, index: 0, intent: 'planned' }, { home })
    assert.equal(write.ok, false, JSON.stringify(value))
    assert.equal(write.code, 'record_corrupt', JSON.stringify(value))
  }
})

test('inboxList returns only bounded fields and maps evidenceRefs to evidenceIds', async () => {
  const long = 'x'.repeat(5000)
  await seedReview('bounded', 'r-bd', {
    summary: long,
    error: long,
    raw: 'SECRET RAW BODY',
    evidenceRecords: [{ id: 'e1', content: 'SOURCE CODE' }],
    annotations: [
      { severity: 'blocker', title: 'T', anchor: 'A', comment: 'C', evidence: 'SOURCE QUOTE', evidenceRefs: ['e1', 'a2', 'bogus'] },
      { severity: 'weird', title: 'u', anchor: 'v', comment: 'w' },
    ],
  })
  const page = await listInbox({ sessionId: 'bounded' }, { home })
  assert.equal(page.ok, true)
  const review = page.reviews[0]
  assert.deepEqual(
    Object.keys(review).sort(),
    ['annotations', 'coverage', 'createdAt', 'error', 'messageId', 'reviewFingerprint', 'reviewId', 'revision', 'sessionId', 'status', 'summary', 'verdict'],
  )
  assert.equal(review.summary.length, 600)
  assert.equal(review.error.length, 500)
  for (const secret of ['SECRET RAW BODY', 'SOURCE CODE', 'SOURCE QUOTE', 'raw', 'evidenceRecords']) {
    assert.equal(JSON.stringify(review).includes(secret), false, secret)
  }
  assert.deepEqual(Object.keys(review.annotations[0]).sort(), ['anchor', 'comment', 'evidenceIds', 'index', 'intent', 'severity', 'title'])
  assert.deepEqual(review.annotations[0].evidenceIds, ['e1', 'a2'])
  assert.equal(review.annotations[0].severity, 'blocker')
  assert.equal(review.annotations[1].severity, 'nit')
  assert.equal('evidenceIds' in review.annotations[1], false)
})

test('setInboxIntent rejects a review whose value identity differs from the requested review id', async () => {
  const sessionId = 'write-identity'
  await writeRecord('reviews', sessionId, 'r-env', {
    sessionId, reviewId: 'r-other', messageId: 'm', status: 'completed', createdAt: 1, annotations: [],
  }, { home })
  const stored = await readRecord('reviews', sessionId, 'r-env', { home })
  const current = reviewFingerprint(stored)
  const result = await setInboxIntent({ sessionId, reviewId: 'r-env', reviewFingerprint: current, expectedRevision: 0, index: 0, intent: 'planned' }, { home })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'review_identity')
  assert.deepEqual(await listRecords('inbox', sessionId, { home }), [])
})

test('write and list agree that a malformed annotation element is corrupt', async () => {
  const sessionId = 'annotation-shape'
  await seedReview(sessionId, 'r-as', { annotations: [null, { severity: 'nit', title: 't', anchor: 'a', comment: 'c' }] })
  const stored = await readRecord('reviews', sessionId, 'r-as', { home })
  const current = reviewFingerprint(stored)
  const write = await setInboxIntent({ sessionId, reviewId: 'r-as', reviewFingerprint: current, expectedRevision: 0, index: 1, intent: 'planned' }, { home })
  assert.equal(write.ok, false)
  assert.equal(write.code, 'record_corrupt')
  const page = await listInbox({ sessionId }, { home })
  assert.equal(page.ok, false)
  assert.equal(page.code, 'record_corrupt')
  assert.deepEqual(await listRecords('inbox', sessionId, { home }), [])
})

test('revision arithmetic rejects unsafe and exhausted counters', async () => {
  const sessionId = 'revision-safe'
  await seedReview(sessionId, 'r-rs')
  const stored = await readRecord('reviews', sessionId, 'r-rs', { home })
  const current = reviewFingerprint(stored)
  for (const expectedRevision of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53]) {
    const result = await setInboxIntent({ sessionId, reviewId: 'r-rs', reviewFingerprint: current, expectedRevision, index: 0, intent: 'planned' }, { home })
    assert.equal(result.code, 'invalid_revision')
  }

  await writeRecord('inbox', sessionId, 'r-rs', { reviewId: 'r-rs', reviewFingerprint: current, revision: Number.MAX_SAFE_INTEGER, intents: {} }, { home })
  const exhausted = await setInboxIntent({ sessionId, reviewId: 'r-rs', reviewFingerprint: current, expectedRevision: Number.MAX_SAFE_INTEGER, index: 0, intent: 'planned' }, { home })
  assert.equal(exhausted.ok, false)
  assert.equal(exhausted.code, 'revision_exhausted')
  const unchanged = await readRecord('inbox', sessionId, 'r-rs', { home })
  assert.equal(unchanged.revision, Number.MAX_SAFE_INTEGER)
  assert.deepEqual(unchanged.intents, {})

  await writeRecord('inbox', sessionId, 'r-rs', { reviewId: 'r-rs', reviewFingerprint: current, revision: Number.MAX_SAFE_INTEGER + 1, intents: {} }, { home })
  const corrupt = await listInbox({ sessionId }, { home })
  assert.equal(corrupt.ok, false)
  assert.equal(corrupt.code, 'record_corrupt')
})

test('inboxList carries anchorSeq only when the stored review has one', async () => {
  const sessionId = 'anchor'
  await seedReview(sessionId, 'r-a')
  await seedReview(sessionId, 'r-b', { anchorSeq: 7 })
  const page = await listInbox({ sessionId }, { home })
  assert.equal(page.ok, true)
  const byId = new Map(page.reviews.map((review) => [review.reviewId, review]))
  assert.equal('anchorSeq' in byId.get('r-a'), false)
  assert.equal(byId.get('r-b').anchorSeq, 7)
})

test('reviewFingerprint is deterministic and content-sensitive', () => {
  const a = { sessionId: 's', reviewId: 'r', annotations: [{ title: 'a', evidenceRefs: ['e1'] }] }
  const reordered = { annotations: [{ evidenceRefs: ['e1'], title: 'a' }], reviewId: 'r', sessionId: 's' }
  const changed = { sessionId: 's', reviewId: 'r', annotations: [{ title: 'b', evidenceRefs: ['e1'] }] }
  assert.equal(reviewFingerprint(a), reviewFingerprint(reordered))
  assert.match(reviewFingerprint(a), /^[0-9a-f]{64}$/)
  assert.notEqual(reviewFingerprint(a), reviewFingerprint(changed))
})
