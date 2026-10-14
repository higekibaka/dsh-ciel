// Ciel sidebar client tests: the pure-ESM sidebar module against a mock React
// renderer and a mock Cordis context. No network, no real DSH, no DOM library:
// the point is the WIRING (addresses -> providers -> native registrations ->
// bodies) and the two behaviors that must not regress — a failed resource never
// shows the last success, and historical evidence never reads the current file
// by itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CIEL_ADVICE,
  adviceAddress,
  createCielSidebar,
  parseCielAddress,
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

function createSidebar(harness, options = {}) {
  return createCielSidebar({
    React: harness.React,
    Tag: options.Tag === undefined ? createTag(harness) : options.Tag,
    ...(options.Button === undefined ? {} : { Button: options.Button }),
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
  const face = typeof entry.registration.inject === 'function' ? entry.registration.inject('s1') : {}
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

test('advice addresses round-trip opaque identities and reject foreign resource types', () => {
  assert.deepEqual(parseCielAddress(adviceAddress('s 1/2', 'tool:a?b')), { protocol: CIEL_ADVICE, sessionId: 's 1/2', recordId: 'tool:a?b' })
  for (const address of ['dsh-resource://ciel-review/session/s/r', 'dsh-resource://ciel-evidence/session/s/r/e', adviceAddress('s','c')+'?q=x', adviceAddress('s','c')+'#fragment', 'dsh-resource://ciel-advice/session/s/%xx', 'dsh-resource://u:p@ciel-advice/session/s/c']) assert.equal(parseCielAddress(address), undefined)
})
test('native advice install and disposal own exactly one provider, kind and body', () => {
  const sidebar = createSidebar(createRenderer()), mock = createMockContext()
  const uninstall = sidebar.install(mock.ctx, { call: async () => ({ ok: true, advice: {} }) })
  assert.equal(mock.providers.size, 1); assert.equal(mock.tabs.size, 1); assert.equal(mock.slots.size, 1)
  assert.equal(sidebar.install(mock.ctx, {}), uninstall)
  assert.deepEqual(sidebar.openAdvice('s','tool:c',{itemIndex:2}), {ok:true,address:adviceAddress('s','tool:c')})
  assert.deepEqual(mock.sidebarCalls[0].options, {kind:CIEL_ADVICE,params:{itemIndex:2}})
  sidebar.dispose(); sidebar.dispose()
  assert.equal(mock.providers.size,0); assert.equal(mock.tabs.size,0); assert.equal(mock.slots.size,0)
  assert.equal(sidebar.openAdvice('s','c').ok,false)
})
test('failed advice resources never render a stale successful payload', () => {
  const harness = createRenderer(), sidebar = createSidebar(harness), mock = createMockContext()
  sidebar.install(mock.ctx, {call:async()=>assert.fail('rendering must not call model')})
  const {tree}=mountBody(harness,mock,CIEL_ADVICE,{snapshot:{address:adviceAddress('s','c'),status:'failed',value:{advice:{text:'STALE'}},failure:{code:'fixture',message:'read failed'}}})
  assert.match(tree.text,/read failed/); assert.doesNotMatch(tree.text,/STALE/)
})

test('saved advice renders parsed ideas, raw disclosure, issues, model provenance and focused item',()=>{
 const harness=createRenderer(),sidebar=createSidebar(harness),mock=createMockContext()
 sidebar.install(mock.ctx,{call:async()=>assert.fail('rendering stored advice does not call a model')})
 const advice={callId:'tool:c',sessionId:'s',kind:'tool',createdAt:1,text:'Original reply',items:[{tier:'high',title:'Idea',framing:'Frame',pitfalls:'Risk',verificationTarget:'Check locally'}],issues:['Parse warning'],modelUsage:{used:[{provider:'p',model:'m'}]}}
 const {tree}=mountBody(harness,mock,CIEL_ADVICE,{params:{itemIndex:0},snapshot:live(adviceAddress('s','tool:c'),{advice})})
 for(const value of ['Original reply','Idea','Frame','Risk','Check locally','Parse warning','p/m','不是核实过的证据'])assert.ok(tree.text.includes(value),value)
 assert.equal(tree.all(n=>n.props['data-ciel-advice-item']!==undefined).length,1)
 assert.ok(tree.find(n=>n.type==='details'&&n.props['data-ciel-advice-raw']!==undefined))
 assert.equal(tree.find(n=>n.props['data-ciel-focus']!==undefined).dom.scrollCalls.length,1)
})
test('unstructured legacy advice displays original text without a duplicate disclosure',()=>{
 const harness=createRenderer(),sidebar=createSidebar(harness),mock=createMockContext()
 sidebar.install(mock.ctx,{call:async()=>assert.fail('no history model requests')})
 const {tree}=mountBody(harness,mock,CIEL_ADVICE,{snapshot:live(adviceAddress('s','command:c'),{advice:{kind:'command',text:'Legacy original',items:[],issues:[]}})})
 assert.match(tree.text,/Legacy original/)
 assert.equal(tree.all(n=>n.props['data-ciel-advice-text']!==undefined).length,1)
 assert.equal(tree.find(n=>n.type==='details'),undefined)
})
test('saved Jev advice shows limited context and incomplete checks without rechecking',()=>{
 const harness=createRenderer(),sidebar=createSidebar(harness),mock=createMockContext()
 sidebar.install(mock.ctx,{call:async()=>assert.fail('no Jev history requests')})
 const jev={mode:'shadow',scope:'provided-context',requestedModel:'jev-fixture',status:'partial',requestCount:1,elapsedMs:5,omittedChecks:1,usage:{inputTokens:30,outputTokens:4},checks:[{id:'a1',status:'completed',relation:'contradicts',confidence:0.8,probabilities:{supports:0.1,contradicts:0.8,insufficient:0.1}},{id:'a2',status:'skipped',reason:'input-too-large'}]}
 const {tree}=mountBody(harness,mock,CIEL_ADVICE,{snapshot:live(adviceAddress('s','tool:c'),{advice:{text:'Original reply',jev}})})
 assert.match(tree.text,/仅对照本次传入的背景/)
 assert.match(tree.text,/建议 1：背景冲突/)
 assert.match(tree.text,/建议 2：未检查.*大小限制/)
 assert.match(tree.text,/另有 1 条建议未检查/)
 assert.ok(tree.text.includes("输入 30 / 输出 4 tokens"))
})
