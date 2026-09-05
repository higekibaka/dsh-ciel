// Review-UI client tests: load the ACTUAL client factory through the same
// stub ModuleLoader as blocks.test.js and assert the pure view-model helpers
// that drive coverage/soundness/labels/selection/feedback plus the Remote
// descriptor and settings-definition completeness. No source-code substring
// assertions as the sole proof — these tests exercise the real exported logic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadClientModule() {
  let captured = null
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const windowStub = {
    __ModuleLoader__: { load: (m) => { captured = m } },
  }
  const reactStub = new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'createElement') return () => ({})
      if (prop === 'useState') return (v) => [v, () => {}]
      if (prop === 'useEffect') return () => {}
      if (prop === 'useRef') return () => ({ current: null })
      return () => {}
    },
  })
  const fn = new Function('window', 'document', src)
  fn.call({}, windowStub, {})
  const module = captured.factory((name) => (name === 'react' ? reactStub : {}))
  return module.exports ?? module
}

const client = loadClientModule()
const t = client.__test

const ann = (o) => ({ severity: 'nit', title: '', anchor: '', comment: '', ...o })

// ── Remote descriptor completeness ────────────────────────────────────────
test('advisorReview Remote exposes the cancel descriptor', () => {
  assert.ok(t.remoteMethodNames.includes('cancel'))
  assert.equal(t.remoteMethodNames.length, 6)
})

test('list/start/feedback/triage/progress remain present', () => {
  for (const m of ['list', 'start', 'feedback', 'triage', 'progress']) {
    assert.ok(t.remoteMethodNames.includes(m), `missing ${m}`)
  }
})

// ── Settings definition completeness (enabled + safety params) ────────────
test('Config defaults add enabled + all safety timers', () => {
  assert.equal(t.defaults.enabled, true)
  assert.equal(t.defaults.criticTimeoutSeconds, 180)
  assert.equal(t.defaults.criticMaxRequests, 16)
  assert.equal(t.defaults.criticMaxTokens, 16384)
  assert.equal(t.defaults.advisorTimeoutSeconds, 180)
  // Model defaults are preserved (do not change user routes).
  assert.equal(t.defaults.criticProvider, 'google')
  assert.equal(t.defaults.criticModel, 'gemini-3.8-flash')
})

test('settings field definitions declare enabled + safety params with ranges', () => {
  const enabled = t.fieldDefinition('enabled')
  assert.equal(enabled.kind, 'check')
  assert.match(enabled.label, /启用批评者评审/)

  const timeout = t.fieldDefinition('criticTimeoutSeconds')
  assert.equal(timeout.kind, 'number')
  assert.equal(timeout.min, 10)
  assert.equal(timeout.max, 600)

  const maxReq = t.fieldDefinition('criticMaxRequests')
  assert.equal(maxReq.kind, 'number')
  assert.equal(maxReq.min, 2)
  assert.equal(maxReq.max, 32)

  const maxTok = t.fieldDefinition('criticMaxTokens')
  assert.equal(maxTok.kind, 'number')
  assert.equal(maxTok.min, 256)
  assert.equal(maxTok.max, 32768)

  const advTimeout = t.fieldDefinition('advisorTimeoutSeconds')
  assert.equal(advTimeout.kind, 'number')
  assert.equal(advTimeout.min, 10)
  assert.equal(advTimeout.max, 600)
})

test('settings field keys include every new safety key', () => {
  for (const k of ['enabled', 'criticTimeoutSeconds', 'criticMaxRequests', 'criticMaxTokens', 'advisorTimeoutSeconds']) {
    assert.ok(t.fieldKeys.includes(k), `missing field key ${k}`)
  }
})

test('critic explore keeps its existing lower bound (0 does not disable models)', () => {
  const explore = t.fieldDefinition('criticExploreBudget')
  assert.equal(explore.min, 0)
  assert.equal(explore.max, 10)
})

// ── Coverage derivation & green gating ────────────────────────────────────
test('deriveCoverage honors explicit coverage, then derives legacy partial', () => {
  assert.equal(t.deriveCoverage({ coverage: 'partial' }), 'partial')
  assert.equal(t.deriveCoverage({ coverage: 'not-verified' }), 'not-verified')
  assert.equal(t.deriveCoverage({ coverage: 'complete' }), 'complete')
  // legacy: salvaged → partial
  assert.equal(t.deriveCoverage({ explore: { salvaged: true } }), 'partial')
  // legacy: unchecked > 0 → partial
  assert.equal(t.deriveCoverage({ stats: { unchecked: 2 } }), 'partial')
  // legacy sound entry with no markers stays complete (backward compatible)
  assert.equal(t.deriveCoverage({ status: 'sound' }), 'complete')
  // missing entry → not-verified
  assert.equal(t.deriveCoverage(null), 'not-verified')
})

test('never green for incomplete / unverified / cancelled / partial coverage', () => {
  assert.equal(t.isSoundEntry({ status: 'incomplete', verdict: 'pass', coverage: 'partial' }), false)
  assert.equal(t.isSoundEntry({ status: 'unverified', verdict: 'pass', coverage: 'not-verified' }), false)
  assert.equal(t.isSoundEntry({ status: 'cancelled', verdict: 'pass', coverage: 'complete' }), false)
  assert.equal(t.isSoundEntry({ status: 'completed', verdict: 'changes', coverage: 'complete' }), false)
  assert.equal(t.isSoundEntry({ status: 'sound', coverage: 'partial' }), false)
  assert.equal(t.isSoundEntry({ status: 'sound', coverage: 'not-verified' }), false)
})

test('never green for legacy salvaged or unchecked>0 entries', () => {
  assert.equal(t.isSoundEntry({ status: 'sound', explore: { salvaged: true, toolCalls: 1, budget: 5 } }), false)
  assert.equal(t.isSoundEntry({ status: 'sound', stats: { unchecked: 1 } }), false)
})

test('legacy compatible entries still green (status sound, or statusless verdict pass)', () => {
  assert.equal(t.isSoundEntry({ status: 'sound', coverage: 'complete' }), true)
  assert.equal(t.isSoundEntry({ status: 'sound' }), true)
  assert.equal(t.isSoundEntry({ verdict: 'pass' }), true)
})

// ── Labels ────────────────────────────────────────────────────────────────
test('statusButtonLabel never emits 无阻断/整体成立 for non-sound entries', () => {
  assert.equal(t.statusButtonLabel({ status: 'incomplete', verdict: 'pass', coverage: 'partial', annotations: [ann({})] }), '◇ 部分核实 · 1 条')
  assert.equal(t.statusButtonLabel({ status: 'unverified', coverage: 'not-verified', annotations: [] }), '◇ 未核实 · 0 条')
  assert.equal(t.statusButtonLabel({ status: 'cancelled' }), '已取消 · 重新评审')
  assert.equal(t.statusButtonLabel({ status: 'error', error: 'budget exceeded' }), '预算熔断 · 重试')
  // a 'sound' status that is NOT really sound (partial coverage) is not green
  assert.equal(t.statusButtonLabel({ status: 'sound', coverage: 'partial', annotations: [ann({})] }), '批注 1 · 复审')
  // sound still green
  assert.equal(t.statusButtonLabel({ status: 'sound', coverage: 'complete', annotations: [ann({}), ann({})] }), '✓ 无阻断 (2)')
})

test('fully verified nits are nonblocking, not falsely labelled unverified', () => {
  const entry = { status: 'completed', verdict: 'pass', coverage: 'complete', annotations: [ann({})] }
  assert.equal(t.isSoundEntry(entry), true)
  assert.equal(t.statusButtonLabel(entry), '✓ 无阻断 (1)')
  assert.equal(t.isSoundEntry({ ...entry, annotations: [ann({ severity: 'blocker' })] }), false)
})

test('verdict badge is neutral (not green) for a pass verdict that is not sound', () => {
  assert.equal(t.verdictBadgeText({ status: 'incomplete', verdict: 'pass', coverage: 'partial' }), '◇ 部分核实')
  assert.equal(t.verdictBadgeClass({ status: 'incomplete', verdict: 'pass', coverage: 'partial' }), 'dsr-vbadge-neutral')
  assert.equal(t.verdictBadgeText({ status: 'sound', verdict: 'pass', coverage: 'complete' }), '✓ 整体成立')
  assert.equal(t.verdictBadgeClass({ status: 'sound', verdict: 'pass', coverage: 'complete' }), 'dsr-vbadge-pass')
})

// ── Progress units & phase labels ─────────────────────────────────────────
test('inFlightLabel separates toolCalls/budget from suspects (not toolCalls/suspects)', () => {
  const label = t.inFlightLabel({ phase: 2, toolCalls: 3, budget: 5, suspects: 8, explore: true, action: { kind: 'tool', name: 'read', target: 'x' } })
  assert.ok(label.includes('排查 3/5'), `expected 排查 3/5 in ${label}`)
  assert.ok(!label.includes('3/8'), 'must not render toolCalls/suspects as the fraction')
  assert.ok(label.includes('疑点 8'), `expected separate suspects in ${label}`)
})

test('inFlightLabel phase2 with zero tools says verification, not nomination', () => {
  const label = t.inFlightLabel({ phase: 2, toolCalls: 0, budget: 5, explore: true })
  assert.ok(!label.includes('存疑分析'), `phase 2 must not say nomination: ${label}`)
  assert.ok(label.includes('核验'), `phase 2 should say verification: ${label}`)
})

test('inFlightLabel phase3 says salvaging', () => {
  const label = t.inFlightLabel({ phase: 3, toolCalls: 4, budget: 5, explore: true, suspects: 2 })
  assert.ok(label.includes('抢救'), `expected salvage label: ${label}`)
})

test('inFlightLabel phase1 says nomination and non-explore stays simple', () => {
  assert.ok(t.inFlightLabel({ phase: 1, explore: true }).includes('存疑分析'))
  assert.equal(t.inFlightLabel({ phase: 1, explore: false }), '评审中…')
  assert.equal(t.inFlightLabel(null), '评审中…')
})

// ── Selection restoration (delta + filter-only reload) ───────────────────
test('restoreSelection starts from all-minus-sent then applies accept/dismiss deltas', () => {
  const sent = new Set([2])
  const base = new Set([0, 1, 3])
  const sel = t.restoreSelection(4, sent, { '0': 'dismiss', '3': 'accept' })
  assert.deepEqual([...sel].sort((a, b) => a - b), [1, 3])
  assert.deepEqual([...base].sort((a, b) => a - b), [0, 1, 3])
})

test('a filter-only triage record must not empty the selection', () => {
  const sel = t.restoreSelection(4, new Set([2]), {})
  assert.deepEqual([...sel].sort((a, b) => a - b), [0, 1, 3])
})

test('restoreSelection ignores out-of-range / non-integer deltas', () => {
  const sel = t.restoreSelection(3, new Set(), { '9': 'accept', 'x': 'dismiss', '-1': 'dismiss' })
  assert.deepEqual([...sel].sort((a, b) => a - b), [0, 1, 2])
})

// ── Malformed Remote results retry ────────────────────────────────────────
test('isListResultLoaded rejects error-shaped / malformed results (so hydrate retries)', () => {
  assert.equal(t.isListResultLoaded({ ok: false, error: 'boom' }), false)
  assert.equal(t.isListResultLoaded({ reviews: undefined }), false)
  assert.equal(t.isListResultLoaded({ ok: true }), false)
  assert.equal(t.isListResultLoaded(null), false)
  assert.equal(t.isListResultLoaded(undefined), false)
  // success-shaped envelope loads
  assert.equal(t.isListResultLoaded({ reviews: [], sentKeys: [], triage: {} }), true)
  // a bare (non-enveloped) reviews array also loads (host list returns light shape)
  assert.equal(t.isListResultLoaded({ reviews: [{ messageId: 'm1' }] }), true)
})

// ── Cancel UI behavior (failed visible/retryable; accepted not clear) ─────
test('cancelOutcome: accepted+cancelled does NOT request refresh; failed is retryable', () => {
  // Request accepted and review actually cancelled → polling picks up, no refresh
  assert.deepEqual(t.cancelOutcome({ ok: true, cancelled: true }), { kind: 'accepted', cancelled: true, refresh: false })
  // Nothing was in flight → the review already finished/never started → refresh
  assert.deepEqual(t.cancelOutcome({ ok: true, cancelled: false }), { kind: 'accepted', cancelled: false, refresh: true })
})

test('cancelOutcome: a failed cancel stays a failure (active state must not be cleared)', () => {
  const o = t.cancelOutcome({ ok: false, error: 'remote down' })
  assert.equal(o.kind, 'failed')
  assert.equal(o.error, 'remote down')
  assert.equal(typeof o.cancelled, 'undefined')
})

test('cancelOutcome: malformed cancel result is treated as a retryable failure', () => {
  assert.equal(t.cancelOutcome(null).kind, 'failed')
  assert.equal(t.cancelOutcome(undefined).kind, 'failed')
  assert.equal(t.cancelOutcome({}).kind, 'failed')
})

// ── Feedback items include evidence/block plus existing fields ───────────
test('buildFeedbackItems carries block and evidence with index/severity/title/anchor/comment', () => {
  const items = t.buildFeedbackItems(
    [
      ann({ severity: 'blocker', title: 'T', anchor: 'A', comment: 'C', block: 'b2', evidence: 'E0' }),
      ann({ severity: 'nit', title: 'U', block: 'b3' }),
    ],
    [0, 1],
  )
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], { index: 0, severity: 'blocker', title: 'T', anchor: 'A', comment: 'C', block: 'b2', evidence: 'E0' })
  // evidence absent → omitted (not set to empty string)
  assert.deepEqual(items[1], { index: 1, severity: 'nit', title: 'U', anchor: '', comment: '', block: 'b3' })
})

// ── createdAt fence ───────────────────────────────────────────────────────
test('entryTime orders host entries by createdAt and treats missing/non-finite as oldest', () => {
  assert.equal(t.entryTime({ createdAt: 5 }), 5)
  assert.equal(t.entryTime({}), -Infinity)
  assert.equal(t.entryTime({ createdAt: 'x' }), -Infinity)
  assert.equal(t.entryTime(null), -Infinity)
})

test('shouldReplace: newer wins; equal replaces; older is kept; undefined existing accepts', () => {
  assert.equal(t.shouldReplace(undefined, { createdAt: 1 }), true)
  assert.equal(t.shouldReplace({ createdAt: 10 }, { createdAt: 20 }), true)
  assert.equal(t.shouldReplace({ createdAt: 20 }, { createdAt: 10 }), false)
  assert.equal(t.shouldReplace({ createdAt: 10 }, { createdAt: 10 }), true)
})

test('durable reviewId outranks a transient regardless of wall clock (lost RPC recovery)', () => {
  // host committed at t=100 → durable
  const durable = { messageId: 'm1', reviewId: 'r1', status: 'sound', createdAt: 100 }
  // browser recorded a transient error at t=200 (client wall clock, later)
  const transient = { messageId: 'm1', status: 'error', error: 'RPC lost', createdAt: 200, transient: true }
  // existing=durable, incoming=transient → keep durable (transient cannot overwrite)
  assert.equal(t.shouldReplace(durable, transient), false)
  // existing=transient, incoming=durable (rehydrate returns committed 100) → durable wins
  assert.equal(t.shouldReplace(transient, durable), true)
})

test('transients and durables order by time within their own tier', () => {
  // two durables: newer wins
  assert.equal(t.shouldReplace({ reviewId: 'a', createdAt: 10 }, { reviewId: 'b', createdAt: 20 }), true)
  assert.equal(t.shouldReplace({ reviewId: 'b', createdAt: 20 }, { reviewId: 'a', createdAt: 10 }), false)
  // two transients: newer wins
  assert.equal(t.shouldReplace({ transient: true, createdAt: 10 }, { transient: true, createdAt: 20 }), true)
  assert.equal(t.shouldReplace({ transient: true, createdAt: 20 }, { transient: true, createdAt: 10 }), false)
})

test('entryRank tiers: transient < legacy/unmarked < durable', () => {
  assert.equal(t.entryRank({ transient: true }), 0)
  assert.equal(t.entryRank({ createdAt: 5 }), 1)
  assert.equal(t.entryRank({ reviewId: 'r' }), 2)
})

// ── AB correlation route attrs ───────────────────────────────────────────
test('criticRouteAttrs projects only the leaf criticProvider/model strings', () => {
  assert.deepEqual(t.criticRouteAttrs({ criticProvider: 'google', criticModel: 'gemini-3.8-flash' }), {
    'data-ciel-critic-provider': 'google',
    'data-ciel-critic-model': 'gemini-3.8-flash',
  })
})

test('criticRouteAttrs omits non-string / empty routes (fail closed), never serializes', () => {
  assert.deepEqual(t.criticRouteAttrs({ criticProvider: 'google', criticModel: '' }), { 'data-ciel-critic-provider': 'google' })
  assert.deepEqual(t.criticRouteAttrs({ criticProvider: 5, criticModel: 'm' }), { 'data-ciel-critic-model': 'm' })
  assert.deepEqual(t.criticRouteAttrs({}), {})
  assert.deepEqual(t.criticRouteAttrs(null), {})
  assert.deepEqual(t.criticRouteAttrs(undefined), {})
})
