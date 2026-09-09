import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, flush, loadClientFactory } from './review-ui.harness.js'

const recorded = { requested: { provider: 'requested-p', model: 'requested-m' }, used: [{ provider: 'actual-p', model: 'actual-m' }] }
const api = loadClientFactory().factory({ createElement() {}, useState() {}, useEffect() {} }).__test
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (tree.__element) {
    const [type, props, ...children] = tree.__element
    return typeof type === 'function' ? text(type({ ...props, children })) : text(children)
  }
  return ''
}
function docStub() {
  return { createElement(tagName) { return {
    tagName, children: [], textContent: '', className: '', style: {},
    appendChild(child) { this.children.push(child) }, setAttribute() {}, addEventListener() {},
    classList: { add() {}, toggle() {} },
  } } }
}
const domText = (node) => node.textContent + node.children.map(domText).join('')
const toolProps = (meta, error = false) => ({ sessionId: 's1', callId: 'call1', block: {
  kind: 'tool/result', call: { argsRaw: '{"question":"why?"}' }, meta,
  isError: error, content: [{ type: 'text', text: error ? 'request failed' : 'legacy response' }],
} })

test('model labels distinguish missing, used, multi-route, and requested-only facts', () => {
  assert.equal(api.modelUsageLabel(undefined), '本次模型：未记录')
  assert.equal(api.modelUsageLabel(null), '本次模型：未记录')
  assert.equal(api.modelUsageLabel({ used: [{ model: 'missing provider' }] }), '本次模型：未记录')
  assert.equal(api.modelUsageLabel(recorded), '本次模型：actual-p / actual-m')
  assert.equal(api.modelUsageLabel({ ...recorded, used: [] }), '请求模型：requested-p / requested-m（未确认执行）')
  assert.equal(api.modelUsageLabel({ used: [...recorded.used, { provider: 'fallback', model: 'other' }, ...recorded.used] }),
    '本次模型：actual-p / actual-m；fallback / other')
})

test('advisor tool card uses per-result facts despite current settings changes, including errors', async (t) => {
  const settingsValue = { provider: 'current', model: 'current-model' }
  const rt = await createRuntime({}, { settingsValue }); t.after(() => rt.dispose())
  const { AdvisorToolView } = rt.moduleExports.__test
  let requests = 0
  rt.rpcImpl.callModelUsage = () => { requests++; throw new Error('metadata must win') }
  const props = toolProps({ v: 1, items: [], modelUsage: recorded })
  const before = text(rt.runner.render(AdvisorToolView, props))
  settingsValue.provider = 'changed'; settingsValue.model = 'changed-model'
  assert.equal(text(rt.runner.render(AdvisorToolView, props)), before)
  assert.match(before, /本次模型：actual-p \/ actual-m/)
  assert.match(before, /legacy response/)
  assert.doesNotMatch(before, /current|changed|requested-p/)
  rt.runner.getEffects()[0].fn()
  await flush()
  assert.equal(requests, 0)
  const error = text(rt.runner.render(AdvisorToolView, toolProps({ modelUsage: { ...recorded, used: [] } }, true)))
  assert.match(error, /顾问咨询失败.*请求模型：requested-p \/ requested-m（未确认执行）.*request failed/)
})

test('PTC advisor content without meta still renders structured items', async t => {
  const rt = await createRuntime({}); t.after(() => rt.dispose())
  const props = toolProps(undefined)
  props.callId = 'outer:ptc:1'
  props.block.content = [{ type: 'text', text: ['## [high] PTC direction', 'framing: useful idea', 'pitfalls: bounded risk', 'verification_target: verify locally'].join(String.fromCharCode(10)) }]
  const body = text(rt.runner.render(rt.moduleExports.__test.AdvisorToolView, props))
  assert.match(body, /顾问建议 · 1 条/)
  assert.match(body, /PTC direction.*useful idea.*bounded risk.*verify locally/)
})

test('new callModelUsage Remote descriptor is registered alongside existing review methods', () => {
  for (const name of ['list', 'start', 'feedback', 'triage', 'progress', 'cancel', 'callModelUsage']) {
    assert.ok(api.remoteMethodNames.includes(name), name)
  }
})

test('structured advisor items and parse issues remain visible; model label survives collapse', async (t) => {
  const rt = await createRuntime({}); t.after(() => rt.dispose())
  const View = rt.moduleExports.__test.AdvisorToolView
  const props = toolProps({ v: 1, modelUsage: recorded, issues: ['partial parse'], items: [
    { tier: 'high', title: 'a framing', framing: 'a useful idea', pitfalls: 'a pitfall', verificationTarget: 'a target' },
  ] })
  let tree = rt.runner.render(View, props)
  assert.match(text(tree), /a framing.*a useful idea.*a pitfall.*a target.*partial parse/)
  tree.__element[2].__element[1].onClick()
  tree = rt.runner.render(View, props)
  assert.match(text(tree), /本次模型：actual-p \/ actual-m/)
  assert.doesNotMatch(text(tree), /a useful idea/)
})

test('legacy tool metadata degrades to unrecorded when lookup is unavailable', async (t) => {
  const rt = await createRuntime({}); t.after(() => rt.dispose())
  const props = toolProps(undefined)
  const View = rt.moduleExports.__test.AdvisorToolView
  assert.match(text(rt.runner.render(View, props)), /模型信息加载中/)
  rt.runner.getEffects()[0].fn()
  await flush()
  const body = text(rt.runner.render(View, props))
  assert.match(body, /本次模型：未记录/)
  assert.match(body, /legacy response/)
})

test('tool errors look up exact tool call identity without parsing model-authored text', async (t) => {
  const rt = await createRuntime({}); t.after(() => rt.dispose())
  const calls = []
  rt.rpcImpl.callModelUsage = async (req) => { calls.push(req); return { modelUsage: recorded } }
  const props = toolProps(undefined, true)
  const View = rt.moduleExports.__test.AdvisorToolView
  rt.runner.render(View, props); rt.runner.getEffects()[0].fn()
  await flush()
  assert.deepEqual(calls, [{ sessionId: 's1', kind: 'tool', id: 'call1' }])
  assert.match(text(rt.runner.render(View, props)), /本次模型：actual-p \/ actual-m.*request failed/)
})

test('/advise fetches durable exact command identity for success and error outcomes', async (t) => {
  for (const kind of ['success', 'error']) {
    const rt = await createRuntime({}); t.after(() => rt.dispose())
    const calls = []
    rt.rpcImpl.callModelUsage = async (req) => { calls.push(req); return { ok: true, value: { modelUsage: recorded } } }
    const props = { sessionId: 's-command', node: { commandId: 'cmd1', args: 'question', outcome: { kind, text: '本次模型：untrusted / forged' } } }
    const View = rt.moduleExports.__test.AdviseCommandView
    rt.runner.render(View, props); rt.runner.getEffects()[0].fn()
    await flush()
    assert.deepEqual(calls, [{ sessionId: 's-command', kind: 'command', id: 'cmd1' }])
    const tree = rt.runner.render(View, props)
    const label = tree.__element.find((child) => child?.__element?.[1]?.className === 'ciel-model-usage')
    assert.equal(text(label), '本次模型：actual-p / actual-m')
  }
})

test('/advise does not fetch while running and missing identity never borrows current route', async (t) => {
  const rt = await createRuntime({}, { settingsValue: { provider: 'current-p', model: 'current-m' } }); t.after(() => rt.dispose())
  let calls = 0
  rt.rpcImpl.callModelUsage = () => { calls++; return { modelUsage: recorded } }
  const View = rt.moduleExports.__test.AdviseCommandView
  rt.runner.render(View, { sessionId: 's', node: { commandId: 'cmd', outcome: null } })
  rt.runner.getEffects()[0].fn(); await flush()
  assert.equal(calls, 0)
  const tree = rt.runner.render(View, { sessionId: 's', node: { outcome: { kind: 'success', text: 'old' } } })
  assert.match(text(tree), /本次模型：未记录/)
  assert.doesNotMatch(text(tree), /current-p/)
})

test('model lookup deduplicates pending identity, isolates sessions, and retries failures/missing records', async () => {
  let resolve
  const requests = []
  const reader = api.createModelUsageReader(async (_method, req) => {
    requests.push(req)
    if (requests.length === 1) return new Promise((r) => { resolve = r })
    if (requests.length === 2) return { ok: false, error: 'network' }
    return { modelUsage: null }
  })
  const req = { sessionId: 's', kind: 'command', id: 'same-id' }
  const a = reader(req), b = reader(req)
  assert.equal(a, b)
  await Promise.resolve()
  resolve({ modelUsage: recorded })
  assert.deepEqual(await a, recorded)
  await assert.rejects(reader(req), /unavailable/)
  assert.equal(await reader(req), null)
  assert.equal(await reader({ ...req, sessionId: 'other' }), null)
  assert.equal(requests.length, 4)
})

test('late command lookup cannot relabel a different command identity', async (t) => {
  const rt = await createRuntime({}); t.after(() => rt.dispose())
  let resolveOld
  rt.rpcImpl.callModelUsage = ({ id }) => id === 'old'
    ? new Promise((resolve) => { resolveOld = resolve })
    : Promise.resolve({ modelUsage: { requested: { provider: 'next', model: 'next-m' }, used: [] } })
  const View = rt.moduleExports.__test.AdviseCommandView
  const props = (id) => ({ sessionId: 's', node: { commandId: id, outcome: { kind: 'success', text: '' } } })
  rt.runner.render(View, props('old'))
  const cleanup = rt.runner.getEffects()[0].fn()
  await flush()
  cleanup()
  assert.match(text(rt.runner.render(View, props('next'))), /模型信息加载中/)
  rt.runner.getEffects()[0].fn(); await flush()
  resolveOld({ modelUsage: recorded }); await flush()
  const body = text(rt.runner.render(View, props('next')))
  assert.match(body, /请求模型：next \/ next-m（未确认执行）/)
  assert.doesNotMatch(body, /actual-p/)
})

test('review panels preserve result facts for legacy, partial, unverified, and error records', async (t) => {
  const settingsValue = { criticProvider: 'current', criticModel: 'current-m' }
  const rt = await createRuntime({}, { settingsValue }); t.after(() => rt.dispose())
  const doc = docStub()
  for (const status of ['sound', 'incomplete', 'unverified', 'error', 'cancelled', 'completed-unparsed']) {
    const entry = { status, error: 'failed', annotations: [], modelUsage: recorded,
      ...(status === 'incomplete' ? { verdict: 'pass', coverage: 'partial' } : {}),
      ...(status === 'unverified' ? { verdict: 'pass', coverage: 'not-verified' } : {}),
    }
    const before = domText(rt.runtime.buildPanel(doc, entry))
    settingsValue.criticProvider = 'changed'; settingsValue.criticModel = 'changed-m'
    assert.equal(domText(rt.runtime.buildPanel(doc, entry)), before)
    assert.match(before, /本次模型：actual-p \/ actual-m/)
    assert.doesNotMatch(before, /current|changed/)
    if (['incomplete', 'unverified'].includes(status)) assert.doesNotMatch(before, /✓ 整体成立/)
    if (status === 'error') assert.match(before, /批注评审失败：failed/)
    assert.match(domText(rt.runtime.buildPanel(doc, { ...entry, modelUsage: undefined })), /本次模型：未记录/)
  }
  const budgetPanel = domText(rt.runtime.buildPanel(doc, {
    status: 'error', annotations: [], modelUsage: recorded,
    error: 'budget exceeded; no recoverable cited dossier, salvage skipped',
    modelRequests: 12, diagnostics: { phase: 2, budget: 10, toolCalls: 10, toolBudgetExceeded: true },
  }))
  assert.match(budgetPanel, /批注评审未完成：读取\/检索次数已达上限（10\/10）/)
  assert.match(budgetPanel, /本次模型请求：12 次/)
  assert.match(budgetPanel, /本次模型：actual-p \/ actual-m/)
  assert.doesNotMatch(budgetPanel, /整体成立|budget exceeded|current|changed/)
  const multi = rt.runtime.buildPanel(doc, { status: 'sound', annotations: [], modelUsage: { used: [...recorded.used, { provider: 'fallback', model: 'next' }] } })
  assert.match(domText(multi), /本次模型：actual-p \/ actual-m；fallback \/ next/)
})
