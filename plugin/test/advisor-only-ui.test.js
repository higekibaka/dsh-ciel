import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'
import { ADVISOR_REMOTE } from '../advisor-protocol.js'
import { createCielSidebar, adviceAddress, parseCielAddress } from '../src/sidebar.js'
import { advisorJevPanel, advisorJevSummary } from '../src/advisor-jev.js'
import { JEV_MODEL, JEV_ENDPOINT, validJevEndpoint, validJevModel, validJevKey } from '../jev-config.js'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const css = name => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8')
const element = (type, props, ...children) => ({ type, props: { ...props, children } })
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
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)
  || nodes(tree).find(node => node.type === 'button' && (node.props['data-ciel-settings-group-head'] === '' || node.props['data-ciel-action'] === '') && text(node).includes(label))
const input = (tree, label) => nodes(tree).find(node => node.props['aria-label'] === label && (['input', 'select'].includes(node.type) || node.props.role === 'switch'))
const json = value => JSON.parse(JSON.stringify(value))
const usage = { requested: { provider: 'requested', model: 'planned' }, used: [{ provider: 'actual', model: 'executed' }] }
const jev = { mode: 'shadow', scope: 'provided-context', requestedModel: 'jev-fixture', status: 'completed', requestCount: 1, elapsedMs: 7, omittedChecks: 0,
  checks: [{ id: 'a1', status: 'completed', relation: 'supports', confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, insufficient: 0.05 } }] }
const idea = { tier: 'high', title: 'Keep boundaries explicit', framing: 'Read durable records', pitfalls: 'Avoid stale state', verificationTarget: 'Verify identity' }
const advice = { sessionId: 's1', callId: 'tool:c1', kind: 'tool', createdAt: 1, text: 'original advice', items: [idea], issues: [], modelUsage: usage, jev }

function harness({ mount = true, sidebar = true, configForms = false, overrides = {}, api: suppliedApi, mountRemote } = {}) {
  let state = [], cursor = 0, revision = 1, secretReady = true, writable = true, refused = false
  const cleanups = [], registrations = [], providers = [], tabs = [], opens = [], mounts = [], writes = [], events = new Map(), styles = []
  const React = { Fragment: 'fragment', createElement: element,
    useState(initial) { const at = cursor++; if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial; return [state[at], next => { state[at] = typeof next === 'function' ? next(state[at]) : next }] },
    useEffect() {}, useRef: value => ({ current: value }),
  }
  let factory
  const window = { __ModuleLoader__: { load: module => { factory = module.factory } }, addEventListener() {}, removeEventListener() {} }
  const document = { createElement: () => ({ textContent: '', remove() { styles.splice(styles.indexOf(this), 1) } }), head: { appendChild: node => styles.push(node) } }
  vm.runInNewContext(source.replace(/^import .+\n/gm, ''), {
    window, document, ADVISOR_REMOTE, createCielSidebar, advisorJevPanel, advisorJevSummary,
    JEV_MODEL, JEV_ENDPOINT, validJevEndpoint, validJevModel, validJevKey,
    SIDEBAR_CSS: css('sidebar.css'), SETTINGS_CSS: css('settings.css'),
  }, { filename: 'advisor-only-client.js' })
  const plugin = factory(name => { assert.equal(name, 'react', 'no Harness client package imports'); return React })
  const value = { ...plugin.__test.defaults, ...overrides }, user = { ...overrides }
  const form = {
    getSnapshot: () => ({ status: 'ready', writable, revision, value: Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'jevApiKey')),
      user: Object.fromEntries(Object.entries(user).filter(([key]) => key !== 'jevApiKey')),
      ...(secretReady ? { secrets: [{ path: ['jevApiKey'], set: Boolean(value.jevApiKey) }] } : {}) }),
    subscribe: () => () => {},
    async mutate(ops, expected) {
      assert.equal(expected, revision)
      if (refused) return false
      writes.push(json(ops))
      for (const op of ops) {
        if (op.op === 'set') { value[op.path[0]] = op.value; user[op.path[0]] = op.value }
        else { value[op.path[0]] = plugin.__test.defaults[op.path[0]]; delete user[op.path[0]] }
      }
      revision++
    },
  }
  const api = suppliedApi || { readAdvice: async request => ({ ok: true, value: { ok: true, advice: { ...advice, ...request } } }), callModelUsage: async () => ({ ok: true, value: { ok: true, modelUsage: usage } }) }
  const remote = { async $mount(descriptor) { mounts.push(descriptor); return mountRemote ? mountRemote() : () => {} } }
  const ctx = {
    [configForms ? 'configForms' : 'settingsScope']: configForms ? { get: () => form, describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'advisor', secrets: [{ path: ['jevApiKey'], set: true }] }] } }) }) } : { bind: () => form },
    resources: { register(provider) { providers.push(provider); return () => { providers.splice(providers.indexOf(provider), 1) } } },
    sidebarRightTabs: { register(tab) { tabs.push(tab); return () => { tabs.splice(tabs.indexOf(tab), 1) } } },
    sidebarRight: { openResource(address, options) { opens.push({ address, options }) } },
    slots: { inject(_name, setup) { return setup() }, register(def, Body) { registrations.push({ def, Body }); return () => {} } },
    inject(names, setup) { if (names.every(name => name in ctx) && (sidebar || !names.includes('resources'))) setup(ctx) },
    effect(setup) { let done = false; const cleanup = setup(); const dispose = async () => { if (done) return; done = true; await cleanup?.() }; cleanups.push(dispose); return dispose },
    on(name, callback) { events.set(name, callback); return () => events.delete(name) },
    get(name) { if (name === 'remote') return remote; if (name === 'remote.cielAdvisor') return api; return ctx[name] },
  }
  if (mount) plugin.apply(ctx)
  return {
    plugin, value, writes, registrations, providers, tabs, opens, mounts, styles, ctx, events,
    render() { cursor = 0; return plugin.__test.CielSettingsSection() },
    card(props) { cursor = 0; return plugin.__test.AdvisorToolView(props) },
    remount() { state = []; cursor = 0 },
    externalEdit() { revision++ }, readOnly() { writable = false }, legacySecrets() { secretReady = false }, refuse() { refused = true },
    async dispose() { for (const cleanup of [...cleanups].reverse()) await cleanup() },
  }
}

const settled = { sessionId: 's1', callId: 'c1', block: { kind: 'tool', call: { argsRaw: JSON.stringify({ question: 'Question?', context: 'Known facts' }) }, meta: { v: 1, items: [idea], issues: [], modelUsage: usage, jev }, content: [{ type: 'text', text: 'raw advice' }], callTime: 1, time: 1001 } }

test('source tree contains no review, inbox, annotation, composer or private client-module integration', () => {
  const files = readdirSync(new URL('../src/', import.meta.url))
  assert.deepEqual(files.sort(), ['advisor-jev.js', 'client.js', 'settings.css', 'sidebar.css', 'sidebar.js'])
  for (const file of files) {
    const body = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
    assert.doesNotMatch(body, /advisorReview|review[-A-Z_]|critic[A-Z]|\bjevEnabled\b|inbox|annotation|triage|prepareFeedback|composer|slash\/input|MutationObserver|setInterval|dsh-client-ui-primitives|react-dom|批注|评审/i, file)
  }
})

test('mount registers only advisor settings, tool card and ciel-advice resource', async t => {
  const rt = harness(); t.after(() => rt.dispose())
  assert.deepEqual(rt.registrations.map(row => row.def.name).sort(), ['settings.action', 'settings.section', 'sidebar.right.pane.tab', 'tool.call.toolview'])
  assert.deepEqual(rt.providers.map(row => row.protocol), ['ciel-advice'])
  assert.deepEqual(rt.tabs.map(row => row.kind), ['ciel-advice'])
  assert.deepEqual(json(rt.plugin.__test.remoteMethodNames).sort(), ['callModelUsage', 'readAdvice'])
  assert.ok(rt.plugin.__test.fieldKeys.every(key => !/critic|review|^jevEnabled$/.test(key)))
  assert.equal(rt.registrations.find(row => row.def.name === 'tool.call.toolview').def.key, 'ask_advisor')
  assert.equal(rt.registrations.find(row => row.def.name === 'settings.section').def.label(), '夏尔 Ciel')
  await rt.plugin.__test.runtime.advisorCall('callModelUsage', { sessionId: 's1', kind: 'tool', id: 'c1' })
  assert.equal(rt.mounts.length, 1)
  assert.ok(rt.mounts[0].descriptors.every(row => row.service === 'cielAdvisor'))
})

test('switches stage changes across remount and save one revision-fenced transaction', async t => {
  const rt = harness(); t.after(() => rt.dispose())
  input(rt.render(), '启用 Ciel').props.onClick()
  input(rt.render(), '启用顾问建议检查（Jev）').props.onClick()
  assert.deepEqual(rt.writes, [])
  rt.remount()
  assert.equal(input(rt.render(), '启用 Ciel').props['aria-checked'], false)
  assert.match(text(rt.render()), /当前已启用.*待保存/s)
  await button(rt.render(), '保存').props.onClick()
  assert.equal(rt.writes.length, 1)
  assert.deepEqual(rt.writes[0], [{ op: 'set', path: ['enabled'], value: false }, { op: 'set', path: ['advisorJevEnabled'], value: true }])
  input(rt.render(), '启用 Ciel').props.onClick()
  rt.externalEdit()
  await button(rt.render(), '保存').props.onClick()
  assert.equal(rt.writes.length, 1)
  assert.match(text(rt.render()), /保存未确认/)
  button(rt.render(), '放弃').props.onClick()
  assert.equal(input(rt.render(), '启用 Ciel').props['aria-checked'], false)
})

test('saved API keys stay redacted; replacement, validation and explicit unset survive', async t => {
  const rt = harness({ overrides: { jevApiKey: 'saved-secret' } }); t.after(() => rt.dispose())
  assert.equal(input(rt.render(), 'Jev API Key').props.value, '')
  assert.doesNotMatch(JSON.stringify(rt.render()), /saved-secret/)
  input(rt.render(), 'Jev 模型 ID').props.onChange({ target: { value: 'jev-next' } })
  await button(rt.render(), '保存').props.onClick()
  assert.equal(rt.value.jevApiKey, 'saved-secret')
  input(rt.render(), 'Jev API Key').props.onChange({ target: { value: 'new-secret' } })
  rt.remount()
  assert.equal(input(rt.render(), 'Jev API Key').props.value, 'new-secret')
  await button(rt.render(), '保存').props.onClick()
  assert.equal(rt.value.jevApiKey, 'new-secret')
  assert.equal(input(rt.render(), 'Jev API Key').props.value, '')
  button(rt.render(), '清除密钥覆盖').props.onClick()
  await button(rt.render(), '保存').props.onClick()
  assert.deepEqual(rt.writes.at(-1), [{ op: 'unset', path: ['jevApiKey'] }])
  for (const [label, value] of [['Jev API Key', 'bad key'], ['Jev 接口地址', 'http://example.invalid'], ['Jev 模型 ID', 'bad model']]) {
    input(rt.render(), label).props.onChange({ target: { value } })
    assert.equal(button(rt.render(), '保存').props.disabled, true)
    button(rt.render(), '放弃').props.onClick()
  }
  rt.legacySecrets()
  assert.equal(input(rt.render(), 'Jev API Key').props.disabled, true)
})

test('catalog selection resets only advisor model/effort and explicit reset remains staged', async t => {
  const rt = harness({ overrides: { maxCallsPerTurn: 5 } }); t.after(() => rt.dispose())
  rt.plugin.__test.getSettingsEditor().set('catalog', { status: 'ready', groups: [{ id: 'route', models: [{ id: 'model', reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }] }] })
  button(rt.render(), '顾问管道').props.onClick()
  input(rt.render(), '提供方路由').props.onChange({ target: { value: 'route' } })
  assert.equal(input(rt.render(), '顾问模型').props.value, 'model')
  assert.equal(input(rt.render(), '思考深度').props.value, 'provider')
  const field = nodes(rt.render()).find(node => node.props['data-ciel-setting'] === 'maxCallsPerTurn')
  button(field, '重置').props.onClick()
  assert.equal(rt.value.maxCallsPerTurn, 5)
  await button(rt.render(), '保存').props.onClick()
  assert.equal(rt.value.maxCallsPerTurn, 3)
  assert.ok(rt.writes[0].some(op => op.op === 'unset' && op.path[0] === 'maxCallsPerTurn'))
})

test('read-only and refused saves preserve safe local control behavior', async t => {
  const rt = harness(); t.after(() => rt.dispose())
  input(rt.render(), 'Jev API Key').props.onChange({ target: { value: 'draft-key' } })
  rt.refuse()
  await button(rt.render(), '保存').props.onClick()
  assert.match(text(rt.render()), /保存未确认/)
  assert.equal(input(rt.render(), 'Jev API Key').props.value, 'draft-key')
  rt.readOnly()
  assert.equal(input(rt.render(), '启用 Ciel').props.disabled, true)
  const before = input(rt.render(), '启用 Ciel').props['aria-checked']
  input(rt.render(), '启用 Ciel').props.onClick()
  assert.equal(input(rt.render(), '启用 Ciel').props['aria-checked'], before)
})

test('configForms namespace preserves redacted secret and advisor settings', async t => {
  const rt = harness({ configForms: true }); t.after(() => rt.dispose())
  assert.match(text(rt.render()), /已配置密钥/)
  assert.equal(input(rt.render(), 'Jev API Key').props.value, '')
  assert.equal(rt.registrations.filter(row => row.def.name === 'settings.section').length, 1)
})

test('advisor cards retain live/error/raw/structured rendering and keyboard disclosure', () => {
  const rt = harness({ mount: false })
  assert.match(text(rt.card({ block: { argsRaw: '{}' } })), /咨询中/)
  let tree = rt.card(settled)
  assert.match(text(tree), /Keep boundaries explicit/)
  assert.match(text(tree), /actual \/ executed/)
  assert.match(text(tree), /Jev 顾问建议检查/)
  const disclosure = nodes(tree).find(node => node.type === 'button' && node.props['aria-expanded'] === true)
  disclosure.props.onClick()
  assert.doesNotMatch(text(rt.card(settled)), /Read durable records/)
  rt.remount()
  tree = rt.card({ ...settled, block: { ...settled.block, isError: true, meta: {}, content: [{ type: 'text', text: 'synthetic failure' }] } })
  assert.match(text(tree), /顾问咨询失败.*synthetic failure/s)
  rt.remount()
  assert.match(text(rt.card({ ...settled, block: { ...settled.block, meta: {}, content: [{ type: 'text', text: 'unstructured reply' }] } })), /unstructured reply/)
  rt.remount()
  assert.match(text(rt.card({ ...settled, block: { ...settled.block, meta: {}, content: [{ type: 'text', text: '## [mid] PTC idea\nframing: A\npitfalls: B\nverification_target: C' }] } })), /PTC idea/)
})

test('advisor card navigation opens the durable advice resource without invoking a model', async t => {
  const rt = harness(); t.after(() => rt.dispose())
  const tree = rt.card(settled)
  assert.match(text(tree), /Jev 顾问建议检查/)
  assert.doesNotMatch(text(tree), /Read durable records/)
  button(tree, '在侧栏查看').props.onClick()
  assert.equal(rt.opens[0].address, adviceAddress('s1', 'tool:c1'))
  assert.deepEqual(json(rt.opens[0].options), { kind: 'ciel-advice' })
  const result = await rt.providers[0].open(rt.opens[0].address, { signal: new AbortController().signal }).next()
  assert.equal(result.value.ok, true)
  assert.equal(result.value.value.advice.callId, 'tool:c1')
  const Body = rt.registrations.find(row => row.def.name === 'sidebar.right.pane.tab').Body
  const props = { useTabInfo: () => ({ tab: { contentId: rt.opens[0].address, navigation: { params: { itemIndex: 0 }, revision: 1 } } }), useResource: () => ({ status: 'live', value: result.value.value }) }
  assert.match(text(Body(props)), /Keep boundaries explicit.*Read durable records/s)
  assert.match(text(Body(props)), /不是核实过的证据/)
  assert.ok(nodes(Body(props)).some(node => node.props['data-ciel-focus'] === ''))
  const failed = Body({ ...props, useResource: () => ({ status: 'failed', failure: { message: 'missing' }, value: result.value.value }) })
  assert.match(text(failed), /missing/)
  assert.doesNotMatch(text(failed), /original advice|Keep boundaries explicit/)
})

test('resource parsing rejects removed protocols and malformed addresses', () => {
  assert.deepEqual(parseCielAddress(adviceAddress('s1', 'tool:with/slash')), { protocol: 'ciel-advice', sessionId: 's1', recordId: 'tool:with/slash' })
  for (const address of ['dsh-resource://ciel-review/session/s1/r1', 'dsh-resource://ciel-evidence/session/s1/r1/e1', 'dsh-resource://ciel-advice/session/s1/x?query=1', 'dsh-resource://ciel-advice/session/s1/%', 'dsh-resource://ciel-advice/session/s1/x/extra']) assert.equal(parseCielAddress(address), undefined)
})

test('remote validates method, request, response and durable advice identity', async t => {
  let calls = 0
  const rt = harness({ api: { readAdvice: async () => { calls++; return { ok: true, value: { ok: true, advice: { ...advice, sessionId: 'wrong' } } } }, callModelUsage: async () => ({ ok: true, value: { ok: true, modelUsage: 'bad' } }) } })
  t.after(() => rt.dispose())
  const call = rt.plugin.__test.runtime.advisorCall
  assert.equal((await call('readReview', { sessionId: 's1', reviewId: 'r1' })).ok, false)
  assert.equal((await call('readAdvice', { sessionId: '../invalid', callId: 'tool:c1' })).ok, false)
  assert.equal(calls, 0)
  assert.equal((await call('readAdvice', { sessionId: 's1', callId: 'tool:c1' })).ok, false)
  assert.equal((await call('callModelUsage', { sessionId: 's1', kind: 'tool', id: 'c1' })).ok, false)
})

test('model usage deduplicates concurrent reads and retries after failure', async () => {
  const rt = harness({ mount: false }); let count = 0, finish
  const reader = rt.plugin.__test.createModelUsageReader(() => { count++; return new Promise(resolve => { finish = resolve }) })
  const request = { sessionId: 's1', kind: 'tool', id: 'c1' }
  const a = reader(request), b = reader(request)
  assert.equal(a, b)
  await Promise.resolve()
  finish({ ok: false })
  await assert.rejects(a)
  const next = reader(request)
  await Promise.resolve()
  finish({ ok: true, modelUsage: usage })
  assert.equal(await next, usage)
  assert.equal(count, 2)
  assert.match(rt.plugin.__test.modelUsageLabel({ requested: usage.requested, used: [] }), /未确认执行/)
})

test('unload releases a late Remote mount and all advice resource ownership', async () => {
  let resolveMount, released = 0
  const rt = harness({ mountRemote: () => new Promise(resolve => { resolveMount = resolve }) })
  await Promise.resolve(); await Promise.resolve()
  const disposed = rt.dispose()
  resolveMount(() => { released++ })
  await disposed
  await rt.dispose()
  assert.equal(released, 1)
  assert.deepEqual(rt.providers, [])
  assert.deepEqual(rt.tabs, [])
  assert.deepEqual(rt.styles, [])
  assert.deepEqual(Object.keys(rt.plugin.__test.runtime), [])
})


test('sidebar navigation failures stay visible on the advisor card', async t => {
  const rt = harness(); t.after(() => rt.dispose())
  rt.ctx.sidebarRight.openResource = () => { throw new Error('sidebar unavailable') }
  button(rt.card(settled), '在侧栏查看').props.onClick()
  assert.match(text(rt.card(settled)), /sidebar unavailable/)
})

test('durable resource reads deduplicate concurrent holders, honor abort and retry after failure', async t => {
  let calls = 0, finish
  const rt = harness({ api: { readAdvice: async () => { calls++; return new Promise(resolve => { finish = resolve }) } } })
  t.after(() => rt.dispose())
  const provider = rt.providers[0], address = adviceAddress('s1', 'tool:c1')
  const aborted = new AbortController()
  const one = provider.open(address, { signal: aborted.signal }).next()
  const two = provider.open(address, { signal: new AbortController().signal }).next()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  aborted.abort()
  finish({ ok: false, error: 'synthetic missing record' })
  assert.equal((await one).done, true)
  assert.equal((await two).value.ok, false)
  const retry = provider.open(address, { signal: new AbortController().signal }).next()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  finish({ ok: true, value: { ok: true, advice } })
  assert.equal((await retry).value.value.advice.callId, 'tool:c1')
})

test('remote recognizes stable Cordis proxies and releases replaced connections', async t => {
  const rt = harness(); t.after(() => rt.dispose())
  const call = rt.plugin.__test.runtime.advisorCall
  const request = { sessionId: 's1', kind: 'tool', id: 'c1' }
  await call('callModelUsage', request)
  let mounts = 0, releases = 0
  const original = {}
  const get = rt.ctx.get
  rt.ctx.get = name => name === 'remote' ? { [Symbol.for('cordis.original')]: original, async $mount() { mounts++; return () => { releases++ } } } : get(name)
  assert.equal((await call('callModelUsage', request)).ok, true)
  rt.events.get('connection/reset')()
  assert.equal((await call('callModelUsage', request)).ok, true)
  assert.equal(mounts, 1)
  await rt.dispose()
  assert.equal(releases, 1)
})


test('settings footer seals the host bottom gutter and keeps action buttons together', async () => {
  const rt = harness(); const tree = rt.render()
  const footer = nodes(tree).find(node => node.props['data-ciel-settings-footer'] === '')
  assert.equal(footer.props['aria-label'], '设置保存操作')
  assert.equal(footer.props['data-dirty'], false)
  const actions = nodes(footer).find(node => node.props['data-ciel-settings-footer-actions'] === '')
  assert.ok(button(actions, '放弃')); assert.ok(button(actions, '保存'))
  const styles = css('settings.css')
  assert.match(styles, /--ciel-settings-gutter:24px/)
  assert.match(styles, /\[data-ciel-settings-footer\]::after\s*\{[^}]*top:100%;[^}]*height:var\(--ciel-settings-gutter\);background:var\(--dsw-alias-bg-layer-2\)/)
  assert.doesNotMatch(styles, /pointer-events:none|backdrop-filter/)
  await rt.dispose()
})
