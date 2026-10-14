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
  const { Tag } = await load('packages/client/ui-primitives/src/Tag.tsx')
  const ciel = await import(pathToFileURL(join(cielRoot, 'plugin/src/sidebar.js')).href)

  // ── the only fixture: Host data RPC ──────────────────────────────────────
  const ADVICE = { callId: 'tool:c-a', sessionId: 's-a', kind: 'tool', text: '顾问原始文本', items: [{tier:'high',title:'方向一',framing:'框架',pitfalls:'陷阱',verificationTarget:'验证'}], issues: [], modelUsage:{used:[{provider:'fixture',model:'fixed'}]}, createdAt:0 }
  function createFixture() {
    const calls = []
    return { calls, async call(method, request) {
      calls.push({method,request})
      assert.equal(method, 'readAdvice')
      return request.sessionId === 's-a' && request.callId === 'tool:c-a' ? {ok:true,advice:ADVICE} : {ok:false,error:'fixture advice missing'}
    } }
  }

  // ── boot: real context + real resources + real sidebar-right + module ────
  async function boot({ sessions = ['s-a'], width = 900 } = {}) {
    roomWidth = width
    const runtime = await SlotTestRuntime.create()
    const panelInfo = { activePanelId: null }
    const frame = { openRightbar() {}, closeRightbar() {}, panelInfo: { getSnapshot: () => panelInfo, subscribe: () => () => {} } }
    runtime.ctx.provide('layout', frame)
    await runtime.mount({ inject: [...resourcesPlugin.inject], apply: resourcesPlugin.apply })
    assert.ok(runtime.ctx.resources, 'real ctx.resources is provided')
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    if (sidebarRightPlugin.inject.includes('shortcuts')) {
      const { default: ShortcutsService } = await load('packages/client/shortcuts/src/client/index.ts')
      await runtime.mount({ inject: ['locale'], apply(ctx) { new ShortcutsService(ctx) } })
    }
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
    const sidebar = ciel.createCielSidebar({ React, Tag })
    const uninstall = sidebar.install(runtime.ctx, {call:fixture.call})
    sessionReferences.set(runtime, references)
    return { runtime, feature, sidebar, uninstall, fixture, selectSession, session: sessions[0] }
  }

  const visible = view => view.container.querySelector('[data-sidebar-right-session]:not([hidden])') || view.container
  const open = async (runtime, address, options) => {
    await act(async () => { runtime.ctx.sidebarRight.openResource(address, options) })
    await act(async () => { await settle() })
  }
  const flush = async () => { await act(async () => { await settle() }) }
  const sessionReferences = new WeakMap()
  const layoutOf = (runtime, session) => runtime.storeOf('rightbar.session', sessionReferences.get(runtime).get(session)).getSnapshot().bySession[session].layout
  const countCalls = (fixture, method, predicate) => fixture.calls.filter((entry) => entry.method === method && (predicate === undefined || predicate(entry.request))).length

  const h = await boot({sessions:['s-a','s-b']})
  try {
    const view = h.runtime.renderSlot('rightbar', {width:420, viewportWidth:1440, canShow:true})
    const address = ciel.adviceAddress('s-a','tool:c-a')
    await open(h.runtime,address,{kind:'ciel-advice'})
    assert.ok(visible(view).querySelector('[data-ciel-advice]'))
    assert.match(visible(view).textContent,/顾问原始文本/)
    assert.match(visible(view).textContent,/方向一/)
    assert.match(visible(view).textContent,/不是核实过的证据/)
    assert.equal(h.fixture.calls.length,1)
    ok('native resources and advice body render without model execution')
    await h.selectSession('s-b')
    await open(h.runtime,address,{kind:'ciel-advice'})
    assert.match(visible(view).textContent,/方向一/)
    assert.ok(h.fixture.calls.every(entry=>entry.request.sessionId==='s-a'))
    ok('address owns session identity across current-session changes')
    await open(h.runtime,ciel.adviceAddress('s-a','missing'),{kind:'ciel-advice'})
    assert.ok(visible(view).querySelector('[data-ciel-state="failed"]'))
    assert.equal(visible(view).querySelector('[data-ciel-advice]'),null)
    ok('failed resource never shows stale advice')
    await open(h.runtime,address,{kind:'ciel-advice'})
    await act(async()=>{h.sidebar.dispose();h.sidebar.dispose();await settle()})
    assert.equal(h.runtime.ctx.sidebarRightTabs.get('ciel-advice'),undefined)
    assert.equal(h.runtime.ctx.resources.source(ciel.adviceAddress('s-a','after')).getSnapshot().status,'none')
    assert.equal(h.sidebar.openAdvice('s-a','tool:c-a').ok,false)
    ok('disposal releases resource provider, tab and body')
  } finally { await h.runtime.dispose() }
  assert.equal(networkRequests,0)
  console.log(JSON.stringify({passed:true,results,networkRequests},null,1))
} finally {
  globalThis.fetch = originalFetch
  disposeHooks()
  dom.window.close()
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
}
