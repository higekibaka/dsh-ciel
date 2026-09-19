// Stage performance-contract tests for the Ciel inbox (no DOM, no network):
// the derived-value caches, the controller/page-token card element memo, and
// the structural sharing that make an unrelated store emit cheap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cachedFilteredReviews,
  cachedPageCounts,
  createInboxController,
  emptyAnnotationsLabel,
  memoReviewCard,
  normalizeReview,
} from '../src/inbox.js'

const SESSION = 's1'

/** One raw Host review envelope that passes validateListPayload. */
function rawReview(index, annotationCount, overrides = {}) {
  return {
    sessionId: SESSION,
    reviewId: 'r' + index,
    messageId: 'm' + index,
    reviewFingerprint: 'fp' + index,
    revision: 5,
    status: 'sound',
    verdict: 'pass',
    coverage: 'complete',
    createdAt: 1000 + index,
    annotations: Array.from({ length: annotationCount }, (_, k) => ({
      index: k,
      severity: k === 0 ? 'blocker' : 'nit',
      title: 't' + k,
      anchor: 'anchor-' + index + '-' + k,
      comment: 'c' + k,
      evidenceIds: [],
      intent: 'pending',
    })),
    ...overrides,
  }
}

function makeController(reviews) {
  const page = reviews
  const controller = createInboxController({
    call: async (method, request) => {
      if (method === 'inboxList') {
        return { ok: true, sessionId: request.sessionId, reviews: page, nextCursor: null, limited: false }
      }
      if (method === 'inboxSetIntent') {
        return {
          ok: true,
          sessionId: request.sessionId,
          reviewId: request.reviewId,
          reviewFingerprint: request.reviewFingerprint,
          revision: request.expectedRevision + 1,
          intents: { [request.index]: request.intent },
        }
      }
      return { ok: false, code: 'unknown', error: 'unexpected method ' + method }
    },
    getSessions: () => ({ list: { getSnapshot: () => ({ current: SESSION }) } }),
    now: () => 1,
  })
  return { controller }
}

const inputs = (review, write, locate = undefined, filter = 'all') => ({ review, write, locate, filter })

test('cachedPageCounts computes once per reviews array and is reused verbatim', () => {
  const reviews = Array.from({ length: 25 }, (_, i) => normalizeReview(rawReview(i, 64), i))
  const first = cachedPageCounts(reviews)
  assert.equal(first.reviews, 25)
  assert.equal(first.annotations, 1600)
  assert.equal(cachedPageCounts(reviews), first, 'same array must return the cached counts')
  const replacement = reviews.slice()
  assert.notEqual(cachedPageCounts(replacement), first, 'a new page recomputes')
})

test('cachedFilteredReviews is keyed by (reviews, filter) and keeps anomaly groups', () => {
  const reviews = [
    normalizeReview(rawReview(0, 2), 0),
    normalizeReview(rawReview(1, 0, { status: 'failed', verdict: undefined, coverage: undefined }), 1),
  ]
  const all = cachedFilteredReviews(reviews, 'all')
  assert.equal(all, reviews, 'the all filter is the page itself')
  assert.equal(cachedFilteredReviews(reviews, 'all'), all)
  const planned = cachedFilteredReviews(reviews, 'planned')
  assert.equal(planned.length, 1)
  assert.equal(planned[0].reviewId, 'r1')
  assert.equal(emptyAnnotationsLabel(planned[0]), '本次评审失败，没有留下批注。')
  assert.equal(cachedFilteredReviews(reviews, 'planned'), planned, 'same filter must reuse the list')
})

test('a confirmed idle probe never reuses another controller or a missing token', () => {
  const a = { id: 'a' }
  assert.notEqual(
    memoReviewCard({}, {}, a, inputs(a, undefined), () => ({ built: 1 })),
    memoReviewCard({}, {}, a, inputs(a, undefined), () => ({ built: 2 })),
    'distinct owners do not share elements',
  )
  assert.notEqual(
    memoReviewCard({}, undefined, a, inputs(a, undefined), () => ({ built: 3 })),
    memoReviewCard({}, undefined, a, inputs(a, undefined), () => ({ built: 4 })),
    'a missing token always rebuilds',
  )
})

test('the card memo keys on controller + page token, not the reviews array', async () => {
  const { controller } = makeController([rawReview(0, 2), rawReview(1, 1)])
  await controller.openPage()
  const before = controller.getSnapshot()
  const token = controller.getPageToken()
  const [reviewA, reviewB] = before.reviews
  const elementA = memoReviewCard(controller, token, reviewA, inputs(reviewA, undefined), () => ({ id: 'A' }))
  const elementB = memoReviewCard(controller, token, reviewB, inputs(reviewB, undefined), () => ({ id: 'B' }))
  // Same inputs and same token: reused.
  assert.equal(memoReviewCard(controller, token, reviewA, inputs(reviewA, undefined), () => ({ id: 'A2' })), elementA)

  const result = await controller.setIntent(reviewA.key, 1, 'planned')
  assert.equal(result.ok, true)
  const after = controller.getSnapshot()
  assert.notEqual(after.reviews, before.reviews, 'the write replaces the reviews array')
  assert.equal(controller.getPageToken(), token, 'a write keeps the page token')
  const afterA = after.reviews[0]
  const afterB = after.reviews[1]
  assert.notEqual(afterA, reviewA)
  assert.equal(afterB, reviewB, 'the untouched review keeps identity')

  const rebuiltA = memoReviewCard(controller, controller.getPageToken(), afterA, inputs(afterA, after.writes[afterA.key]), () => ({ id: 'A3' }))
  const reusedB = memoReviewCard(controller, controller.getPageToken(), afterB, inputs(afterB, after.writes[afterB.key]), () => ({ id: 'B3' }))
  assert.notEqual(rebuiltA, elementA, 'the written card rebuilds')
  assert.equal(reusedB, elementB, 'the untouched card element survives a successful save')
})

test('a page change or a different controller never mis-reuses an element', async () => {
  const { controller } = makeController([rawReview(0, 1)])
  await controller.openPage()
  const token = controller.getPageToken()
  const [review] = controller.getSnapshot().reviews
  const element = memoReviewCard(controller, token, review, inputs(review, undefined), () => ({ id: 'x1' }))
  assert.equal(memoReviewCard(controller, token, review, inputs(review, undefined), () => ({ id: 'x2' })), element)

  await controller.refresh()
  const nextToken = controller.getPageToken()
  assert.notEqual(nextToken, token, 'refresh starts a new page identity')
  assert.notEqual(
    memoReviewCard(controller, nextToken, review, inputs(review, undefined), () => ({ id: 'x3' })),
    element,
    'a new page never serves the old page element',
  )

  const { controller: other } = makeController([rawReview(0, 1)])
  await other.openPage()
  assert.notEqual(
    memoReviewCard(other, other.getPageToken(), review, inputs(review, undefined), () => ({ id: 'x4' })),
    element,
    'a different controller never serves another controller element',
  )
})

test('adopting a server intent structurally shares every untouched review/annotation', async () => {
  const { controller } = makeController([rawReview(0, 3), rawReview(1, 2)])
  await controller.openPage()
  const before = controller.getSnapshot()
  assert.equal(before.phase, 'ready')
  const [reviewA, reviewB] = before.reviews
  const annotations = reviewA.annotations
  const result = await controller.setIntent(reviewA.key, 1, 'planned')
  assert.equal(result.ok, true)
  const after = controller.getSnapshot()
  assert.notEqual(after.reviews, before.reviews, 'the page array must be replaced immutably')
  assert.notEqual(after.reviews[0], reviewA, 'the written review is a new object')
  assert.notEqual(after.reviews[0].annotations, annotations, 'the annotation array changed')
  assert.equal(after.reviews[0].annotations[1].intent, 'planned')
  assert.equal(after.reviews[0].annotations[0], annotations[0], 'untouched annotation keeps identity')
  assert.equal(after.reviews[0].annotations[2], annotations[2], 'untouched annotation keeps identity')
  assert.equal(after.reviews[0].reviewFingerprint, 'fp0')
  assert.equal(after.reviews[0].revision, 6)
  assert.equal(after.reviews[1], reviewB, 'an unrelated review keeps identity (and its card memo)')
})

test('a filter-only change leaves the reviews array and the all-filter list untouched', async () => {
  const { controller } = makeController([rawReview(0, 2), rawReview(1, 1)])
  await controller.openPage()
  const before = controller.getSnapshot()
  const allBefore = cachedFilteredReviews(before.reviews, 'all')
  controller.setFilter('planned')
  const after = controller.getSnapshot()
  assert.equal(after.reviews, before.reviews, 'filtering never rebuilds the page')
  assert.equal(cachedFilteredReviews(after.reviews, 'all'), allBefore)
  assert.equal(cachedPageCounts(after.reviews), cachedPageCounts(before.reviews))
})
