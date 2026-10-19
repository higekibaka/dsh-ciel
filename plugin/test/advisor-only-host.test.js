import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, configValues, readCallModelUsage } from '../index.js'
import { createAdvisorOperation } from '../advisor-operation.js'
import { ADVISOR_METHODS, parseAdvisorRequest, advisorInvocation } from '../advisor-protocol.js'
import { RECORD_KINDS } from '../record-store.js'
import { advisorRepository } from '../advisor-repository.js'

const previousHome = process.env.DSH_HOME
const tempHome = await mkdtemp(join(tmpdir(), 'ciel-activation-host-'))
process.env.DSH_HOME = tempHome
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(tempHome, { recursive: true, force: true })
})

function clock() {
 let time = 0, callback, cleared = false
 return { now: () => time, advance: n => { time += n }, fire: () => callback(),
 timers: { setTimeout(fn) { callback = fn; return { unref() {} } }, clearTimeout() { cleared = true } },
 cleared: () => cleared }
}

async function createHostHarness(configOverrides = {}) {
  const ctx = new Context()
  let guardFn = null
  let registeredTool = null
  let startActivationImpl = null
  const cfg = {
    enabled: true,
    advisorTimeoutSeconds: 30,
    provider: 'test-provider',
    model: 'test-model',
    maxTokens: 2048,
    maxCallsPerTurn: 3,
    requireExploration: true,
    enforceFollowupGap: true,
    planReminderEnabled: true,
    reasoningEffort: 'high',
    guidanceEnabled: true,
    advisorJevEnabled: false,
    ...configOverrides,
  }
  const subagents = {
    start() {
      throw new Error('subagents.start was removed in DSH 0.2.1-rc.2')
    },
    async startActivation(spec) {
      if (!startActivationImpl) throw new Error('startActivationImpl not configured')
      return startActivationImpl(spec)
    },
  }
  const tools = {
    guard(fn) { guardFn = fn; return () => {} },
    register(def) { registeredTool = def; return () => {} },
  }
  const provider = ctx.plugin({
    name: 'advisor-host-test-boundary',
    apply(c) {
      c.provide('tools', tools)
      c.provide('subagents', subagents)
    },
  })
  await provider.await()
  const owner = ctx.plugin({
    name: 'advisor-host-under-test',
    apply: (c) => apply(c, cfg),
  })
  await owner.await()
  return {
    cfg,
    ctx,
    get tool() { return registeredTool },
    get guard() { return guardFn },
    setStartActivation(fn) { startActivationImpl = fn },
    emitAgentCreated(agent) {
      ctx.emit('agent/created', { agent })
    },
    async runAgentRequest(agent, base = { model: 'test-model' }) {
      return ctx.waterfall(ctx, 'agent/request', { agent }, () => Promise.resolve(base))
    },
    emitVolatileUpdate() {
      ctx.emit('loader/volatile-update')
    },
    async dispose() {
      await owner.dispose()
      await provider.dispose()
    },
  }
}

function createParentAgent(id = 'parent-session-1') {
  return {
    id,
    session: {
      snapshotEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'tool/call', data: { name: 'read', callId: 'read-1' } },
      ],
    },
  }
}

test('advisor config and wire surface contain no retired review capability', () => {
 const value = configValues(Config({}))
 assert.deepEqual(Object.keys(value).filter(key=>/^critic|^jevEnabled$/.test(key)), [])
 assert.deepEqual(ADVISOR_METHODS, ['readAdvice','callModelUsage'])
 assert.deepEqual(RECORD_KINDS, ['advice','calls'])
 for(const method of ADVISOR_METHODS) assert.equal(advisorInvocation(method).service, 'cielAdvisor')
 for(const method of ['start','feedback','cancel','inboxList','readReview']) assert.throws(()=>parseAdvisorRequest(method,{}))
 assert.throws(()=>parseAdvisorRequest('callModelUsage',{sessionId:'s1',kind:'command',id:'old'}))
})
test('provider retries share one consultation deadline, not a one-request quota', () => {
 const c=clock(), op=createAdvisorOperation({timeoutMs:100,now:c.now,timers:c.timers})
 for(let i=0;i<6;i++) { op.beforeRequest(); c.advance(10) }
 assert.equal(op.remainingMs(),40)
 assert.equal(op.signal.aborted,false)
 c.advance(40)
 assert.throws(()=>op.beforeRequest(),/advisor timeout/)
 assert.equal(op.signal.aborted,true)
 op.dispose()
})
test('cancellation wins over retries and prevents late publication', async () => {
 const c=clock(), op=createAdvisorOperation({timeoutMs:100,now:c.now,timers:c.timers})
 op.beforeRequest(); assert.equal(op.cancel('caller cancelled'),true)
 assert.throws(()=>op.beforeRequest(),/caller cancelled/)
 assert.throws(()=>op.beginCommit(),/caller cancelled/)
 assert.equal(op.cancel(),false)
 op.dispose(); await op.done; assert.equal(c.cleared(),true)
})
test('timer cancellation and atomic publication fence remain independent of retries', async () => {
 const c=clock(), op=createAdvisorOperation({timeoutMs:100,now:c.now,timers:c.timers})
 c.fire(); assert.throws(()=>op.beforeRequest(),/advisor timeout/); op.dispose()
 const d=clock(), committed=createAdvisorOperation({timeoutMs:100,now:d.now,timers:d.timers})
 committed.beforeRequest(); committed.beginCommit()
 assert.equal(d.cleared(),true); assert.equal(committed.cancel(),false)
 assert.throws(()=>committed.beforeRequest(),/already settled/)
 assert.throws(()=>committed.beginCommit(),/already settled/)
 committed.dispose(); await committed.done
})

test('ask_advisor uses 0.2.1-rc.2 subagents.startActivation with caller delivery, zero-tool restriction, persona, and telemetry', async (t) => {
  const harness = await createHostHarness()
  t.after(() => harness.dispose())
  let capturedSpec = null
  let presentAsArg = null
  let restrictArg = null
  let registeredSection = null
  let registeredContexts = []
  let assembleHook = null
  let disposeCount = 0
  let requestConfig = null

  harness.setStartActivation(async (spec) => {
    capturedSpec = spec
    const childAgent = {
      id: spec.childId,
      ctx: {
        get(serviceName) {
          if (serviceName === 'tools') {
            return {
              presentAs(mode) { presentAsArg = mode },
              restrict(filter) { restrictArg = filter },
            }
          }
          if (serviceName === 'systemPrompt') {
            return {
              getSectionOrder(key) { return key === 'DEPLOYMENT_PERSONA_PREFIX' ? 10 : 0 },
              section(sec) { registeredSection = sec; return () => {} },
              context(ctxDef) { registeredContexts.push(ctxDef); return () => {} },
            }
          }
          return undefined
        },
        on(event, fn) {
          if (event === 'system-prompt/assemble') assembleHook = fn
          return () => {}
        },
        effect(fn) {
          fn()
          return () => {}
        },
      },
      session: {
        snapshotEvents: () => [
          {
            type: 'assistant/message',
            data: {
              message: {
                source: { kind: 'model', provider: 'actual-provider', model: 'actual-model' },
                content: [{ type: 'text', text: '## [high] Use startActivation\nframing: Align with 0.2.1-rc.2 SubagentRuntime.\npitfalls: Forgetting post-start abort disposal.\nverification_target: Run node --test in plugin.' }],
              },
            },
          },
        ],
      },
    }
    harness.emitAgentCreated(childAgent)
    requestConfig = await harness.runAgentRequest(childAgent, { model: 'test-model' })
    return {
      childId: spec.childId,
      messageId: 'msg-1',
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{
          type: 'text',
          text: '## [high] Use startActivation\nframing: Align with 0.2.1-rc.2 SubagentRuntime.\npitfalls: Forgetting post-start abort disposal.\nverification_target: Run node --test in plugin.',
        }],
      }),
      async dispose() { disposeCount++ },
    }
  })

  const parent = createParentAgent('parent-ok')
  const out = await harness.tool.execute(
    { question: 'How should we adapt Ciel to 0.2.1-rc.2?', context: 'subagents.start was removed in favor of startActivation.' },
    { agent: parent, callId: 'call-ok-1' },
  )

  assert.equal(capturedSpec.provider, 'spawn')
  assert.equal(capturedSpec.label, 'advisor')
  assert.equal(capturedSpec.delivery, 'caller')
  assert.equal(typeof capturedSpec.childId, 'string')
  assert.equal(capturedSpec.request.parent, parent)
  assert.equal(capturedSpec.request.maxDepth, 1)
  assert.deepEqual(capturedSpec.request.agentOptions, {
    provider: 'test-provider',
    model: 'test-model',
    maxTokens: 2048,
  })
  assert.equal(presentAsArg, 'native')
  assert.deepEqual(restrictArg, { allow: [] })
  assert.equal(registeredSection?.name, 'deployment:persona-prefix')
  assert.equal(registeredSection?.order, 10)
  assert.match(registeredSection?.text ?? '', /You are a senior technical advisor/)
  assert.deepEqual(registeredContexts, [])
  assert.equal(typeof assembleHook, 'function')
  const assembled = await assembleHook({}, {}, async () => ({
    sections: [registeredSection],
    contexts: [],
    tools: [{ name: 'spawn_agent' }, { name: 'send_message' }],
  }))
  assert.deepEqual(assembled.tools, [])
  assert.equal(requestConfig.reasoningEffort, 'high')
  assert.equal(disposeCount, 1)
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].tier, 'high')
  assert.deepEqual(out.modelUsage, {
    requested: { provider: 'test-provider', model: 'test-model' },
    used: [{ provider: 'actual-provider', model: 'actual-model' }],
  })
  const storedAdvice = await advisorRepository.readRecord('advice', 'parent-ok', 'tool:call-ok-1')
  assert.equal(storedAdvice?.items?.length, 1)
  const storedUsage = await readCallModelUsage('parent-ok', 'tool', 'call-ok-1')
  assert.deepEqual(storedUsage?.used, [{ provider: 'actual-provider', model: 'actual-model' }])
})

test('ask_advisor disposes active subagent activation on caller abort, tool guard violation, and child error', async (t) => {
  const harness = await createHostHarness()
  t.after(() => harness.dispose())

  // 1. Caller abort while run.result is pending disposes the activation once
  let abortedDisposeCount = 0
  let resolveAbortedResult
  harness.setStartActivation(async (spec) => {
    const childAgent = { id: spec.childId, ctx: { get: () => undefined }, session: { snapshotEvents: () => [] } }
    harness.emitAgentCreated(childAgent)
    return {
      childId: spec.childId,
      messageId: 'msg-abort',
      result: new Promise((resolve) => { resolveAbortedResult = resolve }),
      async dispose() {
        abortedDisposeCount++
        resolveAbortedResult?.({ stopReason: 'aborted', output: [] })
      },
    }
  })

  const abortController = new AbortController()
  const parent = createParentAgent('parent-abort')
  const pendingAbort = harness.tool.execute(
    { question: 'Abort test?', context: 'Testing post-start abort disposal.' },
    { agent: parent, callId: 'call-abort-1', signal: abortController.signal },
  )
  await new Promise((r) => setImmediate(r))
  abortController.abort()
  await assert.rejects(pendingAbort, /advisor cancelled/)
  assert.equal(abortedDisposeCount, 1)

  // 2. Unexpected tool call inside advisor child triggers tools.guard and disposes activation
  let guardDisposeCount = 0
  harness.setStartActivation(async (spec) => {
    const childAgent = { id: spec.childId, ctx: { get: () => undefined }, session: { snapshotEvents: () => [] } }
    harness.emitAgentCreated(childAgent)
    return {
      childId: spec.childId,
      messageId: 'msg-guard',
      result: new Promise((resolve) => {
        setImmediate(() => {
          const verdict = harness.guard({ agent: childAgent })
          assert.equal(verdict, 'advisor has no tools')
          resolve({ stopReason: 'aborted', output: [] })
        })
      }),
      async dispose() { guardDisposeCount++ },
    }
  })
  await assert.rejects(
    harness.tool.execute(
      { question: 'Guard test?', context: 'Testing tool guard in advisor child.' },
      { agent: createParentAgent('parent-guard'), callId: 'call-guard-1' },
    ),
    /unexpected tool in advisor/,
  )
  assert.equal(guardDisposeCount, 1)

  // 3. Child error surfaces childErrorDetail from the agent captured on agent/created
  harness.setStartActivation(async (spec) => {
    const childAgent = {
      id: spec.childId,
      ctx: { get: () => undefined },
      session: {
        snapshotEvents: () => [
          { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'upstream model 503' } } } },
        ],
      },
    }
    harness.emitAgentCreated(childAgent)
    return {
      childId: spec.childId,
      messageId: 'msg-err',
      result: Promise.resolve({ stopReason: 'error', output: [] }),
      async dispose() {},
    }
  })
  await assert.rejects(
    harness.tool.execute(
      { question: 'Error detail test?', context: 'Testing childErrorDetail extraction.' },
      { agent: createParentAgent('parent-err'), callId: 'call-err-1' },
    ),
    /advisor consultation ended with "error": upstream model 503/,
  )
})
