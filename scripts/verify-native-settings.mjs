#!/usr/bin/env node
// Real DSH SettingsRoot + native Switch/Tag + real Ciel client, in JSDOM.
// Only settings/RPC data are fixtures. CSS Modules are compiled from the real
// stylesheets; no native component implementation or CSS is copied here.
// Run from DSH checkout:
// DSH_CHECKOUT=$PWD TSX_TSCONFIG_PATH=$PWD/tsconfig.base.client.json node --import tsx/esm /path/to/dsh-ciel/scripts/verify-native-settings.mjs
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { loadClientFactory } from '../plugin/test/review-ui.harness.js'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required')
const rootRequire = createRequire(join(checkout, 'package.json'))
const webRequire = createRequire(join(checkout, 'apps/web/package.json'))
const { JSDOM } = rootRequire('jsdom')
const { transform } = rootRequire('lightningcss')
const dom = new JSDOM('<!doctype html><html><head></head><body><main id="settings-fixture"></main><main id="review-fixture"></main></body></html>', { pretendToBeVisual: true })
const doc = dom.window.document
const saved = new Map()
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'Text', 'Event', 'KeyboardEvent', 'InputEvent', 'NodeFilter', 'IS_REACT_ACT_ENVIRONMENT']) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  const value = key === 'IS_REACT_ACT_ENVIRONMENT' ? true : ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key]
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
const styles = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.css')) return nextLoad(url, context)
  const result = transform({ filename: fileURLToPath(url), code: readFileSync(new URL(url)), cssModules: url.endsWith('.module.css') })
  const map = Object.fromEntries(Object.entries(result.exports || {}).map(([name, value]) => [name, value.name]))
  return { format: 'module', shortCircuit: true, source: `const style=document.createElement('style');style.textContent=${JSON.stringify(result.code.toString())};document.head.appendChild(style);export default ${JSON.stringify(map)};` }
} })
const originalFetch = globalThis.fetch, originalError = console.error
let network = 0, modelCalls = 0
const warnings = []
const cleanups = [], roots = []
let React, act
try {
  globalThis.fetch = async () => { network++; throw new Error('Network forbidden') }
  console.error = (...args) => { warnings.push(args.map(String).join(' ')); originalError(...args) }
  React = webRequire('react')
  const ReactDOM = webRequire('react-dom')
  const { createRoot } = webRequire('react-dom/client')
  act = React.act || webRequire('react-dom/test-utils').act
  const h = React.createElement
  const load = relative => import(pathToFileURL(join(checkout, relative)).href)
  const [{ Switch }, { Tag }, { SettingsRoot }] = await Promise.all([
    load('packages/client/ui-primitives/src/Switch.tsx'),
    load('packages/client/ui-primitives/src/Tag.tsx'),
    load('packages/client/ui-settings-general/src/client/SettingsRoot.tsx'),
  ])
  const plugin = loadClientFactory(doc).factory(React, { 'react-dom': ReactDOM, '@deepseek-ai/dsh-client-ui-primitives': { Switch, Tag } })
  let value = { ...plugin.__test.defaults, criticExploreBudget: 20, criticMaxRequests: 32 }, user = {}, revision = 0
  const scopeListeners = new Set(), writes = [], registrations = []
  const remote = { $mount: async () => {}, $on: () => () => {} }
  const rpc = {
    list: async () => ({ ok: true, value: { reviews: [], sentKeys: [], triage: {} } }),
    progress: async () => ({ ok: true, value: { inFlight: false } }),
    start: async () => { modelCalls++; throw new Error('Review must not start') },
    feedback: async () => { modelCalls++; throw new Error('Automatic feedback must not run') },
  }
  const ctx = {
    settingsScope: { bind(spec) { assert.equal(spec.namespace, 'ciel'); return {
      getSnapshot: () => ({ status: 'ready', mode: 'host', writable: true, value, user, revision }),
      subscribe(fn) { scopeListeners.add(fn); return () => scopeListeners.delete(fn) },
      async mutate(ops, expected) {
        assert.equal(expected, revision)
        writes.push(ops)
        value = { ...value }; user = { ...user }
        for (const op of ops) {
          const key = op.path[0]
          if (op.op === 'set') { value[key] = op.value; user[key] = op.value }
          else { value[key] = plugin.__test.defaults[key]; delete user[key] }
        }
        revision++
        for (const fn of scopeListeners) fn()
      },
    } } },
    get(name) {
      if (name === 'remote') return remote
      if (name === 'remote.advisorReview') return rpc
      if (name === 'remote.session') return { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
    },
    on() { return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off },
    slots: {
      inject(_name, fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off); return off },
      register(def, component) { const record = { def, component }; registrations.push(record); return () => { const index = registrations.indexOf(record); if (index >= 0) registrations.splice(index, 1) } },
    },
  }
  await act(async () => { plugin.apply(ctx) })
  const section = registrations.find(r => r.def.name === 'settings.section' && r.def.id === 'ciel')
  assert.ok(section)
  assert.ok(!registrations.some(r => r.def.name === 'settings.plugin.item'))
  const rows = [{ id: 'general', label: '通用设置', order: 0 }, { id: 'models', label: '模型', order: 10 }, { id: 'plugins', label: '插件', order: 15 }, { id: 'agent-presets', label: 'Agent 预设', order: 20 }, { id: section.def.id, label: section.def.label(), order: section.def.order }].sort((a, b) => a.order - b.order)
  const shellProps = {
    wide: true, reconnect() {}, t: key => key,
    useSections: select => select(rows), useConnectionState: select => select('connected'), useOnboardingSteps: select => select([]),
    useSessions: select => select({ phase: 'ready', current: 'fixture', byId: { fixture: { blank: false } } }),
    renderSlot(name, owner, options) {
      if (name === 'settings.trigger' || name === 'settings.header') return '设置'
      if (name === 'settings.close') return '关闭设置'
      if (name === 'settings.section') return options.only === 'ciel' ? h(section.component, owner) : h('h2', null, rows.find(r => r.id === options.only)?.label)
      return null
    },
  }
  const root = createRoot(doc.getElementById('settings-fixture')); roots.push(root)
  await act(async () => root.render(h(SettingsRoot, shellProps)))
  const click = async node => { assert.ok(node, 'control exists'); await act(async () => node.click()) }
  const nav = label => [...doc.querySelectorAll('nav button')].find(n => n.textContent === label)
  const button = label => [...doc.querySelectorAll('button')].find(n => n.textContent === label)
  await click(doc.querySelector('[aria-haspopup="dialog"]'))
  assert.deepEqual([...doc.querySelectorAll('nav button')].map(n => n.textContent), ['通用设置', '模型', '插件', 'Agent 预设', '夏尔 Ciel'])
  await click(nav('夏尔 Ciel'))
  const sw = () => doc.querySelector('button[role="switch"][aria-label="启用 Ciel"]')
  assert.equal(sw().getAttribute('aria-checked'), 'true')
  assert.equal(dom.window.getComputedStyle(sw()).width, '36px', 'real native Switch stylesheet is active')
  await click(sw())
  assert.equal(sw().getAttribute('aria-checked'), 'false')
  assert.equal(value.enabled, true, 'toggle is staged, not persisted')
  assert.match(doc.body.textContent, /当前已启用/)
  assert.match(doc.body.textContent, /待保存 · 已关闭/)
  assert.equal(writes.length, 0)
  await click(nav('插件'))
  assert.equal(scopeListeners.size, 0, 'section subscription released on navigation')
  await click(nav('夏尔 Ciel'))
  assert.equal(sw().getAttribute('aria-checked'), 'false', 'draft survives section remount')
  await click(button('放弃'))
  assert.equal(sw().getAttribute('aria-checked'), 'true')
  await click(sw())
  await click(button('保存'))
  assert.equal(writes.length, 1)
  assert.equal(value.enabled, false)
  assert.equal(value.criticExploreBudget, 20)
  assert.equal(value.criticMaxRequests, 32, 'retired user settings are preserved but never edited')
  assert.equal(doc.querySelector('[aria-label="每次评审最多几次工具查询"]'), null)
  assert.equal(doc.querySelector('[aria-label="每次评审最多请求模型几次"]'), null)
  assert.match(doc.body.textContent, /只按总时间控制评审/)
  assert.match(doc.body.textContent, /当前已停用/)
  assert.equal(button('保存').disabled, true)
  await click([...doc.querySelectorAll('button')].find(n => n.textContent === '关闭设置'))
  assert.equal(scopeListeners.size, 0)

  const rt = plugin.__test.runtime
  const reviewRoot = createRoot(doc.getElementById('review-fixture')); roots.push(reviewRoot)
  const baseEntry = { reviewId: 'native-review', messageId: 'native-message', status: 'incomplete', verdict: 'pass', coverage: 'partial', createdAt: 1, annotations: [], summary: '4 项疑点，4 项排除', stats: { checked: 4, confirmed: 0, excluded: 4, unchecked: 0 }, privacy: { mode: 'restricted-snapshot' }, coverageNote: '资料读取范围受限' }
  rt.absorb(baseEntry)
  await act(async () => reviewRoot.render(h('div', null, h('p', null, '这是一份超过两百字的隔离测试草稿。'.repeat(20)), h(rt.ReviewButton, { sessionId: 'fixture', messageId: 'native-message' }))))
  const card = () => doc.querySelector('.dsr-tail')
  assert.ok(card())
  assert.equal(card().querySelector('[data-tone="warning"]').textContent, '◇ 部分核实')
  assert.ok(!card().querySelector('[data-tone="success"]'), 'incomplete zero annotations must not look verified')
  assert.equal(card().querySelectorAll('.ciel-native-tag-mount').length, card().querySelectorAll('[data-tone]').length)
  await click(card().querySelector('.dsr-vtoggle'))
  assert.equal(card().querySelector('.dsr-details').hidden, true)
  for (let i = 2; i <= 6; i++) {
    await act(async () => { rt.absorb({ ...baseEntry, createdAt: i }); rt.emit() })
    assert.equal(doc.querySelectorAll('.dsr-tail').length, 1)
    assert.equal(card().querySelectorAll('[data-tone]').length, 3, 'portal tags do not accumulate on repaint')
    assert.equal(card().querySelector('.dsr-details').hidden, true)
  }
  await act(async () => reviewRoot.render(null))
  assert.equal(doc.querySelectorAll('.dsr-tail').length, 0)
  assert.equal(doc.querySelectorAll('.ciel-native-tag-mount').length, 0)
  assert.equal(network, 0)
  assert.equal(modelCalls, 0)
  assert.deepEqual(warnings, [])
  console.log(JSON.stringify({ passed: true, settingsSidebarOrder: rows.map(r => r.id), nativeSwitchCss: true, draftSurvivesNavigation: true, atomicSave: true, nativeTags: true, collapseSurvivesRepaint: true, portalCleanup: true, network, modelCalls }))
} finally {
  if (act) await act(async () => { for (const root of roots) root.unmount(); for (const off of cleanups.reverse()) off() })
  globalThis.fetch = originalFetch
  console.error = originalError
  styles.deregister()
  dom.window.close()
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
}
