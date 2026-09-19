// Removal-contract suite for the withdrawn experimental appearance feature.
//
// The user explicitly deleted Ciel's experimental appearance (the
// `uiAppearance` settings field and the `data-ciel-appearance` rendering
// contract) while keeping the performance work and the STANDARD visuals. This
// file proves the withdrawal is complete on every surface, and that the
// retained performance contract is still present.
//
// It must pass under plain `node --test plugin/test/*.test.js` with no
// environment parameters. Legal CSS such as `appearance:none` and
// `transparent` colours is explicitly NOT a feature marker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime, mockTimers, flush, makeHookRunner } from './review-ui.harness.js'
import { loadClientFactory } from './performance-review-ui.harness.js'

// ── surfaces ────────────────────────────────────────────────────────────────
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(pluginRoot, 'src')
const clientPath = join(pluginRoot, 'client.js')
const indexPath = join(pluginRoot, 'index.js')
const clientSource = readFileSync(clientPath, 'utf8')

/** The exact host-schema defaults, with NO appearance key (asserted below). */
const DEFAULTS = {
  provider: 'kimi-coding', model: 'kimi-for-coding', maxTokens: 4096, maxCallsPerTurn: 3,
  requireExploration: true, enforceFollowupGap: true, planReminderEnabled: true,
  reasoningEffort: 'provider', guidanceEnabled: true, criticProvider: 'google',
  criticModel: 'gemini-3.8-flash', criticEffort: 'medium', criticExploreEnabled: true,
  enabled: true, criticTimeoutSeconds: 180,
  criticMaxTokens: 16384, advisorTimeoutSeconds: 180,
  criticAdditionalRoots: [],
}

// ── 1. host configuration schema ────────────────────────────────────────────
test('host Config declares no uiAppearance field', async () => {
  const host = await import(new URL('../index.js', import.meta.url).href)
  assert.ok(host.Config && (typeof host.Config === 'object' || typeof host.Config === 'function'), 'plugin/index.js must export the Config schema')
  assert.ok(host.Config.dict && typeof host.Config.dict === 'object', 'the Config schema must expose its field dictionary')
  assert.equal(typeof host.Config({}).enabled, 'boolean', 'the schema must remain callable to resolve defaults')
  assert.equal('uiAppearance' in host.Config.dict, false, 'the host schema must not declare uiAppearance')
  for (const key of Object.keys(host.Config.dict)) {
    assert.doesNotMatch(key, /appearance/i, 'no host schema key may look like the removed feature: ' + key)
  }
  // A known retained field proves the schema itself is intact and non-vacuous.
  assert.ok('enabled' in host.Config.dict, 'the schema must still declare the retained enabled field')
  assert.ok('criticAdditionalRoots' in host.Config.dict, 'the schema must still declare criticAdditionalRoots')
  const resolved = host.Config({})
  assert.equal(typeof resolved.enabled, 'boolean')
  assert.equal(resolved.uiAppearance, undefined, 'a resolved config must not invent an appearance value')
})

// ── 2. client settings surface (defaults / field table / groups / render) ───
function settingsCard(overrides = {}) {
  let state = []
  let cursor = 0
  const writes = []
  const registrations = []
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const React = {
    Fragment: 'fragment', createElement: h,
    cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...props } }),
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useEffect() {},
  }
  const plugin = loadClientFactory().factory(React)
  const value = { ...DEFAULTS, ...overrides }
  const user = { ...overrides }
  plugin.apply({
    settingsScope: { bind: () => ({
      getSnapshot: () => ({ status: 'ready', writable: true, value, user, revision: 0 }),
      subscribe: () => () => {},
      async mutate() {},
    }) },
    on: () => () => {}, get: () => undefined,
    slots: {
      inject(name, register) { if (name === 'settings.section' || name === 'settings.plugin.item') register() },
      register(def) { registrations.push(def); return () => {} },
    },
    effect(fn) { const cleanup = fn(); return cleanup },
  })
  return { api: plugin.__test, writes, registrations, render() { cursor = 0; return plugin.__test.CielSettingsSection() } }
}
function nodes(tree) {
  if (tree == null || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props))
  return [tree, ...nodes(tree.props.children)]
}
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (typeof tree.type === 'function') return text(tree.type(tree.props))
  return text(tree.props.children)
}

test('client defaults, field table and groups contain no uiAppearance', () => {
  const rt = settingsCard()
  const api = rt.api
  assert.equal(Object.prototype.hasOwnProperty.call(api.defaults, 'uiAppearance'), false)
  assert.deepEqual(api.defaults, DEFAULTS, 'the staged defaults must be exactly the retained fields')
  assert.equal(api.fieldKeys.includes('uiAppearance'), false, 'the field table must not contain uiAppearance')
  assert.equal(api.fieldDefinition('uiAppearance'), undefined, 'fieldDefinition must not describe uiAppearance')
  for (const key of api.fieldKeys) assert.doesNotMatch(key, /appearance/i, 'no settings field may look like the removed feature: ' + key)
  assert.equal(api.fieldDefinition('enabled').kind, 'check', 'a known retained field must still be described')
  if (typeof api.hasGroup === 'function') {
    assert.equal(api.hasGroup('appearance'), false, 'the appearance group must not be registered')
  }
  // The exported helper surface must not carry the removed feature either.
  for (const key of Object.keys(api)) assert.doesNotMatch(key, /appearance/i, 'no __test helper may look like the removed feature: ' + key)
  const runtime = api.runtime || {}
  for (const key of Object.keys(runtime)) assert.doesNotMatch(key, /appearance/i, 'no runtime surface may look like the removed feature: ' + key)
})

test('the rendered Ciel settings section has no appearance control', () => {
  const rt = settingsCard()
  const tree = rt.render()
  const controls = nodes(tree)
  assert.ok(controls.length > 5, 'the settings tree must render real controls (non-vacuous)')
  const appearanceSettings = controls.filter((node) => node.props !== undefined && node.props !== null && node.props['data-ciel-setting'] === 'uiAppearance')
  assert.deepEqual(appearanceSettings, [], 'no control may be bound to the removed uiAppearance setting')
  const selectWithOption = controls.filter((node) => node.type === 'select')
  for (const select of selectWithOption) {
    const body = text(select)
    assert.doesNotMatch(body, /透明|玻璃/, 'no select may offer the removed transparent/glass choices: ' + body)
  }
  assert.doesNotMatch(text(tree), /外观（实验性）/, 'the removed 外观（实验性） group must not be rendered')
  for (const node of controls) {
    if (node.props === undefined || node.props === null) continue
    for (const value of Object.values(node.props)) {
      if (typeof value === 'string') assert.doesNotMatch(value, /uiAppearance|data-ciel-appearance/, 'no rendered prop may carry a removed-feature token')
    }
  }
  // A known retained control proves the section really rendered.
  assert.match(text(tree), /启用 Ciel/, 'the retained enabled control must still render')
})

// ── 3. sources and the rebuilt bundle carry no feature markers ──────────────
/** Feature tokens ONLY: legal CSS words are deliberately not matched. */
const FORBIDDEN = /\buiAppearance\b|data-ciel-appearance/g
const forbiddenTokens = (source) => [...String(source).matchAll(FORBIDDEN)].map((match) => match[0])

test('the token matcher bans only the feature, never legal CSS', () => {
  assert.deepEqual(forbiddenTokens('a{appearance:none;background:transparent;color:color-mix(in srgb,red 50%,transparent)}'), [],
    'appearance:none and transparent are legal CSS and must not be treated as feature markers')
  assert.deepEqual(forbiddenTokens('const x = { appearance: "none" }'), [], 'the CSS property name alone is not a feature marker')
  assert.notDeepEqual(forbiddenTokens('DEFAULTS.uiAppearance = "standard"'), [], 'uiAppearance must be detected')
  assert.notDeepEqual(forbiddenTokens("'data-ciel-appearance': value"), [], 'data-ciel-appearance must be detected')
})

test('no source file or rebuilt bundle contains a feature marker', () => {
  const files = ['index.js', 'client.js']
  for (const name of readdirSync(srcRoot)) {
    if (name.endsWith('.js') || name.endsWith('.css')) files.push(join('src', name))
  }
  const offenders = []
  for (const relative of files) {
    const text = readFileSync(join(pluginRoot, relative), 'utf8')
    const found = forbiddenTokens(text)
    if (found.length > 0) offenders.push({ file: relative, tokens: [...new Set(found)] })
  }
  assert.deepEqual(offenders, [], 'the withdrawn feature must leave no token in sources or the built bundle')
  // The rebuilt bundle must still contain legal CSS occurrences, so this scan is
  // not vacuous and the removal did not strip unrelated styling.
  assert.ok(clientSource.includes('transparent'), 'legal transparent CSS must survive the removal')
  assert.ok(clientSource.includes('appearance'), 'legal appearance CSS must survive the removal')
})

test('no rendered root emits data-ciel-appearance', async () => {
  const rt = await createRuntime({})
  // The full bundle registers its roots through apply(); walk the runtime
  // surface for a retained appearance store or a leaked attribute anchor.
  const runtime = rt.moduleExports.__test.runtime || {}
  assert.equal(runtime.appearance, undefined, 'the runtime must not expose an appearance source')
  const source = readFileSync(clientPath, 'utf8')
  assert.equal(source.includes('data-ciel-appearance'), false)
  assert.equal(source.includes('uiAppearance'), false)
  rt.dispose()
})

// ── 4. retained performance contract ────────────────────────────────────────
const inboxModule = await import(new URL('../src/inbox.js', import.meta.url).href)
const { cachedPageCounts, cachedFilteredReviews, createInboxController, memoReviewCard, normalizeReview, INBOX_PANEL_ID } = inboxModule

const SESSION = 's1'
function rawReview(index, annotationCount, overrides = {}) {
  return {
    sessionId: SESSION, reviewId: 'r' + index, messageId: 'm' + index, reviewFingerprint: 'fp' + index,
    revision: 5, status: 'sound', verdict: 'pass', coverage: 'complete', createdAt: 1000 + index,
    annotations: Array.from({ length: annotationCount }, (_, k) => ({
      index: k, severity: k === 0 ? 'blocker' : 'nit', title: 't' + k, anchor: 'anchor-' + index + '-' + k,
      comment: 'c' + k, evidenceIds: [], intent: 'pending',
    })),
    ...overrides,
  }
}
function makeController(reviews) {
  const page = reviews
  return createInboxController({
    call: async (method, request) => {
      if (method === 'inboxList') return { ok: true, sessionId: request.sessionId, reviews: page, nextCursor: null, limited: false }
      if (method === 'inboxSetIntent') {
        return { ok: true, sessionId: request.sessionId, reviewId: request.reviewId, reviewFingerprint: request.reviewFingerprint, revision: request.expectedRevision + 1, intents: { [request.index]: request.intent } }
      }
      return { ok: false, code: 'unknown', error: 'unexpected method ' + method }
    },
    getSessions: () => ({ list: { getSnapshot: () => ({ current: SESSION }) } }),
    now: () => 1,
  })
}
const inputs = (review, write, locate = undefined, filter = 'all') => ({ review, write, locate, filter })

test('exact page counts are still computed from the real annotation shape', () => {
  const reviews = Array.from({ length: 25 }, (_, index) => normalizeReview(rawReview(index, 64), index))
  const counts = cachedPageCounts(reviews)
  assert.equal(counts.reviews, 25)
  assert.equal(counts.annotations, 1600)
  assert.equal(counts.planned + counts.rejected + counts.pending, counts.annotations)
  assert.equal(cachedPageCounts(reviews), counts, 'the derived cache must still be reused for the same page')
  assert.equal(cachedFilteredReviews(reviews, 'all'), reviews, 'the all filter must still reuse the page')
})

test('the card memo still keys on controller + page token', async () => {
  const controller = makeController([rawReview(0, 2), rawReview(1, 1)])
  await controller.openPage()
  const token = controller.getPageToken()
  const [reviewA, reviewB] = controller.getSnapshot().reviews
  const elementA = memoReviewCard(controller, token, reviewA, inputs(reviewA, undefined), () => ({ id: 'A' }))
  const elementB = memoReviewCard(controller, token, reviewB, inputs(reviewB, undefined), () => ({ id: 'B' }))
  assert.equal(memoReviewCard(controller, token, reviewA, inputs(reviewA, undefined), () => ({ id: 'A2' })), elementA, 'unchanged inputs reuse the element')
  const result = await controller.setIntent(reviewA.key, 1, 'planned')
  assert.equal(result.ok, true)
  assert.equal(controller.getPageToken(), token, 'a successful write keeps the page token')
  const after = controller.getSnapshot()
  assert.equal(after.reviews[1], reviewB, 'an unrelated review keeps identity')
  assert.equal(memoReviewCard(controller, controller.getPageToken(), after.reviews[1], inputs(after.reviews[1], after.writes[after.reviews[1].key]), () => ({ id: 'B3' })), elementB, 'the untouched card survives the write')
  await controller.refresh()
  assert.notEqual(controller.getPageToken(), token, 'a refresh starts a new page identity')
})

test('the inbox still subscribes through useSyncExternalStore with a stable pair', async () => {
  const calls = []
  const runner = makeHookRunner()
  const React = {
    createElement: (...args) => ({ __element: args }),
    ...runner.hooks,
    useSyncExternalStore(subscribe, getSnapshot) { calls.push([subscribe, getSnapshot]); return getSnapshot() },
  }
  const inbox = inboxModule.createCielInbox({ React })
  const registrations = {}
  inbox.install({
    slots: { inject: (key, fn) => fn(), register: (desc, component) => { registrations['main:' + desc.key] = component; return () => {} } },
  }, {
    call: async (method, request) => {
      if (method === 'inboxList') return { ok: true, sessionId: request.sessionId, reviews: [rawReview(0, 2)], nextCursor: null, limited: false }
      return { ok: false, code: 'unknown', error: 'unexpected method ' + method }
    },
    getSessions: () => ({ list: { getSnapshot: () => ({ current: SESSION }) } }),
  })
  const controller = inbox.getController()
  await controller.openPage()
  const component = registrations['main:' + INBOX_PANEL_ID]
  runner.render(component, { controller })
  runner.render(component, { controller })
  assert.ok(calls.length >= 2, 'useSyncExternalStore must be used for the inbox controller')
  assert.equal(new Set(calls.map((entry) => entry[0])).size, 1, 'the subscribe pair must be stable across renders')
  const snapshot = calls[0][1]()
  assert.equal(snapshot.phase, 'ready', 'the external store must return the live controller snapshot')
})

test('the disclosure threshold and original indices are retained', async () => {
  const React = { createElement: (...args) => ({ __element: args }), ...makeHookRunner().hooks }
  const build = (count) => {
    const runner = makeHookRunner()
    const react = { createElement: (...args) => ({ __element: args }), ...runner.hooks, useSyncExternalStore: undefined }
    const inbox = inboxModule.createCielInbox({ React: react })
    const registrations = {}
    inbox.install({ slots: { inject: (key, fn) => fn(), register: (desc, component) => { registrations['main:' + desc.key] = component; return () => {} } } }, {
      call: async (method, request) => {
        if (method === 'inboxList') return { ok: true, sessionId: request.sessionId, reviews: [rawReview(0, count)], nextCursor: null, limited: false }
        return { ok: false, code: 'unknown', error: 'unexpected method ' + method }
      },
      getSessions: () => ({ list: { getSnapshot: () => ({ current: SESSION }) } }),
    })
    return { runner, inbox, registrations }
  }
  const walk = (node, visit, depth = 0) => {
    if (depth > 20 || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child, visit, depth + 1); return }
    if (!Object.prototype.hasOwnProperty.call(node, '__element')) return
    visit(node)
    const type = node.__element[0]
    if (typeof type === 'function') walk(type(node.__element[1]), visit, depth + 1)
    for (let i = 2; i < node.__element.length; i += 1) walk(node.__element[i], visit, depth + 1)
  }
  const findAll = (node, predicate) => { const found = []; walk(node, (element) => { if (predicate(element)) found.push(element) }); return found }
  const propsOf = (node) => node.__element[1]
  for (const [count, expectedDetails] of [[8, 0], [9, 1]]) {
    const { runner, inbox, registrations } = build(count)
    await inbox.getController().openPage()
    const tree = runner.render(registrations['main:' + INBOX_PANEL_ID], { controller: inbox.getController() })
    const details = findAll(tree, (element) => propsOf(element)['data-ciel-disclosure'] !== undefined)
    assert.equal(details.length, expectedDetails, count + ' annotations: wrong disclosure count')
    const annotations = findAll(tree, (element) => propsOf(element)['data-ciel-inbox-annotation'] !== undefined)
    assert.equal(annotations.length, count, 'every annotation node must remain in the DOM')
    assert.deepEqual(annotations.map((node) => propsOf(node)['data-ciel-inbox-annotation']), Array.from({ length: count }, (_, k) => String(k)), 'original indices must be preserved')
  }
})

test('the shared progress scheduler still destroys an idle timer', async () => {
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return { inFlight: false } } })
  rt.runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const timers = mockTimers()
  try {
    const cleanup = rt.runner.getEffects()[1].fn()
    await flush()
    assert.equal(calls, 1, 'mount probes once')
    assert.equal(timers.intervalCount(), 0, 'confirmed idle must destroy the shared timer')
    timers.fireTick()
    await flush()
    assert.equal(calls, 1, 'a cleared timer cannot tick')
    cleanup()
    assert.equal(timers.intervalCount(), 0)
  } finally {
    timers.restore()
    rt.dispose()
  }
})

test('an orphaned in-flight probe is still fenced from a new mount', async () => {
  let resolvePending
  const pending = new Promise((resolve) => { resolvePending = resolve })
  let calls = 0
  const rt = await createRuntime({ progress: () => { calls += 1; return pending } })
  rt.runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
  const first = rt.runner.getEffects()
  const timers = mockTimers()
  try {
    const cleanup = first[1].fn()
    await flush()
    assert.equal(calls, 1)
    cleanup()
    rt.runner.render(rt.ReviewButton, { messageId: 'm1', sessionId: 's1' })
    rt.runner.getEffects()[1].fn()
    await flush()
    assert.equal(calls, 1, 'the new mount must not adopt the orphaned probe')
    resolvePending({ inFlight: false })
    await flush()
    assert.equal(calls, 2, 'after the orphan settles the new generation probes once')
  } finally {
    timers.restore()
    rt.dispose()
  }
})

test('the single mark supervisor and selection recovery remain wired', async () => {
  assert.match(clientSource, /createMarkSupervisor/, 'the single mark supervisor must remain')
  assert.match(clientSource, /mark supervisor lifetime/, 'the supervisor lifetime effect must remain')
  const rt = await createRuntime({})
  assert.equal(typeof rt.moduleExports.__test.restoreSelection, 'function', 'selection recovery must remain exported')
  const selection = rt.moduleExports.__test.restoreSelection(3, new Set(['r1']), { r1: 'planned' })
  assert.ok(selection !== null && selection !== undefined, 'restoreSelection must return a usable state')
  rt.dispose()
})

test('the native action Button path is retained', async () => {
  const Button = ({ children, ...props }) => ({ __element: ['button', { ...props, 'data-fixture-native': 'Button' }, children] })
  const runner = makeHookRunner()
  const React = { createElement: (...args) => ({ __element: args }), ...runner.hooks, useSyncExternalStore: undefined }
  const inbox = inboxModule.createCielInbox({ React, Button })
  const registrations = {}
  inbox.install({ slots: { inject: (key, fn) => fn(), register: (desc, component) => { registrations['main:' + desc.key] = component; return () => {} } } }, {
    call: async (method, request) => {
      if (method === 'inboxList') return { ok: true, sessionId: request.sessionId, reviews: [rawReview(0, 2)], nextCursor: null, limited: false }
      return { ok: false, code: 'unknown', error: 'unexpected method ' + method }
    },
    getSessions: () => ({ list: { getSnapshot: () => ({ current: SESSION }) } }),
  })
  await inbox.getController().openPage()
  const tree = runner.render(registrations['main:' + INBOX_PANEL_ID], { controller: inbox.getController() })
  const walk = (node, visit, depth = 0) => {
    if (depth > 20 || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child, visit, depth + 1); return }
    if (!Object.prototype.hasOwnProperty.call(node, '__element')) return
    visit(node)
    const type = node.__element[0]
    if (typeof type === 'function') walk(type(node.__element[1]), visit, depth + 1)
    for (let i = 2; i < node.__element.length; i += 1) walk(node.__element[i], visit, depth + 1)
  }
  let native = 0
  walk(tree, (element) => { if (element.__element[1] !== undefined && element.__element[1] !== null && element.__element[1]['data-ciel-native-button'] !== undefined) native += 1 })
  assert.ok(native > 0, 'at least one action control must still use the native Button marker')
})
