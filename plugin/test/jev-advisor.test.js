import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, parseAdvisorItems } from '../index.js'
import { resolvedConfig } from './config-fixture.js'
import { prepareAdvisorJev, checkAdvisorWithJev, renderAdvisorJev } from '../jev-advisor.js'
import { JEV_MODEL } from '../jev-client.js'
import { isAdvisorJev, parseAdvisorResult } from '../advisor-protocol.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-advisor-jev-'))
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const section = (n = 1, framing = 'Use an in-process queue.') => `## [high] Direction ${n}\nframing: ${framing}\npitfalls: Queue saturation.\nverification_target: Check the memory limit.\n`
const input = (text = section()) => ({ question: 'Which queue fits?', context: 'Only one process is available.', text, items: parseAdvisorItems(text).items })
const answer = ids => ({ model: JEV_MODEL, answers: Object.fromEntries(ids.map((id, i) => {
  const choice = ['supports', 'contradicts', 'insufficient'][i % 3]
  return [id, { type: 'choice', choice, confidence: 0.8,
    probabilities: Object.fromEntries(['supports', 'contradicts', 'insufficient'].map(key => [key, key === choice ? 0.8 : 0.1])) }]
})), usage: { input_tokens: 200, output_tokens: 20 } })
const check = options => checkAdvisorWithJev({ prepared: prepareAdvisorJev(input()), enabled: true, apiKey: 'fixture-key', ...options })

test('advisor check uses complete original sections beyond UI bounds and only the supplied context', () => {
  const original = section(1, 'Useful premise. '.repeat(140) + 'TAIL_CONSTRAINT') + section(2)
  const data = input(original), prepared = prepareAdvisorJev(data)
  assert.ok(data.items[0].framing.length < prepared.request.state.items.a1.advice.length)
  assert.equal(prepared.request.state.items.a1.advice + prepared.request.state.items.a2.advice, original)
  assert.match(prepared.request.state.items.a1.advice, /TAIL_CONSTRAINT/)
  assert.equal(prepared.request.state.context, data.context)
  assert.equal(prepared.request.state.question, data.question)
  assert.match(prepared.request.questions.a1.instructions, /not independent fact verification/)
  assert.match(prepared.request.questions.a1.instructions, /untrusted data/)
})

test('recognized heading with missing/empty framing yields no-exact-claim', () => {
  const noItemData = input(section(1))
  delete noItemData.items[0]
  const noItemPrepared = prepareAdvisorJev(noItemData)
  assert.equal(noItemPrepared.checks[0].reason, 'no-exact-claim')

  const noFramingData = input(section(1))
  delete noFramingData.items[0].framing
  const noFramingPrepared = prepareAdvisorJev(noFramingData)
  assert.equal(noFramingPrepared.checks[0].reason, 'no-exact-claim')

  const emptyFramingData = input(section(1))
  emptyFramingData.items[0].framing = ''
  const emptyFramingPrepared = prepareAdvisorJev(emptyFramingData)
  assert.equal(emptyFramingPrepared.checks[0].reason, 'no-exact-claim')
})

test('aggregate 24-KiB request-budget boundaries across individually valid sections', () => {
  const s1Text = section(1, 'a'.repeat(10 * 1024))
  const data1 = input(s1Text)

  const MAX_STATE_BYTES = 24 * 1024
  const baseS2Text = section(2, '')
  // Calculate overhead of adding a2 object
  const dualSize = Buffer.byteLength(JSON.stringify({ question: data1.question, context: data1.context, items: { a1: { advice: s1Text }, a2: { advice: baseS2Text } } }))
  const exactPadding = MAX_STATE_BYTES - dualSize

  const exactData = input(s1Text + section(2, 'b'.repeat(exactPadding)))
  const exactPrepared = prepareAdvisorJev(exactData)
  assert.equal(exactPrepared.checks[0].status, 'pending')
  assert.equal(exactPrepared.checks[1].status, 'pending')

  const overflowData = input(s1Text + section(2, 'b'.repeat(exactPadding + 1)))
  const overflowPrepared = prepareAdvisorJev(overflowData)
  assert.equal(overflowPrepared.checks[0].status, 'pending')
  assert.equal(overflowPrepared.checks[1].reason, 'input-too-large')
})

test('oversized and sensitive input is skipped explicitly instead of clipped', () => {
  for (const [reason, data] of [
    ['input-too-large', input(section(1, '文'.repeat(9000)))],
    ['input-too-large', { ...input(), context: '文'.repeat(9000) }],
    ['sensitive-input', input(section(1, 'safe '.repeat(400) + 'api_key = "' + 's'.repeat(40) + '"'))],
    ['sensitive-input', { ...input(), question: 'api_key = "' + 's'.repeat(40) + '"' }],
    ['sensitive-input', { ...input(), context: 'api_key = "' + 's'.repeat(40) + '"' }],
  ]) {
    const prepared = prepareAdvisorJev(data)
    assert.equal(prepared.checks[0].reason, reason)
    assert.deepEqual(prepared.request.state, { items: {} })
    assert.deepEqual(prepared.request.questions, {})
  }
  const prepared = prepareAdvisorJev(input(section(1, '文'.repeat(9000)) + section(2)))
  assert.equal(prepared.checks[1].status, 'pending')
  assert.deepEqual(Object.keys(prepared.request.state.items), ['a2'])
})

test('checks at most six suggestions and reports missing structured advice', async () => {
  const prepared = prepareAdvisorJev(input(Array.from({ length: 8 }, (_, i) => section(i)).join('\n')))
  assert.equal(prepared.checks.length, 6)
  assert.equal(prepared.omittedChecks, 2)
  const result = await check({ prepared: prepareAdvisorJev(input('Unstructured answer.')), fetchImpl: () => assert.fail('must not request') })
  assert.equal(result.reason, 'no-eligible-claims')
  assert.ok(isAdvisorJev(result))
})

test('renderAdvisorJev output assertions', () => {
  const result = {
    status: 'partial',
    reason: 'timeout',
    omittedChecks: 2,
    checks: [
      { id: 'a1', status: 'completed', relation: 'supports' },
      { id: 'a2', status: 'completed', relation: 'contradicts' },
      { id: 'a3', status: 'completed', relation: 'insufficient' },
      { id: 'a4', status: 'skipped', reason: 'no-exact-claim' }
    ]
  }
  const rendered = renderAdvisorJev(result)
  assert.match(rendered, /\[Ciel Jev 顾问建议检查：partial\]/)
  assert.match(rendered, /仅与本次传入的背景核对，未独立验证事实。依据不足不代表建议错误；采用前仍需核实。/)
  assert.match(rendered, /- 建议 1：背景支持/)
  assert.match(rendered, /- 建议 2：背景冲突/)
  assert.match(rendered, /- 建议 3：依据不足/)
  assert.match(rendered, /- 建议 4：未检查（no-exact-claim）/)
  assert.match(rendered, /未完成原因：timeout/)
  assert.match(rendered, /另有 2 条建议未检查。/)

  const cleanResult = { status: 'completed', checks: [], omittedChecks: 0 }
  const cleanRendered = renderAdvisorJev(cleanResult)
  assert.doesNotMatch(cleanRendered, /未完成原因/)
  assert.doesNotMatch(cleanRendered, /未检查。/)
})

test('one batch returns all three relations; supplement preserves original advice parsing', async () => {
  const data = input(section(1) + section(2) + section(3))
  let calls = 0
  const result = await check({ prepared: prepareAdvisorJev(data), fetchImpl: async (_url, options) => {
    calls++
    return Response.json(answer(Object.keys(JSON.parse(options.body).questions)))
  } })
  assert.equal(calls, 1)
  assert.equal(result.scope, 'provided-context')
  assert.deepEqual(result.checks.map(row => row.relation), ['supports', 'contradicts', 'insufficient'])
  assert.ok(isAdvisorJev(result))
  assert.deepEqual(parseAdvisorItems(renderAdvisorJev(result) + '\n\n' + data.text), parseAdvisorItems(data.text))
  const rpc = { ok: true, advice: { sessionId: 's1', callId: 'c1', text: data.text, jev: result } }
  parseAdvisorResult('readAdvice', rpc)
  for (const mutate of [
    r => { r.scope = 'verified-facts' }, r => { r.checks[0].id = 'a7' },
    r => { r.checks[0].relation = 'safe' }, r => { r.checks.push(r.checks[0]) },
    r => { r.checks[0].probabilities.supports = 0 }, r => { r.requestCount = 2 },
  ]) {
    const copy = structuredClone(rpc); mutate(copy.advice.jev)
    assert.equal(isAdvisorJev(copy.advice.jev), false)
    assert.throws(() => parseAdvisorResult('readAdvice', copy))
  }
})

test('off, missing credentials, time budget and transport failure return labeled optional results', async () => {
  for (const [reason, options, count] of [
    ['disabled', { enabled: false }, 0], ['missing-key', { apiKey: '' }, 0],
    ['time-unavailable', { timeoutMs: 0 }, 0],
    ['http-error', {}, 1], ['timeout', { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }, 1],
  ]) {
    let calls = 0
    const fetchImpl = options.fetchImpl || (async () => new Response('private upstream error', { status: 503 }))
    const result = await check({ ...options, fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })
    assert.equal(result.reason, reason)
    assert.equal(calls, count)
    assert.ok(isAdvisorJev(result))
    assert.doesNotMatch(JSON.stringify(result), /private upstream error|fixture-key/)
  }
})

let serial = 0
async function harness(t, overrides = {}, fetchImpl = () => assert.fail('unexpected Jev request')) {
  const previousFetch = globalThis.fetch, previousKey = process.env.TYPESAFE_API_KEY
  globalThis.fetch = fetchImpl
  process.env.TYPESAFE_API_KEY = 'fixture-key'
  t.after(() => {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
  })
  const ctx = new Context(), config = resolvedConfig(overrides)
  const parent = { id: 'advisor-jev-' + (++serial), session: { snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } }, { type: 'tool/call', data: { name: 'read', callId: 'read-1' } },
  ] } }
  const requests = [], disposals = []
  let tool
  const provider = ctx.plugin({ name: 'advisor-test-boundary', apply(c) {
    c.provide('tools', { register: definition => { tool = definition }, guard: () => () => {} })
    c.provide('subagents', { startActivation: async (spec) => {
      requests.push(spec)
      return { childId: spec.childId ?? (parent.id + '-child'), messageId: 'm-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: section().trim() }] }),
        dispose: async () => { disposals.push(true) } }
    } })
  } })
  await provider.await()
  const owner = ctx.plugin({ name: 'advisor-under-test', apply: c => apply(c, config) })
  await owner.await()
  t.after(async () => { await owner.dispose(); await provider.dispose() })
  assert.ok(tool)
  const callId = 'consult-1'
  return { tool, requests, disposals,
    call: signal => tool.execute({ question: input().question, context: input().context }, { agent: parent, callId, signal }),
    configure(patch) { Object.assign(config, patch); ctx.emit('loader/volatile-update') },
    read: () => ctx.get('cielAdvisor').readAdvice({ sessionId: parent.id, callId: 'tool:' + callId }),
  }
}

test('advisor checks default off and do not request Jev', async t => {
  assert.equal(resolvedConfig({}).advisorJevEnabled, false)
  const h = await harness(t)
  const value = await h.call()
  assert.equal(value.jev, undefined)
  assert.equal(value.text, section().trim())
  assert.equal(h.tool.output.render({}, value)[0].text, section().trim())
  assert.equal((await h.read()).advice.jev, undefined)
  assert.equal(h.requests.length, 1)
  assert.equal(h.disposals.length, 1)
})

test('advisor uses saved shared connection and sees live changes before its optional stage', async t => {
  const h = await harness(t, { advisorJevEnabled: true, jevApiKey: 'old-fixture' }, async (url, options) => {
    assert.equal(url, 'https://proxy.invalid/systemone')
    assert.equal(options.headers.Authorization, 'Bearer saved-fixture')
    assert.equal(JSON.parse(options.body).model, 'jev-new')
    return Response.json(answer(['a1']))
  })
  const pending = h.call()
  h.configure({ jevApiKey: 'saved-fixture', jevEndpoint: 'https://proxy.invalid/systemone', jevModel: 'jev-new' })
  const value = await pending
  assert.equal(value.jev.requestedModel, 'jev-new')
  assert.ok(isAdvisorJev(value.jev))
  assert.doesNotMatch(JSON.stringify(await h.read()), /saved-fixture|proxy.invalid/)
})

test('enabled host persists original reply and returns Jev to the model and presentation metadata', async t => {
  let calls = 0
  const h = await harness(t, { advisorJevEnabled: true }, async (_url, options) => {
    calls++
    const request = JSON.parse(options.body)
    assert.equal(request.state.items.a1.advice, section().trim())
    return Response.json(answer(Object.keys(request.questions)))
  })
  const value = await h.call()
  assert.equal(calls, 1)
  assert.equal(value.text, section().trim())
  assert.ok(isAdvisorJev(value.jev))
  assert.match(h.tool.output.render({}, value)[0].text, /背景支持/)
  assert.ok(h.tool.output.render({}, value)[0].text.endsWith(section().trim()))
  assert.deepEqual(h.tool.output.presentationMeta({}, value).jev, value.jev)
  const saved = await h.read()
  parseAdvisorResult('readAdvice', saved)
  assert.equal(saved.advice.text, section().trim())
  assert.deepEqual(saved.advice.jev, value.jev)
  assert.doesNotMatch(JSON.stringify(saved), /fixture-key|Only one process/)
})

test('API failure keeps the advisor answer and a readable error result without retry', async t => {
  let calls = 0
  const h = await harness(t, { advisorJevEnabled: true }, async () => { calls++; throw new Error('private error') })
  const value = await h.call()
  assert.equal(calls, 1)
  assert.equal(value.text, section().trim())
  assert.equal(value.jev.reason, 'transport-error')
  assert.equal((await h.read()).advice.text, section().trim())
})

for (const action of ['advisor-off', 'caller-cancel', 'ciel-off']) test('in-flight control: ' + action, { timeout: 2000 }, async t => {
  let arrived, finish, transportSignal
  const started = new Promise(resolve => { arrived = resolve })
  const h = await harness(t, { advisorJevEnabled: true }, (_url, options) => {
    transportSignal = options.signal; arrived()
    return new Promise(resolve => { finish = () => resolve(Response.json(answer(['a1']))) })
  })
  const controller = new AbortController()
  const pending = h.call(controller.signal)
  await started
  if (action === 'advisor-off') h.configure({ advisorJevEnabled: false })
  if (action === 'caller-cancel') controller.abort()
  if (action === 'ciel-off') h.configure({ enabled: false })
  if (action.endsWith('-off') && action !== 'ciel-off') {
    const value = await pending
    assert.equal(value.text, section().trim())
    assert.equal(value.jev.status, action === 'advisor-off' ? 'cancelled' : 'completed')
    assert.equal((await h.read()).advice.text, section().trim())
  } else {
    await assert.rejects(pending, /cancel|disabled/i)
    assert.equal((await h.read()).ok, false)
  }
  assert.equal(transportSignal.aborted, true)
  assert.equal(h.disposals.length, 1)
})
