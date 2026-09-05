import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewHarness, SUSPECT, verdict } from './host-harness.js'
import {
  parseSuspectResponse, parseCriticReview, reviewCoverage, createReviewOperation,
  createConsultationGate, createBudgetWatchdog, readReviews, persistReview, reviewsPath,
} from '../index.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-runtime-tests-'))
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))

async function scenario(t, scripts, config) {
  const h = await reviewHarness(scripts, config)
  t.after(() => h.dispose())
  return h
}

for (const text of ['I cannot review this.', '', '## suspects\n1. suspect: bad count', '## suspects\n- suspect: ']) {
  test('malformed nomination fails without a second call: ' + JSON.stringify(text), async (t) => {
    const h = await scenario(t, [text])
    const result = await h.start()
    assert.equal(result.ok, false)
    assert.equal(result.review.status, 'error')
    assert.match(result.error, /format error/)
    assert.equal(h.requests.length, 1)
    assert.equal(h.disposals.length, 1)
    assert.equal(h.service.inFlight.size, 0)
  })
}

test('only a well-formed empty list short-circuits, without a verified green result', async (t) => {
  const h = await scenario(t, ['## suspects'])
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.status, 'unverified')
  assert.equal(result.review.coverage, 'not-verified')
  assert.equal(result.review.sound, false)
  assert.equal(h.requests.length, 1)
  assert.equal((await readReviews(h.sid))[0].status, 'unverified')
})

test('strict parsing never turns a malformed verdict dossier into annotations', () => {
  const text = '## dossier\n### [blocker] excluded suspicion\nevidence: file.js:1\ncomment: excluded\n## verdict: PASS'
  const parsed = parseCriticReview(text, 'draft', [], { explore: true })
  assert.equal(parsed.valid, false)
  assert.deepEqual(parsed.annotations, [])
  const duplicate = parseCriticReview('## verdict: pass\n## verdict: changes', '', [], { strict: true })
  assert.equal(duplicate.valid, false)
})

test('evidence downgrade recomputes severity verdict', () => {
  const parsed = parseCriticReview('## verdict: changes\n### [blocker] guess\ncomment: not verified', 'draft', [], { explore: true })
  assert.equal(parsed.annotations[0].severity, 'nit')
  assert.equal(parsed.verdict, 'pass')
  assert.equal(parsed.verdictAdjusted, true)
})

test('confirmed-defect statistics cannot claim a clean result with no annotations', () => {
  const parsed = parseCriticReview('## verdict: pass\nstats: 排查 1 · 证伪 1 · 排除 0 · 未查 0', '', [], { explore: true })
  const coverage = reviewCoverage(parsed, { explore: true, suspects: { total: 1, triaged: 1, skipped: 0 } })
  assert.equal(coverage.coverage, 'partial')
  assert.equal(coverage.stats.unchecked, 1)
})

test('phase one excludes author evidence; phase two gets it and all handles drain', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool }) => { tool(); return verdict() }])
  const result = await h.start()
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.modelRequests, 2)
  assert.equal(result.review.explore.toolCalls, 1)
  assert.equal(h.requests[0].prompt[0].text.includes('AUTHOR_EVIDENCE_SENTINEL'), false)
  assert.equal(h.requests[1].prompt[0].text.includes('AUTHOR_EVIDENCE_SENTINEL'), true)
  assert.equal(h.service.children.size, 0)
  assert.equal(h.disposals.length, 2)
})

test('pre-triaged suspects enter total and unchecked once; partial is not sound', async (t) => {
  const two = SUSPECT + '\n- suspect: second count | block: b1 | bearing: low | falsify: read'
  const h = await scenario(t, [two, verdict().replace('fixed fixture result', 'BOTH files independently verified')], { criticExploreBudget: 1 })
  const { review } = await h.start()
  assert.equal(review.stats.checked, 2)
  assert.equal(review.stats.unchecked, 1)
  assert.equal(review.summary.includes('BOTH'), false)
  assert.match(review.summary, /1 项未查/)
  assert.equal(review.status, 'incomplete')
  assert.equal(review.sound, false)
})

test('missing or inconsistent statistics produce incomplete coverage', () => {
  for (const stats of [undefined, { checked: 1, confirmed: 8, excluded: 0 }, { checked: 0, confirmed: 0, excluded: 0 }]) {
    const result = reviewCoverage({ stats }, { explore: true, suspects: { total: 2, triaged: 2, skipped: 0 } })
    assert.equal(result.coverage, 'partial')
    assert.equal(result.stats.unchecked, 2)
  }
})

for (const stopReason of ['error', 'refusal', 'max-tokens', 'aborted']) {
  test('non-budget failure does not trigger a salvage model: ' + stopReason, async (t) => {
    const h = await scenario(t, [SUSPECT, { stopReason, error: 'synthetic provider failure' }])
    const result = await h.start()
    assert.equal(result.ok, false)
    assert.equal(h.requests.length, 2)
    assert.equal(h.disposals.length, 2)
    assert.equal(h.service.inFlight.size, 0)
  })
}

test('tool execution is denied before over-budget bodies run; empty salvage is skipped', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool }) => {
    tool('read'); tool('read'); return verdict()
  }], { criticExploreBudget: 1 })
  const result = await h.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /budget exceeded.*salvage skipped/)
  assert.equal(h.executions.length, 1)
  assert.equal(h.requests.length, 2)
})

test('budget with cited partial dossier permits only one independent salvage', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool, visible }) => {
    tool()
    visible('## dossier\n- result: s1 | outcome: cleared | evidence: read fixture.js:1 confirms 42 lines')
    tool()
    return ''
  }, async () => {
    const progress = await h.service.progress({ sessionId: h.sid, messageId: h.messageId })
    assert.equal(progress.phase, 3)
    assert.equal(progress.toolCalls, 1)
    // The new writer may misread its own lack of tools; the frozen findings
    // still retain the original investigator's settled outcome.
    return verdict({ excluded: 0 })
  }], { criticExploreBudget: 1 })
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.stats.excluded, 1)
  assert.equal(h.requests[2].prompt[0].text.includes('AUTHOR_EVIDENCE_SENTINEL'), false)
  assert.equal(result.review.explore.salvaged, true)
  assert.equal(result.review.status, 'incomplete')
  assert.equal(result.review.sound, false)
  assert.equal(h.requests.length, 3)
  assert.notEqual(h.requests[1].signal, h.requests[2].signal)
  assert.equal(h.requests[2].signal.aborted, false)
})

test('salvage failure terminates without another retry', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool, visible }) => {
    tool(); visible('## dossier\n- result: s1 | outcome: cleared | evidence: read fixture.js:1')
    tool(); return ''
  }, { stopReason: 'error' }], { criticExploreBudget: 1 })
  assert.equal((await h.start()).ok, false)
  assert.equal(h.requests.length, 3)
})

test('cancel reaches the active phase, persists cancellation, and forbids salvage', async (t) => {
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  const h = await scenario(t, [SUSPECT, async ({ signal }) => {
    entered()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return ''
  }])
  const pending = h.start()
  await ready
  assert.equal((await h.service.cancel({ sessionId: 'another', messageId: h.messageId })).cancelled, false)
  assert.equal((await h.cancel()).cancelled, true)
  const result = await pending
  assert.equal(result.review.status, 'cancelled')
  assert.equal(h.requests.length, 2)
  assert.equal(h.service.inFlight.size, 0)
  assert.equal((await h.service.progress({ sessionId: h.sid, messageId: h.messageId })).inFlight, false)
})

test('plugin disposal cancels and drains a pending review', async (t) => {
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  const h = await scenario(t, [async ({ signal }) => {
    entered()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return ''
  }])
  const pending = h.start()
  await ready
  await h.stop()
  assert.equal((await pending).review.status, 'cancelled')
  assert.equal(h.disposals.length, 1)
  assert.equal(h.ctx.get('advisorReview'), undefined)
})

test('request limit stops before another request and never pays for salvage', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ request }) => { request(); return verdict() }], { criticMaxRequests: 2 })
  const result = await h.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /model request limit/)
  assert.equal(h.requests.length, 2)
  assert.equal(result.review.modelRequests, 2)
})

test('disabled model calls and unavailable guards fail before spawning', async (t) => {
  const h = await scenario(t, [], { enabled: false })
  assert.match((await h.start()).error, /disabled/)
  h.configure({ enabled: true })
  h.service.guardAvailable = false
  assert.match((await h.start()).error, /tools.guard/)
  assert.equal(h.requests.length, 0)
})

test('deadline and request limiter share one abortable lifetime and dispose timers', async () => {
  let now = 0, callback, cleared = 0
  const operation = createReviewOperation({ timeoutMs: 10, maxRequests: 2, now: () => now, timers: {
    setTimeout: (fn) => { callback = fn; return 1 }, clearTimeout: () => { cleared += 1 },
  } })
  operation.beforeRequest()
  now = 10
  assert.throws(() => operation.beforeRequest(), /timeout/)
  assert.equal(operation.signal.aborted, true)
  callback()
  operation.dispose()
  await operation.done
  assert.equal(cleared, 1)
})

test('terminal watchdog sample detects a burst even before the first tick', () => {
  let breaches = 0
  const watchdog = createBudgetWatchdog({ agents: { get: () => ({ session: { snapshotEvents: () => [{ type: 'tool/call' }, { type: 'tool/call' }] } }) }, runId: 'child', budget: 1, onBreach: () => { breaches += 1 } })
  assert.equal(watchdog.stop(), 2)
  assert.equal(breaches, 1)
  assert.equal(watchdog.breached(), true)
})

test('advisor reservations reject parallel calls and count unsettled completions', () => {
  const gate = createConsultationGate(), parent = {}
  const facts = { turnKey: 1, settledThisTurn: 0 }
  const release = gate.reserve(parent, facts, 3)
  assert.throws(() => gate.reserve(parent, facts, 3), /in flight/)
  release()
  gate.reserve(parent, facts, 3)()
  gate.reserve(parent, facts, 3)()
  assert.throws(() => gate.reserve(parent, facts, 3), /exhausted/)
  gate.reserve(parent, { ...facts, turnKey: 2 }, 3)()
  assert.throws(() => gate.reserve(parent, undefined, 3), /telemetry/)
})

test('storage read errors are not empty success and rejected ledgers can retry', async (t) => {
  const h = await scenario(t, [])
  const reviewPath = reviewsPath(h.sid)
  await mkdir(reviewPath, { recursive: true })
  await assert.rejects(() => h.service.list({ sessionId: h.sid }))
  await rm(reviewPath, { recursive: true })
  const feedbackPath = join(home, 'dsh-advisor', 'feedback', h.sid + '.jsonl')
  await mkdir(feedbackPath, { recursive: true })
  await assert.rejects(() => h.service.sentSet(h.sid))
  await assert.rejects(() => h.service.triageSet(h.sid))
  assert.equal(h.service.sentBySession.has(h.sid), false)
  assert.equal(h.service.triageBySession.has(h.sid), false)
  await rm(feedbackPath, { recursive: true })
  assert.deepEqual((await h.service.list({ sessionId: h.sid })).reviews, [])
})

test('feedback uses persisted evidence and original message, deduplicating selection', async (t) => {
  const h = await scenario(t, [])
  await persistReview(h.sid, { reviewId: 'saved', messageId: h.messageId, annotations: [{ severity: 'blocker', title: 'Count', block: 'b1', anchor: '42', comment: 'incorrect', evidence: 'read fixture.js:1 says 41' }] })
  const request = { sessionId: h.sid, messageId: h.messageId, reviewId: 'saved', items: [{ index: 0, evidence: 'tampered' }, { index: 0 }] }
  const result = await h.service.feedback(request)
  assert.equal(result.delivered, 1)
  const text = h.delivered[0].content[0].text
  assert.ok(text.includes('evidence: read fixture.js:1 says 41'))
  assert.ok(text.includes('block: b1'))
  assert.ok(text.includes(h.messageId))
  assert.equal(text.includes('tampered'), false)
  assert.equal((await h.service.feedback(request)).delivered, 0)
  assert.equal(h.delivered.length, 1)
})
