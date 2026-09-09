// Ciel sidebar client tests: the pure-ESM sidebar module against a mock React
// renderer and a mock Cordis context. No network, no real DSH, no DOM library:
// the point is the WIRING (addresses -> providers -> native registrations ->
// bodies) and the two behaviors that must not regress — a failed resource never
// shows the last success, and historical evidence never reads the current file
// by itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileAddressFor, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import {
  CIEL_ADVICE,
  CIEL_EVIDENCE,
  CIEL_REVIEW,
  adviceAddress,
  createCielSidebar,
  evidenceAddress,
  parseCielAddress,
  reviewAddress,
} from '../src/sidebar.js'

// ── a tiny React renderer ────────────────────────────────────────────────

/**
 * A hook-owning renderer for one root component. State survives re-renders;
 * refs are attached to fake DOM nodes before effects run, mirroring React's
 * render -> refs -> effects order.
 */
function createRenderer() {
  const Fragment = Symbol('Fragment')
  let instance = null
  const sameDeps = (left, right) => {
    if (left === right) return true
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }
  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { __element: true, type, props: { ...(props || {}), children: kids } }
    },
    useState(initial) {
      const index = instance.cursor++
      if (instance.state[index] === undefined) instance.state[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = instance.state[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef(initial) {
      const index = instance.cursor++
      if (instance.refs[index] === undefined) instance.refs[index] = { current: initial }
      return instance.refs[index]
    },
    useEffect(effect, deps) {
      const index = instance.cursor++
      instance.effects.push({ index, effect, deps })
    },
  }
  const runEffects = () => {
    for (const entry of instance.effects) {
      const previous = instance.effectSlots[entry.index]
      const run = entry.deps === undefined || previous === undefined || !sameDeps(previous.deps, entry.deps)
      if (!run) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = entry.effect()
      instance.effectSlots[entry.index] = {
        deps: entry.deps === undefined ? undefined : [...entry.deps],
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      }
    }
  }
  const build = (raw) => {
    const elements = []
    const convert = (node) => {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
      if (Array.isArray(node)) return { children: node.map(convert).filter((child) => child !== null) }
      if (node.__element !== true) return null
      if (node.type === Fragment) return convert(node.props.children)
      if (typeof node.type === 'function') return convert(node.type(node.props))
      const dom = { scrollCalls: [], focusCalls: 0 }
      dom.scrollIntoView = (options) => { dom.scrollCalls.push(options) }
      dom.focus = () => { dom.focusCalls += 1 }
      const element = { type: node.type, props: node.props, dom, children: [] }
      elements.push(element)
      const ref = node.props.ref
      if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = dom
      const child = convert(node.props.children)
      if (child !== null) element.children.push(child)
      return element
    }
    const root = convert(raw)
    const textOf = (node) => {
      if (node === null || node === undefined) return ''
      if (node.text !== undefined) return node.text
      return (node.children || []).map(textOf).join('')
    }
    return {
      root,
      elements,
      text: textOf(root),
      all: (predicate) => elements.filter(predicate),
      find: (predicate) => elements.find(predicate),
      textOf,
      click: (element) => (typeof element.props.onClick === 'function' ? element.props.onClick({}) : undefined),
      change: (element, value) => (typeof element.props.onChange === 'function' ? element.props.onChange({ target: { checked: value, value } }) : undefined),
    }
  }
  const render = () => {
    instance.cursor = 0
    instance.effects = []
    const raw = instance.component(instance.props)
    const tree = build(raw)
    runEffects()
    return tree
  }
  return {
    React,
    mount(component, props) {
      instance = { component, props, cursor: 0, state: [], refs: [], effects: [], effectSlots: [] }
      return render()
    },
    rerender: () => render(),
    unmount() {
      for (const slot of instance.effectSlots) if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
      instance = null
    },
  }
}

/** The native Tag fixture: a hook-free span, like the real platform Tag. */
function createTag(harness) {
  return function FixtureTag(props) {
    return harness.React.createElement('span', { 'data-ciel-tag': props.tone || 'neutral' }, props.children)
  }
}

// ── a tiny Cordis context ────────────────────────────────────────────────

function createMockContext(options = {}) {
  const providers = new Map()
  const tabs = new Map()
  const slots = new Map()
  const effectCleanups = []
  const sidebarCalls = []
  const sidebar = options.sidebar === undefined
    ? { openResource(address, openOptions) { sidebarCalls.push({ address, options: openOptions }) } }
    : options.sidebar
  const ctx = {
    effect(setup, label) {
      const cleanup = setup()
      let active = true
      const record = { label, runs: 0 }
      const dispose = () => {
        if (!active) return
        active = false
        record.runs += 1
        if (typeof cleanup === 'function') cleanup()
      }
      effectCleanups.push(record)
      return dispose
    },
    resources: {
      register(provider) {
        if (providers.has(provider.protocol)) throw new Error('duplicate provider ' + provider.protocol)
        providers.set(provider.protocol, provider)
        return () => { providers.delete(provider.protocol) }
      },
    },
    sidebarRightTabs: {
      register(definition) {
        if (tabs.has(definition.kind)) throw new Error('duplicate kind ' + definition.kind)
        tabs.set(definition.kind, definition)
        return () => { tabs.delete(definition.kind) }
      },
    },
    slots: {
      inject(key, callback) {
        const cleanup = callback()
        return () => { if (typeof cleanup === 'function') cleanup() }
      },
      register(registration, component) {
        if (slots.has(registration.key)) throw new Error('duplicate slot key ' + registration.key)
        slots.set(registration.key, { registration, component })
        return () => { slots.delete(registration.key) }
      },
    },
    get(key) {
      return key === 'sidebarRight' ? sidebar : undefined
    },
  }
  return { ctx, providers, tabs, slots, effectCleanups, sidebarCalls, sidebar }
}

/** The shipped alpha.2 helper retains the owning Session even with no cwd. */
function fileAddress(sessionId, path) {
  return fileAddressFor(sessionId, undefined, path)
}

function createSidebar(harness, options = {}) {
  return createCielSidebar({
    React: harness.React,
    Tag: options.Tag === undefined ? createTag(harness) : options.Tag,
    ...(options.Button === undefined ? {} : { Button: options.Button }),
    fileAddressFor: options.fileAddressFor === undefined ? fileAddress : options.fileAddressFor,
  })
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Collect every frame of one provider stream. */
async function frames(stream) {
  const out = []
  for await (const frame of stream) out.push(frame)
  return out
}

/** Mount one registered body with fake standard props. */
function mountBody(harness, mock, kind, { params, snapshot, faceExtra } = {}) {
  const definition = mock.tabs.get(kind)
  assert.ok(definition, 'tab type registered for ' + kind)
  const entry = mock.slots.get(definition.id)
  assert.ok(entry, 'body registered for ' + kind)
  const face = entry.registration.inject('s1')
  assert.equal(typeof snapshot.address, 'string', 'mountBody needs the resource address')
  const actionCalls = []
  const actions = {
    calls: actionCalls,
    openResource(address, options) { actionCalls.push({ address, options }) },
    openTab() {},
    close() {},
  }
  const tab = {
    id: 'tab-1',
    kind,
    contentId: snapshot.address,
    navigation: { address: snapshot.address, params, revision: 1 },
    visible: true,
    signal: new AbortController().signal,
    actions,
  }
  const tree = harness.mount(entry.component, {
    ...face,
    ...faceExtra,
    sessionId: 's1',
    useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' }, tab }),
    useResource: () => snapshot,
  })
  return { tree, tab, face, actions, component: entry.component, registration: entry.registration }
}

const live = (address, value) => ({ address, status: 'live', value, failure: undefined })
const failed = (address, failure) => ({ address, status: 'failed', value: undefined, failure })

// ── addresses ────────────────────────────────────────────────────────────

test('reviewAddress encodes every segment and parses back exactly', () => {
  const address = reviewAddress('s 1/2', 'r?3#4')
  assert.equal(address, 'dsh-resource://ciel-review/session/s%201%2F2/r%3F3%234')
  assert.deepEqual(parseCielAddress(address), { protocol: CIEL_REVIEW, sessionId: 's 1/2', recordId: 'r?3#4' })
})

test('evidenceAddress carries the evidence segment and round-trips it', () => {
  const address = evidenceAddress('s', 'r', 'e%&/x')
  assert.equal(address, 'dsh-resource://ciel-evidence/session/s/r/e%25%26%2Fx')
  assert.deepEqual(parseCielAddress(address), { protocol: CIEL_EVIDENCE, sessionId: 's', recordId: 'r', evidenceId: 'e%&/x' })
  assert.equal(adviceAddress('s', 'c1'), 'dsh-resource://ciel-advice/session/s/c1')
})

test('parseCielAddress is strict about scheme, scope, segment count, and encoding', () => {
  assert.equal(parseCielAddress('dsh-resource://ciel-review/session/s/r/'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-review/session/s'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-review/session//r'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-evidence/session/s/r'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-advice/session/s/r/e'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-review/absolute/s/r'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-review/session/s/%zz'), undefined)
  assert.equal(parseCielAddress('file:///ciel-review/session/s/r'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-file/session/s/r'), undefined)
  assert.equal(parseCielAddress('/session/s/r'), undefined)
  assert.equal(parseCielAddress(undefined), undefined)
  assert.equal(parseCielAddress(''), undefined)
})

test('parseCielAddress rejects query, fragment, port, and userinfo, and accepts a mixed-case protocol', () => {
  assert.equal(parseCielAddress('dsh-resource://ciel-review/session/s/r?q=1'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-review/session/s/r#frag'), undefined)
  assert.equal(parseCielAddress('dsh-resource://ciel-review:80/session/s/r'), undefined)
  assert.equal(parseCielAddress('dsh-resource://u@ciel-review/session/s/r'), undefined)
  assert.deepEqual(parseCielAddress('dsh-resource://CIEL-REVIEW/session/s/r'), { protocol: CIEL_REVIEW, sessionId: 's', recordId: 'r' })
})

// ── factory ──────────────────────────────────────────────────────────────

test('createCielSidebar requires React and fileAddressFor', () => {
  assert.throws(() => createCielSidebar(), /React/)
  assert.throws(() => createCielSidebar({ React: {} }), /React/)
  assert.throws(() => createCielSidebar({ React: createRenderer().React }), /fileAddressFor/)
})

test('a missing Tag degrades to a plain span chip', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness, { Tag: null })
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: { reviewId: 'r1', status: 'sound', annotations: [] } }) })
  const review = { reviewId: 'r1', messageId: 'm1', status: 'sound', annotations: [] }
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  assert.ok(tree.find((element) => element.props['data-ciel-chip'] !== undefined), 'expected a span chip')
})

// ── install ──────────────────────────────────────────────────────────────

test('install registers the three static providers, tab types, and bodies', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const call = async () => ({ ok: true, review: { reviewId: 'r1', annotations: [] } })
  const uninstall = sidebar.install(mock.ctx, { call })
  assert.equal(typeof uninstall, 'function')
  assert.deepEqual([...mock.providers.keys()].sort(), [CIEL_ADVICE, CIEL_EVIDENCE, CIEL_REVIEW])
  assert.deepEqual([...mock.tabs.keys()].sort(), [CIEL_ADVICE, CIEL_EVIDENCE, CIEL_REVIEW])
  assert.equal(mock.slots.size, 3)
  for (const protocol of [CIEL_REVIEW, CIEL_EVIDENCE, CIEL_ADVICE]) {
    assert.equal(mock.providers.get(protocol).protocol, protocol)
    assert.equal(mock.providers.get(protocol).reload, undefined, 'a static provider has no reload')
    const definition = mock.tabs.get(protocol)
    assert.equal(definition.priority, 'extension')
    assert.deepEqual(definition.patterns, ['dsh-resource://' + protocol + '/**'])
    assert.equal(mock.slots.get(definition.id).registration.name, 'sidebar.right.pane.tab')
  }
})

test('tab types accept only their own well-formed addresses and title by id', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = mock.tabs.get(CIEL_REVIEW)
  assert.equal(review.canOpen(reviewAddress('s1', 'r1')), true)
  assert.equal(review.canOpen(evidenceAddress('s1', 'r1', 'e1')), false)
  assert.equal(review.canOpen('dsh-resource://ciel-review/session/s1'), false)
  assert.equal(review.title(reviewAddress('s1', 'r1')), '评审 r1')
  assert.equal(mock.tabs.get(CIEL_EVIDENCE).title(evidenceAddress('s1', 'r1', 'e1')), '证据 e1')
  assert.equal(mock.tabs.get(CIEL_ADVICE).title(adviceAddress('s1', 'c1')), '顾问 c1')
  assert.equal(mock.tabs.get(CIEL_ADVICE).title('nonsense'), 'nonsense')
})

test('the body inject face carries the prepareFeedback callback', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const prepare = () => ({ ok: true })
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }), onPrepareFeedback: prepare })
  const definition = mock.tabs.get(CIEL_REVIEW)
  const face = mock.slots.get(definition.id).registration.inject('s1')
  assert.equal(face.prepareFeedback, prepare)
  assert.equal(typeof face.openReview, 'function')
  assert.equal(typeof face.openEvidence, 'function')
  assert.equal(typeof face.openCurrentFile, 'function')
})

test('install is idempotent on one context and refuses another', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const uninstall = sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  assert.equal(sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) }), uninstall)
  assert.equal(mock.providers.size, 3)
  assert.throws(() => sidebar.install(createMockContext().ctx, { call: async () => ({ ok: true, review: {} }) }), /already installed/)
})

test('a registration clash unwinds everything the failed install already registered', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  mock.ctx.resources.register = (provider) => {
    if (provider.protocol === CIEL_EVIDENCE) throw new Error('protocol already has a provider')
    mock.providers.set(provider.protocol, provider)
    return () => { mock.providers.delete(provider.protocol) }
  }
  assert.throws(() => sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) }), /already has a provider/)
  assert.equal(mock.providers.size, 0, 'the first provider was released')
  assert.equal(mock.tabs.size, 0)
  assert.equal(mock.slots.size, 0)
  assert.equal(sidebar.openReview('s1', 'r1').ok, false)
})

test('install rejects a context without the native services', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  assert.throws(() => sidebar.install(null, { call() {} }), /cordis context/)
  assert.throws(() => sidebar.install({ effect() {} }, { call() {} }), /ctx.resources/)
  assert.throws(() => sidebar.install(createMockContext().ctx, {}), /call\(method, request\)/)
})

test('dispose is idempotent, removes every registration, and retires the entry points', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  sidebar.dispose()
  sidebar.dispose()
  assert.equal(mock.providers.size, 0)
  assert.equal(mock.tabs.size, 0)
  assert.equal(mock.slots.size, 0)
  assert.ok(mock.effectCleanups.length > 0)
  assert.ok(mock.effectCleanups.every((record) => record.runs === 1), 'every effect cleanup ran exactly once')
  const result = sidebar.openReview('s1', 'r1')
  assert.equal(result.ok, false)
  assert.match(result.error, /disposed/)
  assert.throws(() => sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) }), /disposed/)
})

test('entry points before install report an error instead of throwing', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  for (const result of [sidebar.openReview('s1', 'r1'), sidebar.openEvidence('s1', 'r1', 'e1'), sidebar.openAdvice('s1', 'c1'), sidebar.openCurrentFile('s1', '/a.ts', 1)]) {
    assert.equal(result.ok, false)
    assert.match(result.error, /not installed/)
  }
})

// ── providers ────────────────────────────────────────────────────────────

test('the review provider reads once, maps the business object, and ends its stream', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const calls = []
  const review = { reviewId: 'r1', annotations: [{ severity: 'nit', evidenceRefs: ['e1'] }] }
  sidebar.install(mock.ctx, { call: async (method, request) => { calls.push({ method, request }); return { ok: true, review } } })
  const provider = mock.providers.get(CIEL_REVIEW)
  const out = await frames(provider.open(reviewAddress('s1', 'r1'), { signal: new AbortController().signal }))
  assert.equal(out.length, 1)
  assert.equal(out[0].ok, true)
  assert.deepEqual(out[0].value, { sessionId: 's1', reviewId: 'r1', review })
  assert.deepEqual(calls, [{ method: 'readReview', request: { sessionId: 's1', reviewId: 'r1' } }])
})

test('the evidence and advice providers send their documented requests', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const calls = []
  sidebar.install(mock.ctx, {
    call: async (method, request) => {
      calls.push({ method, request })
      if (method === 'readEvidence') return { ok: true, evidence: { id: 'e1', status: 'available' } }
      return { ok: true, advice: { callId: 'c1', text: 't' } }
    },
  })
  const evidence = await frames(mock.providers.get(CIEL_EVIDENCE).open(evidenceAddress('s1', 'r1', 'e1'), { signal: new AbortController().signal }))
  const advice = await frames(mock.providers.get(CIEL_ADVICE).open(adviceAddress('s1', 'c1'), { signal: new AbortController().signal }))
  assert.deepEqual(evidence[0].value, { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence: { id: 'e1', status: 'available' } })
  assert.deepEqual(advice[0].value, { sessionId: 's1', callId: 'c1', advice: { callId: 'c1', text: 't' } })
  assert.deepEqual(calls, [
    { method: 'readEvidence', request: { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1' } },
    { method: 'readAdvice', request: { sessionId: 's1', callId: 'c1' } },
  ])
})

test('a business failure becomes one failure frame carrying the module code', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: false, error: 'no such review' }) })
  const out = await frames(mock.providers.get(CIEL_REVIEW).open(reviewAddress('s1', 'r1'), { signal: new AbortController().signal }))
  assert.equal(out.length, 1)
  assert.equal(out[0].ok, false)
  assert.equal(out[0].error.code, 'ciel-sidebar/read-failed')
  assert.equal(out[0].error.message, 'no such review')
  assert.equal(out[0].error.isDSHRemoteError, true)
  assert.ok(out[0].error instanceof Error)
})

test('a throwing call and a malformed result are failure frames, never stream faults', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const thrown = createMockContext()
  sidebar.install(thrown.ctx, { call: async () => { throw new Error('boom') } })
  const first = await frames(thrown.providers.get(CIEL_REVIEW).open(reviewAddress('s1', 'r1'), { signal: new AbortController().signal }))
  assert.equal(first[0].error.message, 'boom')

  const other = createRenderer()
  const second = createSidebar(other)
  const malformed = createMockContext()
  second.install(malformed.ctx, { call: async () => ({ ok: true }) })
  const out = await frames(malformed.providers.get(CIEL_REVIEW).open(reviewAddress('s1', 'r1'), { signal: new AbortController().signal }))
  assert.equal(out[0].ok, false)
  assert.match(out[0].error.message, /returned no review/)
})

test('an unsupported or foreign address is one failure frame', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const provider = mock.providers.get(CIEL_REVIEW)
  for (const address of ['dsh-resource://ciel-review/absolute/s/r', 'dsh-resource://ciel-evidence/session/s/r/e', 'nonsense']) {
    const out = await frames(provider.open(address, { signal: new AbortController().signal }))
    assert.equal(out.length, 1)
    assert.equal(out[0].error.code, 'ciel-sidebar/unsupported-address')
  }
})

test('an already-aborted signal yields nothing', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  let called = 0
  sidebar.install(mock.ctx, { call: async () => { called += 1; return { ok: true, review: {} } } })
  const controller = new AbortController()
  controller.abort()
  const out = await frames(mock.providers.get(CIEL_REVIEW).open(reviewAddress('s1', 'r1'), { signal: controller.signal }))
  assert.deepEqual(out, [])
  assert.equal(called, 0)
})

test('an abort after the read settles yields nothing', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  let release
  sidebar.install(mock.ctx, { call: () => new Promise((resolve) => { release = resolve }) })
  const controller = new AbortController()
  const pending = frames(mock.providers.get(CIEL_REVIEW).open(reviewAddress('s1', 'r1'), { signal: controller.signal }))
  await flush()
  controller.abort()
  release({ ok: true, review: { reviewId: 'r1' } })
  assert.deepEqual(await pending, [])
})

test('concurrent opens share one host read and a later open reads again', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const resolvers = []
  let called = 0
  sidebar.install(mock.ctx, {
    call: () => {
      called += 1
      return new Promise((resolve) => { resolvers.push(resolve) })
    },
  })
  const provider = mock.providers.get(CIEL_REVIEW)
  const address = reviewAddress('s1', 'r1')
  const signal = new AbortController().signal
  const first = frames(provider.open(address, { signal }))
  const second = frames(provider.open(address, { signal }))
  await flush()
  assert.equal(called, 1)
  resolvers[0]({ ok: true, review: { reviewId: 'r1' } })
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.length, 1)
  assert.equal(right.length, 1)
  const third = frames(provider.open(address, { signal }))
  await flush()
  assert.equal(called, 2)
  resolvers[1]({ ok: true, review: { reviewId: 'r1' } })
  assert.equal((await third).length, 1)
})

// ── the review body ──────────────────────────────────────────────────────

const reviewEntry = () => ({
  reviewId: 'r1',
  messageId: 'm1',
  status: 'completed',
  verdict: 'changes',
  coverage: 'complete',
  summary: '一句话总评',
  stats: { checked: 2, confirmed: 1, excluded: 1, unchecked: 0 },
  modelUsage: { requested: { provider: 'p', model: 'm' }, used: [{ provider: 'p', model: 'm' }] },
  createdAt: 0,
  annotations: [
    { severity: 'blocker', title: '标题一', anchor: '锚点一', comment: '评论一', evidenceRefs: ['e1', 'e2'] },
    { severity: 'nit', title: '标题二', comment: '评论二' },
  ],
})

test('the review body renders the entry, its annotations, and their evidence refs', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = reviewEntry()
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  assert.match(tree.text, /标题一/)
  assert.match(tree.text, /锚点一/)
  assert.match(tree.text, /评论一/)
  assert.match(tree.text, /标题二/)
  assert.match(tree.text, /排查 2 · 证伪 1 · 排除 1 · 未查 0/)
  assert.match(tree.text, /p\/m/)
  assert.equal(tree.all((element) => element.props['data-ciel-annotation'] !== undefined).length, 2)
  assert.equal(tree.all((element) => element.props['data-ciel-evidence-ref'] !== undefined).length, 2)
  assert.equal(tree.find((element) => element.props['data-ciel-review-status'] !== undefined).props['data-ciel-review-status'], '发现问题')
})

test('time-only review details show query count and total seconds without a count ceiling', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = { ...reviewEntry(), explore: { limitMode: 'time', toolCalls: 123, timeoutSeconds: 180 } }
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  assert.match(tree.text, /已查询 123 次 · 总时限 180 秒/)
  assert.doesNotMatch(tree.text, /123\/|undefined|Infinity/)
})

test('selecting annotations asks the parent to stage them, in index order', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const requests = []
  sidebar.install(mock.ctx, {
    call: async () => ({ ok: true, review: {} }),
    onPrepareFeedback: async (request) => { requests.push(request); return { ok: true, count: request.items.length } },
  })
  const review = reviewEntry()
  const mounted = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const boxes = mounted.tree.all((element) => element.props['data-ciel-select'] !== undefined)
  mounted.tree.change(boxes[1], true)
  mounted.tree.change(boxes[0], true)
  const withSelection = harness.rerender()
  assert.match(withSelection.text, /已选 2 条/)
  const submit = withSelection.find((element) => element.props['data-ciel-submit'] !== undefined)
  await submit.props.onClick()
  assert.deepEqual(requests, [{ sessionId: 's1', reviewId: 'r1', messageId: 'm1', items: [{ index: 0 }, { index: 1 }] }])
  assert.match(harness.rerender().text, /已填入输入框/)
})

test('a failed prepareFeedback is shown and leaves the selection intact', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, {
    call: async () => ({ ok: true, review: {} }),
    onPrepareFeedback: async () => ({ ok: false, error: '输入框已变化' }),
  })
  const review = reviewEntry()
  const mounted = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  mounted.tree.change(mounted.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], true)
  const submit = harness.rerender().find((element) => element.props['data-ciel-submit'] !== undefined)
  await submit.props.onClick()
  const after = harness.rerender()
  assert.match(after.text, /输入框已变化/)
  assert.match(after.text, /已选 1 条/)
})

test('the review body without a wired callback says so instead of pretending', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = reviewEntry()
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  assert.match(tree.text, /输入框回传未接线/)
  assert.equal(tree.find((element) => element.props['data-ciel-submit'] !== undefined).props.disabled, true)
})

test('Host triage states initialize the checkboxes and a toggle saves by exact sid/rid/index', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  const triageRequests = []
  sidebar.install(mock.ctx, {
    call: async () => ({ ok: true, review: {} }),
    onTriage: async (request) => { triageRequests.push(request); return { ok: true } },
  })
  const review = { ...reviewEntry(), triage: { states: { 0: 'accept', 1: 'dismiss' } } }
  const mounted = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const boxes = mounted.tree.all((element) => element.props['data-ciel-select'] !== undefined)
  assert.equal(boxes[0].props.checked, true, 'accept starts checked')
  assert.equal(boxes[1].props.checked, false, 'dismiss starts unchecked')
  assert.match(mounted.tree.text, /已选 1 条/)
  mounted.tree.change(boxes[1], true)
  await flush()
  assert.deepEqual(triageRequests, [{
    sessionId: 's1',
    reviewId: 'r1',
    changes: [{ index: 1, state: 'accept' }],
    indices: [0, 1],
  }])
  assert.match(harness.rerender().text, /已选 2 条/)
})

test('a failed triage save surfaces and the checkbox keeps the user choice', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, {
    call: async () => ({ ok: true, review: {} }),
    onTriage: async () => ({ ok: false, error: 'WAL append failed' }),
  })
  const review = { ...reviewEntry(), triage: { states: {} } }
  const mounted = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  mounted.tree.change(mounted.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], true)
  await flush()
  const after = harness.rerender()
  assert.match(after.text, /分诊保存失败：WAL append failed/)
  assert.equal(after.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, true)
  // A failed save keeps the local choice and its failure line across a remount.
  const remount = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  assert.equal(remount.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, true)
  assert.match(remount.tree.text, /分诊保存失败：WAL append failed/, 'the failure line is restored with the choice')
})

test('a late Host triage record cannot clobber a live choice', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = { ...reviewEntry(), triage: { states: { 0: 'accept' } } }
  const mounted = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  mounted.tree.change(mounted.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], false)
  review.triage.states[0] = 'dismiss'
  const after = harness.rerender()
  assert.equal(after.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, false)
  assert.match(after.text, /勾选只用于回传，不代表问题成立/)
})

test('a local triage choice survives a remount over a stale pinned review', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, {
    call: async () => ({ ok: true, review: {} }),
    onTriage: async () => ({ ok: true }),
  })
  const review = { ...reviewEntry(), triage: { states: { 0: 'accept' } } }
  const snapshot = live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review })
  const first = mountBody(harness, mock, CIEL_REVIEW, { snapshot })
  assert.equal(first.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, true)
  first.tree.change(first.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], false)
  await flush()
  // The pinned record still carries triage accept; the local choice wins.
  const second = mountBody(harness, mock, CIEL_REVIEW, { snapshot })
  assert.equal(second.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, false)
  assert.match(second.tree.text, /已选 0 条/, 'the UI never resets to all-selected')
})

test('the same review id in another session never borrows the first session choice', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }), onTriage: async () => ({ ok: true }) })
  const review = { ...reviewEntry(), triage: { states: { 0: 'accept' } } }
  const first = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  first.tree.change(first.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], false)
  await flush()
  const other = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s2', 'r1'), { sessionId: 's2', reviewId: 'r1', review }),
  })
  assert.equal(other.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, true, "another session's identical review id keeps its own triage")
})

test('a record whose identity changed never borrows the previous choice', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }), onTriage: async () => ({ ok: true }) })
  const review = { ...reviewEntry(), createdAt: 0, triage: { states: { 0: 'accept' } } }
  const address = reviewAddress('s1', 'r1')
  const first = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(address, { sessionId: 's1', reviewId: 'r1', review }),
  })
  first.tree.change(first.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], false)
  await flush()
  const replacement = { ...reviewEntry(), createdAt: 99, triage: { states: { 0: 'accept' } } }
  const second = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(address, { sessionId: 's1', reviewId: 'r1', review: replacement }),
  })
  assert.equal(second.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0].props.checked, true, 'the new record starts from its own triage')
})

test('a remount with no local choice keeps the pinned frame triage and never selects all', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = { ...reviewEntry(), triage: { states: { 0: 'accept' } } }
  const snapshot = live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review })
  const first = mountBody(harness, mock, CIEL_REVIEW, { snapshot })
  const firstBoxes = first.tree.all((element) => element.props['data-ciel-select'] !== undefined)
  assert.equal(firstBoxes[0].props.checked, true)
  assert.equal(firstBoxes[1].props.checked, false)
  assert.match(first.tree.text, /已选 1 条/)
  const second = mountBody(harness, mock, CIEL_REVIEW, { snapshot })
  const secondBoxes = second.tree.all((element) => element.props['data-ciel-select'] !== undefined)
  assert.equal(secondBoxes[0].props.checked, true, 'the pinned frame triage is applied')
  assert.equal(secondBoxes[1].props.checked, false)
  assert.match(second.tree.text, /已选 1 条/, 'the UI never resets to all-selected')
})

test('a triage settlement from another review never shows on this one', async () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  let settle
  sidebar.install(mock.ctx, {
    call: async () => ({ ok: true, review: {} }),
    onTriage: () => new Promise((resolve) => { settle = resolve }),
  })
  const review = { ...reviewEntry(), triage: { states: {} } }
  const snapshot = live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review })
  const first = mountBody(harness, mock, CIEL_REVIEW, { snapshot })
  first.tree.change(first.tree.all((element) => element.props['data-ciel-select'] !== undefined)[0], true)
  await flush()
  assert.equal(typeof settle, 'function', 'the triage call is pending')
  const other = { ...reviewEntry(), reviewId: 'r2' }
  const otherSnapshot = live(reviewAddress('s1', 'r2'), { sessionId: 's1', reviewId: 'r2', review: other })
  mountBody(harness, mock, CIEL_REVIEW, { snapshot: otherSnapshot })
  settle({ ok: false, error: 'stale settlement' })
  await flush()
  assert.doesNotMatch(harness.rerender().text, /stale settlement/)
})

test('the optional native Button receives variant/size; the fallback stays a plain button', () => {
  const harness = createRenderer()
  const seen = []
  const FixtureButton = (props) => {
    seen.push(props)
    return harness.React.createElement('button', { 'data-fixture-button': props.variant, disabled: props.disabled, onClick: props.onClick }, props.children)
  }
  const native = createSidebar(harness, { Button: FixtureButton })
  const mock = createMockContext()
  native.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = reviewEntry()
  const mounted = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const submit = mounted.tree.find((element) => element.props['data-fixture-button'] === 'primary')
  assert.ok(submit, 'the native primitive rendered the submit')
  const submitProps = seen.find((props) => props['data-ciel-submit'] !== undefined)
  assert.ok(submitProps, 'the native primitive received the submit props')
  assert.equal(submitProps.variant, 'primary')
  assert.equal(submitProps.size, 'md')
  assert.equal(submitProps['data-ciel-action'], '')
  assert.equal(submitProps.disabled, true, 'the prominent CTA is still disabled until an annotation is selected')
  const refProps = seen.filter(props => props['data-ciel-evidence-ref'] !== undefined)
  assert.ok(refProps.length > 0)
  for (const props of refProps) {
    assert.equal(props.variant, 'toolbar', 'evidence references have a visible native filled surface')
    assert.equal(props.size, 'md')
    assert.equal(props.children, '查看证据 ' + props['data-ciel-evidence-ref'])
    assert.equal(props.icon.props['aria-hidden'], true, 'the decorative arrow does not change the accessible name')
  }

  const plainHarness = createRenderer()
  const plain = createSidebar(plainHarness)
  const plainMock = createMockContext()
  plain.install(plainMock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const plainMounted = mountBody(plainHarness, plainMock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const plainSubmit = plainMounted.tree.find((element) => element.props['data-ciel-submit'] !== undefined)
  assert.equal(plainSubmit.type, 'button')
  assert.equal(plainSubmit.props.type, 'button')
  assert.equal(plainSubmit.props.variant, undefined, 'native-only props never reach a plain button')
  assert.equal(plainSubmit.props.size, undefined)
  assert.equal(plainSubmit.props['data-ciel-action'], '')
  const plainRef = plainMounted.tree.find(element => element.props['data-ciel-evidence-ref'] !== undefined)
  assert.equal(plainRef.props.icon, undefined, 'native icon props never leak onto DOM fallback buttons')
})

test('a failed resource shows the failure and never the stale review', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const snapshot = {
    address: reviewAddress('s1', 'r1'),
    status: 'failed',
    value: { sessionId: 's1', reviewId: 'r1', review: reviewEntry() },
    failure: { code: 'ciel-sidebar/read-failed', message: '读取失败' },
  }
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, { snapshot })
  assert.equal(tree.find((element) => element.props['data-ciel-state'] !== undefined).props['data-ciel-state'], 'failed')
  assert.match(tree.text, /读取失败/)
  assert.doesNotMatch(tree.text, /标题一/)
  assert.doesNotMatch(tree.text, /一句话总评/)
})

test('annotationIndex focuses the matching annotation row', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = reviewEntry()
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    params: { annotationIndex: 1 },
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const focused = tree.find((element) => element.props['data-ciel-focus'] !== undefined)
  assert.equal(focused.props['data-ciel-annotation'], '1')
  assert.equal(focused.dom.scrollCalls.length, 1)
})

test('an evidence ref opens the evidence address through the native sidebar', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = reviewEntry()
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const button = tree.find((element) => element.props['data-ciel-evidence-ref'] === 'e1')
  button.props.onClick({})
  assert.equal(mock.sidebarCalls.length, 1)
  assert.equal(mock.sidebarCalls[0].address, evidenceAddress('s1', 'r1', 'e1'))
  assert.equal(mock.sidebarCalls[0].options.kind, CIEL_EVIDENCE)
})

// ── the evidence body ────────────────────────────────────────────────────

const evidenceEntry = () => ({
  id: 'e1',
  kind: 'source',
  path: 'src/a.ts',
  startLine: 10,
  endLine: 12,
  content: 'line ten\nline eleven\nline twelve',
  contentSha256: 'abcdef0123456789',
  capturedAt: 0,
  tool: 'read',
  truncated: false,
  status: 'available',
  currentPath: '/work/src/a.ts',
})

test('the evidence body numbers the snippet lines and marks the navigated line', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = evidenceEntry()
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
    params: { line: 11 },
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  const lines = tree.all((element) => element.props['data-ciel-line'] !== undefined)
  assert.deepEqual(lines.map((element) => element.props['data-ciel-line']), ['10', '11', '12'])
  assert.match(tree.text, /line eleven/)
  assert.match(tree.text, /行 10–12/)
  const target = tree.find((element) => element.props['data-ciel-line-target'] !== undefined)
  assert.equal(target.props['data-ciel-line'], '11')
  assert.equal(target.dom.scrollCalls.length, 1)
})

test('withheld evidence never renders its content, even when content is present', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = { ...evidenceEntry(), status: 'withheld', content: 'SECRET-SNIPPET' }
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  assert.doesNotMatch(tree.text, /SECRET-SNIPPET/)
  assert.match(tree.text, /隐私检查未提供内容/)
  assert.equal(tree.all((element) => element.props['data-ciel-line'] !== undefined).length, 0)
})

test('limited evidence shows its content with a limitation notice', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = { ...evidenceEntry(), status: 'limited', truncated: true, content: 'partial body' }
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  assert.match(tree.text, /partial body/)
  assert.match(tree.text, /可能不完整/)
  assert.ok(tree.find((element) => element.props['data-ciel-tag'] === 'warning'))
})

test('an unrecognized evidence status hides its content and says so', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = { ...evidenceEntry(), status: 'corrupt', content: 'UNTRUSTED-SNIPPET' }
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  assert.doesNotMatch(tree.text, /UNTRUSTED-SNIPPET/)
  assert.match(tree.text, /证据状态为 corrupt，未显示内容/)
  assert.equal(tree.all((element) => element.props['data-ciel-line'] !== undefined).length, 0)
})

test('duplicate evidence refs render one button each', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const review = { ...reviewEntry(), annotations: [{ severity: 'blocker', title: 't', evidenceRefs: ['e1', 'e1', 'e2'] }] }
  const { tree } = mountBody(harness, mock, CIEL_REVIEW, {
    snapshot: live(reviewAddress('s1', 'r1'), { sessionId: 's1', reviewId: 'r1', review }),
  })
  const refs = tree.all((element) => element.props['data-ciel-evidence-ref'] !== undefined)
  assert.deepEqual(refs.map((element) => element.props['data-ciel-evidence-ref']), ['e1', 'e2'])
})

for (const [label, cwd, path, decodedPath] of [
  ['relative', '/work', 'src/a.ts', 'src/a.ts'],
  ['workspace absolute', '/work', '/work/src/a.ts', 'src/a.ts'],
  ['external root', '/work', '/external/a.ts', '/external/a.ts'],
  ['unknown root', undefined, '/work/src/a.ts', '/work/src/a.ts'],
  ['encoded path', '/work', '/external/中文 #?.md', '/external/中文 #?.md'],
  ['Windows workspace', ['C:', 'work'].join(String.fromCharCode(92)), ['C:', 'work', 'src', 'a.ts'].join(String.fromCharCode(92)), 'src/a.ts'],
  ['Windows external drive', ['C:', 'work'].join(String.fromCharCode(92)), ['D:', 'lib', 'a.ts'].join(String.fromCharCode(92)), 'D:/lib/a.ts'],
  ['Windows UNC', ['C:', 'work'].join(String.fromCharCode(92)), ['', '', 'server', 'share', 'a.ts'].join(String.fromCharCode(92)), '//server/share/a.ts'],
]) {
  test('current-file navigation retains the evidence Session: ' + label, () => {
    const harness = createRenderer()
    const sidebar = createSidebar(harness, { fileAddressFor: (sid, path) => fileAddressFor(sid, cwd, path) })
    const mock = createMockContext()
    sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
    const owner = 'other session/#'
    const evidence = { ...evidenceEntry(), path: '/project/display-only.ts', currentPath: path }
    const mounted = mountBody(harness, mock, CIEL_EVIDENCE, {
      snapshot: live(evidenceAddress(owner, 'r1', 'e1'), { sessionId: owner, reviewId: 'r1', evidenceId: 'e1', evidence }),
    })
    assert.equal(mounted.actions.calls.length, 0)
    mounted.tree.find(element => element.props['data-ciel-open-current'] !== undefined).props.onClick({})
    const request = mounted.actions.calls[0]
    assert.deepEqual(parseFileAddress(request.address), { scope: 'session', sessionId: owner, path: decodedPath })
    assert.deepEqual(request.options, { params: { line: 10 } })
    assert.equal(mock.sidebarCalls.length, 0, 'use the tab-owned action, not current-session global navigation')
    assert.match(mounted.tree.text, /Markdown 渲染视图请切换/)
    assert.match(mounted.tree.text, /历史行号可能已不对应当前内容/)
  })
}

test('line-navigation guidance is absent without an openable path or source line', () => {
  for (const overrides of [{ currentPath: undefined }, { startLine: undefined }]) {
    const harness = createRenderer()
    const sidebar = createSidebar(harness)
    const mock = createMockContext()
    sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
    const evidence = { ...evidenceEntry(), ...overrides }
    const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
      snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
    })
    assert.equal(tree.find(element => element.props['data-ciel-current-line-hint'] !== undefined), undefined)
  }
})

test('the current-file button opens the native file address at the snippet start line', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = evidenceEntry()
  const mounted = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  assert.equal(mounted.actions.calls.length, 0, 'the current file is never read before the click')
  const button = mounted.tree.find((element) => element.props['data-ciel-open-current'] !== undefined)
  assert.equal(button.props['data-ciel-open-current'], '/work/src/a.ts')
  button.props.onClick({})
  assert.equal(mounted.actions.calls.length, 1)
  assert.equal(mounted.actions.calls[0].address, 'dsh-resource://file/session/s1//work/src/a.ts')
  assert.deepEqual(mounted.actions.calls[0].options, { params: { line: 10 } }, 'the tab actions carry no kind: the native registry picks the viewer')
})

test('the current-file button uses only the trusted currentPath and never falls back to path', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  // A recorded virtual path without a Host-resolved currentPath: display-only.
  const evidence = { ...evidenceEntry(), path: '/project/virtual/src/a.ts', currentPath: undefined }
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  assert.equal(tree.find((element) => element.props['data-ciel-open-current'] !== undefined), undefined)
  assert.match(tree.text, /没有可打开的当前文件路径/)
  assert.match(tree.text, /\/project\/virtual\/src\/a\.ts/, 'the recorded path stays visible')
  assert.equal(mock.sidebarCalls.length, 0)
})

test('the current-file button prefers the Host-resolved currentPath over the recorded path', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = { ...evidenceEntry(), path: '/project/virtual/src/a.ts', currentPath: '/work/src/a.ts' }
  const mounted = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  const button = mounted.tree.find((element) => element.props['data-ciel-open-current'] !== undefined)
  assert.equal(button.props['data-ciel-open-current'], '/work/src/a.ts')
  button.props.onClick({})
  assert.equal(mounted.actions.calls[0].address, 'dsh-resource://file/session/s1//work/src/a.ts')
  assert.doesNotMatch(mounted.actions.calls[0].address, /virtual/)
})

test('the compare button splits the pane and lands the file beside it; no split stays single-column', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = evidenceEntry()
  const snapshot = live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence })
  const splitCalls = []
  const mounted = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot,
    faceExtra: { splitPane: (paneId) => { splitCalls.push(paneId); return 'pane-2' } },
  })
  mounted.tree.find((element) => element.props['data-ciel-compare-current'] !== undefined).props.onClick({})
  assert.deepEqual(splitCalls, ['pane-1'], 'the split names the pane the tab is in')
  assert.deepEqual(mounted.actions.calls, [{
    address: 'dsh-resource://file/session/s1//work/src/a.ts',
    options: { paneId: 'pane-2', revealIfOpened: false, params: { line: 10 } },
  }])

  const single = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot,
    faceExtra: { splitPane: () => undefined },
  })
  single.tree.find((element) => element.props['data-ciel-compare-current'] !== undefined).props.onClick({})
  assert.deepEqual(single.actions.calls, [{
    address: 'dsh-resource://file/session/s1//work/src/a.ts',
    options: { params: { line: 10 } },
  }], 'no split keeps one column')

  const noFace = mountBody(harness, mock, CIEL_EVIDENCE, { snapshot })
  noFace.tree.find((element) => element.props['data-ciel-compare-current'] !== undefined).props.onClick({})
  assert.deepEqual(noFace.actions.calls, [{
    address: 'dsh-resource://file/session/s1//work/src/a.ts',
    options: { params: { line: 10 } },
  }])
})

test('reported author-tool evidence explains it is not an independent read', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const evidence = { ...evidenceEntry(), kind: 'reported', origin: 'author-tool', content: '', path: undefined, currentPath: undefined }
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, {
    snapshot: live(evidenceAddress('s1', 'r1', 'e1'), { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence }),
  })
  assert.match(tree.text, /作者报告/)
  assert.match(tree.text, /来源 author-tool/)
  assert.match(tree.text, /宿主未另行保存内容/)
  assert.match(tree.text, /不是本插件的独立读取或核实/)
  assert.equal(tree.find((element) => element.props['data-ciel-evidence-reported'] !== undefined).props['data-ciel-evidence-reported'], 'author-tool')
  assert.equal(tree.all((element) => element.props['data-ciel-line'] !== undefined).length, 0)
  assert.doesNotMatch(tree.text, /证据没有保存内容片段/)
})

test('a failed evidence resource shows the failure and no snippet', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const snapshot = {
    address: evidenceAddress('s1', 'r1', 'e1'),
    status: 'failed',
    value: { sessionId: 's1', reviewId: 'r1', evidenceId: 'e1', evidence: evidenceEntry() },
    failure: { code: 'ciel-sidebar/read-failed', message: '读取失败' },
  }
  const { tree } = mountBody(harness, mock, CIEL_EVIDENCE, { snapshot })
  assert.match(tree.text, /读取失败/)
  assert.doesNotMatch(tree.text, /line ten/)
  assert.equal(tree.all((element) => element.props['data-ciel-line'] !== undefined).length, 0)
})

// ── the advice body ──────────────────────────────────────────────────────

test('the advice body shows the reply, the parsed ideas, and the not-verification banner', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const advice = {
    callId: 'c1',
    kind: 'tool',
    text: '原始建议文本',
    items: [{ tier: 'high', title: '方向一', framing: '框架一', pitfalls: '陷阱一', verificationTarget: '验证一' }],
    issues: ['问题一'],
    modelUsage: { used: [{ provider: 'p', model: 'm' }] },
    createdAt: 0,
  }
  const { tree } = mountBody(harness, mock, CIEL_ADVICE, {
    snapshot: live(adviceAddress('s1', 'c1'), { sessionId: 's1', callId: 'c1', advice }),
  })
  assert.match(tree.text, /原始建议文本/)
  assert.match(tree.text, /方向一/)
  assert.match(tree.text, /框架一/)
  assert.match(tree.text, /陷阱一/)
  assert.match(tree.text, /验证一/)
  assert.match(tree.text, /问题一/)
  assert.match(tree.text, /不是核实过的证据/)
  assert.equal(tree.all((element) => element.props['data-ciel-advice-item'] !== undefined).length, 1)
  assert.ok(tree.find((element) => element.type === 'details' && element.props['data-ciel-advice-raw'] !== undefined), 'the raw reply sits behind one collapsed disclosure')
  assert.equal(tree.all((element) => element.props['data-ciel-advice-text'] !== undefined).length, 1, 'the raw reply appears once')
})

test('advice without parsed items shows its reply directly, with no disclosure', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const advice = { callId: 'c1', kind: 'command', text: '只有原始文本', items: [], issues: [], createdAt: 0 }
  const { tree } = mountBody(harness, mock, CIEL_ADVICE, {
    snapshot: live(adviceAddress('s1', 'c1'), { sessionId: 's1', callId: 'c1', advice }),
  })
  assert.match(tree.text, /只有原始文本/)
  assert.equal(tree.find((element) => element.type === 'details'), undefined)
  assert.equal(tree.all((element) => element.props['data-ciel-advice-text'] !== undefined).length, 1)
})

test('an empty advice record degrades to a notice', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const { tree } = mountBody(harness, mock, CIEL_ADVICE, {
    snapshot: live(adviceAddress('s1', 'c1'), { sessionId: 's1', callId: 'c1', advice: {} }),
  })
  assert.match(tree.text, /不是核实过的证据/)
  assert.equal(tree.all((element) => element.props['data-ciel-advice-item'] !== undefined).length, 0)
})

// ── chat-entry entry points ──────────────────────────────────────────────

test('openReview/openEvidence/openAdvice open the documented addresses with params', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  assert.deepEqual(sidebar.openReview('s1', 'r1', { annotationIndex: 2, evidenceId: 'e9' }), { ok: true, address: reviewAddress('s1', 'r1') })
  assert.deepEqual(sidebar.openEvidence('s1', 'r1', 'e1', { line: 3 }), { ok: true, address: evidenceAddress('s1', 'r1', 'e1') })
  assert.deepEqual(sidebar.openAdvice('s1', 'c1', { itemIndex: 1 }), { ok: true, address: adviceAddress('s1', 'c1') })
  assert.deepEqual(mock.sidebarCalls.map((entry) => entry.options), [
    { kind: CIEL_REVIEW, params: { annotationIndex: 2, evidenceId: 'e9' } },
    { kind: CIEL_EVIDENCE, params: { line: 3 } },
    { kind: CIEL_ADVICE, params: { itemIndex: 1 } },
  ])
})

test('openCurrentFile builds the native file address at the requested line', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext()
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  assert.deepEqual(sidebar.openCurrentFile('s1', '/work/src/a.ts', 12), { ok: true, address: 'dsh-resource://file/session/s1//work/src/a.ts' })
  assert.deepEqual(mock.sidebarCalls[0].options.params, { line: 12 })
  assert.equal(sidebar.openCurrentFile('s1', '', 1).ok, false)
  assert.equal(sidebar.openCurrentFile('s1', '/a.ts', 0).ok, true)
  assert.deepEqual(mock.sidebarCalls[1].options.params, undefined)
})

test('a native sidebar failure is reported, not thrown', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext({ sidebar: { openResource() { throw new Error('no session surface is mounted') } } })
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const result = sidebar.openReview('s1', 'r1')
  assert.equal(result.ok, false)
  assert.match(result.error, /no session surface/)
})

test('a missing sidebarRight service is reported, not thrown', () => {
  const harness = createRenderer()
  const sidebar = createSidebar(harness)
  const mock = createMockContext({ sidebar: null })
  sidebar.install(mock.ctx, { call: async () => ({ ok: true, review: {} }) })
  const result = sidebar.openAdvice('s1', 'c1')
  assert.equal(result.ok, false)
  assert.match(result.error, /sidebarRight service is unavailable/)
})

// ── stylesheet ───────────────────────────────────────────────────────────

test('the stylesheet is attribute-scoped, token-only, and never restyles native controls', () => {
  const css = readFileSync(new URL('../src/sidebar.css', import.meta.url), 'utf8')
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
  const selectors = []
  for (const block of cleaned.split('}')) {
    const brace = block.indexOf('{')
    if (brace < 0) continue
    const selector = block.slice(0, brace).trim()
    if (selector === '' || selector.startsWith('@')) continue
    selectors.push(selector)
  }
  assert.ok(selectors.length >= 30, 'the sheet carries the surface rules')
  for (const selector of selectors) {
    for (const part of selector.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
      assert.ok(part.startsWith('[data-ciel-'), 'every selector is scoped to the module: ' + part)
    }
  }
  for (const required of [
    '[data-ciel-review]', '[data-ciel-evidence]', '[data-ciel-advice]', '[data-ciel-state]',
    '[data-ciel-review-head]', '[data-ciel-review-summary]', '[data-ciel-review-privacy]',
    '[data-ciel-evidence-body]', '[data-ciel-line-number]', '[data-ciel-line-text]',
    '[data-ciel-evidence-withheld]', '[data-ciel-evidence-reported]',
    '[data-ciel-advice-items]', '[data-ciel-advice-raw]', '[data-ciel-review-actions]',
    '@media (max-width: 520px)',
  ]) {
    assert.ok(css.includes(required), 'missing ' + required)
  }
  assert.match(css, /var\(--dsw-alias-label-primary\)/)
  assert.match(css, /var\(--dsw-alias-border-l1\)/)
  assert.match(css, /white-space:\s*pre-wrap/)
  assert.match(css, /overflow-wrap:\s*anywhere/)
  assert.match(css, /min-width:\s*0/)
  assert.doesNotMatch(cleaned, /(^|[},])\s*(button|input|select|textarea|a)\s*[,{]/m, 'native controls keep their own styling')
  assert.ok(css.includes('[data-ciel-action]:focus-visible'))
  assert.ok(css.includes('outline: 2px solid var(--dsw-alias-state-business-primary)'))
  assert.ok(css.includes('[data-ciel-summary-head]'))
  assert.ok(css.includes('opacity: 1;'), 'modern summary headers must not fade their actions')
})
