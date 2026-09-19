// Stage tests for the approved on-demand annotation disclosure:
//   - <=8 annotations stay expanded; >8 render behind a native <details>
//   - every annotation node and its original index stay in the DOM
//   - the review status / summary / error text stays OUTSIDE the disclosure
//   - the <details> is uncontrolled (no "open" prop), so a successful write
//     re-render cannot force it closed (real open state is covered by the
//     browser driver).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHookRunner } from './performance-review-ui.harness.js'
import { INBOX_PANEL_ID, createCielInbox } from '../src/inbox.js'

const SESSION = 's1'

function rawReview(id, count, overrides = {}) {
  return {
    sessionId: SESSION,
    reviewId: 'r' + id,
    messageId: 'm' + id,
    reviewFingerprint: 'fp' + id,
    revision: 5,
    status: 'sound',
    verdict: 'pass',
    coverage: 'complete',
    createdAt: 1000 + id,
    annotations: Array.from({ length: count }, (_, k) => ({
      index: k,
      severity: k === 0 ? 'blocker' : 'nit',
      title: 't' + k,
      anchor: 'anchor-' + id + '-' + k,
      comment: 'c' + k,
      evidenceIds: [],
    })),
    ...overrides,
  }
}

const propsOf = (node) => node.__element[1]

/** Walk the element tree, expanding function components (the stub never reconciles). */
function walk(node, visit, depth = 0) {
  if (depth > 20 || node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1)
    return
  }
  if (!Object.prototype.hasOwnProperty.call(node, '__element')) return
  visit(node)
  const type = node.__element[0]
  if (typeof type === 'function') walk(type(node.__element[1]), visit, depth + 1)
  for (let i = 2; i < node.__element.length; i += 1) walk(node.__element[i], visit, depth + 1)
}

function findAll(node, predicate) {
  const found = []
  walk(node, (element) => { if (predicate(element)) found.push(element) })
  return found
}

function liveInbox(reviews) {
  const runner = makeHookRunner()
  const React = { createElement: (...args) => ({ __element: args }), ...runner.hooks }
  const inbox = createCielInbox({ React })
  const registrations = {}
  inbox.install({
    slots: {
      inject: (key, fn) => fn(),
      register: (desc, component) => { registrations['main:' + desc.key] = component; return () => {} },
    },
  }, {
    call: async (method, request) => {
      if (method === 'inboxList') return { ok: true, sessionId: request.sessionId, reviews, nextCursor: null, limited: false }
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
      return { ok: false, code: 'unexpected', error: 'unexpected method ' + method }
    },
    getSessions: () => ({ list: { getSnapshot: () => ({ current: SESSION }) } }),
  })
  return {
    runner,
    controller: inbox.getController(),
    render: () => runner.render(registrations['main:' + INBOX_PANEL_ID], { controller: inbox.getController() }),
  }
}

const disclosureNodes = (node) => findAll(node, (element) => propsOf(element)['data-ciel-disclosure'] !== undefined)
const annotationNodes = (node) => findAll(node, (element) => propsOf(element)['data-ciel-inbox-annotation'] !== undefined)

test('8 annotations stay expanded; 9 render behind a native disclosure', async () => {
  const eight = liveInbox([rawReview(0, 8)])
  await eight.controller.openPage()
  const tree8 = eight.render()
  assert.equal(disclosureNodes(tree8).length, 0, '8 annotations are not wrapped')
  assert.equal(annotationNodes(tree8).length, 8)

  const nine = liveInbox([rawReview(0, 9)])
  await nine.controller.openPage()
  const tree9 = nine.render()
  const details = disclosureNodes(tree9)
  assert.equal(details.length, 1)
  assert.equal(propsOf(details[0])['data-ciel-disclosure'], '9')
  assert.equal(propsOf(details[0])['data-ciel-inbox-disclosure'], '9')
  const summary = findAll(tree9, (element) => propsOf(element)['data-ciel-disclosure-summary'] !== undefined)
  assert.equal(summary.length, 1)
  assert.equal(summary[0].__element[2], '批注明细 9 条')
  const annotations = annotationNodes(tree9)
  assert.equal(annotations.length, 9, 'every annotation node is still in the DOM')
  assert.deepEqual(
    annotations.map((node) => propsOf(node)['data-ciel-inbox-annotation']),
    ['0', '1', '2', '3', '4', '5', '6', '7', '8'],
    'original indices are preserved',
  )
  const childTypes = details[0].__element.slice(2).filter(Boolean).map((child) => (child && child.__element ? child.__element[0] : typeof child))
  assert.deepEqual(childTypes, ['summary', 'ul'], 'the disclosure holds only the summary and the annotation list')
})

test('the review error/status copy stays outside the disclosure', async () => {
  const failing = liveInbox([rawReview(0, 9, {
    status: 'failed', verdict: undefined, coverage: undefined, error: 'boom', summary: '失败摘要',
  })])
  await failing.controller.openPage()
  const tree = failing.render()
  const details = disclosureNodes(tree)
  assert.equal(details.length, 1)
  assert.equal(propsOf(details[0])['data-ciel-disclosure'], '9')
  assert.equal(findAll(details[0], (element) => propsOf(element)['data-ciel-inbox-review-error'] !== undefined).length, 0,
    'the error line must not be inside the disclosure')
  assert.equal(findAll(details[0], (element) => propsOf(element)['data-ciel-inbox-summary'] !== undefined).length, 0,
    'the review summary must not be inside the disclosure')
  const errors = findAll(tree, (element) => propsOf(element)['data-ciel-inbox-review-error'] !== undefined)
  const summaries = findAll(tree, (element) => propsOf(element)['data-ciel-inbox-summary'] !== undefined)
  assert.equal(errors.length, 1, 'the error line is rendered somewhere in the card')
  assert.equal(summaries.length, 1, 'the review summary is rendered somewhere in the card')
})

test('the disclosure is uncontrolled and survives a successful write re-render', async () => {
  const rt = liveInbox([rawReview(0, 9), rawReview(1, 3)])
  await rt.controller.openPage()
  let tree = rt.render()
  let details = disclosureNodes(tree)
  assert.equal(details.length, 1)
  assert.equal(propsOf(details[0]).open, undefined, 'no open prop: the DOM owns the disclosure state')

  const review = rt.controller.getSnapshot().reviews[0]
  const result = await rt.controller.setIntent(review.key, 1, 'planned')
  assert.equal(result.ok, true)

  tree = rt.render()
  details = disclosureNodes(tree)
  assert.equal(details.length, 1, 'the disclosure is still rendered after the write')
  assert.equal(propsOf(details[0])['data-ciel-disclosure'], '9')
  assert.equal(propsOf(details[0]).open, undefined, 'still uncontrolled after a write re-render')
  assert.equal(annotationNodes(tree).length, 12, 'all annotations of the page remain in the DOM')
})
