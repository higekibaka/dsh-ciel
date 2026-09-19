#!/usr/bin/env node
// Real native sidebar integration for the Ciel sidebar module, in JSDOM.
//
// Every service under test is the target checkout's production implementation:
// the real Cordis Context, the real SlotRegistry/renderer (through
// dsh-client-test-runtime), the real ResourceRegistry, the real
// SidebarRightTabRegistry + SidebarRightController + RightbarSeat (ui-dockkit
// included), and the real React + Tag. Only the Host data RPC (`call`) and the
// frame's open/close report are fixtures. No server, no model request, no
// network, no DSH_HOME access.
//
// Run from the DSH checkout:
//   DSH_CHECKOUT=/path/to/dsh-checkout \
//   TSX_TSCONFIG_PATH=$DSH_CHECKOUT/tsconfig.base.client.json \
//   node --import tsx/esm /path/to/dsh-ciel/scripts/verify-sidebar-native.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required')
const cielRoot = fileURLToPath(new URL('..', import.meta.url))
const rootRequire = createRequire(join(checkout, 'package.json'))
const runtimeRequire = createRequire(join(checkout, 'packages/test-support/client-runtime/package.json'))

// ── the two test-only module stubs (vitest's expect/vi surface and CSS) ────
const VITEST_SHIM = `
export const expect = { addSnapshotSerializer() {} }
function makeFn(impl) {
  const fn = (...args) => (impl === undefined ? undefined : impl(...args))
  fn.mock = { calls: [], results: [] }
  fn.mockReturnValue = () => fn
  fn.mockResolvedValue = () => fn
  fn.mockImplementation = () => fn
  fn.mockClear = () => fn
  fn.mockReset = () => fn
  return fn
}
export const vi = { fn: makeFn, spyOn: () => makeFn(), restoreAllMocks() {}, clearAllMocks() {}, stubGlobal() {} }
export const afterEach = () => {}
export const beforeEach = () => {}
export const describe = () => {}
export const it = () => {}
export default { expect, vi, afterEach, beforeEach, describe, it }
`
const CSS_STUB = "const css = new Proxy({}, { get: (_, key) => typeof key === 'string' ? key : undefined }); export default css;"
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vitest') return { url: 'node:ciel-vitest-shim', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'node:ciel-vitest-shim') return { format: 'module', shortCircuit: true, source: VITEST_SHIM }
    if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: CSS_STUB }
    return nextLoad(url, context)
  },
})

// ── JSDOM globals (url gives localStorage; pretendToBeVisual gives rAF) ─────
const { JSDOM } = rootRequire('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const saved = new Map()
const GLOBALS = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'Text', 'Event', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'CustomEvent', 'NodeFilter']
for (const key of GLOBALS) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  const bound = ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
  const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : bound ? dom.window[key].bind(dom.window) : dom.window[key]
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true, configurable: true })
// The seat reads animation state on fullscreen paths; jsdom has no animations.
Object.defineProperty(dom.window.Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
// The room rule reads rectangles; jsdom lays out nothing. One width drives every
// pane/strip measurement so a scenario can say "two halves fit" or "they do not".
let roomWidth = 900
Object.defineProperty(dom.window.Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  writable: true,
  value() { return { x: 0, y: 0, width: roomWidth, height: 400, top: 0, left: 0, right: roomWidth, bottom: 400, toJSON() { return this } } },
})

// The real stylesheet, injected exactly as the plugin's client half will do:
// one <style> in the document, no module import.
const cssText = readFileSync(join(cielRoot, 'plugin/src/sidebar.css'), 'utf8')
const styleElement = dom.window.document.createElement('style')
styleElement.textContent = cssText
dom.window.document.head.appendChild(styleElement)

const originalFetch = globalThis.fetch
let networkRequests = 0
globalThis.fetch = async () => { networkRequests += 1; throw new Error('Network forbidden') }

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })
const results = []
const ok = (name, detail) => { results.push(detail === undefined ? { name } : { name, detail }) }

let hooksActive = true
const disposeHooks = () => { if (hooksActive) { hooksActive = false; hooks.deregister() } }

try {
  // ── real modules, loaded from the target checkout ────────────────────────
  const React = runtimeRequire('react')
  const { act, fireEvent } = runtimeRequire('@testing-library/react')
  const load = (relative) => import(pathToFileURL(join(checkout, relative)).href)
  const { SlotTestRuntime } = await load('packages/test-support/client-runtime/src/index.ts')
  const resourcesPlugin = await load('packages/client/resources/src/client/index.ts')
  const sidebarRightPlugin = await load('packages/client/ui-sidebar-right/src/client/index.ts')
  const { LocaleRuntime } = await load('packages/client/locale/src/client/index.ts')
  const { dockPaneIds } = await load('packages/client/ui-dockkit/src/index.ts')
  const { Tag } = await load('packages/client/ui-primitives/src/Tag.tsx')
  const { Button } = await load('packages/client/ui-primitives/src/Button.tsx')
  const { fileAddressFor, parseFileAddress } = await load('packages/util/workspace-path/src/index.ts')
  const { textDefinition } = await load('packages/client/ui-sidebar-documentpreview/src/client/definition.ts')
  const ciel = await import(pathToFileURL(join(cielRoot, 'plugin/src/sidebar.js')).href)

  // ── the only fixture: Host data RPC ──────────────────────────────────────
  const REVIEW_A = {
    reviewId: 'r-a', messageId: 'm-a', status: 'completed', verdict: 'changes', coverage: 'complete',
    summary: 'A 会话的评审摘要', createdAt: 0,
    annotations: [{ severity: 'blocker', title: 'A 批注', anchor: '锚点 A', comment: '评论 A', evidenceRefs: ['e-src'] }],
  }
  const REVIEW_B = {
    reviewId: 'r-b', messageId: 'm-b', status: 'sound', verdict: 'pass', coverage: 'complete',
    summary: 'B 会话的评审摘要', createdAt: 0, annotations: [],
  }
  const REVIEW_TRIAGE = {
    reviewId: 'r-triage', messageId: 'm-triage', status: 'completed', verdict: 'changes', coverage: 'complete',
    summary: '分诊恢复', createdAt: 0,
    triage: { states: { 0: 'accept' } },
    annotations: [
      { severity: 'blocker', title: '分诊批注', comment: '评论' },
      { severity: 'nit', title: '第二条批注', comment: '评论二' },
    ],
  }
  const EVIDENCE = {
    'e-src': { id: 'e-src', kind: 'source', path: 'src/a.ts', startLine: 10, endLine: 12, content: 'line ten\nline eleven\nline twelve', contentSha256: 'abcdef0123456789', capturedAt: 0, tool: 'read', truncated: false, status: 'available', currentPath: '/work/src/a.ts' },
    'e-external': { id: 'e-external', kind: 'source', path: '/external-1/notes.md', currentPath: '/external/notes #?.md', startLine: 3, content: 'historical external note', status: 'available' },
    'e-withheld': { id: 'e-withheld', kind: 'source', path: 'src/secret.ts', startLine: 1, endLine: 1, content: 'SECRET-SNIPPET', capturedAt: 0, tool: 'read', status: 'withheld' },
    'e-report': { id: 'e-report', kind: 'reported', origin: 'author-tool', content: '', path: '/project/virtual/src/a.ts', capturedAt: 0, tool: 'read', status: 'available' },
    'e-virtual': { id: 'e-virtual', kind: 'source', path: '/project/virtual/src/a.ts', startLine: 4, endLine: 4, content: 'virtual body', capturedAt: 0, tool: 'read', status: 'available' },
  }
  const ADVICE = {
    'c-a': { callId: 'c-a', kind: 'tool', text: '顾问原始文本', items: [{ tier: 'high', title: '方向一', framing: '框架', pitfalls: '陷阱', verificationTarget: '验证' }], issues: ['问题一'], modelUsage: { used: [{ provider: 'fixture', model: 'fixed' }] }, createdAt: 0 },
  }
  function createFixture() {
    const calls = []
    const call = async (method, request) => {
      calls.push({ method, request })
      if (method === 'readReview') {
        if (request.reviewId === 'r-fail') return { ok: false, error: 'fixture review failed' }
        if (request.sessionId === 's-a' && request.reviewId === 'r-a') return { ok: true, review: REVIEW_A }
        if (request.sessionId === 's-a' && request.reviewId === 'r-triage') return { ok: true, review: REVIEW_TRIAGE }
        if (request.sessionId === 's-b' && request.reviewId === 'r-b') return { ok: true, review: REVIEW_B }
        return { ok: false, error: 'fixture review not found' }
      }
      if (method === 'readEvidence') {
        const evidence = EVIDENCE[request.evidenceId]
        return evidence === undefined ? { ok: false, error: 'fixture evidence not found' } : { ok: true, evidence }
      }
      if (method === 'readAdvice') {
        const advice = ADVICE[request.callId]
        return advice === undefined ? { ok: false, error: 'fixture advice not found' } : { ok: true, advice }
      }
      return { ok: false, error: 'unknown method ' + method }
    }
    return { call, calls }
  }

  // ── boot: real context + real resources + real sidebar-right + module ────
  async function boot({ sessions = ['s-a'], width = 900 } = {}) {
    roomWidth = width
    const runtime = await SlotTestRuntime.create()
    const frame = { openRightbar() {}, closeRightbar() {} }
    runtime.ctx.provide('layout', frame)
    await runtime.mount({ inject: [...resourcesPlugin.inject], apply: resourcesPlugin.apply })
    assert.ok(runtime.ctx.resources, 'real ctx.resources is provided')
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.declare({
      'rightbar': { kind: 'single', scope: 'root' },
      'conversation.session.header.corner': { kind: 'single', scope: 'session' },
    })
    // alpha.2 selects the main view through retention, not a mutable `current`.
    // Keep the other open sessions alive while switching the visible seat.
    const references = new Map()
    for (const id of sessions) {
      await runtime.sessions.add({ id })
      references.set(id, runtime.sessions.retainFor(runtime.ctx, id, { source: 'ciel-fixture' }))
    }
    let mainView = runtime.sessions.retainFor(runtime.ctx, sessions[0], { source: 'mainView' })
    const selectSession = async (id) => {
      await act(async () => {
        const next = runtime.sessions.retainFor(runtime.ctx, id, { source: 'mainView' })
        mainView.release()
        mainView = next
      })
    }
    const feature = await runtime.mount({ inject: [...sidebarRightPlugin.inject], apply: sidebarRightPlugin.apply })
    assert.ok(runtime.ctx.sidebarRightTabs, 'real ctx.sidebarRightTabs is provided')

    const fixture = createFixture()
    const prepareCalls = []
    const triageCalls = []
    const sidebar = ciel.createCielSidebar({
      React,
      Tag,
      Button,
      fileAddressFor: (sessionId, path) => fileAddressFor(sessionId, '/work', path),
    })
    const uninstall = sidebar.install(runtime.ctx, {
      call: fixture.call,
      onPrepareFeedback: async (request) => { prepareCalls.push(request); return { ok: true, count: request.items.length } },
      onTriage: async (request) => { triageCalls.push(request); return { ok: true } },
    })
    // The native viewer a file address resolves to; a fixture type + body, not a
    // mocked service. It reports the address and the navigation line it received.
    runtime.ctx.sidebarRightTabs.register({ ...textDefinition(), id: 'fixture/file', kind: 'file', priority: 'builtin' })
    function FileBody(props) {
      const info = props.useTabInfo()
      const params = info.tab.navigation.params
      return React.createElement('span', {
        'data-fixture-file': '',
        'data-address': info.tab.contentId,
        'data-line': params !== undefined && params !== null && params.line !== undefined ? String(params.line) : '',
      })
    }
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'fixture/file' }, FileBody)
    sessionReferences.set(runtime, references)
    return { runtime, feature, sidebar, uninstall, fixture, prepareCalls, triageCalls, selectSession, session: sessions[0] }
  }

  const open = async (runtime, address, options) => {
    await act(async () => { runtime.ctx.sidebarRight.openResource(address, options) })
    await act(async () => { await settle() })
  }
  const flush = async () => { await act(async () => { await settle() }) }
  const sessionReferences = new WeakMap()
  const layoutOf = (runtime, session) => runtime.storeOf('rightbar.session', sessionReferences.get(runtime).get(session)).getSnapshot().bySession[session].layout
  const countCalls = (fixture, method, predicate) => fixture.calls.filter((entry) => entry.method === method && (predicate === undefined || predicate(entry.request))).length

  // ═══ scenario 1: wide room, full native flow ═════════════════════════════
  {
    const h = await boot({ sessions: ['s-a', 's-b'], width: 900 })
    try {
      const view = h.runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
      assert.ok(view.container.querySelector('[data-sidebar-right-panel]'), 'the real RightbarSeat rendered')

      // 1. slot inject reaches the body, and useTabInfo/useResource are assembled.
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-a'), { kind: 'ciel-review' })
      const root = view.container.querySelector('[data-ciel-review]')
      assert.ok(root, 'the review body rendered through the real slot framework')
      assert.equal(root.getAttribute('data-ciel-review'), 'r-a')
      assert.match(view.container.textContent, /A 会话的评审摘要/)
      assert.match(view.container.textContent, /A 批注/)
      assert.equal(countCalls(h.fixture, 'readReview', (request) => request.sessionId === 's-a' && request.reviewId === 'r-a'), 1, 'the real resource provider read once through the fixture RPC')
      assert.equal(dom.window.getComputedStyle(root).display, 'flex', 'the injected stylesheet lays the review surface out')
      ok('slot inject + hook assembly', { body: true, useTabInfo: true, useResource: true })

      const beforeMain = layoutOf(h.runtime, 's-a')
      await act(async () => { h.runtime.panelInfo.set({ activePanelId: 'fixture-global-panel' }) })
      assert.equal(view.container.querySelector('[data-sidebar-right-panel]'), null, 'a global main panel hides Session sidebar content')
      assert.equal(h.runtime.ctx.resources.source(ciel.reviewAddress('s-a', 'r-a')).getSnapshot().status, 'live', 'hiding the root keeps tab-owned resources pinned')
      await act(async () => { h.runtime.panelInfo.set({ activePanelId: null }) })
      await flush()
      assert.ok(view.container.querySelector('[data-ciel-review]'), 'returning to Conversation restores the review')
      assert.equal(layoutOf(h.runtime, 's-a'), beforeMain, 'main-panel switches retain the Session layout')
      assert.equal(countCalls(h.fixture, 'readReview', request => request.reviewId === 'r-a'), 1, 'no re-read on main-panel remount')
      ok('root main-panel switch retains Session sidebar and resource pin')

      // 2. navigation through the real tab domain re-renders and focuses.
      const tabA = h.runtime.ctx.sidebarRight.active()
      await act(async () => { h.runtime.ctx.sidebarRight.tabDomain.navigate('s-a', tabA.id, { address: tabA.contentId, params: { annotationIndex: 0 } }) })
      const focused = view.container.querySelector('[data-ciel-focus]')
      assert.ok(focused, 'navigation.params.annotationIndex reached the body through useTabInfo')
      assert.equal(focused.getAttribute('data-ciel-annotation'), '0')
      assert.equal(view.container.querySelector('[data-ciel-review]').getAttribute('data-ciel-focus-index'), '0')
      assert.equal(view.container.querySelector('[data-ciel-review]').getAttribute('data-ciel-revision'), '2')
      ok('useTabInfo navigation subscription')

      // 3. the injected prepareFeedback callback is the one the body calls.
      await act(async () => { fireEvent.click(view.container.querySelector('[data-ciel-select="0"]')) })
      await act(async () => { fireEvent.click(view.container.querySelector('[data-ciel-submit]')); await settle() })
      assert.deepEqual(h.prepareCalls, [{ sessionId: 's-a', reviewId: 'r-a', messageId: 'm-a', items: [{ index: 0 }] }], 'inject face reached the body and the request is the review session')
      assert.match(view.container.textContent, /已填入输入框/)
      ok('injected prepareFeedback reaches the body')

      // 3b. Host triage restores the boxes, and a click saves by exact sid/rid.
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-triage'), { kind: 'ciel-review' })
      const triageBox = view.container.querySelector('[data-ciel-select="0"]')
      assert.ok(triageBox, 'the triage review body rendered its annotation')
      assert.equal(triageBox.checked, true, 'Host triage state accept restored the checkbox')
      assert.equal(view.container.querySelector('[data-ciel-select="1"]').checked, false, 'an absent index starts unchecked, never all-selected')
      assert.match(view.container.textContent, /已选 1 条/)
      await act(async () => { fireEvent.click(triageBox); await settle() })
      assert.deepEqual(h.triageCalls[0], {
        sessionId: 's-a',
        reviewId: 'r-a',
        changes: [{ index: 0, state: 'accept' }],
        indices: [0],
      }, 'the earlier prepare-feedback selection also saved triage for its own review')
      assert.deepEqual(h.triageCalls[h.triageCalls.length - 1], {
        sessionId: 's-a',
        reviewId: 'r-triage',
        changes: [{ index: 0, state: 'dismiss' }],
        indices: [],
      }, 'the triage save carries the exact sid/rid/index')
      assert.equal(view.container.querySelector('[data-ciel-select="0"]').checked, false)
      assert.match(view.container.textContent, /勾选只用于回传，不代表问题成立/)
      ok('triage restore and save', { restored: 'accept', saved: 'dismiss' })

      // 3c. a real remount: switch to another tab and back. The review resource
      // stays pinned to its first frame (triage accept), yet the local dismiss
      // must survive the body's unmount and remount.
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-a'), { kind: 'ciel-review' })
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-triage'), { kind: 'ciel-review' })
      const remounted = view.container.querySelector('[data-ciel-select="0"]')
      assert.ok(remounted, 'the triage review body remounted')
      assert.equal(remounted.checked, false, 'the local dismiss survived a real remount')
      assert.equal(view.container.querySelector('[data-ciel-select="1"]').checked, false)
      assert.match(view.container.textContent, /已选 0 条/)
      assert.equal(h.runtime.ctx.resources.source(ciel.reviewAddress('s-a', 'r-triage')).getSnapshot().status, 'live', 'the record stayed pinned and was not re-read')
      assert.equal(countCalls(h.fixture, 'readReview', (request) => request.reviewId === 'r-triage'), 1, 'no re-read of the pinned record')
      ok('triage survives a real remount', { pinned: true, checked: false, reRead: false })

      // 4. a failed read shows the failure and never a stale value.
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-fail'), { kind: 'ciel-review' })
      const failedPanel = view.container.querySelector('[data-ciel-state="failed"]')
      assert.ok(failedPanel, 'the failed body renders the failure panel')
      assert.match(view.container.textContent, /fixture review failed/)
      assert.equal(view.container.querySelector('[data-ciel-review]'), null, 'no review content under a failure')
      const failedSnapshot = h.runtime.ctx.resources.source(ciel.reviewAddress('s-a', 'r-fail')).getSnapshot()
      assert.equal(failedSnapshot.status, 'failed')
      assert.equal(failedSnapshot.value, undefined, 'the real registry holds no last value for a failed first read')
      ok('failed read: failure panel, no stale value')

      // 5. session isolation: the address, not the current session, is authority.
      await h.selectSession('s-b')
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-a'), { kind: 'ciel-review' })
      const cross = view.container.querySelector('[data-ciel-review="r-a"]')
      assert.ok(cross, "session A's review renders while the current session is B")
      assert.match(view.container.textContent, /A 会话的评审摘要/)
      assert.equal(countCalls(h.fixture, 'readReview', (request) => request.reviewId === 'r-a' && request.sessionId === 's-a') >= 1, true, 'the read carried the address session')
      assert.equal(h.fixture.calls.some((entry) => entry.method === 'readReview' && entry.request.sessionId === 's-b' && entry.request.reviewId === 'r-a'), false, 'no read was issued under the current session')
      await h.selectSession('s-a')
      ok('session isolation', { addressSession: 's-a', currentSession: 's-b' })

      // 6. per-occurrence pinning: the cross-session tab opened in step 5 still
      // holds the address after session A's own tab closes; the last close
      // releases the record, and reopening reads again.
      const beforeClose = countCalls(h.fixture, 'readReview', (request) => request.reviewId === 'r-a')
      const reviewAddress = ciel.reviewAddress('s-a', 'r-a')
      const findTab = (session) => Object.values(layoutOf(h.runtime, session).tabs).find((tab) => tab.contentId === reviewAddress)
      const liveTab = findTab('s-a')
      assert.ok(liveTab, "session A's review tab is still open")
      assert.equal(h.runtime.ctx.resources.source(reviewAddress).getSnapshot().status, 'live')
      await act(async () => { h.runtime.ctx.sidebarRight.close(liveTab.id) })
      await flush()
      assert.equal(h.runtime.ctx.resources.source(reviewAddress).getSnapshot().status, 'live', "session B's occurrence still pins the address")
      await h.selectSession('s-b')
      const otherTab = findTab('s-b')
      assert.ok(otherTab, "session B's cross-session tab is still open")
      await act(async () => { h.runtime.ctx.sidebarRight.close(otherTab.id) })
      await flush()
      const released = h.runtime.ctx.resources.source(reviewAddress).getSnapshot()
      assert.notEqual(released.status, 'live', 'the last close released the resource')
      assert.equal(released.value, undefined)
      await h.selectSession('s-a')
      await open(h.runtime, reviewAddress, { kind: 'ciel-review' })
      assert.equal(countCalls(h.fixture, 'readReview', (request) => request.reviewId === 'r-a'), beforeClose + 1, 'reopening reads again')
      ok('per-occurrence pinning and release', { heldWhileOtherTabOpen: true, releasedOnLastClose: true })

      // 7. evidence: source lines, withheld content, reported author-tool.
      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-src'), { kind: 'ciel-evidence' })
      assert.match(view.container.textContent, /line eleven/)
      assert.deepEqual([...view.container.querySelectorAll('[data-ciel-line]')].map((node) => node.getAttribute('data-ciel-line')), ['10', '11', '12'])
      assert.ok(view.container.querySelector('[data-ciel-open-current]'), 'a trusted currentPath offers the current-file button')
      assert.equal(dom.window.getComputedStyle(view.container.querySelector('[data-ciel-evidence]')).display, 'flex')
      assert.equal(dom.window.getComputedStyle(view.container.querySelector('[data-ciel-line-text]')).whiteSpace, 'pre-wrap', 'long code lines wrap instead of scrolling sideways')
      assert.equal(dom.window.getComputedStyle(view.container.querySelector('[data-ciel-line-number]')).textAlign, 'right')
      assert.equal(dom.window.getComputedStyle(view.container.querySelector('[data-ciel-evidence-body]')).overflow, 'auto')
      ok('evidence source lines')

      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-withheld'), { kind: 'ciel-evidence' })
      assert.ok(view.container.querySelector('[data-ciel-evidence-withheld]'))
      assert.doesNotMatch(view.container.textContent, /SECRET-SNIPPET/)
      assert.equal(view.container.querySelectorAll('[data-ciel-line]').length, 0)
      ok('withheld evidence hides content')

      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-report'), { kind: 'ciel-evidence' })
      assert.ok(view.container.querySelector('[data-ciel-evidence-reported]'), 'reported author-tool evidence is labelled')
      assert.match(view.container.textContent, /作者报告/)
      assert.match(view.container.textContent, /宿主未另行保存内容/)
      assert.match(view.container.textContent, /不是本插件的独立读取或核实/)
      assert.equal(view.container.querySelectorAll('[data-ciel-line]').length, 0)
      ok('reported author-tool evidence', { kind: 'reported', origin: 'author-tool' })

      // 8. the current-file button never falls back to a virtual path.
      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-virtual'), { kind: 'ciel-evidence' })
      assert.match(view.container.textContent, /\/project\/virtual\/src\/a\.ts/, 'the recorded virtual path is displayed')
      assert.equal(view.container.querySelector('[data-ciel-open-current]'), null, 'no current-file button without a Host currentPath')
      assert.equal(view.container.querySelector('[data-fixture-file]'), null, 'no file tab opened from a virtual path')
      ok('currentPath-only current-file button')

      // 9. an explicit click opens the live file through the native viewer.
      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-src'), { kind: 'ciel-evidence' })
      await act(async () => { fireEvent.click(view.container.querySelector('[data-ciel-open-current]')) })
      await flush()
      const fileBody = view.container.querySelector('[data-fixture-file]')
      assert.ok(fileBody, 'the native file viewer opened')
      assert.equal(fileBody.getAttribute('data-address'), 'dsh-resource://file/session/s-a/src/a.ts')
      assert.equal(fileBody.getAttribute('data-line'), '10', 'params.line reached the native viewer')
      ok('explicit current-file open', { address: fileBody.getAttribute('data-address'), line: 10 })

      assert.equal(textDefinition().canOpen('dsh-resource://file/absolute/external/notes.md'), false, 'the real alpha.2 viewer refuses the legacy address')
      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-external'), { kind: 'ciel-evidence' })
      assert.match(view.container.querySelector('[data-ciel-current-line-hint]').textContent, /Markdown 渲染视图请切换/)
      await act(async () => { fireEvent.click(view.container.querySelector('[data-ciel-open-current]')) })
      await flush()
      const external = view.container.querySelector('[data-fixture-file]')
      assert.ok(external, 'the native alpha.2 claim accepts a Session-owned external file')
      assert.deepEqual(parseFileAddress(external.getAttribute('data-address')), { scope: 'session', sessionId: 's-a', path: '/external/notes #?.md' })
      assert.equal(external.getAttribute('data-line'), '3')
      ok('external source address and Markdown line guidance')

      // 9b. the explicit compare gesture: the native Button primitive renders
      // the control, the native split opens a second pane, and the file lands
      // beside the evidence (a new tab even though the file is already open).
      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-src'), { kind: 'ciel-evidence' })
      const compareButton = view.container.querySelector('[data-ciel-compare-current]')
      assert.ok(compareButton, 'the compare control renders')
      assert.match(compareButton.getAttribute('class') || '', /primary/, 'the native Button primitive rendered the compare control')
      await act(async () => { fireEvent.click(compareButton); await settle() })
      await flush()
      const paneIds = [...view.container.querySelectorAll('[data-dockkit-pane]')].map((node) => node.getAttribute('data-dockkit-pane'))
      assert.equal(paneIds.length, 2, 'the compare gesture split the column')
      const rightPane = paneIds[paneIds.length - 1]
      const beside = [...view.container.querySelectorAll('[data-fixture-file]')].find((node) => {
        const pane = node.closest('[data-dockkit-pane]')
        return pane !== null && pane.getAttribute('data-dockkit-pane') === rightPane
      })
      assert.ok(beside, 'the file opened in the new pane beside the evidence')
      assert.equal(beside.getAttribute('data-line'), '10', 'the compare tab carries the snippet line')
      ok('explicit compare split', { panes: 2, pane: rightPane, line: 10 })

      // 10. advice body: ideas, not verification.
      await open(h.runtime, ciel.adviceAddress('s-a', 'c-a'), { kind: 'ciel-advice' })
      assert.ok(view.container.querySelector('[data-ciel-advice]'))
      assert.match(view.container.textContent, /顾问原始文本/)
      assert.match(view.container.textContent, /方向一/)
      assert.match(view.container.textContent, /不是核实过的证据/)
      ok('advice body disclaimer')

      // 11. the split gesture opened two panes; at capacity the native control
      // hides and the API refuses another split.
      assert.equal(dockPaneIds(layoutOf(h.runtime, 's-a')).length, 2)
      assert.equal(view.container.querySelectorAll('[data-dockkit-split-button]').length, 0, 'the split control hides at two panes')
      let extraPane
      await act(async () => { extraPane = h.runtime.ctx.sidebarRight.split() })
      assert.equal(extraPane, undefined, 'a full column refuses another split')
      ok('split capacity', { panes: 2, refused: true })

      // 12. dispose removes types, providers, and bodies; it is idempotent.
      // An open ciel tab first, so the seat's unavailable-kind path is visible.
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-a'), { kind: 'ciel-review' })
      await act(async () => { h.sidebar.dispose(); h.sidebar.dispose(); await settle() })
      assert.equal(h.runtime.ctx.sidebarRightTabs.get('ciel-review'), undefined)
      assert.equal(h.runtime.ctx.sidebarRightTabs.get('ciel-evidence'), undefined)
      assert.equal(h.runtime.ctx.sidebarRightTabs.get('ciel-advice'), undefined)
      assert.equal(h.runtime.ctx.resources.source(ciel.reviewAddress('s-a', 'r-after-dispose')).getSnapshot().status, 'none', 'no provider remains after dispose')
      assert.ok(view.container.querySelector('[data-sidebar-right-unavailable]'), 'the open tab now reports an unavailable kind')
      assert.deepEqual(h.sidebar.openReview('s-a', 'r-a'), { ok: false, error: 'dsh-ciel sidebar is disposed' })
      assert.throws(() => h.sidebar.install(h.runtime.ctx, { call: h.fixture.call }), /disposed/)
      ok('dispose idempotent and complete')
    } finally {
      await h.runtime.dispose()
    }
  }

  // ═══ scenario 2: insufficient room keeps the native split single-column ═══
  {
    const h = await boot({ sessions: ['s-a'], width: 100 })
    try {
      const view = h.runtime.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true })
      await open(h.runtime, ciel.reviewAddress('s-a', 'r-a'), { kind: 'ciel-review' })
      const split = view.container.querySelector('[data-dockkit-split-button]')
      assert.equal(split, null, 'alpha.2 hides the native split control when halves do not fit')
      let paneId
      await act(async () => { paneId = h.runtime.ctx.sidebarRight.split() })
      assert.equal(paneId, undefined, 'the explicit split refuses')
      assert.equal(dockPaneIds(layoutOf(h.runtime, 's-a')).length, 1, 'the column stays single')
      // The same explicit gesture with no room: the split is refused and the
      // file opens as a tab in the one column.
      await open(h.runtime, ciel.evidenceAddress('s-a', 'r-a', 'e-src'), { kind: 'ciel-evidence' })
      await act(async () => { fireEvent.click(view.container.querySelector('[data-ciel-compare-current]')); await settle() })
      await flush()
      assert.equal(dockPaneIds(layoutOf(h.runtime, 's-a')).length, 1, 'no room keeps one column')
      const singleFile = view.container.querySelector('[data-fixture-file]')
      assert.ok(singleFile, 'the file still opens in the single column')
      assert.equal(singleFile.getAttribute('data-line'), '10')
      ok('compare without room', { panes: 1, line: 10 })
      ok('native split insufficient room', { panes: 1, hidden: true, refused: true })
    } finally {
      await h.runtime.dispose()
    }
  }

  assert.equal(networkRequests, 0, 'no network request was made')
  console.log(JSON.stringify({ passed: true, checks: results.length, results, networkRequests }, null, 1))
} finally {
  globalThis.fetch = originalFetch
  disposeHooks()
  dom.window.close()
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
}
