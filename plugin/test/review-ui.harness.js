// Review-UI integration harness: drives the REAL client factory — running
// apply(), hydrate(), and the ReviewButton component effects — against a fake
// Remote RPC and a tiny React hook runner. No server, no real DOM, no model.
// The goal is to prove the WIRING (RPC → store → component state → label),
// which pure-helper assertions alone cannot.

import { readFileSync } from 'node:fs'

export function loadClientFactory() {
  let captured = null
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const windowStub = { __ModuleLoader__: { load: (m) => { captured = m } } }
  // Minimal DOM so apply()'s <style> append works; ReviewButton effects that
  // touch the DOM walk away (rootRef is null in the harness).
  const doc = {
    createElement: () => ({
      tagName: '', textContent: '', className: '', style: {},
      appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} }, contains: () => false,
    }),
    head: { appendChild() {} }, body: {},
  }
  const fn = new Function('window', 'document', src)
  fn.call({}, windowStub, doc)
  return { captured, factory: (reactStub) => captured.factory((name) => (name === 'react' ? reactStub : {})), doc }
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

/**
 * Run the client plugin's apply() against a fake Cordis ctx.
 * @param {object} rpc  fake advisorReview RPC ({list,start,progress,cancel,feedback,triage})
 * @param {object} opts
 * @returns {Promise<object>} live internals + stubs needed to drive the wiring.
 */
export async function createRuntime(rpc = {}, opts = {}) {
  const { captured, factory, doc } = loadClientFactory()
  const runner = makeHookRunner()
  const reactStub = {
    createElement: (...a) => ({ __element: a }),
    ...runner.hooks,
  }
  const moduleExports = factory(reactStub)

  const rpcCalls = {}
  for (const m of ['list', 'start', 'progress', 'cancel', 'feedback', 'triage']) {
    rpcCalls[m] = []
  }
  const defer = (m, req) => {
    rpcCalls[m].push(req)
    const implied = rpc[m]
    if (typeof implied === 'function') return implied(req)
    if (implied === undefined) return Promise.resolve(m === 'list' ? { reviews: [], sentKeys: [], triage: {} } : {})
    return Promise.resolve(implied)
  }
  const rpcImpl = {
    list: (req) => defer('list', req),
    start: (req) => defer('start', req),
    progress: (req) => defer('progress', req),
    cancel: (req) => defer('cancel', req),
    feedback: (req) => defer('feedback', req),
    triage: (req) => defer('triage', req),
  }

  const handlers = {}
  const effectCleanups = []
  const settingsValue = opts.settingsValue || {}
  const settingsScopeStub = opts.noGetSnapshot
    ? { set: async () => {}, unset: async () => {} }
    : { getSnapshot: () => ({ status: 'ready', value: settingsValue, user: {}, writable: true }), set: async () => {}, unset: async () => {} }
  const ctx = {
    settingsScope: {
      bind: () => settingsScopeStub,
    },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
    get: (key) => {
      if (key === 'remote') return { $mount: () => Promise.resolve(), $on: () => () => {} }
      if (key === 'remote.advisorReview') return rpcImpl
      return undefined
    },
    slots: {
      injected: {},
      registries: {},
      inject(name, fn) { this.injected[name] = fn; return () => {} },
      register(desc, renderFn) { this.registries[desc.id || desc.key] = renderFn; return renderFn },
    },
    effect: (fn) => {
      const out = fn()
      if (typeof out === 'function') effectCleanups.push(out)
      return () => {}
    },
  }

  moduleExports.apply(ctx)
  await flush()

  // Wire the reconnect handler so tests can fire it.
  const fireConnectionReset = () => { for (const h of handlers['connection/reset'] || []) h() }
  // Run every captured effect cleanup (plugin teardown) so tests can assert the
  // test-runtime capture is cleared.
  const dispose = () => { for (const c of effectCleanups.splice(0)) c() }

  // Grab the ReviewButton component registered for the assistant-actions slot.
  const assistantFn = ctx.slots.injected['conversation.chat.assistant-actions']
  let ReviewButton = null
  if (assistantFn) {
    assistantFn()
    const renderFn = ctx.slots.registries['advisor-review']
    if (renderFn) {
      const head = renderFn({ messageId: 'm0', sessionId: 's0' })
      ReviewButton = head && head.__element ? head.__element[0] : null
    }
  }

  const runtime = moduleExports.__test.runtime
  return {
    moduleExports, ctx, doc, runner, reactStub, rpcCalls, rpcImpl, runtime,
    fireConnectionReset, ReviewButton, dispose,
  }
}

/** Settle microtasks so async RPC callbacks / mount continuations resolve. */
export async function flush() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await Promise.resolve()
}

/**
 * A fake timer controller stubbing setInterval/clearInterval for the poll loop.
 * Returns { fireTick, restore }. Use try/finally around the test.
 */
export function mockTimers() {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const intervals = new Map()
  let nextId = 1
  globalThis.setInterval = (fn, ms) => { const id = nextId++; intervals.set(id, fn); return id }
  globalThis.clearInterval = (id) => { intervals.delete(id) }
  return {
    fireTick: () => { for (const fn of intervals.values()) fn() },
    intervalCount: () => intervals.size,
    restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear },
  }
}
