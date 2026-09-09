import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewHarness, SUSPECT, verdict } from './host-harness.js'
import {
  Config, parseSuspectResponse, parseCriticReview, reviewCoverage, createReviewOperation,
  createConsultationGate, createReviewObserver, readReviews, persistReview, reviewsPath, recoverCitedDossier,
} from '../index.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-runtime-tests-'))
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))

async function scenario(t, scripts, config) {
  const h = await reviewHarness(scripts, config)
  t.after(() => h.dispose())
  return h
}

test('review defaults expose one deadline while accepting deprecated count settings', () => {
  assert.equal(Config({}).criticTimeoutSeconds, 180)
  assert.equal(Config({}).criticExploreBudget, undefined)
  assert.equal(Config({}).criticMaxRequests, undefined)
  assert.equal(Config({ criticExploreBudget: 0, criticMaxRequests: 2 }).criticExploreBudget, 0)
  assert.equal(Config({ criticExploreBudget: 1000, criticMaxRequests: 1000 }).criticMaxRequests, 1000)
})

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
  const h = await scenario(t, [SUSPECT, ({ tool }) => { const ref = tool().evidence_refs[0]; return verdict({ evidence: ref }) }])
  const result = await h.start()
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.modelRequests, 2)
  assert.equal(result.review.explore.toolCalls, 1)
  assert.equal(h.requests[0].prompt[0].text.includes('AUTHOR_EVIDENCE_SENTINEL'), false)
  assert.equal(h.requests[1].prompt[0].text.includes('AUTHOR_EVIDENCE_SENTINEL'), true)
  assert.equal(h.service.children.size, 0)
  assert.equal(h.disposals.length, 2)
})

test('all nominated suspects reach verification regardless of legacy count settings', async (t) => {
  const two = SUSPECT + '\n- suspect: second count | block: b1 | bearing: low | falsify: read'
  const h = await scenario(t, [two, ({ tool }) => {
    const ref = tool().evidence_refs[0]
    return verdict({ evidence: ref }).replace('fixed fixture result', 'BOTH files independently verified')
  }], { criticExploreBudget: 1 })
  const { review } = await h.start()
  assert.deepEqual(review.suspects, { total: 2, triaged: 2, skipped: 0 })
  assert.match(h.requests[1].prompt[0].text, /second count/)
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

for (const legacyLimit of [0, 1, 20, 50]) {
  test('legacy query count ' + legacyLimit + ' does not restrict exploration or stop reads', async (t) => {
    const h = await scenario(t, [SUSPECT, ({ tool }) => {
      let ref
      for (let i = 0; i < 75; i++) ref = tool('read').evidence_refs[0]
      return verdict({ evidence: ref })
    }], { criticExploreBudget: legacyLimit, criticMaxRequests: 2 })
    const result = await h.start()
    assert.equal(result.ok, true)
    assert.equal(result.review.status, 'sound')
    assert.deepEqual(result.review.limits, { mode: 'time', timeoutSeconds: 180 })
    assert.equal(result.review.explore.toolCalls, 75)
    assert.equal(result.review.explore.budget, undefined)
    assert.equal(h.executions.length, 75)
    assert.equal(h.requests.length, 2)
    assert.equal(h.disposals.length, 2)
  })
}

test('settled checkpoints can continue reading without an extra salvage child', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool, visible }) => {
    const ref = tool().evidence_refs[0]
    visible('## dossier' + String.fromCharCode(10) + '- result: s1 | outcome: cleared | evidence: ' + ref)
    for (let i = 0; i < 10; i++) tool()
    return verdict({ evidence: ref })
  }], { criticExploreBudget: 1 })
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.explore.salvaged, undefined)
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.explore.toolCalls, 11)
  assert.equal(h.requests.length, 2)
})

test('conflicting or retracted checkpoints cannot revive an earlier finding', () => {
  const selected = [{ id: 's1' }, { id: 's2' }]
  const initial = '## dossier\n- result: s1 | outcome: cleared | evidence: read file.js:1\n- result: s2 | outcome: defect | evidence: read file.js:2'
  for (const changed of [
    '- result: s1 | outcome: defect | evidence: read file.js:1',
    '- result: s1 | outcome: unchecked | evidence: none',
    '- result: s1 | outcome: cleared | evidence: read other.js:1',
    '- result: s1 | outcome: cleared | evidence: guessing',
    '- result: s1 | outcome: invalid | evidence: read file.js:1',
    '- result: s1 | outcome: cleared | evidence: read file.js:1\n- result: s1 | outcome: cleared | evidence: read file.js:1',
  ]) {
    const rows = recoverCitedDossier([initial, '## dossier\n' + changed, initial], selected)
    assert.deepEqual(rows[0], { id: 's1', outcome: 'unchecked', evidence: '' })
    assert.equal(rows[1].outcome, 'defect')
  }
})

test('recovery accepts identical cross-message checkpoints but not unframed or unselected rows', () => {
  const valid = '## dossier\n- result: s1 | outcome: cleared | evidence: read file.js:1'
  assert.equal(recoverCitedDossier([valid, valid, 'checking next'], [{ id: 's1' }])[0].outcome, 'cleared')
  assert.deepEqual(recoverCitedDossier([valid.replace('## dossier\n', ''), '## dossier\n- result: s9 | outcome: defect | evidence: read file.js:1'], [{ id: 's1' }]), [{ id: 's1', outcome: 'unchecked', evidence: '' }])
})

test('an empty final dossier is not repaired by an extra model request', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool, visible }) => {
    const ref = tool().evidence_refs[0]
    visible('## dossier\n- result: s1 | outcome: cleared | evidence: ' + ref)
    visible('## dossier\n- result: s1 | outcome: unchecked | evidence: none')
    visible('I need another read.')
    tool()
  }], { criticExploreBudget: 1 })
  assert.equal((await h.start()).ok, false)
  assert.equal(h.requests.length, 2)
})

test('a checkpoint followed by an empty answer cannot start a salvage writer', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ tool, visible }) => {
    const ref = tool().evidence_refs[0]
    visible('## dossier\n- result: s1 | outcome: cleared | evidence: ' + ref)
    tool(); return ''
  }, { stopReason: 'error' }], { criticExploreBudget: 1 })
  assert.equal((await h.start()).ok, false)
  assert.equal(h.requests.length, 2)
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

test('legacy request cap is ignored while model requests remain counted', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ request, tool }) => {
    for (let i = 0; i < 100; i++) request()
    return verdict({ evidence: tool().evidence_refs[0] })
  }], { criticMaxRequests: 2 })
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.modelRequests, 102)
  assert.equal(h.requests.length, 2)
})

for (const phase of [1, 2]) {
  test('the shared deadline stops phase ' + phase + ' without another model or tool execution', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    const hold = async ({ signal, tool, request }) => {
      if (phase === 2) {
        for (let i = 0; i < 70; i++) { request(); tool() }
      }
      entered()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      if (phase === 2) assert.match(tool().denied, /timeout/, 'even a late tool attempt cannot run after expiry')
      return verdict()
    }
    const nominate = () => { t.mock.timers.tick(6000); return SUSPECT }
    const h = await scenario(t, phase === 1 ? [hold] : [nominate, hold], { criticTimeoutSeconds: 10, criticExploreBudget: 1, criticMaxRequests: 2 })
    const pending = h.start()
    await ready
    const progress = await h.service.progress({ sessionId: h.sid, messageId: h.messageId })
    assert.equal(progress.limitMode, 'time')
    assert.equal(progress.remainingMs, phase === 2 ? 4000 : 10000, 'phase changes never reset the total deadline')
    assert.equal(progress.budget, undefined)
    assert.equal(progress.elapsedMs, phase === 2 ? 6000 : 0, 'elapsed time includes prior phases')
    t.mock.timers.tick(phase === 2 ? 4000 : 10000)
    const result = await pending
    assert.equal(result.ok, false)
    assert.match(result.error, /review timeout/)
    assert.deepEqual(result.review.limits, { mode: 'time', timeoutSeconds: 10 })
    assert.equal(result.review.diagnostics.limitMode, 'time')
    assert.equal(result.review.diagnostics.toolCalls, phase === 2 ? 70 : 0)
    assert.equal(h.requests.length, phase)
    assert.equal(h.disposals.length, phase)
    assert.equal(h.service.children.size, 0)
    assert.equal(h.service.activeOperations.size, 0)
    assert.equal((await h.service.progress({ sessionId: h.sid, messageId: h.messageId })).inFlight, false)
  })
}

test('file checking stays disabled only through its explicit switch', async (t) => {
  const h = await scenario(t, ['## verdict: pass' + String.fromCharCode(10) + 'summary: draft only'], { criticExploreEnabled: false, criticExploreBudget: 100 })
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.coverage, 'not-verified')
  assert.equal(result.review.explore, undefined)
  assert.deepEqual(h.requests[0].toolFilter.allow, [])
  assert.equal(h.executions.length, 0)
})

test('source preparation spends the same deadline before any model starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const h = await scenario(t, [])
  let started
  const ready = new Promise(resolve => { started = resolve })
  h.service.createCorpus = async ({ signal }) => {
    started()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('fixture capture stopped')
  }
  const pending = h.start()
  await ready
  t.mock.timers.tick(180000)
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /review timeout/)
  assert.equal(h.requests.length, 0)
  assert.equal(h.service.inFlight.size, 0)
  assert.equal(h.service.activeOperations.size, 0)
})

test('disabled model calls and unavailable guards fail before spawning', async (t) => {
  const h = await scenario(t, [], { enabled: false })
  assert.match((await h.start()).error, /disabled/)
  h.configure({ enabled: true })
  h.service.guardAvailable = false
  assert.match((await h.start()).error, /tools.guard/)
  assert.equal(h.requests.length, 0)
})

test('the default operation only limits elapsed time and disposes its timer', async () => {
  let now = 0, callback, cleared = 0
  const operation = createReviewOperation({ timeoutMs: 10, now: () => now, timers: {
    setTimeout: (fn) => { callback = fn; return 1 }, clearTimeout: () => { cleared += 1 },
  } })
  for (let i = 0; i < 1000; i++) operation.beforeRequest()
  assert.equal(operation.requests(), 1000)
  assert.equal(operation.remainingMs(), 10)
  now = 10
  assert.throws(() => operation.beforeRequest(), /timeout/)
  assert.equal(operation.signal.aborted, true)
  callback()
  operation.dispose()
  await operation.done
  assert.equal(cleared, 1)
})

test('terminal observer counts a burst but never aborts it', () => {
  let breaches = 0
  const watchdog = createReviewObserver({ agents: { get: () => ({ session: { snapshotEvents: () => [{ type: 'tool/call' }, { type: 'tool/call' }] } }) }, runId: 'child', budget: 1, onBreach: () => { breaches += 1 } })
  assert.equal(watchdog.stop(), 2)
  assert.equal(breaches, 0)
  assert.equal(typeof watchdog.breached, 'undefined')
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
  // The v1 store has no per-session .jsonl file: a regular file where the
  // session DIRECTORY belongs makes every read fail closed instead of listing.
  const reviewPath = reviewsPath(h.sid)
  await mkdir(join(home, 'ciel', 'v1', 'reviews'), { recursive: true })
  await writeFile(reviewPath, 'not a directory')
  await assert.rejects(() => h.service.list({ sessionId: h.sid }))
  await rm(reviewPath, { force: true })
  const feedbackPath = join(home, 'ciel', 'v1', 'feedback', h.sid)
  await mkdir(join(home, 'ciel', 'v1', 'feedback'), { recursive: true })
  await writeFile(feedbackPath, 'not a directory')
  await assert.rejects(() => h.service.sentSet(h.sid))
  await assert.rejects(() => h.service.triageSet(h.sid))
  assert.equal(h.service.sentBySession.has(h.sid), false)
  assert.equal(h.service.triageBySession.has(h.sid), false)
  await rm(feedbackPath, { force: true })
  assert.deepEqual((await h.service.list({ sessionId: h.sid })).reviews, [])
})

test('feedback draft uses persisted evidence without dispatch or sent ledger changes', async (t) => {
  const h = await scenario(t, [])
  await persistReview(h.sid, { reviewId: 'saved', messageId: h.messageId, annotations: [{ severity: 'blocker', title: 'Count', block: 'b1', anchor: '42', comment: 'incorrect', evidence: 'read fixture.js:1 says 41' }] })
  const request = { sessionId: h.sid, messageId: h.messageId, reviewId: 'saved', items: [{ index: 0, evidence: 'tampered' }, { index: 0 }] }
  const result = await h.service.prepareFeedback(request)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.sessionId, h.sid)
  assert.equal(result.messageId, h.messageId)
  assert.match(result.text, /evidence: read fixture.js:1 says 41/)
  assert.match(result.text, /block: b1/)
  assert.ok(result.text.includes(h.messageId))
  assert.doesNotMatch(result.text, /tampered|用户逐条确认/)
  assert.deepEqual(await h.service.prepareFeedback(request), result, 'draft may be recovered after the user clears it')
  assert.equal(h.delivered.length, 0)
  assert.deepEqual((await h.service.list({ sessionId: h.sid })).sentKeys, [])
  assert.equal((await h.service.prepareFeedback({ ...request, messageId: 'wrong' })).ok, false)
  assert.equal((await h.service.prepareFeedback({ ...request, items: [{ index: 99 }] })).ok, false)
  h.configure({ enabled: false })
  assert.equal((await h.service.prepareFeedback(request)).ok, false)
})

test('legacy feedback endpoint refuses automatic sending, including stale clients', async (t) => {
  const h = await scenario(t, [])
  assert.equal((await h.service.feedback({ sessionId: h.sid })).ok, false)
  assert.equal(h.delivered.length, 0)
  assert.deepEqual((await h.service.list({ sessionId: h.sid })).sentKeys, [])
})

// ── PTC transport seam (runner/runtime land separately; settled policy here) ──

test('PTC transport is allowed with tools, never counted, and nested reads are the queries', async (t) => {
  const h = await scenario(t, [SUSPECT, ({ runCode }) => {
    const [read] = runCode([{ name: 'read', args: { file_path: '/project/fixture.js' } }])
    return verdict({ evidence: read.evidence_refs[0] })
  }])
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.status, 'sound')
  assert.equal(result.review.explore.toolCalls, 1, 'the outer run_code transport is not a query')
  assert.equal(h.executions.length, 1)
  const events = h.childEvents.at(-1)
  assert.equal(events.filter((e) => e.type === 'tool/ptc-dispatch-start').length, 1)
  assert.equal(events.filter((e) => e.type === 'tool/ptc-dispatch').length, 1)
  assert.equal(events.filter((e) => e.type === 'tool/call' && e.data.name === 'run_code').length, 1)
  assert.equal(events.filter((e) => e.type === 'tool/call' && e.data.name === 'read').length, 0, 'nested dispatch logs a ptc event, not a native call')
})

test('a no-tool phase refuses the run_code transport without executing a reader', async (t) => {
  let denied
  const h = await scenario(t, [({ runCode }) => {
    denied = runCode([{ name: 'read', args: { file_path: '/project/fixture.js' } }])
    return SUSPECT
  }])
  const result = await h.start()
  assert.match(denied.denied, /cannot execute that tool/)
  assert.equal(result.ok, false)
  assert.match(result.error, /unexpected tool in review: run_code/)
  assert.equal(h.executions.length, 0)
  assert.equal(h.childEvents.at(-1).filter((e) => e.type === 'tool/ptc-dispatch-start').length, 0)
})

test('the per-control guard fails closed for foreign or unbound agents and delegates only the exact child', async (t) => {
  let observed
  const h = await scenario(t, [SUSPECT, ({ child, control, runCode }) => {
    runCode([{ name: 'read', args: { file_path: '/project/fixture.js' } }])
    observed = {
      child,
      isFunction: typeof control.guard === 'function',
      exact: control.guard({ agent: child, name: 'read', arguments: { file_path: '/project/fixture.js' } }),
      sameIdOnly: control.guard({ agent: { id: control.childId }, name: 'read', arguments: {} }),
      foreign: control.guard({ agent: { id: 'foreign-agent' }, name: 'read', arguments: {} }),
      foreignTransport: control.guard({ agent: { id: 'foreign-agent' }, name: 'run_code', arguments: {} }),
      usedAfterExact: control.used,
    }
    return verdict()
  }])
  await h.start()
  assert.equal(observed.isFunction, true)
  assert.equal(observed.exact, undefined)
  assert.match(observed.sameIdOnly, /cannot execute that tool/, 'a same-id impostor is not the bound child')
  assert.match(observed.foreign, /cannot execute that tool/)
  assert.match(observed.foreignTransport, /cannot execute that tool/, 'foreign outer transport is rejected too')
  assert.equal(observed.usedAfterExact, 2, 'nested read + exact private call counted; refused calls did not')
  const stale = h.lastControl()
  assert.equal(stale.bound, false, 'unbindControl releases the gate')
  assert.equal(stale.child, undefined, 'the bound child reference is cleared, not retained')
  assert.match(stale.guard({ agent: observed.child, name: 'read', arguments: {} }), /cannot execute that tool/)
})

test('the shared deadline denies nested PTC source calls after expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  const hold = async ({ signal, runCode }) => {
    for (let i = 0; i < 3; i++) runCode([{ name: 'read', args: { file_path: '/project/fixture.js' } }])
    entered()
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    const late = runCode([{ name: 'read', args: { file_path: '/project/fixture.js' } }])
    assert.match(late.denied, /timeout/)
    return verdict()
  }
  const nominate = () => { t.mock.timers.tick(6000); return SUSPECT }
  const h = await scenario(t, [nominate, hold], { criticTimeoutSeconds: 10 })
  const pending = h.start()
  await ready
  t.mock.timers.tick(4000)
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /review timeout/)
  assert.equal(result.review.diagnostics.toolCalls, 3)
  assert.equal(h.service.children.size, 0)
  assert.equal(h.service.activeOperations.size, 0)
})
