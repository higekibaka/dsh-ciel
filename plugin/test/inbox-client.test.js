// Ciel inbox client tests: the pure-ESM inbox module (controller + components)
// against a mock React renderer, a mock Cordis context, and a fake
// business-level RPC. No network, no real DSH, no DOM library, no model call.
//
// The point is the wiring and the failure modes the feature is judged on:
// session/generation isolation, never-optimistic writes with a per-review busy
// guard and strict success validation, conflict recovery, page-local filtering
// and counts that never hide anomalous groups, native slot registration and
// cleanup, and a locate gesture that never reports success without a real DOM
// node and stops the moment its page/session/navigation changes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INBOX_LABEL,
  INBOX_PANEL_ID,
  INTENT_LABELS,
  MAX_LOAD_OLDER_PAGES,
  anchorSelector,
  createCielInbox,
  createInboxController,
  currentSessionId,
  filterReviews,
  isConflictResult,
  isValidIntentMap,
  normalizeIntent,
  normalizeLimit,
  normalizeReview,
  pageCounts,
  statusLabel,
  validateListPayload,
} from '../src/inbox.js'
import { createRuntime } from './review-ui.harness.js'

const POINTER = 'a'.repeat(64)
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

// ── tiny React renderer ───────────────────────────────────────────────────

function createRenderer() {
  let instance = null
  const same = (left, right) => {
    if (left === right) return true
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }
  const React = {
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { __el: true, type, props: { ...(props || {}), children: kids } }
    },
    useState(initial) {
      const index = instance.cursor++
      if (instance.state[index] === undefined) instance.state[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [instance.state[index].value, (next) => { instance.state[index].value = typeof next === 'function' ? next(instance.state[index].value) : next }]
    },
    useEffect(effect, deps) {
      instance.effects.push({ index: instance.cursor++, effect, deps })
    },
  }
  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    if (node.text !== undefined) return node.text
    return (node.children || []).map(textOf).join('')
  }
  const build = (raw) => {
    const elements = []
    const convert = (node) => {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
      if (Array.isArray(node)) return { children: node.map(convert).filter((child) => child !== null) }
      if (!node.__el) return null
      if (typeof node.type === 'function') return convert(node.type(node.props))
      const element = { type: node.type, props: node.props, children: [] }
      elements.push(element)
      const child = convert(node.props.children)
      if (child !== null) element.children.push(child)
      return element
    }
    const root = convert(raw)
    return {
      root,
      elements,
      text: textOf(root),
      all: (predicate) => elements.filter(predicate),
      find: (predicate) => elements.find(predicate),
      textOf,
      click: (element) => (element && typeof element.props.onClick === 'function' ? element.props.onClick({}) : undefined),
    }
  }
  const render = () => {
    instance.cursor = 0
    instance.effects = []
    const tree = build(instance.component(instance.props))
    for (const entry of instance.effects) {
      const previous = instance.slots[entry.index]
      const shouldRun = entry.deps === undefined || previous === undefined || !same(previous.deps, entry.deps)
      if (!shouldRun) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = entry.effect()
      instance.slots[entry.index] = { deps: entry.deps === undefined ? undefined : [...entry.deps], cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    }
    return tree
  }
  return {
    React,
    mount(component, props) {
      instance = { component, props, cursor: 0, state: [], effects: [], slots: [] }
      return render()
    },
    rerender: () => render(),
    unmount() {
      for (const slot of instance.slots) if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
      instance = null
    },
  }
}

/** The plain-span Tag fixture, like the native chip's structural role. */
function FixtureTag(props) {
  return { __el: true, type: 'span', props: { 'data-tag': props.tone || 'neutral', children: props.children } }
}

function createMockContext() {
  const registrations = new Map()
  const slotKey = (registration) => registration.name + ':' + (registration.key === undefined ? registration.id : registration.key)
  const ctx = {
    slots: {
      inject(key, callback) {
        const cleanup = callback()
        return () => { if (typeof cleanup === 'function') cleanup() }
      },
      register(registration, component) {
        registrations.set(slotKey(registration), { registration, component })
        return () => { registrations.delete(slotKey(registration)) }
      },
    },
  }
  return { ctx, registrations }
}

// ── fixtures ──────────────────────────────────────────────────────────────

function reviewOf(overrides) {
  return {
    sessionId: 's1',
    reviewId: 'r1',
    messageId: 'm1',
    createdAt: 100,
    status: 'sound',
    reviewFingerprint: POINTER,
    revision: 0,
    annotations: [{ index: 0, severity: 'nit', title: 't', anchor: 'a', comment: 'c', intent: 'pending' }],
    ...overrides,
  }
}

function listResult(sessionId, reviews, nextCursor, limited) {
  return { ok: true, sessionId, reviews, nextCursor: nextCursor === undefined ? null : nextCursor, limited: limited === true }
}

function writeResult(overrides) {
  return { ok: true, sessionId: 's1', reviewId: 'r1', reviewFingerprint: POINTER, revision: 1, intents: { 0: 'planned' }, ...overrides }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakeSessions(initial) {
  const listeners = new Set()
  const state = { current: initial }
  return {
    list: {
      getSnapshot: () => ({ byId: {
        background: { id: 'background', retainedBy: { subagentView: 1 } },
        ...(state.current === undefined ? {} : { [state.current]: { id: state.current, retainedBy: { mainView: 1 } } }),
      } }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    setCurrent(next) { state.current = next; for (const listener of [...listeners]) listener() },
  }
}

test('selection follows main-view ownership and supports the older current field', () => {
  assert.equal(currentSessionId(fakeSessions('s1').list.getSnapshot()), 's1')
  assert.equal(currentSessionId(fakeSessions(undefined).list.getSnapshot()), undefined)
  assert.equal(currentSessionId({ byId: { old: { id: 'old', retainedBy: {} } } }), undefined)
  assert.equal(currentSessionId({ current: 'legacy' }), 'legacy')
  assert.equal(currentSessionId({ current: undefined }), undefined)
})

function makeController(callImpl, options) {
  const calls = []
  const opts = options === undefined ? {} : options
  const controller = createInboxController({
    call: async (method, request) => { calls.push({ method, request }); return callImpl(method, request) },
    getSessions: opts.getSessions,
    host: opts.host,
    pageSize: opts.pageSize,
    now: () => 1000,
  })
  return { controller, calls }
}

// ── pure helpers ──────────────────────────────────────────────────────────

test('normalizeLimit clamps to 1..25 and defaults to 25', () => {
  assert.equal(normalizeLimit(undefined), 25)
  assert.equal(normalizeLimit(0), 1)
  assert.equal(normalizeLimit(7.8), 7)
  assert.equal(normalizeLimit(100), 25)
  assert.equal(normalizeLimit(NaN), 25)
})

test('normalizeIntent accepts only the three legal values', () => {
  assert.equal(normalizeIntent('planned'), 'planned')
  assert.equal(normalizeIntent('rejected'), 'rejected')
  assert.equal(normalizeIntent('pending'), 'pending')
  assert.equal(normalizeIntent('accept'), 'pending')
  assert.equal(normalizeIntent(undefined), 'pending')
})

test('isValidIntentMap rejects unknown keys and values', () => {
  assert.equal(isValidIntentMap({}), true)
  assert.equal(isValidIntentMap({ 0: 'planned', 2: 'rejected' }), true)
  assert.equal(isValidIntentMap({ '01': 'planned' }), false)
  assert.equal(isValidIntentMap({ 0: 'accept' }), false)
  assert.equal(isValidIntentMap(null), false)
  assert.equal(isValidIntentMap([]), false)
  assert.equal(isValidIntentMap({ 0: 'planned' }, 1), true)
  assert.equal(isValidIntentMap({ 1: 'planned' }, 1), false)
  assert.equal(isValidIntentMap({ 0: 'planned' }, 0), false)
})

test('identity strings are preserved verbatim, never trimmed or truncated', () => {
  const long = 'r'.repeat(512)
  const review = normalizeReview(reviewOf({ reviewId: long, messageId: '  m  ' }), 0)
  assert.equal(review.reviewId, long)
  assert.equal(review.messageId, '  m  ')
  assert.equal(review.invalid, undefined)
  const over = normalizeReview(reviewOf({ reviewId: 'r'.repeat(513) }), 0)
  assert.equal(over.reviewId.length, 513, 'the identity itself is kept, not clipped')
  assert.equal(over.invalid, true, 'an over-long identity is an explicit invalid response')
})

test('statusLabel covers the real completed status', () => {
  assert.equal(statusLabel('completed'), '已完成')
  assert.equal(statusLabel('sound'), '整体成立')
  assert.equal(statusLabel('incomplete'), '未检查完')
  assert.equal(statusLabel('nonsense'), '状态未知')
})

test('normalizeReview keeps only declared fields and bounds every non-identity string', () => {
  const review = normalizeReview({
    sessionId: 's', reviewId: 'r', messageId: 'm', createdAt: 12, status: 'error',
    reviewFingerprint: POINTER, revision: 3, anchorSeq: 9,
    summary: 'x'.repeat(900),
    raw: 'RAW-SECRET',
    evidence: { content: 'SOURCE-SECRET' },
    annotations: [{ index: 0, severity: 'blocker', title: 'T', anchor: 'A', comment: 'C', evidenceIds: ['e1', 'e2', 'bogus', 'e1'], intent: 'planned', raw: 'nope' }],
  }, 0)
  assert.equal(review.reviewId, 'r')
  assert.equal(review.messageId, 'm')
  assert.equal(review.anchorSeq, 9)
  assert.equal(review.revision, 3)
  assert.equal(review.summary.length <= 600, true)
  assert.equal(Object.prototype.hasOwnProperty.call(review, 'raw'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(review, 'evidence'), false)
  const annotation = review.annotations[0]
  assert.deepEqual(annotation.evidenceIds, ['e1', 'e2', 'bogus', 'e1'])
  assert.equal(Object.prototype.hasOwnProperty.call(annotation, 'raw'), false)
  assert.equal(annotation.intent, 'planned')
})

test('validateListPayload accepts the Host shape and rejects anything short of it', () => {
  assert.equal(validateListPayload(listResult('s1', [reviewOf()]), 's1'), undefined)
  assert.equal(validateListPayload({ ok: true, sessionId: 's1', reviews: null, nextCursor: null }, 's1'), 'reviews')
  assert.equal(validateListPayload({ ok: true, sessionId: 's2', reviews: [], nextCursor: null }, 's1'), 'session')
  assert.equal(validateListPayload(listResult('s1', [null]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ sessionId: 'other' })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ reviewId: '' })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ messageId: '' })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ reviewFingerprint: '' })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ revision: -1 })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ annotations: null })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ annotations: [null] })]), 's1'), 'annotation')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ annotations: [{ index: 1, severity: 'nit', intent: 'pending' }] })]), 's1'), 'annotation')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ annotations: [{ index: 0, severity: 'critical' }] })]), 's1'), 'annotation')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ annotations: [{ index: 0, intent: 'accept' }] })]), 's1'), 'annotation')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ revision: 1.5 })]), 's1'), 'review')
  assert.equal(validateListPayload(listResult('s1', [reviewOf({ reviewId: 'r'.repeat(513) })]), 's1'), 'review')
  assert.equal(validateListPayload({ ok: true, sessionId: 's1', reviews: [], nextCursor: 5 }, 's1'), 'cursor')
})

test('filterReviews keeps anomalous groups under every intent filter', () => {
  const page = [
    normalizeReview(reviewOf({ reviewId: 'ok', annotations: [{ index: 0, intent: 'planned' }] }), 0),
    normalizeReview(reviewOf({ reviewId: 'bad', status: 'error', annotations: [] }), 1),
    normalizeReview(reviewOf({ reviewId: 'stop', status: 'cancelled', annotations: [] }), 2),
  ]
  assert.deepEqual(filterReviews(page, 'rejected').map((r) => r.reviewId), ['bad', 'stop'])
  assert.deepEqual(filterReviews(page, 'planned').map((r) => r.reviewId), ['ok', 'bad', 'stop'])
  assert.deepEqual(filterReviews(page, 'all').map((r) => r.reviewId), ['ok', 'bad', 'stop'])
})

test('pageCounts is page-local', () => {
  const page = [
    normalizeReview(reviewOf({ reviewId: 'a', annotations: [{ index: 0, intent: 'planned' }] }), 0),
    normalizeReview(reviewOf({ reviewId: 'b', annotations: [{ index: 0, intent: 'pending' }, { index: 1, intent: 'rejected' }] }), 1),
    normalizeReview(reviewOf({ reviewId: 'c', status: 'cancelled', annotations: [] }), 2),
  ]
  const counts = pageCounts(page)
  assert.equal(counts.reviews, 3)
  assert.equal(counts.annotations, 3)
  assert.equal(counts.planned, 1)
  assert.equal(counts.pending, 1)
  assert.equal(counts.rejected, 1)
  assert.equal(counts.cancelled, 1)
})

test('isConflictResult recognises the Host conflict codes but not revision_exhausted', () => {
  assert.equal(isConflictResult({ ok: false, code: 'fingerprint_mismatch' }), true)
  assert.equal(isConflictResult({ ok: false, code: 'revision_conflict' }), true)
  assert.equal(isConflictResult({ ok: false, code: 'review_not_found' }), true)
  assert.equal(isConflictResult({ ok: false, code: 'write_failed' }), false)
  assert.equal(isConflictResult({ ok: false, code: 'revision_exhausted' }), false)
  assert.equal(isConflictResult({ ok: false, code: 'store_error' }), false)
})

test('anchorSelector targets the existing Ciel-owned message anchor', () => {
  assert.equal(anchorSelector('s1', 'm1'), '[data-ciel-session-id="s1"][data-ciel-message-id="m1"]')
})

// ── controller: session + generation isolation ────────────────────────────

test('a late response from another session never overwrites the current page', async () => {
  const first = deferred()
  const second = deferred()
  const { controller, calls } = makeController((method, request) => (request.sessionId === 's1' ? first.promise : second.promise))
  controller.syncSession('s1')
  const loadFirst = controller.ensureLoaded()
  controller.syncSession('s2')
  const loadSecond = controller.ensureLoaded()
  second.resolve(listResult('s2', [reviewOf({ sessionId: 's2', reviewId: 'r2', messageId: 'm2' })]))
  await loadSecond
  first.resolve(listResult('s1', [reviewOf({ sessionId: 's1', reviewId: 'r1', messageId: 'm1' })]))
  await loadFirst
  await flush()
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.sessionId, 's2')
  assert.deepEqual(snapshot.reviews.map((review) => review.reviewId), ['r2'])
  assert.deepEqual(calls.map((call) => call.request.sessionId), ['s1', 's2'])
})

test('a malformed page is an explicit error, never a silent empty page', async () => {
  for (const page of [
    { ok: true, sessionId: 's1', reviews: null, nextCursor: null, limited: false },
    { ok: true, sessionId: 's1', reviews: [null], nextCursor: null, limited: false },
    { ok: true, sessionId: 's1', reviews: [reviewOf({ sessionId: 'other' })], nextCursor: null, limited: false },
    { ok: true, sessionId: 's1', reviews: [reviewOf({ reviewFingerprint: '' })], nextCursor: null, limited: false },
  ]) {
    const { controller } = makeController(() => page)
    controller.syncSession('s1')
    const result = await controller.ensureLoaded()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'record_corrupt')
    const snapshot = controller.getSnapshot()
    assert.equal(snapshot.phase, 'error')
    assert.equal(snapshot.errorCode, 'record_corrupt')
    assert.equal(snapshot.reviews.length, 0)
  }
})

test('a write response that lands after a session switch is dropped, not applied', async () => {
  const write = deferred()
  const { controller } = makeController((method) => (method === 'inboxList' ? listResult('s1', [reviewOf()]) : write.promise))
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const pending = controller.setIntent('r1#0', 0, 'planned')
  controller.syncSession('s2')
  write.resolve(writeResult())
  const result = await pending
  assert.equal(result.stale, true)
  assert.equal(controller.getSnapshot().reviews.length, 0)
})

test('no session means no request and a visible empty state', async () => {
  const { controller, calls } = makeController(() => listResult('s1', []))
  controller.syncSession(undefined)
  const result = await controller.ensureLoaded()
  assert.equal(result.ok, false)
  assert.equal(controller.getSnapshot().sessionId, undefined)
  assert.equal(controller.getSnapshot().phase, 'empty')
  assert.equal(calls.length, 0)
  await controller.refresh()
  assert.equal(calls.length, 0)
})

// ── controller: writes ────────────────────────────────────────────────────

test('a chosen intent is never marked saved before the server confirms', async () => {
  const gate = deferred()
  const { controller } = makeController((method) => (method === 'inboxList' ? listResult('s1', [reviewOf()]) : gate.promise))
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const pending = controller.setIntent('r1#0', 0, 'planned')
  await flush()
  assert.equal(controller.getSnapshot().reviews[0].annotations[0].intent, 'pending')
  assert.equal(controller.getSnapshot().writes['r1#0'].pending, true)
  gate.resolve(writeResult())
  const result = await pending
  assert.equal(result.ok, true)
  const review = controller.getSnapshot().reviews[0]
  assert.equal(review.annotations[0].intent, 'planned')
  assert.equal(review.revision, 1)
  assert.equal(controller.getSnapshot().writes['r1#0'].pending, false)
})

test('a second same-review write is refused while the first is in flight', async () => {
  const gate = deferred()
  const { controller, calls } = makeController((method) => (method === 'inboxList' ? listResult('s1', [reviewOf()]) : gate.promise))
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const first = controller.setIntent('r1#0', 0, 'planned')
  await flush()
  const second = await controller.setIntent('r1#0', 0, 'rejected')
  assert.equal(second.code, 'write_busy')
  assert.equal(calls.filter((call) => call.method === 'inboxSetIntent').length, 1)
  gate.resolve(writeResult())
  assert.equal((await first).ok, true)
})

test('a success response is validated strictly before anything is adopted', async () => {
  const cases = [
    { name: 'missing session', result: writeResult({ sessionId: undefined }) },
    { name: 'wrong review', result: writeResult({ reviewId: 'other' }) },
    { name: 'wrong fingerprint', result: writeResult({ reviewFingerprint: 'b'.repeat(64) }) },
    { name: 'skipped revision', result: writeResult({ revision: 2 }) },
    { name: 'missing intents', result: writeResult({ intents: undefined }) },
    { name: 'illegal intent value', result: writeResult({ intents: { 0: 'accept' } }) },
    { name: 'array intents', result: writeResult({ intents: [] }) },
    { name: 'intent index out of range', result: writeResult({ intents: { 5: 'planned' } }) },
  ]
  for (const entry of cases) {
    const { controller } = makeController((method) => (method === 'inboxList' ? listResult('s1', [reviewOf()]) : entry.result))
    controller.syncSession('s1')
    await controller.ensureLoaded()
    const result = await controller.setIntent('r1#0', 0, 'planned')
    assert.equal(result.ok, false, entry.name)
    assert.equal(result.conflict, true, entry.name)
    assert.equal(controller.getSnapshot().reviews[0].annotations[0].intent, 'pending', entry.name)
    assert.equal(controller.getSnapshot().reviews[0].revision, 0, entry.name)
  }
})

test('an older stored intent set is never reused: sparse intents reset unlisted ones', async () => {
  const both = reviewOf({
    revision: 3,
    annotations: [
      { index: 0, severity: 'nit', title: 't', anchor: 'a', comment: 'c', intent: 'planned' },
      { index: 1, severity: 'nit', title: 't', anchor: 'a', comment: 'c', intent: 'rejected' },
    ],
  })
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [both])
    : writeResult({ revision: 4, intents: { 1: 'planned' } })))
  controller.syncSession('s1')
  await controller.ensureLoaded()
  await controller.setIntent('r1#0', 0, 'rejected')
  const intents = controller.getSnapshot().reviews[0].annotations.map((annotation) => annotation.intent)
  assert.deepEqual(intents, ['pending', 'planned'])
})

test('a conflict is shown and requires a refresh; the stale click is not retried', async () => {
  const { controller, calls } = makeController((method) => {
    if (method === 'inboxList') return listResult('s1', [reviewOf()])
    return { ok: false, code: 'fingerprint_mismatch', error: '评审内容已变化，内容指纹不匹配；请刷新后重试' }
  })
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const first = await controller.setIntent('r1#0', 0, 'planned')
  assert.equal(first.conflict, true)
  assert.equal(controller.getSnapshot().writes['r1#0'].conflict, true)
  assert.equal(controller.getSnapshot().reviews[0].annotations[0].intent, 'pending')
  const writeCalls = calls.filter((call) => call.method === 'inboxSetIntent').length
  const second = await controller.setIntent('r1#0', 0, 'rejected')
  assert.equal(second.code, 'stale')
  assert.equal(calls.filter((call) => call.method === 'inboxSetIntent').length, writeCalls)
  await controller.refresh()
  assert.equal(controller.getSnapshot().writes['r1#0'], undefined)
})

test('a plain write failure (and revision_exhausted) stays retryable and is not a conflict', async () => {
  let attempt = 0
  const { controller } = makeController((method) => {
    if (method === 'inboxList') return listResult('s1', [reviewOf()])
    attempt += 1
    if (attempt === 1) return { ok: false, code: 'write_failed', error: '收件箱写入失败；状态未更新' }
    if (attempt === 2) return { ok: false, code: 'revision_exhausted', error: '评审意向版本已达上限' }
    return writeResult()
  })
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const failed = await controller.setIntent('r1#0', 0, 'planned')
  assert.equal(failed.ok, false)
  assert.equal(failed.conflict, false)
  assert.equal(controller.getSnapshot().writes['r1#0'].error, '收件箱写入失败；状态未更新')
  const exhausted = await controller.setIntent('r1#0', 0, 'planned')
  assert.equal(exhausted.ok, false)
  assert.equal(exhausted.conflict, false)
  assert.equal(controller.getSnapshot().writes['r1#0'].error, '评审意向版本已达上限')
  const retried = await controller.setIntent('r1#0', 0, 'planned')
  assert.equal(retried.ok, true)
  assert.equal(controller.getSnapshot().reviews[0].annotations[0].intent, 'planned')
})

test('the request carries the current fingerprint and expected revision', async () => {
  const { controller, calls } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ revision: 7 })])
    : writeResult({ revision: 8 })))
  controller.syncSession('s1')
  await controller.ensureLoaded()
  await controller.setIntent('r1#0', 0, 'planned')
  const request = calls.find((call) => call.method === 'inboxSetIntent').request
  assert.deepEqual(request, {
    sessionId: 's1', reviewId: 'r1', reviewFingerprint: POINTER, expectedRevision: 7, index: 0, intent: 'planned',
  })
})

// ── controller: paging, filter, counts ────────────────────────────────────

test('paging fetches one page at a time, replaces the page, and keeps page-local counts', async () => {
  const pages = {
    undefined: listResult('s1', [reviewOf({ reviewId: 'r1' }), reviewOf({ reviewId: 'r2', status: 'error', annotations: [] })], 'c1', true),
    c1: listResult('s1', [reviewOf({ reviewId: 'r3' })], null, false),
  }
  const { controller, calls } = makeController((method, request) => pages[request.cursor])
  controller.syncSession('s1')
  await controller.ensureLoaded()
  assert.equal(calls[0].request.limit, 25)
  const first = controller.getSnapshot()
  assert.deepEqual(first.reviews.map((review) => review.reviewId), ['r1', 'r2'])
  assert.equal(first.limited, true)
  assert.equal(pageCounts(first.reviews).failed, 1)
  assert.equal(first.nextCursor, 'c1')
  await controller.nextPage()
  const second = controller.getSnapshot()
  assert.deepEqual(second.reviews.map((review) => review.reviewId), ['r3'])
  assert.equal(second.pageIndex, 2)
  assert.equal(calls[1].request.cursor, 'c1')
  assert.deepEqual(filterReviews(second.reviews, 'pending').map((review) => review.reviewId), ['r3'])
  await controller.prevPage()
  assert.deepEqual(controller.getSnapshot().reviews.map((review) => review.reviewId), ['r1', 'r2'])
  assert.equal(controller.getSnapshot().pageIndex, 1)
  assert.equal(calls[2].request.cursor, undefined)
})

test('setFilter is page-local and rejects unknown filters', async () => {
  const { controller } = makeController(() => listResult('s1', [reviewOf()]))
  controller.syncSession('s1')
  await controller.ensureLoaded()
  controller.setFilter('planned')
  assert.equal(controller.getSnapshot().filter, 'planned')
  controller.setFilter('bogus')
  assert.equal(controller.getSnapshot().filter, 'all')
})

test('the inbox never installs a polling interval', async () => {
  const realSetInterval = globalThis.setInterval
  let intervalCalls = 0
  globalThis.setInterval = (...args) => { intervalCalls += 1; return realSetInterval(...args) }
  try {
    const { controller } = makeController((method) => (method === 'inboxList' ? listResult('s1', [reviewOf()]) : writeResult({ intents: {} })))
    controller.syncSession('s1')
    await controller.ensureLoaded()
    await controller.setIntent('r1#0', 0, 'planned')
    controller.syncSession('s2')
    await controller.ensureLoaded()
    await controller.refresh()
  } finally {
    globalThis.setInterval = realSetInterval
  }
  assert.equal(intervalCalls, 0)
})

// ── controller: locate ────────────────────────────────────────────────────

function locateOptions(overrides) {
  const order = []
  const state = { ready: false, loadThroughCalls: 0, loadOlderCalls: 0, findCalls: 0 }
  const opts = {
    order,
    state,
    host: {
      revealConversation: () => { order.push('reveal') },
      beginNavigation: () => { order.push('navigate'); return { aborted: state.aborted === true } },
      findAnchor: () => { state.findCalls += 1; return state.ready ? { id: 'anchor' } : undefined },
      scrollToAnchor: () => { order.push('scroll') },
      nextFrame: async () => {},
      loadThrough: async () => { state.loadThroughCalls += 1; if (typeof overrides.afterLoadThrough === 'function') overrides.afterLoadThrough(state) },
      loadOlder: async () => { state.loadOlderCalls += 1 },
      revealInbox: () => { order.push('back') },
    },
    getSessions: () => ({ list: { getSnapshot: () => ({ current: 's1' }) } }),
  }
  return opts
}

test('locate reports success only after a real anchor node appears, and scrolls it', async () => {
  const options = locateOptions({ afterLoadThrough: (state) => { state.ready = true } })
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ anchorSeq: 7 })])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, true)
  assert.equal(options.state.loadThroughCalls, 1)
  assert.equal(options.state.loadOlderCalls, 0)
  assert.ok(options.order.indexOf('reveal') < options.order.indexOf('navigate'), 'fresh navigation signal after the panel switch')
  assert.ok(options.order.includes('scroll'))
  assert.equal(controller.getSnapshot().locate['r1#0'].phase, 'located')
})

test('locate never fakes success when the anchor stays absent', async () => {
  const options = locateOptions({})
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ anchorSeq: 7 })])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_found')
  assert.equal(options.state.loadThroughCalls, 1)
  assert.ok(!options.order.includes('scroll'), 'no scroll without a node')
  assert.ok(options.order.includes('back'), 'a failed locate brings the inbox back so the error is visible')
  assert.equal(controller.getSnapshot().locate['r1#0'].phase, 'failed')
  assert.match(controller.getSnapshot().locate['r1#0'].error, /尝试加载/)
})

test('a legacy record without anchorSeq pages older history a bounded number of times', async () => {
  const options = locateOptions({})
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf()])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, false)
  assert.equal(options.state.loadOlderCalls, MAX_LOAD_OLDER_PAGES)
  assert.equal(options.state.loadThroughCalls, 0)
})

test('an aborted navigation signal fails the locate without loading history', async () => {
  const options = locateOptions({ afterLoadThrough: (state) => { state.ready = true } })
  options.host.beginNavigation = () => { options.order.push('navigate'); return { aborted: true } }
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ anchorSeq: 7 })])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stale')
  assert.equal(options.state.loadThroughCalls, 0)
  assert.ok(!options.order.includes('scroll'))
  assert.ok(!options.order.includes('back'), 'never hijack a navigation the user cancelled')
  assert.equal(controller.getSnapshot().locate['r1#0'].phase, 'failed')
})

test('a session switch during a history load stops the locate and writes nothing to the new page', async () => {
  const options = locateOptions({})
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ anchorSeq: 7 })])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  options.host.loadThrough = async () => {
    options.state.loadThroughCalls += 1
    controller.syncSession('s2')
  }
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stale')
  assert.equal(options.state.loadOlderCalls, 0)
  assert.ok(!options.order.includes('back'), 'a superseded locate does not yank the user back')
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.sessionId, 's2')
  assert.deepEqual(Object.keys(snapshot.locate), [])
})

test('locate refuses a review that belongs to another session', async () => {
  const options = locateOptions({})
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf()])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  controller.syncSession('s2')
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, false)
  assert.equal(options.state.findCalls, 0)
})

test('a locate failure survives the panel-open refresh but is cleared by an explicit refresh', async () => {
  const options = locateOptions({})
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ anchorSeq: 7 })])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  await controller.locate('r1#0')
  assert.equal(controller.getSnapshot().locate['r1#0'].phase, 'failed')
  await controller.openPage()
  assert.equal(controller.getSnapshot().locate['r1#0'].phase, 'failed', 'the mount/open refresh keeps the just-shown failure')
  await controller.refresh()
  assert.equal(controller.getSnapshot().locate['r1#0'], undefined, 'an explicit refresh clears it')
})

test('the default locate scrolls the found element when no hook is injected', async () => {
  const options = locateOptions({ afterLoadThrough: (state) => { state.ready = true } })
  delete options.host.scrollToAnchor
  const scrolled = []
  options.host.findAnchor = () => (options.state.ready ? { scrollIntoView: (opts) => scrolled.push(opts) } : undefined)
  const { controller } = makeController((method) => (method === 'inboxList'
    ? listResult('s1', [reviewOf({ anchorSeq: 7 })])
    : listResult('s1', [])), options)
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, true)
  assert.deepEqual(scrolled, [{ behavior: 'smooth', block: 'center' }])
})

test('a locate failure from page 2 stays visible after returning to page 1, and a session switch clears it', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const pages = {
    undefined: listResult('s1', [reviewOf({ reviewId: 'r1', messageId: 'm1' })], 'c1', false),
    c1: listResult('s1', [reviewOf({ reviewId: 'r2', messageId: 'm2', anchorSeq: 9 })], null, false),
  }
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async (method, request) => pages[request.cursor],
    getSessions: () => fakeSessions('s1'),
    nextFrame: async () => {},
    revealConversation: () => {},
    revealInbox: () => {},
    beginNavigation: () => ({ aborted: false }),
    findAnchor: () => undefined,
    loadThrough: async () => {},
  })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  await controller.nextPage()
  const result = await controller.locate('r2#0')
  assert.equal(result.ok, false)
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  const tree = renderer.rerender()
  const notice = tree.find((element) => element.props['data-ciel-inbox-locate-notice'] !== undefined)
  assert.ok(notice, 'a global notice shows when the failing review is not on the reopened page')
  assert.match(tree.textOf(notice), /r2/)
  assert.match(tree.textOf(notice), /尝试加载/)
  controller.syncSession('s2')
  const after = renderer.rerender()
  assert.equal(after.find((element) => element.props['data-ciel-inbox-locate-notice'] !== undefined), undefined, 'a session switch clears the notice')
})

test('the module bindSessions invalidates an in-flight read when the service arrives after install with no panel', async () => {
  const renderer = createRenderer()
  const { ctx } = createMockContext()
  const slow = deferred()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, { call: (method, request) => (request.sessionId === 's1' ? slow.promise : Promise.resolve(listResult('s2', [reviewOf({ sessionId: 's2', reviewId: 'r2', messageId: 'm2' })]))) })
  const controller = inbox.getController()
  controller.syncSession('s1')
  const loading = controller.ensureLoaded()
  // The sessions service is not available at install; it arrives afterwards
  // and the panel is never mounted.
  const sessions = fakeSessions('s1')
  assert.equal(typeof inbox.bindSessions, 'function')
  inbox.bindSessions(sessions)
  sessions.setCurrent('s2')
  slow.resolve(listResult('s1', [reviewOf()]))
  await loading
  await flush()
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.sessionId, 's2')
  assert.equal(snapshot.reviews.length, 0)
})

test('bindSessions invalidates an in-flight read from the root subscription', async () => {
  const slow = deferred()
  const sessions = fakeSessions('s1')
  const { controller } = makeController((method, request) => (request.sessionId === 's1' ? slow.promise : listResult('s2', [reviewOf({ sessionId: 's2', reviewId: 'r2', messageId: 'm2' })])))
  controller.bindSessions(sessions)
  const loading = controller.ensureLoaded()
  sessions.setCurrent('s2')
  slow.resolve(listResult('s1', [reviewOf()]))
  await loading
  await flush()
  assert.equal(controller.getSnapshot().sessionId, 's2')
})

// ── factory: native registration and cleanup ──────────────────────────────

test('install registers the matching main panel and sidebar entry, and cleanup removes both', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  const uninstall = inbox.install(ctx, { call: async () => listResult('s1', []) })
  const main = registrations.get('main:' + INBOX_PANEL_ID)
  const entry = registrations.get('sidebar.panellist:' + INBOX_PANEL_ID)
  assert.ok(main, 'main panel registered under the shared id')
  assert.equal(main.registration.key, INBOX_PANEL_ID)
  assert.ok(entry, 'sidebar.panellist entry registered under the same id')
  assert.equal(entry.registration.id, INBOX_PANEL_ID)
  assert.equal(entry.registration.label, INBOX_LABEL)
  assert.equal(entry.registration.order, 40)
  assert.equal(typeof main.registration.inject, 'function')
  assert.equal(inbox.getController() !== undefined, true)
  uninstall()
  assert.equal(registrations.size, 0)
  assert.equal(inbox.getController(), undefined)
})

test('install requires a call function and React', () => {
  const renderer = createRenderer()
  assert.throws(() => createCielInbox({}), /React/)
  const inbox = createCielInbox({ React: renderer.React })
  const { ctx } = createMockContext()
  assert.throws(() => inbox.install(ctx, {}), /call/)
})

// ── panel rendering ───────────────────────────────────────────────────────

test('the panel shows a no-session explanation instead of a request', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  let calls = 0
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async () => { calls += 1; return listResult('s1', []) },
    getSessions: () => fakeSessions(undefined),
  })
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  const tree = renderer.mount(panel.component, { ...panel.registration.inject() })
  assert.match(tree.text, /当前没有打开的会话/)
  assert.equal(calls, 0)
})

test('a failed locate is visible after the inbox panel mounts back', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async () => listResult('s1', [reviewOf({ anchorSeq: 7 })]),
    getSessions: () => fakeSessions('s1'),
    nextFrame: async () => {},
    revealConversation: () => {},
    revealInbox: () => {},
    beginNavigation: () => ({ aborted: false }),
    findAnchor: () => undefined,
    loadThrough: async () => {},
  })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.locate('r1#0')
  assert.equal(result.ok, false)
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  const tree = renderer.rerender()
  assert.ok(tree.find((element) => element.props['data-ciel-inbox-locate-error'] !== undefined), 'the locate failure is rendered after the panel comes back')
  assert.match(tree.text, /尝试加载/)
})

test('opening the panel reads a fresh page even for an already-loaded session', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const calls = []
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async (method, request) => { calls.push(request); return listResult('s1', [reviewOf()]) },
    getSessions: () => fakeSessions('s1'),
  })
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  assert.equal(calls.length, 1)
  renderer.unmount()
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  assert.equal(calls.length, 2, 'reopening the same panel refreshes its page')
  renderer.unmount()
})

test('failed, cancelled, and unfinished reviews stay grouped even with zero annotations', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const reviews = [
    reviewOf({ reviewId: 'ok', messageId: 'm1' }),
    reviewOf({ reviewId: 'bad', messageId: 'm2', status: 'error', error: 'boom', annotations: [] }),
    reviewOf({ reviewId: 'stop', messageId: 'm3', status: 'cancelled', annotations: [] }),
    reviewOf({ reviewId: 'part', messageId: 'm4', status: 'incomplete', coverage: 'partial', annotations: [] }),
  ]
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, { call: async () => listResult('s1', reviews), getSessions: () => fakeSessions('s1') })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  const tree = renderer.mount(panel.component, { ...panel.registration.inject() })
  const groups = tree.all((element) => element.props['data-ciel-inbox-review'] !== undefined)
  assert.deepEqual(groups.map((group) => group.props['data-ciel-inbox-review']), ['ok', 'bad', 'stop', 'part'])
  assert.match(tree.text, /本次评审失败，没有留下批注。/)
  assert.match(tree.text, /本次评审已取消，没有留下批注。/)
  assert.match(tree.text, /本次评审未检查完，没有留下批注。/)
  assert.match(tree.text, /错误：boom/)
})

test('intent controls are disabled as one review group while a write is in flight', async () => {
  const gate = deferred()
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const review = reviewOf({
    annotations: [
      { index: 0, severity: 'nit', title: 't', anchor: 'a', comment: 'c', intent: 'pending' },
      { index: 1, severity: 'nit', title: 't', anchor: 'a', comment: 'c', intent: 'pending' },
    ],
  })
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async (method) => (method === 'inboxList' ? listResult('s1', [review]) : gate.promise),
    getSessions: () => fakeSessions('s1'),
  })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  void controller.setIntent('r1#0', 0, 'planned')
  await flush()
  const tree = renderer.rerender()
  const intents = tree.all((element) => element.props['data-ciel-intent'] !== undefined)
  assert.equal(intents.length, 6)
  assert.equal(intents.every((button) => button.props.disabled === true), true)
  gate.resolve(writeResult())
  await flush()
})

test('the static sidebar entry renders no count badge', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, { call: async () => listResult('s1', [reviewOf(), reviewOf({ reviewId: 'r2' })]), getSessions: () => fakeSessions('s1') })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const icon = registrations.get('sidebar.panellist:' + INBOX_PANEL_ID)
  const tree = renderer.mount(icon.component, { ...icon.registration.inject(), size: 16, active: false })
  assert.ok(tree.find((element) => element.props['data-ciel-inbox-icon'] !== undefined))
  assert.equal(tree.find((element) => element.props['data-ciel-inbox-count'] !== undefined), undefined)
  assert.equal(tree.find((element) => element.props['data-count'] !== undefined), undefined)
})

test('view-review and evidence buttons reuse the native right sidebar with exact ids', async () => {
  const opens = []
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const review = reviewOf({ annotations: [{ index: 0, severity: 'blocker', title: 'T', anchor: 'A', comment: 'C', intent: 'pending', evidenceIds: ['e1'] }] })
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async () => listResult('s1', [review]),
    getSessions: () => fakeSessions('s1'),
    openReview: (...args) => { opens.push(['review', ...args]); return { ok: true } },
    openEvidence: (...args) => { opens.push(['evidence', ...args]); return { ok: true } },
  })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  const tree = renderer.rerender()
  tree.click(tree.find((element) => element.props['data-ciel-inbox-view-review'] !== undefined))
  tree.click(tree.find((element) => element.props['data-ciel-inbox-evidence'] !== undefined))
  await flush()
  assert.deepEqual(opens[0], ['review', 's1', 'r1'])
  assert.deepEqual(opens[1], ['evidence', 's1', 'r1', 'e1'])
})

test('opening a review returns to the conversation and retries only the rightbar binding error', async () => {
  const order = []
  let attempts = 0
  const renderer = createRenderer()
  const { ctx } = createMockContext()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async () => listResult('s1', [reviewOf()]),
    getSessions: () => fakeSessions('s1'),
    nextFrame: async () => {},
    revealConversation: () => { order.push('reveal') },
    beginNavigation: () => { order.push('navigate'); return { aborted: false } },
    revealInbox: () => { order.push('back') },
    openReview: () => {
      attempts += 1
      return attempts < 3 ? { ok: false, error: 'sidebarRight: no session surface is mounted' } : { ok: true }
    },
  })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.openResource('review', 'r1#0')
  assert.equal(result.ok, true)
  assert.equal(attempts, 3)
  assert.ok(order.indexOf('reveal') < order.indexOf('navigate'), 'a fresh navigation signal is taken after the switch')
  assert.ok(!order.includes('back'))
  assert.equal(controller.getSnapshot().open.status, 'opened')
})

test('a non-binding open failure is final and the inbox is brought back to show it', async () => {
  const order = []
  let attempts = 0
  const renderer = createRenderer()
  const { ctx } = createMockContext()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async () => listResult('s1', [reviewOf()]),
    getSessions: () => fakeSessions('s1'),
    nextFrame: async () => {},
    openEvidence: () => { attempts += 1; return { ok: false, error: '证据不属于此评审' } },
    revealConversation: () => { order.push('reveal') },
    revealInbox: () => { order.push('back') },
  })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.openResource('evidence', 'r1#0', 'e1')
  assert.equal(result.ok, false)
  assert.equal(attempts, 1, 'an unrelated failure is never retried')
  assert.deepEqual(order, ['reveal', 'back'])
  const open = controller.getSnapshot().open
  assert.equal(open.status, 'failed')
  assert.equal(open.error, '证据不属于此评审')
})

test('a session switch while waiting for the rightbar aborts the open without a stale failure', async () => {
  const renderer = createRenderer()
  const { ctx } = createMockContext()
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  const controllerRef = { current: null }
  let attempts = 0
  inbox.install(ctx, {
    call: async () => listResult('s1', [reviewOf()]),
    getSessions: () => fakeSessions('s1'),
    nextFrame: async () => {},
    beginNavigation: () => ({ aborted: false }),
    openReview: () => {
      attempts += 1
      controllerRef.current.syncSession('s2')
      return { ok: false, error: 'sidebarRight: no session surface is mounted' }
    },
  })
  const controller = inbox.getController()
  controllerRef.current = controller
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const result = await controller.openResource('review', 'r1#0')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stale')
  assert.equal(attempts, 1)
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.sessionId, 's2')
  assert.equal(snapshot.open.status, 'idle')
})

test('filter buttons, the disclaimer, and the refresh label match their page-local semantics', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const reviews = [
    reviewOf({ reviewId: 'r1', annotations: [{ index: 0, intent: 'planned' }] }),
    reviewOf({ reviewId: 'r2', annotations: [{ index: 0, intent: 'pending' }] }),
  ]
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, { call: async () => listResult('s1', reviews), getSessions: () => fakeSessions('s1') })
  const controller = inbox.getController()
  controller.syncSession('s1')
  await controller.ensureLoaded()
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  const tree = renderer.mount(panel.component, { ...panel.registration.inject() })
  const planned = tree.find((element) => element.props['data-ciel-inbox-filter'] === 'planned')
  const pending = tree.find((element) => element.props['data-ciel-inbox-filter'] === 'pending')
  assert.match(tree.textOf(planned), /准备处理 1/)
  assert.match(tree.textOf(pending), /待判断 1/)
  assert.match(tree.text, /处理意向只记录你的处理计划/)
  const refresh = tree.find((element) => element.props['data-ciel-inbox-refresh'] !== undefined)
  assert.equal(tree.textOf(refresh), '刷新（回到首页）')
  tree.click(planned)
  assert.equal(controller.getSnapshot().filter, 'planned')
  assert.equal(INTENT_LABELS.planned, '准备处理')
})

test('switching the current session refetches exactly one page and cleans up the subscription', async () => {
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const sessions = fakeSessions('s1')
  const calls = []
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async (method, request) => { calls.push(request); return listResult(request.sessionId, [reviewOf({ sessionId: request.sessionId, reviewId: 'r-' + request.sessionId, messageId: 'm' })]) },
    getSessions: () => sessions,
  })
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 's1')
  sessions.setCurrent('s2')
  await flush()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].sessionId, 's2')
  sessions.setCurrent('s2')
  await flush()
  assert.equal(calls.length, 2, 'an unchanged session does not refetch')
  renderer.unmount()
})

// ── built-bundle integration: the real client mounts the inbox surface ────

test('the built client factory injects into main + sidebar.panellist and exposes the observation hook', async (t) => {
  const runtime = await createRuntime({})
  t.after(() => runtime.dispose())
  assert.equal(typeof runtime.ctx.slots.injected['main'], 'function')
  assert.equal(typeof runtime.ctx.slots.injected['sidebar.panellist'], 'function')
  assert.equal(runtime.moduleExports.__test.inbox.panelId, INBOX_PANEL_ID)
  assert.equal(runtime.moduleExports.__test.remoteMethodNames.includes('inboxList'), true)
  assert.equal(runtime.moduleExports.__test.remoteMethodNames.includes('inboxSetIntent'), true)
  assert.equal(typeof runtime.runtime.inbox.bindSessions, 'function')
  const controller = runtime.runtime.inbox.getController()
  assert.equal(controller !== undefined, true)
  assert.equal(controller.getSnapshot().sessionId, undefined)
})
