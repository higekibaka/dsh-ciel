import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, parseAdvisorItems } from '../index.js'
import { resolvedConfig } from './config-fixture.js'
import { prepareAdvisorDecision, checkAdvisorWithDecision, renderAdvisorDecision } from '../decision-advisor.js'
import { DECISION_MODEL } from '../decision-client.js'
import { isAdvisorDecision, parseAdvisorResult } from '../advisor-protocol.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-advisor-decision-'))
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const section = (n = 1, framing = 'Use an in-process queue.') => `## [high] Direction ${n}\nframing: ${framing}\npitfalls: Queue saturation.\nverification_target: Check the memory limit.\n`
const input = (text = section()) => ({ question: 'Which queue fits?', context: 'Only one process is available.', text, items: parseAdvisorItems(text).items })
const answer = ids => ({ answers: Object.fromEntries(ids.map((id, i) => {
  const choice = ['supports', 'contradicts', 'insufficient'][i % 3]
  return [id, { type: 'choice', choice, confidence: 0.8,
    probabilities: Object.fromEntries(['supports', 'contradicts', 'insufficient'].map(key => [key, key === choice ? 0.8 : 0.1])) }]
})), usage: { total_input_tokens: 200, total_output_tokens: 0, total_tokens: 200 } })
const stateOf = prepared => JSON.parse(prepared.request.input)
const check = options => checkAdvisorWithDecision({ prepared: prepareAdvisorDecision(input()), enabled: true, apiKey: 'fixture-key', ...options })

test('advisor check uses complete original sections beyond UI bounds and only the supplied context', () => {
  const original = section(1, 'Useful premise. '.repeat(140) + 'TAIL_CONSTRAINT') + section(2)
  const data = input(original), prepared = prepareAdvisorDecision(data)
  const state = stateOf(prepared)
  assert.ok(data.items[0].framing.length < state.items.a1.advice.length)
  assert.equal(state.items.a1.advice + state.items.a2.advice, original)
  assert.match(state.items.a1.advice, /TAIL_CONSTRAINT/)
  assert.equal(state.context, data.context)
  assert.equal(state.question, data.question)
  assert.equal(prepared.request.state, undefined)
  assert.equal(prepared.request.model, DECISION_MODEL)
  assert.match(prepared.request.questions.a1.instructions, /not independent fact verification/)
  assert.match(prepared.request.questions.a1.instructions, /untrusted data/)
  assert.equal(prepared.request.questions.a1.type, 'choice')
  assert.deepEqual(Object.keys(prepared.request.questions.a1.criteria), ['supports', 'contradicts', 'insufficient'])
})

test('recognized heading with missing/empty framing yields no-exact-claim', () => {
  const noItemData = input(section(1))
  delete noItemData.items[0]
  assert.equal(prepareAdvisorDecision(noItemData).checks[0].reason, 'no-exact-claim')

  const noFramingData = input(section(1))
  delete noFramingData.items[0].framing
  assert.equal(prepareAdvisorDecision(noFramingData).checks[0].reason, 'no-exact-claim')

  const emptyFramingData = input(section(1))
  emptyFramingData.items[0].framing = ''
  assert.equal(prepareAdvisorDecision(emptyFramingData).checks[0].reason, 'no-exact-claim')
})

test('aggregate 24-KiB input-budget boundaries across individually valid sections', () => {
  const s1Text = section(1, 'a'.repeat(10 * 1024))
  const data1 = input(s1Text)
  const MAX_INPUT_BYTES = 24 * 1024
  const baseS2Text = section(2, '')
  const dualSize = Buffer.byteLength(JSON.stringify({ question: data1.question, context: data1.context, items: { a1: { advice: s1Text }, a2: { advice: baseS2Text } } }))
  const exactPadding = MAX_INPUT_BYTES - dualSize

  const exactPrepared = prepareAdvisorDecision(input(s1Text + section(2, 'b'.repeat(exactPadding))))
  assert.equal(exactPrepared.checks[0].status, 'pending')
  assert.equal(exactPrepared.checks[1].status, 'pending')
  assert.equal(Buffer.byteLength(exactPrepared.request.input), MAX_INPUT_BYTES)

  const overflowPrepared = prepareAdvisorDecision(input(s1Text + section(2, 'b'.repeat(exactPadding + 1))))
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
    const prepared = prepareAdvisorDecision(data)
    assert.equal(prepared.checks[0].reason, reason)
    assert.deepEqual(JSON.parse(prepared.request.input), { items: {} })
    assert.deepEqual(prepared.request.questions, {})
  }
  const prepared = prepareAdvisorDecision(input(section(1, '文'.repeat(9000)) + section(2)))
  assert.equal(prepared.checks[1].status, 'pending')
  assert.deepEqual(Object.keys(stateOf(prepared).items), ['a2'])
})

test('checks at most six suggestions and reports missing structured advice', async () => {
  const prepared = prepareAdvisorDecision(input(Array.from({ length: 8 }, (_, i) => section(i)).join('\n')))
  assert.equal(prepared.checks.length, 6)
  assert.equal(prepared.omittedChecks, 2)
  const result = await check({ prepared: prepareAdvisorDecision(input('Unstructured answer.')), fetchImpl: () => assert.fail('must not request') })
  assert.equal(result.reason, 'no-eligible-claims')
  assert.ok(isAdvisorDecision(result))
})

test('renderAdvisorDecision output assertions', () => {
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
  const rendered = renderAdvisorDecision(result)
  assert.match(rendered, /\[Ciel Gemini Decision 顾问建议检查：partial\]/)
  assert.match(rendered, /仅与本次传入的背景核对，未独立验证事实。依据不足不代表建议错误；采用前仍需核实。/)
  assert.match(rendered, /- 建议 1：背景支持/)
  assert.match(rendered, /- 建议 2：背景冲突/)
  assert.match(rendered, /- 建议 3：依据不足/)
  assert.match(rendered, /- 建议 4：未检查（no-exact-claim）/)
  assert.match(rendered, /未完成原因：timeout/)
  assert.match(rendered, /另有 2 条建议未检查。/)

  const cleanRendered = renderAdvisorDecision({ status: 'completed', checks: [], omittedChecks: 0 })
  assert.doesNotMatch(cleanRendered, /未完成原因/)
  assert.doesNotMatch(cleanRendered, /未检查。/)
})

test('one batch returns all three relations; supplement preserves original advice parsing', async () => {
  const data = input(section(1) + section(2) + section(3))
  let calls = 0
  const result = await check({ prepared: prepareAdvisorDecision(data), fetchImpl: async (_url, options) => {
    calls++
    return Response.json(answer(Object.keys(JSON.parse(options.body).questions)))
  } })
  assert.equal(calls, 1)
  assert.equal(result.scope, 'provided-context')
  assert.deepEqual(result.checks.map(row => row.relation), ['supports', 'contradicts', 'insufficient'])
  assert.ok(isAdvisorDecision(result))
  assert.deepEqual(parseAdvisorItems(renderAdvisorDecision(result) + '\n\n' + data.text), parseAdvisorItems(data.text))
  const rpc = { ok: true, advice: { sessionId: 's1', callId: 'c1', text: data.text, decision: result } }
  parseAdvisorResult('readAdvice', rpc)
  for (const mutate of [
    r => { r.scope = 'verified-facts' }, r => { r.checks[0].id = 'a7' },
    r => { r.checks[0].relation = 'safe' }, r => { r.checks.push(r.checks[0]) },
    r => { r.checks[0].probabilities.supports = 0 }, r => { r.requestCount = 2 },
  ]) {
    const copy = structuredClone(rpc); mutate(copy.advice.decision)
    assert.equal(isAdvisorDecision(copy.advice.decision), false)
    assert.throws(() => parseAdvisorResult('readAdvice', copy))
  }
  // Historical records saved under the retired key stay readable.
  const historical = { ok: true, advice: { sessionId: 's1', callId: 'c2', text: data.text, jev: result } }
  parseAdvisorResult('readAdvice', historical)
  assert.ok(isAdvisorDecision(historical.advice.jev))
})

test('off, missing credentials, time budget and transport failure return labeled optional results', async () => {
  for (const [reason, options, count] of [
    ['disabled', { enabled: false }, 0], ['missing-key', { apiKey: '' }, 0],
    ['time-unavailable', { timeoutMs: 0 }, 0],
    ['http-error', {}, 1], ['timeout', { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }, 1],
    ['safety-blocked', { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'safety' } }), { status: 400 }) }, 1],
  ]) {
    let calls = 0
    const fetchImpl = options.fetchImpl || (async () => new Response('private upstream error', { status: 503 }))
    const result = await check({ ...options, fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })
    assert.equal(result.reason, reason)
    assert.equal(calls, count)
    assert.ok(isAdvisorDecision(result))
    assert.doesNotMatch(JSON.stringify(result), /private upstream error|fixture-key/)
  }
})

let serial = 0
async function harness(t, overrides = {}, fetchImpl = () => assert.fail('unexpected Gemini Decision request'), credentials) {
  const previousFetch = globalThis.fetch, previousKey = process.env.GEMINI_API_KEY, previousGoogle = process.env.GOOGLE_API_KEY
  globalThis.fetch = fetchImpl
  process.env.GEMINI_API_KEY = 'fixture-key'
  delete process.env.GOOGLE_API_KEY
  t.after(() => {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousKey
    if (previousGoogle === undefined) delete process.env.GOOGLE_API_KEY
    else process.env.GOOGLE_API_KEY = previousGoogle
  })
  const ctx = new Context(), config = resolvedConfig(overrides)
  const parent = { id: 'advisor-decision-' + (++serial), session: { snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } }, { type: 'tool/call', data: { name: 'read', callId: 'read-1' } },
  ] } }
  const requests = [], disposals = []
  let tool
  const provider = ctx.plugin({ name: 'advisor-test-boundary', apply(c) {
    if (credentials) c.provide('credentials', credentials)
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
  return { tool, requests, disposals, ctx,
    call: signal => tool.execute({ question: input().question, context: input().context }, { agent: parent, callId, signal }),
    configure(patch) { Object.assign(config, patch); ctx.emit('loader/volatile-update') },
    read: () => ctx.get('cielAdvisor').readAdvice({ sessionId: parent.id, callId: 'tool:' + callId }),
  }
}

test('advisor checks default off and do not request Gemini Decisions', async t => {
  assert.equal(resolvedConfig({}).advisorDecisionEnabled, false)
  const h = await harness(t)
  const value = await h.call()
  assert.equal(value.decision, undefined)
  assert.equal(value.text, section().trim())
  assert.equal(h.tool.output.render({}, value)[0].text, section().trim())
  assert.equal((await h.read()).advice.decision, undefined)
  assert.equal(h.requests.length, 1)
  assert.equal(h.disposals.length, 1)
})

test('advisor uses the live saved connection and the official endpoint header contract', async t => {
  let seen
  const h = await harness(t, { advisorDecisionEnabled: true, decisionApiKey: 'old-fixture' }, async (url, options) => {
    seen = { url, options }
    return Response.json(answer(['a1']))
  })
  const pending = h.call()
  h.configure({ decisionApiKey: 'saved-fixture', decisionEndpoint: 'https://proxy.invalid/decisions', decisionModel: 'decision-new' })
  const value = await pending
  assert.equal(seen.url, 'https://proxy.invalid/decisions')
  assert.equal(seen.options.headers['x-goog-api-key'], 'saved-fixture')
  assert.equal(seen.options.headers.Authorization, undefined)
  assert.equal(JSON.parse(seen.options.body).model, 'decision-new')
  assert.equal(value.decision.requestedModel, 'decision-new')
  assert.ok(isAdvisorDecision(value.decision))
  assert.doesNotMatch(JSON.stringify(await h.read()), /saved-fixture|proxy.invalid/)
})

test('enabled host persists the original reply and returns Decision to the model and metadata', async t => {
  let calls = 0
  const h = await harness(t, { advisorDecisionEnabled: true }, async (url, options) => {
    calls++
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions')
    assert.equal(options.headers['x-goog-api-key'], 'fixture-key')
    const request = JSON.parse(options.body)
    assert.equal(JSON.parse(request.input).items.a1.advice, section().trim())
    return Response.json(answer(Object.keys(request.questions)))
  })
  const value = await h.call()
  assert.equal(calls, 1)
  assert.equal(value.text, section().trim())
  assert.ok(isAdvisorDecision(value.decision))
  assert.match(h.tool.output.render({}, value)[0].text, /背景支持/)
  assert.ok(h.tool.output.render({}, value)[0].text.endsWith(section().trim()))
  assert.deepEqual(h.tool.output.presentationMeta({}, value).decision, value.decision)
  assert.equal(h.tool.output.presentationMeta({}, value).jev, undefined)
  const saved = await h.read()
  parseAdvisorResult('readAdvice', saved)
  assert.equal(saved.advice.text, section().trim())
  assert.deepEqual(saved.advice.decision, value.decision)
  assert.equal(saved.advice.jev, undefined)
  assert.doesNotMatch(JSON.stringify(saved), /fixture-key|Only one process/)
})

test('safety blocks keep the advisor answer and a readable error result without retry', async t => {
  let calls = 0
  const h = await harness(t, { advisorDecisionEnabled: true }, async () => {
    calls++
    return new Response(JSON.stringify({ error: { code: 'prohibited_content' } }), { status: 400 })
  })
  const value = await h.call()
  assert.equal(calls, 1)
  assert.equal(value.text, section().trim())
  assert.equal(value.decision.reason, 'safety-blocked')
  assert.equal((await h.read()).advice.text, section().trim())
})

test('API failure keeps the advisor answer and a readable error result without retry', async t => {
  let calls = 0
  const h = await harness(t, { advisorDecisionEnabled: true }, async () => { calls++; throw new Error('private error') })
  const value = await h.call()
  assert.equal(calls, 1)
  assert.equal(value.text, section().trim())
  assert.equal(value.decision.reason, 'transport-error')
  assert.equal((await h.read()).advice.text, section().trim())
})

test('a failing host credential store degrades the optional check without failing the answer', async t => {
  const h = await harness(t, { advisorDecisionEnabled: true }, () => assert.fail('must not request'), {
    async resolve() { throw new Error('vault PRIVATE_BODY') },
  })
  const value = await h.call()
  assert.equal(value.text, section().trim())
  assert.equal(value.decision.reason, 'missing-key')
  assert.equal(value.decision.requestCount, 0)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_BODY|vault/)
  assert.equal((await h.read()).advice.text, section().trim())
})

test('a self-referential or empty advisor route is rejected before the budget is spent', async t => {
  const h = await harness(t, { advisorDecisionEnabled: true })
  for (const route of [{ provider: 'ciel' }, { provider: '   ' }, { model: '' }]) {
    h.configure(route)
    await assert.rejects(h.call(), /invalid advisor route/)
  }
  assert.equal(h.requests.length, 0)
  // The rejection is an admission error, so the phase budget is untouched.
  h.configure({ provider: 'kimi-coding', model: 'kimi-for-coding' })
  const value = await h.call()
  assert.equal(value.text, section().trim())
  assert.equal(h.requests.length, 1)
})

for (const action of ['advisor-off', 'caller-cancel', 'ciel-off']) test('in-flight control: ' + action, { timeout: 2000 }, async t => {
  let arrived, finish, transportSignal
  const started = new Promise(resolve => { arrived = resolve })
  const h = await harness(t, { advisorDecisionEnabled: true }, (_url, options) => {
    transportSignal = options.signal; arrived()
    return new Promise(resolve => { finish = () => resolve(Response.json(answer(['a1']))) })
  })
  const controller = new AbortController()
  const pending = h.call(controller.signal)
  await started
  if (action === 'advisor-off') h.configure({ advisorDecisionEnabled: false })
  if (action === 'caller-cancel') controller.abort()
  if (action === 'ciel-off') h.configure({ enabled: false })
  if (action.endsWith('-off') && action !== 'ciel-off') {
    const value = await pending
    assert.equal(value.text, section().trim())
    assert.equal(value.decision.status, action === 'advisor-off' ? 'cancelled' : 'completed')
    assert.equal((await h.read()).advice.text, section().trim())
  } else {
    await assert.rejects(pending, /cancel|disabled/i)
    assert.equal((await h.read()).ok, false)
  }
  assert.equal(transportSignal.aborted, true)
  assert.equal(h.disposals.length, 1)
})
