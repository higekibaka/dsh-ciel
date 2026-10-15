#!/usr/bin/env node
// Real DSH SettingsRoot + real advisor-only Ciel client, in JSDOM.
// Only settings/RPC data are fixtures. CSS Modules are compiled from the real
// stylesheets; no native component implementation or CSS is copied here.
// Run from DSH checkout:
// DSH_CHECKOUT=$PWD TSX_TSCONFIG_PATH=$PWD/tsconfig.base.client.json node --import tsx/esm /path/to/dsh-ciel/scripts/verify-native-settings.mjs
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { loadClientFactory } from '../plugin/test/advisor-ui.harness.js'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required')
const rootRequire = createRequire(join(checkout, 'package.json'))
const webRequire = createRequire(join(checkout, 'apps/web/package.json'))
const { JSDOM } = rootRequire('jsdom')
const { transform } = rootRequire('lightningcss')
const dom = new JSDOM('<!doctype html><html><head></head><body><main id="settings-fixture"></main></body></html>', { pretendToBeVisual: true })
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
  let value = { ...plugin.__test.defaults }, user = {}, revision = 0
  const scopeListeners = new Set(), writes = [], registrations = []
  const remote = { $mount: async () => {}, $on: () => () => {} }
  const rpc = { readAdvice: async () => ({ ok: false, error: 'fixture missing' }), callModelUsage: async () => ({ modelUsage: null }) }
  const ctx = {
    configForms: { describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'advisor', secrets: [{ path: ['jevApiKey'], set: Boolean(value.jevApiKey) }] }] } }) }), get(entryId) { assert.equal(entryId, 'advisor'); return {
      getSnapshot: () => ({ status: 'ready', mode: 'host', writable: true, value: Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'jevApiKey')), user: Object.fromEntries(Object.entries(user).filter(([key]) => key !== 'jevApiKey')), revision }),
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
      if (name === 'remote.cielAdvisor') return rpc
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
  let shellState = { open: false, activeId: undefined }
  const shellListeners = new Set()
  const setShell = patch => { shellState = { ...shellState, ...patch }; for (const fn of shellListeners) fn() }
  const shellProps = {
    useStore: select => select(React.useSyncExternalStore(fn => { shellListeners.add(fn); return () => shellListeners.delete(fn) }, () => shellState)),
    useShortcuts: select => select([]),
    actions: { select: activeId => setShell({ activeId }), open: () => setShell({ open: true }), close: () => setShell({ open: false }), openSection: activeId => setShell({ activeId, open: true }) },
    wide: true, reconnect() {}, t: key => key,
    useSections: select => select(rows), useConnectionState: select => select('connected'), useOnboardingSteps: select => select([]),
    useDesktopUpdate: select => select({ failed: false, opening: false }), openDesktopUpdate() {},
    useSessions: select => select({ phase: 'ready', current: 'fixture', byId: { fixture: { blank: false, retainedBy: { mainView: 1 } } } }),
    renderSlot(name, owner, options) {
      if (name === 'settings.trigger' || name === 'settings.header') return '设置'
      if (name === 'settings.close') return '关闭设置'
      if (name === 'settings.section') return options.only === 'ciel' ? h(section.component, owner) : h('h2', null, rows.find(r => r.id === options.only)?.label)
      return options?.fallback ?? null
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
  const findInputByLabel = (label) => {
    let input = doc.querySelector(`input[aria-label="${label}"], button[role="switch"][aria-label="${label}"]`)
    if (input) return input
    const labels = [...doc.querySelectorAll('label')]
    const labelEl = labels.find(l => l.textContent === label)
    if (labelEl && labelEl.getAttribute('for')) {
      return doc.getElementById(labelEl.getAttribute('for'))
    }
    return null
  }
  const sw = () => findInputByLabel('启用 Ciel')
  assert.equal(sw().getAttribute('aria-checked'), 'true')
  const advisorJevSwitch = () => findInputByLabel('启用顾问建议检查（Jev）')
  assert.equal(advisorJevSwitch().getAttribute('aria-checked'), 'false')
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
  await click(advisorJevSwitch())
  assert.equal(value.advisorJevEnabled, false, 'Jev stays off until Save')
  await click(sw())
  await click(button('保存'))
  assert.equal(value.enabled, false)
  assert.equal(value.advisorJevEnabled, true)
  assert.equal(writes.length, 1)
  assert.equal(doc.querySelector('[aria-label="启用 Jev 证据检查"]'), null)
  assert.equal(doc.querySelector('[aria-label="允许评审时查文件"]'), null)
  assert.match(doc.body.textContent, /当前已停用/)
  await click(advisorJevSwitch())
  await click(button('保存'))
  assert.equal(value.advisorJevEnabled, false)
  const keyInput = () => findInputByLabel('Jev API Key')
  assert.equal(keyInput().type, 'password')
  assert.equal(keyInput().disabled, false, 'secret metadata comes from the native describe mirror')
  const change = async (node, next) => { await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, next)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }) }
  await change(keyInput(), 'native-fixture-secret')
  await change(findInputByLabel('Jev 模型 ID'), 'jev-native')
  await click(button('保存'))
  assert.equal(value.jevApiKey, 'native-fixture-secret')
  assert.equal(value.jevModel, 'jev-native')
  assert.equal(keyInput().value, '', 'saved key is not reflected back into the input')
  assert.match(doc.body.textContent, /已配置密钥/)
  assert.ok(!doc.body.innerHTML.includes('native-fixture-secret'))
  await change(findInputByLabel('Jev 接口地址'), 'http://invalid.test')
  assert.equal(button('保存').disabled, true)
  await click(button('放弃'))
  await click(button('清除密钥覆盖'))
  await click(button('保存'))
  assert.equal(value.jevApiKey, '')
  await click([...doc.querySelectorAll('button')].find(n => n.textContent === '关闭设置'))
  assert.equal(scopeListeners.size, 0)

  assert.equal(network, 0)
  assert.equal(modelCalls, 0)
  assert.deepEqual(warnings, [])
  console.log(JSON.stringify({ passed: true, settingsSidebarOrder: rows.map(r => r.id), advisorOnly: true, draftSurvivesNavigation: true, atomicSave: true, secretRedaction: true, network, modelCalls }))
} finally {
  if (act) await act(async () => { for (const root of roots) root.unmount(); for (const off of cleanups.reverse()) off() })
  globalThis.fetch = originalFetch
  console.error = originalError
  styles.deregister()
  dom.window.close()
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
}
