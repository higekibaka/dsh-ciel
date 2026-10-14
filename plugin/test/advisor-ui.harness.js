// Advisor client fixture: real built factory, fake Host services, no network.
import { readFileSync } from 'node:fs'

// Interface-only fixtures, not native styling proof. The native UI acceptance
// script supplies the real shared components and ReactDOM instead.
export function fixtureClientRequire(React, modules = {}) {
  const primitives = {
    Switch: ({ checked, onChange, label, disabled, title, className }) => React.createElement('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, title, className, onClick: () => onChange(!checked), 'data-fixture-native': 'Switch' }),
    Tag: ({ tone = 'outline', className, children }) => React.createElement('span', { 'data-tone': tone, className, 'data-fixture-native': 'Tag' }, children),
  }
  return name => {
    if (Object.hasOwn(modules, name)) return modules[name]
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (children, container, key) => ({ __portal: { children, container, key } }) }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    return {}
  }
}

// Minimal optional-service injection for interface fixtures. Native acceptance
// uses the real Cordis dependency lifecycle, including provider replacement.
export function fixtureServiceInjection(ctx) {
  if (typeof ctx.inject !== 'function') ctx.inject = (names, callback) => {
    if (names.every(name => ctx[name] !== undefined)) callback(ctx)
  }
  return ctx
}

export function loadClientFactory(documentOverride) {
  let captured = null
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const windowStub = { __ModuleLoader__: { load: (m) => { captured = m } } }
  // Minimal DOM so apply()'s advisor stylesheet installation works in fixtures.
  const doc = documentOverride || {
    createElement: () => ({
      tagName: '', textContent: '', className: '', style: {},
      appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} }, contains: () => false,
    }),
    head: { appendChild() {} }, body: {},
  }
  const fn = new Function('window', 'document', src)
  fn.call({}, windowStub, doc)
  return { captured, factory: (reactStub, modules) => {
    const plugin = captured.factory(fixtureClientRequire(reactStub, modules))
    const apply = plugin.apply
    plugin.apply = ctx => apply(fixtureServiceInjection(ctx))
    return plugin
  }, doc }
}

export function makeHookRunner() {
  const state = []
  const refs = []
  let cursor = 0
  let effects = []
  const hooks = {
    useState(initial) {
      const i = cursor++
      if (state[i] === undefined) state[i] = { value: initial }
      return [state[i].value, (v) => { state[i].value = typeof v === 'function' ? v(state[i].value) : v }]
    },
    useEffect(fn, deps) {
      effects.push({ fn, deps })
    },
    useRef(initial) {
      const i = cursor++
      if (refs[i] === undefined) refs[i] = { current: initial }
      return refs[i]
    },
  }
  return {
    hooks,
    render(component, props) {
      cursor = 0
      effects = []
      return component(props)
    },
    getEffects: () => effects,
    getState: () => ({ values: [...state], refs: [...refs] }),
    stateValues: () => state.map((s) => s.value),
    refValues: () => refs.map((r) => r.current),
  }
}

export async function createRuntime(rpc = {}, opts = {}) {
  const { factory, doc } = loadClientFactory(opts.document)
  const runner = makeHookRunner()
  const reactStub = { createElement: (...a) => ({ __element: a }), ...runner.hooks }
  const moduleExports = factory(reactStub), cleanups = [], rpcCalls = { readAdvice: [], callModelUsage: [] }
  const rpcImpl = Object.fromEntries(Object.keys(rpcCalls).map(method => [method, async request => {
    rpcCalls[method].push(request)
    return typeof rpc[method] === 'function' ? rpc[method](request) : rpc[method] || { modelUsage: null }
  }]))
  const remote = { $mount: async () => () => {}, $on: () => () => {} }
  const ctx = {
    settingsScope: { bind: () => ({ getSnapshot: () => ({ status: 'ready', value: opts.settingsValue || {}, user: {}, writable: true }), subscribe: () => () => {} }) },
    on: () => () => {}, get: key => key === 'remote' ? remote : key === 'remote.cielAdvisor' ? rpcImpl : undefined,
    slots: { injected: {}, registries: {}, inject(name, fn) { this.injected[name]=fn; return () => {} }, register(desc, renderFn) {this.registries[desc.id||desc.key]=renderFn; return () => {}} },
    effect(fn) { const result = fn(); if (typeof result === 'function') cleanups.push(result) },
  }
  moduleExports.apply(ctx)
  await flush()
  return { moduleExports, ctx, doc, runner, reactStub, rpcCalls, rpcImpl, runtime: moduleExports.__test.runtime, async dispose() { await Promise.all(cleanups.splice(0).map(fn=>fn())) } }
}
export async function flush() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
