import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AdvisorReviewService, Config, persistReview, readFeedbackTriage } from '../index.js'
import { listRecords } from '../record-store.js'
const originalHome = process.env.DSH_HOME
const home = await mkdtemp(join(tmpdir(), 'ciel-pagination-host-'))
process.env.DSH_HOME = home
after(async () => { if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome; await rm(home, { recursive: true, force: true }) })
const service = new AdvisorReviewService(new Context(), new Set(), () => Config({}))
const review = (id, count = 2) => ({ reviewId: id, messageId: 'm-' + id, createdAt: 1, annotations: Array.from({ length: count }, (_, i) => ({ severity: 'nit', title: 'note-' + i })) })

test('review RPC pages past 200 records with exact cursor progression', async () => {
  for (let i = 0; i < 201; i++) await persistReview('paged', review('r-' + i, 0))
  const ids = [], sizes = []
  let cursor
  do {
    const page = await service.list({ sessionId: 'paged', cursor })
    sizes.push(page.reviews.length)
    ids.push(...page.reviews.map(r => r.reviewId))
    assert.equal(page.limited, page.nextCursor !== null)
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(sizes, [100, 100, 1])
  assert.equal(new Set(ids).size, 201)
  await assert.rejects(service.list({ sessionId: 'paged', cursor: '../bad' }), { code: 'CIEL_RECORD_INVALID_CURSOR' })
})
test('triage validates ownership and indices before writing any record', async () => {
  await persistReview('triage', review('r-one'))
  for (const request of [
    { sessionId: 'foreign', reviewId: 'r-one', changes: [{ index: 0, state: 'accept' }] },
    { sessionId: 'triage', reviewId: 'missing', changes: [{ index: 0, state: 'accept' }] },
    { sessionId: 'triage', reviewId: 'r-one', changes: [{ index: 2, state: 'accept' }] },
    { sessionId: 'triage', reviewId: 'r-one', changes: [{ index: -1, state: 'accept' }] },
    { sessionId: 'triage', reviewId: 'r-one', changes: [{ index: 0, state: 'invented' }] },
  ]) assert.equal((await service.triage(request)).ok, false)
  assert.deepEqual(await listRecords('feedback', 'triage'), [])
  assert.deepEqual(await listRecords('feedback', 'foreign'), [])
})
test('250 toggles of one review create one record and preserve final intent', async () => {
  await persistReview('toggles', review('r-one'))
  for (let i = 0; i < 250; i++) assert.equal((await service.triage({ sessionId: 'toggles', reviewId: 'r-one', changes: [{ index: 0, state: i % 2 ? 'dismiss' : 'accept' }] })).ok, true)
  assert.equal((await listRecords('feedback', 'toggles')).length, 1)
  const result = await service.readReview({ sessionId: 'toggles', reviewId: 'r-one' })
  assert.equal(result.review.triage.states[0], 'dismiss')
  assert.equal((await service.list({ sessionId: 'toggles' })).reviews.length, 1)
})
test('concurrent triage batches serialize across read and write without lost updates', async () => {
  await persistReview('concurrent', review('r-one'))
  const values = await Promise.all([
    service.triage({ sessionId: 'concurrent', reviewId: 'r-one', changes: [{ index: 0, state: 'accept' }] }),
    service.triage({ sessionId: 'concurrent', reviewId: 'r-one', changes: [{ index: 1, state: 'accept' }] }),
    service.triage({ sessionId: 'concurrent', reviewId: 'r-one', changes: [{ index: 0, state: 'dismiss' }], filter: 'blocker' }),
  ])
  assert.ok(values.every(value => value.ok))
  const result = (await readFeedbackTriage('concurrent', ['r-one'])).get('r-one')
  assert.deepEqual([...result.states], [[0, 'dismiss'], [1, 'accept']])
  assert.equal(result.filter, 'blocker')
  assert.equal(service.triageOperations.size, 0)
})
