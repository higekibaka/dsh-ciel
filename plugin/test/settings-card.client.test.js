import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientFactory } from './review-ui.harness.js'

const DEFAULTS = {
  provider: 'kimi-coding', model: 'kimi-for-coding', maxTokens: 4096, maxCallsPerTurn: 3,
  requireExploration: true, enforceFollowupGap: true, planReminderEnabled: true,
  reasoningEffort: 'provider', guidanceEnabled: true, criticProvider: 'google',
  criticModel: 'gemini-3.8-flash', criticEffort: 'medium', criticExploreEnabled: true,
  enabled: true, criticTimeoutSeconds: 180,
  criticMaxTokens: 16384, advisorTimeoutSeconds: 180,
  criticAdditionalRoots: [],
}

function settingsCard(overrides = {}) {
  let state = []
  let cursor = 0
  let revision = 0
  let loseResponse = false
  const mutations = []
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
  const value = { ...DEFAULTS, criticExploreBudget: 20, ...overrides }
  const user = { ...overrides }
  const writes = []
  const cleanups = []
  plugin.apply({
    settingsScope: { bind: () => ({
      getSnapshot: () => ({ status: 'ready', writable: true, value, user, revision }),
      subscribe: () => () => {},
      async mutate(ops, expectedRevision) {
        assert.equal(expectedRevision, revision)
        mutations.push(ops)
        for (const op of ops) {
          const key = op.path[0]
          if (op.op === 'set') { writes.push(['set', key, op.value]); value[key] = op.value; user[key] = op.value }
          else { writes.push(['unset', key]); value[key] = key === 'criticExploreBudget' ? 20 : DEFAULTS[key]; delete user[key] }
        }
        revision++
        if (loseResponse) { loseResponse = false; throw new Error('synthetic lost response') }
      },
    }) },
    on: () => () => {}, get: () => undefined,
    slots: { inject(name, register) { if (name === 'settings.section' || name === 'settings.plugin.item') register() }, register(def) { registrations.push(def); return () => {} } },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  })
  return {
    api: plugin.__test, writes, value, mutations, registrations,
    loseNextSaveResponse() { loseResponse = true },
    externalEdit(key, next) { value[key] = next; revision++ },
    remount() { state = []; cursor = 0 },
    render() { cursor = 0; return plugin.__test.CielSettingsSection() },
    dispose() { cleanups.forEach((fn) => fn()) },
  }
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
const button = (tree, label) => nodes(tree).find((n) => n.type === 'button' && text(n) === label)
const input = (tree, label) => nodes(tree).find((n) => (['input', 'select', 'textarea'].includes(n.type) || n.props.role === 'switch') && n.props['aria-label'] === label)
function open(rt) { return rt.render() }

test('Ciel registers one dedicated left-navigation page after Agent presets', t => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  assert.equal(rt.registrations.length, 1)
  assert.equal(rt.registrations[0].name, 'settings.section')
  assert.equal(rt.registrations[0].id, 'ciel')
  assert.equal(rt.registrations[0].order, 30)
  assert.equal(rt.registrations[0].label(), '夏尔 Ciel')
})

test('unsaved Switch state survives navigation while status distinguishes persisted and staged values', t => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  let tree = open(rt)
  input(tree, '启用 Ciel').props.onClick()
  tree = rt.render()
  assert.match(text(tree), /当前已启用/)
  assert.match(text(tree), /待保存 · 已关闭/)
  rt.remount()
  tree = rt.render()
  assert.equal(input(tree, '启用 Ciel').props['aria-checked'], false)
  assert.deepEqual(rt.writes, [])
  button(tree, '放弃').props.onClick()
  assert.equal(input(rt.render(), '启用 Ciel').props['aria-checked'], true)
})

test('a changed namespace revision refuses stale save without discarding the draft', async t => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  input(open(rt), '启用 Ciel').props.onClick()
  rt.externalEdit('maxCallsPerTurn', 7)
  await button(rt.render(), '保存').props.onClick()
  assert.deepEqual(rt.writes, [])
  assert.match(text(rt.render()), /保存未确认，草稿已保留/)
  assert.equal(input(rt.render(), '启用 Ciel').props['aria-checked'], false)
  button(rt.render(), '放弃').props.onClick()
  assert.equal(input(rt.render(), '每个代理回合最多咨询几次').props.value, '7')
})

test('a lost save response can be acknowledged without sending a duplicate write', async t => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  input(open(rt), '启用 Ciel').props.onClick()
  rt.loseNextSaveResponse()
  await button(rt.render(), '保存').props.onClick()
  const tree = rt.render()
  assert.equal(rt.value.enabled, false)
  assert.match(text(tree), /保存未确认/)
  assert.equal(button(tree, '保存').props.disabled, true)
  assert.equal(button(tree, '放弃').props.disabled, false)
  button(tree, '放弃').props.onClick()
  assert.doesNotMatch(text(rt.render()), /保存未确认/)
  assert.equal(rt.mutations.length, 1)
})

test('additional source roots are explicit, staged, validated and saved as an array', async (t) => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  let tree = open(rt)
  nodes(tree).find((n) => n.type === 'button' && text(n).startsWith('高级设置')).props.onClick()
  tree = rt.render()
  const label = rt.api.fieldDefinition('criticAdditionalRoots').label
  input(tree, label).props.onChange({ target: { value: '/opt/project-one\n/opt/framework' } })
  tree = rt.render()
  assert.deepEqual(rt.writes, [])
  assert.equal(button(tree, '保存').props.disabled, false)
  await button(tree, '保存').props.onClick()
  assert.deepEqual(rt.writes, [['set', 'criticAdditionalRoots', ['/opt/project-one', '/opt/framework']]])
  tree = rt.render()
  input(tree, label).props.onChange({ target: { value: '/opt/project/../private' } })
  tree = rt.render()
  assert.equal(input(tree, label).props['aria-invalid'], true)
  assert.equal(button(tree, '保存').props.disabled, true)
})

test('settings retain all baseline defaults and exactly one editor per configuration key', (t) => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  assert.deepEqual(rt.api.defaults, DEFAULTS)
  assert.deepEqual([...rt.api.fieldKeys].sort(), Object.keys(DEFAULTS).sort())
  assert.equal(new Set(rt.api.fieldKeys).size, Object.keys(DEFAULTS).length)
  assert.deepEqual(rt.writes, [])
})

test('global switch is first; common controls open and advanced/model groups stay collapsed', (t) => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  const tree = open(rt)
  assert.equal(tree.type, 'section')
  const controls = nodes(tree).filter((n) => n.type === 'input' || n.type === 'select' || n.props.role === 'switch')
  assert.equal(controls[0].props['aria-label'], '启用 Ciel')
  assert.equal(controls[0].props['aria-checked'], true)
  assert.equal(controls[0].props['data-fixture-native'], 'Switch')
  const hint = rt.api.fieldDefinition('enabled').hint
  for (const part of ['保存后', 'ask_advisor', '批注评审', '新的批注回传', '取消正在进行', '既有结果仍可查看']) assert.ok(hint.includes(part), part)
  const groups = nodes(tree).filter((n) => n.type === 'button' && n.props['aria-expanded'] !== undefined)
  assert.equal(groups.find((n) => text(n).includes('常用设置')).props['aria-expanded'], true)
  for (const name of ['高级设置（通常保持默认）', '顾问管道', '批评者（批注评审）路由']) {
    assert.equal(groups.find((n) => text(n).includes(name)).props['aria-expanded'], false)
  }
  assert.match(text(tree), /顾问.*批评者/)
  assert.match(text(tree), /以下修改均在点击「保存」后生效/)
  assert.ok(!text(tree).includes('启用批评者评审'))
  assert.equal(button(tree, '保存').props.disabled, true)
  for (const control of controls) {
    assert.ok(control.props['aria-label'])
    if (control.props.role === 'switch') assert.ok(control.props.title)
    else assert.ok(nodes(tree).some((n) => n.props.id === control.props['aria-describedby']))
  }
})

test('settings explain time-only reviews and preserve separate advisor quotas', (t) => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  const hint = (key) => rt.api.fieldDefinition(key).hint
  assert.equal(rt.api.fieldDefinition('criticExploreBudget'), undefined)
  assert.equal(rt.api.fieldDefinition('criticMaxRequests'), undefined)
  assert.match(hint('criticTimeoutSeconds'), /不限制查询次数或模型请求次数/)
  assert.match(hint('maxCallsPerTurn'), /实际 turn.*不等于.*规划阶段/)
  for (const key of ['advisorTimeoutSeconds', 'criticTimeoutSeconds']) assert.match(hint(key), /不是费用上限/)
  assert.match(hint('guidanceEnabled'), /保存后/)
  assert.doesNotMatch(hint('criticExploreEnabled'), /保密|公开|世界可碰/)
})

test('global toggle and numeric edits stay staged, discard restores, one save writes original keys', async (t) => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  let tree = open(rt)
  input(tree, '启用 Ciel').props.onClick()
  tree = rt.render()
  input(tree, '每个代理回合最多咨询几次').props.onChange({ target: { value: '4' } })
  tree = rt.render()
  assert.deepEqual(rt.writes, [])
  button(tree, '放弃').props.onClick()
  tree = rt.render()
  assert.equal(input(tree, '启用 Ciel').props['aria-checked'], true)
  assert.equal(input(tree, '每个代理回合最多咨询几次').props.value, '3')
  input(tree, '启用 Ciel').props.onClick()
  tree = rt.render()
  input(tree, '每个代理回合最多咨询几次').props.onChange({ target: { value: '4' } })
  tree = rt.render()
  assert.equal(nodes(tree).filter((n) => n.type === 'button' && text(n) === '保存').length, 1)
  await button(tree, '保存').props.onClick()
  assert.deepEqual(rt.writes, [['set', 'enabled', false], ['set', 'maxCallsPerTurn', 4]])
  assert.equal(rt.mutations.length, 1, 'all fields share one atomic Save')
  assert.equal(button(rt.render(), '保存').props.disabled, true)
})

test('numeric reset stages a renderable default, can discard, and only unsets on save', async (t) => {
  const rt = settingsCard({ maxCallsPerTurn: 8 }); t.after(() => rt.dispose())
  let tree = open(rt)
  button(tree, '重置').props.onClick()
  tree = rt.render()
  assert.equal(input(tree, '每个代理回合最多咨询几次').props.value, '3')
  assert.deepEqual(rt.writes, [])
  button(tree, '放弃').props.onClick()
  tree = rt.render()
  assert.equal(input(tree, '每个代理回合最多咨询几次').props.value, '8')
  button(tree, '重置').props.onClick()
  await button(rt.render(), '保存').props.onClick()
  assert.deepEqual(rt.writes, [['unset', 'maxCallsPerTurn']])
})

test('model route groups preserve their labels, defaults, catalog choices, and custom effort', (t) => {
  const rt = settingsCard(); t.after(() => rt.dispose())
  let tree = open(rt)
  const advisor = nodes(tree).find((n) => n.type === 'button' && text(n).includes('顾问管道'))
  advisor.props.onClick()
  tree = rt.render()
  assert.equal(input(tree, '提供方路由').props.value, 'kimi-coding')
  assert.equal(input(tree, '顾问模型').props.value, 'kimi-for-coding')
  assert.equal(input(tree, '思考深度').props.value, 'provider')
  rt.api.getSettingsEditor().set('catalog', { status: 'ready', groups: [{ id: 'kimi-coding', displayName: 'Kimi', models: [
    { id: 'kimi-for-coding', name: 'Coding', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } },
  ] }] })
  tree = rt.render()
  assert.equal(input(tree, '顾问模型').type, 'select')
  assert.match(text(input(tree, '顾问模型')), /Coding（kimi-for-coding）/)
  assert.match(text(input(tree, '思考深度')), /跟随提供方默认.*高（high） · 模型默认/)
  input(tree, '思考深度').props.onChange({ target: { value: 'medium' } })
  assert.match(text(input(rt.render(), '思考深度')), /medium（自定义）/)
  assert.deepEqual(rt.writes, [])
})
