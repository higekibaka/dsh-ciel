import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import * as records from '../record-store.js'
import { createReviewRepository } from '../review-repository.js'
import { createReviewOperation } from '../review-operation.js'
import { reviewHarness } from './host-harness.js'

const entry = { sessionId: 's', reviewId: 'r', messageId: 'm', createdAt: 1, status: 'sound', annotations: [], evidenceRecords: [] }
for (const boundary of ['evidence', 'before-commit', 'after-commit']) test('repository injection exercises cancel at ' + boundary + ' without global fs patches', async t => {
  const home = await mkdtemp('/tmp/ciel-repository-'); t.after(() => rm(home, { recursive: true, force: true }))
  const op = createReviewOperation(); t.after(() => op.dispose()); let accepted
  const repository = createReviewRepository({ home, store: { ...records, async writeRecord(kind, sid, id, value, options) {
    if (kind === 'evidence') {
      await records.writeRecord(kind, sid, id, value, options)
      if (boundary === 'evidence') accepted = op.cancel('cancel fixture')
      return
    }
    const before = options.beforeCommit
    return records.writeRecord(kind, sid, id, value, { ...options, beforeCommit() {
      if (boundary === 'before-commit') accepted = op.cancel('cancel fixture')
      before()
      if (boundary === 'after-commit') accepted = op.cancel('cancel fixture')
    } })
  } } })
  if (boundary === 'after-commit') await repository.persistReview('s', entry, op)
  else await assert.rejects(repository.persistReview('s', entry, op), /cancel fixture/)
  assert.equal(accepted, boundary !== 'after-commit')
  assert.equal(!!await repository.readRecord('reviews', 's', 'r'), boundary === 'after-commit')
})

test('one terminal error is published after a summary write failure and operation ownership drains', async t => {
  const home = await mkdtemp('/tmp/ciel-terminal-'); t.after(() => rm(home, { recursive: true, force: true }))
  const h = await reviewHarness(['## verdict: pass\nsummary: fixture'], { criticExploreEnabled: false }); t.after(() => h.dispose())
  let attempts = 0, terminal = 0
  h.service.coordinator.repository = createReviewRepository({ home, store: { ...records, writeRecord(kind, ...args) {
    if (kind === 'reviews') {
      attempts++
      if (args[2].status !== 'error') throw new Error('fixture write failure')
      terminal++
    }
    return records.writeRecord(kind, ...args)
  } } })
  const result = await h.start()
  assert.equal(result.ok, false)
  assert.equal(attempts, 2)
  assert.equal(terminal, 1)
  const stored = await records.readRecord('reviews', h.sid, result.review.reviewId, { home })
  assert.equal(stored.status, 'error')
  assert.equal(h.service.coordinator.inFlight.size, 0)
  assert.equal(h.service.coordinator.activeOperations.size, 0)
})

test('advice cancellation during publication cannot save normal output', async t => {
  const home = await mkdtemp('/tmp/ciel-advice-commit-'); t.after(() => rm(home, { recursive: true, force: true }))
  const op = createReviewOperation(); t.after(() => op.dispose())
  const repository = createReviewRepository({ home, store: { ...records, writeRecord(kind, sid, id, value, options) {
    const before = options.beforeCommit
    return records.writeRecord(kind, sid, id, value, { ...options, beforeCommit() { op.cancel('advisor cancelled'); before() } })
  } } })
  await assert.rejects(repository.persistAdvice('s', 'tool', 'call', 'fixture output', { used: [] }, op), /advisor cancelled/)
  assert.equal(await repository.readRecord('advice', 's', 'tool:call'), null)
})
