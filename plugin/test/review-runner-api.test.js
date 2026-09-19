// Focused offline unit coverage for review-runner.js against the DSH
// 0.1.5+ AgentSetup/agents.create contract and the 0.18.0 tooled PTC realm.
// The real DSH modules are replaced by in-process data: fixtures so this runs
// without a built checkout, network, or model SDK. Integration against the real
// AgentLoop/SubagentRuntime lives in scripts/verify-runtime.mjs.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createRestrictedReviewProvider } from '../review-runner.js'

const RUNNER_URL = new URL('../review-runner.js', import.meta.url).href
const dataUrl = (source) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source)

// The fixtures read their per-test state off globalThis, so the single cached
// module instance can serve every scenario.
const SUBAGENT_SOURCE = `
const S = () => globalThis.__cielRunnerFake
export function assertSubagentMaxDepth(maxDepth) { S().calls.push({ op: 'assertMaxDepth', maxDepth }) }
export function resolveChildDepth(parent, maxDepth) { S().calls.push({ op: 'resolveChildDepth', parentId: parent.id, maxDepth }); return 1 }
export function captureDelegatedPolicyOverrides(parent) { S().calls.push({ op: 'capturePolicy', parentId: parent.id }); return { inherited: true } }
export function childSessionMeta(parent, depth, isSeeded) {
  S().calls.push({ op: 'childSessionMeta', depth, isSeeded })
  return { cwd: parent.session.header.cwd, parentSession: parent.id, isSeeded, origin: 'subagent', delegationDepth: depth, agentPreset: 'fixture-preset' }
}
export function resolveChildAgentOptions(parent, requested, depth) { S().calls.push({ op: 'resolveChildAgentOptions', depth }); return { ...requested, subagentDepth: depth } }
export function appendDelegatedPolicyOverrides(session, inherited) { S().calls.push({ op: 'appendPolicy', inherited }) }
export function finalAssistantOutput(events) { S().calls.push({ op: 'finalAssistantOutput', count: events.length }); return [{ type: 'text', text: 'fixture-final-output' }] }
`

const LLM_SOURCE = `
export function createUserMessage(message) { globalThis.__cielRunnerFake.calls.push({ op: 'createUserMessage' }); return { role: 'user', content: message.content } }
`

const PTC_RUNTIME_SOURCE = `
const S = () => globalThis.__cielRunnerFake
export const REVIEW_RUNTIME_LANGUAGE = 'typescript'
export function createReviewCodeRuntime(options) {
  const state = S()
  state.calls.push({ op: 'createReviewCodeRuntime' })
  state.deadlineAt = options && options.deadlineAt
  if (state.runtimeMode === 'badshape') return { language: 'python', run() {}, async dispose() { await new Promise(resolve => setImmediate(resolve)); state.privateRuntimeDisposed += 1 } }
  return {
    language: 'typescript',
    isolation: 'worker-thread+quickjs',
    async run(request) {
      const state = S()
      state.runtimeRuns = (state.runtimeRuns || 0) + 1
      const namespace = request.bindings && request.bindings[0]
      state.lastBindingNames = namespace ? Object.keys(namespace.functions) : []
      state.lastErrorClass = namespace && namespace.errorClass
      let error
      if (namespace && typeof namespace.functions.read === 'function') {
        try { await namespace.functions.read({ file_path: '/project/a.js' }) }
        catch (caught) { error = caught && caught.message }
      }
      state.lastBindingError = error
      return { logs: [], value: { names: state.lastBindingNames, error } }
    },
    async dispose() { await new Promise(resolve => setImmediate(resolve)); state.privateRuntimeDisposed += 1 },
  }
}
export function assertRuntimeCompatible(privateRuntime, deploymentRuntime) {
  const state = S()
  state.calls.push({ op: 'assertRuntimeCompatible' })
  if (state.compatThrows) throw new Error('language mismatch')
  if (privateRuntime === undefined) throw new Error('private runtime unavailable')
  if (deploymentRuntime === undefined) return
  if (privateRuntime.language !== deploymentRuntime.language) throw new Error('language mismatch')
}
`

const TOOLS_SOURCE = `
const S = () => globalThis.__cielRunnerFake
export class ToolRuntime {
  constructor(ctx, config) {
    const state = S()
    if (state.toolsMode === 'throws') throw new Error('private registry construction failed')
    state.private.push({ op: 'ToolRuntime', config })
    state.privateToolsInstance = this
    this.ctx = ctx
    this.config = config
    this.presentation = null
    this.registered = []
  }
  presentAs(mode) { S().private.push({ op: 'presentAs', mode }); this.presentation = mode; return () => {} }
  restrict(filter) { S().private.push({ op: 'restrict', filter }); this.restriction = filter; return () => {} }
  register(definition) { this.registered.push(definition); S().private.push({ op: 'register', name: definition.name }); return () => {} }
  guard(guard) { this.guard = guard; S().private.push({ op: 'private-guard' }); return () => {} }
  get(name, scope) {
    const state = S()
    if (name !== 'run_code' || state.privateRunCodeMissing) return undefined
    const registered = this.registered
    const privateCtx = this.ctx
    return {
      name: 'run_code',
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: 'PTC:' + JSON.stringify(value) }] },
      async execute(args, exec) {
        state.private.push({ op: 'private-run-code', args, exactChild: exec.agent === state.child, parent: exec.parent })
        if (state.privateRunCodeThrows) throw new Error('/host/secret stack boom')
        if (state.transportFailure !== undefined) {
          const failure = new Error(state.transportFailure)
          failure.code = 'CODE_RUN_FAILED'
          failure.name = 'CodeRunFailedError'
          throw failure
        }
        if (state.transportArbitrary !== undefined) {
          const arbitrary = new Error(state.transportArbitrary)
          arbitrary.code = 'SOME_OTHER_CODE'
          throw arbitrary
        }
        if (!state.bindingProbe) return { ok: true, args }
        const functions = Object.create(null)
        for (const definition of registered) {
          functions[definition.name] = async (raw) => {
            if (state.nestedMode === 'deny') throw new Error('prepolicy /host/secret stack')
            const agent = state.nestedMode === 'foreign' ? { id: 'other' } : state.child
            return await definition.execute(raw, { agent, signal: exec.signal })
          }
        }
        const outcome = await privateCtx.get('codeRuntime').run({
          program: args.code,
          bindings: [{ global: 'tools', functions, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }],
          signal: exec.signal,
        })
        return outcome.value
      },
    }
  }
}
`

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === RUNNER_URL) {
      const state = globalThis.__cielRunnerFake
      if (specifier === '@deepseek-ai/dsh-subagent') return { url: dataUrl(SUBAGENT_SOURCE), shortCircuit: true }
      if (specifier === '@deepseek-ai/dsh-llm') return { url: dataUrl(LLM_SOURCE), shortCircuit: true }
      if (specifier === './ptc-runtime.js') {
        if (state?.runtimeMode === 'missing') throw new Error('Cannot find module ./ptc-runtime.js')
        return { url: dataUrl(PTC_RUNTIME_SOURCE), shortCircuit: true }
      }
      if (specifier === '@deepseek-ai/dsh-tools') {
        if (state?.toolsMode === 'missing') throw new Error('Cannot find package @deepseek-ai/dsh-tools')
        return { url: dataUrl(TOOLS_SOURCE), shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})
after(() => hook.deregister())

function fixture({
  allowTools = true,
  withCorpus = true,
  turnEndKind = 'completed',
  truncatePublic = false,
  rootRuntime,
  runtimeMode = 'ok',
  toolsMode = 'ok',
  guard = true,
} = {}) {
  const state = {
    calls: [], createOptions: [], bound: [], unbound: [], private: [], isolateLabels: [],
    systemPrompt: { contexts: [], sections: [] },
    tools: { presentation: null, restrict: undefined, registered: [] },
    childCtxAgentReads: 0,
    preStep: undefined,
    toolsExecute: undefined,
    hookDisposed: false,
    idleResolve: undefined,
    privateProvided: {},
    privateToolsInstance: undefined,
    privateRuntimeDisposed: 0,
    deadlineAt: undefined,
    runtimeMode,
    toolsMode,
    rootRun: 0,
    rootRuntime: rootRuntime === undefined
      ? { language: 'typescript', isolation: 'worker-thread', run() { state.rootRun += 1 } }
      : rootRuntime,
  }
  globalThis.__cielRunnerFake = state

  const child = {
    id: 'child-1',
    session: {
      header: { id: 'child-1', parentSession: 'parent-1' },
      appended: [],
      append(type, data) { this.appended.push({ type, data }) },
      snapshotEvents() { return [{ type: 'turn/end', data: { reason: { kind: turnEndKind } } }] },
    },
    cancel(reason) { state.calls.push({ op: 'cancel', reason }); state.idleResolve?.() },
    followup(message) { state.calls.push({ op: 'followup', message }); state.idleResolve?.() },
    whenIdle() { return new Promise((resolve) => { state.idleResolve = resolve }) },
  }
  state.child = child

  const makeIsolated = (labels) => ({
    labels,
    get(name) { return state.privateProvided[name] },
    provide(name, value) {
      state.privateProvided[name] = value
      state.calls.push({ op: 'private-provide', name })
      return () => { state.calls.push({ op: 'private-unprovide', name }) }
    },
    isolate(name) { state.isolateLabels.push(name); return makeIsolated([...labels, name]) },
  })

  const childCtxTarget = {
    systemPrompt: {
      getContextOrder(name) { state.calls.push({ op: 'getContextOrder', name }); return 10 },
      getSectionOrder(name) { state.calls.push({ op: 'getSectionOrder', name }); return 20 },
      context(entry) { state.systemPrompt.contexts.push(entry) },
      section(entry) { state.systemPrompt.sections.push(entry) },
    },
    tools: {
      presentAs(mode) { state.tools.presentation = mode },
      restrict(filter) { state.tools.restrict = filter },
      register(definition) { state.tools.registered.push(definition) },
    },
    get(name) { state.calls.push({ op: 'get', name }); return name === 'codeRuntime' ? state.rootRuntime : undefined },
    isolate(name) { state.isolateLabels.push(name); return makeIsolated([name]) },
    on(name, handler) {
      state.calls.push({ op: 'on', name })
      if (name === 'tools/execute') { state.toolsExecute = handler; return () => { state.hookDisposed = true } }
      if (name === 'agent/pre-step') state.preStep = handler
      return () => {}
    },
  }
  const childCtx = new Proxy(childCtxTarget, {
    get(target, property, receiver) {
      // DSH 0.1.5 removed the reverse handle: setup receives the child as its
      // second argument and must never read childCtx.agent.
      if (property === 'agent') { state.childCtxAgentReads += 1; throw new Error('childCtx.agent must not be read') }
      return Reflect.get(target, property, receiver)
    },
  })

  const parent = {
    id: 'parent-1',
    session: { header: { id: 'parent-1', cwd: '/fixture-project' } },
    ctx: {
      agents: {
        async create(options) {
          state.createOptions.push(options)
          state.calls.push({ op: 'create' })
          const commit = await options.setup(childCtx, child)
          state.calls.push({ op: 'setup-returned' })
          commit?.commit()
          state.calls.push({ op: 'published' })
          return { agent: child, dispose: async () => { state.calls.push({ op: 'handle.dispose' }) } }
        },
      },
    },
  }

  const control = {
    timeoutMs: 180000,
    used: 0,
    allowTools,
    accessLimited: false,
    operation: {
      check() { state.calls.push({ op: 'check' }) },
      remainingMs: () => 150000,
      requests: () => 3,
      cancel(reason) { state.calls.push({ op: 'operation.cancel', reason }) },
    },
    ...withCorpus ? {
      corpus: {
        read: (args) => ({ file_path: args.file_path, content: 'line1\nline2', truncated: false }),
        grep: () => ({ matches: [], truncated: false }),
        glob: () => ({ paths: [], truncated: false }),
        publicInfo: () => ({ fileCount: 1, byteCount: 2, roots: ['/project'], truncated: truncatePublic }),
      },
    } : {},
    ...guard ? {
      guard(exec) { state.calls.push({ op: 'control.guard', name: exec?.name }); return state.guardDenial },
    } : {},
  }

  const callbacks = {
    claimControl: (request) => { state.calls.push({ op: 'claim' }); return state.failClaim ? null : control },
    bindControl: (boundControl, boundChild) => {
      state.calls.push({ op: 'bind' })
      if (state.failBind) throw new Error('review guard unavailable')
      state.bound.push(boundChild)
      boundControl.bound = true
    },
    unbindControl: async (boundControl, id) => { state.calls.push({ op: 'unbind', id }); state.unbound.push(id) },
  }

  const controller = new AbortController()
  const request = {
    parent,
    prompt: 'Review the fixture.',
    signal: controller.signal,
    descriptor: { mode: 'one-shot', provider: 'ciel-review-private' },
    maxDepth: 1,
    toolFilter: { allow: ['read', 'grep', 'glob'] },
    persona: 'FIXTURE_PERSONA',
    agentOptions: { provider: 'fixture', model: 'fixed', maxTokens: 100 },
  }
  const indexOf = (op) => state.calls.findIndex((call) => call.op === op)
  const privateNames = () => state.private.filter((entry) => entry.op === 'register').map((entry) => entry.name)
  return { state, child, parent, control, callbacks, controller, request, indexOf, privateNames }
}

async function startRun(f, overrides = {}) {
  const provider = await createRestrictedReviewProvider(f.callbacks)
  const run = await provider.start({ ...f.request, ...overrides })
  return run
}

async function finish(f, run) {
  f.state.idleResolve?.()
  await run.result
  await run.dispose()
}

test('setup consumes the second argument and never reads the removed childCtx.agent', async () => {
  const f = fixture()
  const run = await startRun(f)
  assert.equal(f.state.childCtxAgentReads, 0, 'runner must not touch the removed reverse property')
  assert.equal(f.state.bound.length, 1, 'bindControl ran exactly once')
  assert.equal(f.state.bound[0], f.child, 'binding received the setup second argument, not a context property')
  assert.equal(run.localAgent, f.child)
  const options = f.state.createOptions[0]
  assert.equal(options.parentAgent, f.parent, 'agents.create must name the live parent for runtime ownership')
  assert.equal(options.meta.parentSession, f.parent.id, 'durable lineage metadata is still recorded')
  assert.equal(options.meta.agentPreset, undefined, 'child must not claim the parent preset it never joined')
  assert.equal(options.agentOptions.subagentDepth, 1)
  assert.equal(options.signal, f.controller.signal)
  assert.equal(options.sessionId, run.id)
  await finish(f, run)
  assert.equal((await run.result).stopReason, 'completed')
  assert.deepEqual(f.state.unbound, [run.id])
})

test('tooled setup presents the official PTC transport and builds the private realm before the first request', async () => {
  const f = fixture()
  const run = await startRun(f)
  const setupDone = f.indexOf('setup-returned')
  const bound = f.indexOf('bind')
  const request = f.indexOf('followup')
  assert.ok(bound > -1 && setupDone > -1 && request > -1, 'all phases observed')
  assert.ok(bound < request, 'guard binding precedes the first request')
  assert.ok(setupDone < request, 'setup commits before the first request')
  assert.ok(f.state.calls.slice(0, request).some((call) => call.op === 'check'), 'guard checks run before the first request')
  // The child's own registry presents the official PTC transport and the
  // root-runtime-generated SDK, with exactly the allowed snapshot readers.
  assert.equal(f.state.tools.presentation, 'ptc')
  assert.deepEqual(f.state.tools.restrict, { allow: [] }, 'every inherited body is shadowed away')
  assert.deepEqual(f.state.tools.registered.map((tool) => tool.name), ['read', 'grep', 'glob'])
  // The private realm is isolated by label and gets the same readers, an inert
  // prompt sink, the private runtime and the fail-closed control.guard.
  assert.deepEqual(f.state.isolateLabels, ['tools', 'codeRuntime', 'systemPrompt'])
  assert.deepEqual(f.privateNames(), ['read', 'grep', 'glob'])
  assert.equal(typeof f.state.privateProvided.systemPrompt.tools, 'function')
  assert.equal(typeof f.state.privateProvided.systemPrompt.section, 'function')
  assert.equal(typeof f.state.privateProvided.systemPrompt.getSectionOrder, 'function')
  assert.equal(f.state.privateProvided.codeRuntime.language, 'typescript')
  assert.equal(typeof f.state.privateProvided.codeRuntime.run, 'function')
  assert.deepEqual(f.state.privateToolsInstance.config, { mode: 'native' })
  assert.equal(f.state.privateToolsInstance.presentation, 'ptc')
  assert.deepEqual(f.state.privateToolsInstance.restriction, { allow: [] })
  assert.equal(f.state.privateToolsInstance.guard, f.control.guard, 'private guard is the exact fail-closed control closure')
  // The private runtime's deadline is the review operation's REMAINING time.
  assert.equal(typeof f.state.deadlineAt, 'function')
  const remaining = f.state.deadlineAt() - Date.now()
  assert.ok(remaining > 140000 && remaining <= 150000, 'deadlineAt reads the shared remaining budget: ' + remaining)
  assert.equal(f.state.systemPrompt.contexts[0].name, 'subagent:delegation')
  assert.equal(f.state.systemPrompt.contexts[0].text.includes('delegated subagent'), true)
  assert.deepEqual(f.state.systemPrompt.sections.map((section) => section.name), ['deployment:persona-prefix'])
  await finish(f, run)
  assert.equal(f.state.privateRuntimeDisposed, 1, 'runtime disposed on normal completion')
  assert.equal(f.state.hookDisposed, true, 'scoped hook disposed on completion')
  assert.deepEqual(f.state.unbound, [run.id])
})

test('no-tool phase stays native with no readers and never resolves a code runtime', async () => {
  const f = fixture({ allowTools: false, withCorpus: false })
  const run = await startRun(f, { toolFilter: { allow: [] } })
  assert.equal(f.state.tools.presentation, 'native')
  assert.deepEqual(f.state.tools.restrict, { allow: [] })
  assert.deepEqual(f.state.tools.registered, [])
  assert.deepEqual(f.state.private, [], 'no private registry for a no-tool phase')
  assert.deepEqual(f.state.isolateLabels, [])
  assert.equal(f.state.calls.some((call) => call.op === 'createReviewCodeRuntime'), false)
  await finish(f, run)
  assert.equal(f.state.privateRuntimeDisposed, 0)
})

test('reader tools refuse foreign agents and return shared-deadline telemetry', async () => {
  const f = fixture()
  const run = await startRun(f)
  const readTool = f.state.tools.registered.find((tool) => tool.name === 'read')
  assert.match(readTool.description, /JSON\.parse/, 'description tells the model to parse the JSON string')
  assert.match(readTool.description, /review_time/, 'description names the review_time telemetry field')
  assert.match(readTool.description, /evidence_refs/, 'description names the host receipt ids')
  const own = await readTool.execute({ file_path: '/project/a.js' }, { agent: f.child, signal: new AbortController().signal })
  const parsed = JSON.parse(own)
  assert.equal(parsed.file_path, '/project/a.js')
  assert.equal(parsed.review_budget, undefined)
  assert.deepEqual(parsed.review_time, { limit_ms: 180000, remaining_ms: 150000, tool_calls: 0, model_requests: 3, instruction: parsed.review_time.instruction })
  assert.match(parsed.review_time.instruction, /counts are telemetry only/)
  await assert.rejects(
    readTool.execute({ file_path: '/project/a.js' }, { agent: { id: 'other' }, signal: new AbortController().signal }),
    (error) => error.code === 'CIEL_REVIEW_ACCESS_LIMITED',
  )
  const rendered = readTool.finalizeContent({}, { isError: true })
  assert.match(rendered[0].text, /Review data unavailable or outside allowed scope/)
  assert.equal(rendered[0].text.includes('/fixture-project'), false, 'no host path leaks through the safe error')
  await finish(f, run)
})

test('the outer run_code bridge delegates only the exact bound child to the private registry', async () => {
  const f = fixture()
  const run = await startRun(f)
  const hook = f.state.toolsExecute
  assert.equal(typeof hook, 'function')
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { isError: false, value: 'stock-runtime-result', content: [] } }
  const exec = { agent: f.child, name: 'run_code', arguments: { code: 'return 1', description: 'probe' }, signal: new AbortController().signal }
  const result = await hook(exec, next)
  assert.equal(nextCalls, 0, 'a matching reviewer outer run_code never falls through to the deployment runtime')
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { ok: true, args: exec.arguments })
  assert.match(result.content[0].text, /^PTC:/)
  const delegated = f.state.private.filter((entry) => entry.op === 'private-run-code')
  assert.equal(delegated.length, 1)
  assert.equal(delegated[0].exactChild, true, 'private transport saw the exact child object')
  assert.equal(delegated[0].parent, undefined, 'only the OUTER run_code is bridged')
  assert.equal(f.state.rootRun, 0, 'the deployment runtime was never invoked for the review child')
  await finish(f, run)
})

test('foreign agents and non-run_code calls keep the normal path', async () => {
  const f = fixture()
  const run = await startRun(f)
  const hook = f.state.toolsExecute
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return { isError: false, value: 'stock' } }
  await hook({ agent: { id: 'other' }, name: 'run_code', arguments: {}, signal: new AbortController().signal }, next)
  await hook({ agent: f.child, name: 'read', arguments: {}, signal: new AbortController().signal }, next)
  await hook({ agent: f.child, name: 'bash', arguments: {}, signal: new AbortController().signal }, next)
  assert.equal(nextCalls, 3, 'every non-matching call is delegated to the next wrapper')
  assert.equal(f.state.private.filter((entry) => entry.op === 'private-run-code').length, 0)
  await finish(f, run)
})

test('any matching reviewer transport failure denies instead of falling through', async () => {
  const cases = [
    ['private transport missing', (f) => { f.state.privateRunCodeMissing = true }],
    ['private transport throws', (f) => { f.state.privateRunCodeThrows = true }],
    ['language parity broken', (f) => { f.state.rootRuntime.language = 'python' }],
    ['operation closed', (f) => { f.control.operation.check = () => { throw new Error('closed') } }],
  ]
  for (const [label, mutate] of cases) {
    const f = fixture()
    const run = await startRun(f)
    mutate(f)
    const hook = f.state.toolsExecute
    let nextCalls = 0
    const result = await hook(
      { agent: f.child, name: 'run_code', arguments: { code: 'return 1' }, signal: new AbortController().signal },
      async () => { nextCalls += 1; return { isError: false, value: 'stock' } },
    )
    assert.equal(nextCalls, 0, label + ': must never fall through to the deployment runtime')
    assert.equal(result.isError, true, label + ': denied')
    assert.match(result.content[0].text, /Review data unavailable or outside allowed scope/, label)
    assert.equal(result.content[0].text.includes('/host'), false, label + ': no host path leaks')
    assert.equal(result.content[0].text.includes('boom'), false, label + ': no raw runtime error leaks')
    await finish(f, run)
  }
})

test('program-facing binding failures are sanitized and carry review_time', async () => {
  for (const mode of ['deny', 'foreign']) {
    const f = fixture()
    f.state.bindingProbe = true
    f.state.nestedMode = mode
    const run = await startRun(f)
    const result = await f.state.toolsExecute(
      { agent: f.child, name: 'run_code', arguments: { code: 'probe' }, signal: new AbortController().signal },
      async () => { throw new Error('must not fall through') },
    )
    assert.equal(result.isError, false, mode + ': the outer run_code succeeded; only the nested binding rejected')
    assert.equal(f.state.runtimeRuns, 1)
    const message = f.state.lastBindingError
    assert.equal(typeof message, 'string', mode + ': the binding rejected instead of resolving a success object')
    const parsed = JSON.parse(message)
    assert.equal(parsed.error, 'Review data unavailable or outside allowed scope')
    assert.equal(parsed.review_time.remaining_ms, 150000)
    assert.equal(parsed.review_time.limit_ms, 180000)
    assert.equal(message.includes('/host'), false, mode + ': no host path')
    assert.equal(message.includes('secret'), false, mode + ': no raw reason')
    assert.equal(message.includes('stack'), false, mode + ': no stack')
    assert.deepEqual(f.state.lastErrorClass, { name: 'ToolCallError', memberNameProperty: 'toolName' }, mode + ': errorClass preserved')
    assert.deepEqual(f.state.lastBindingNames, ['read', 'grep', 'glob'], mode + ': only allowed readers bound')
    await finish(f, run)
  }
})

test('a typed CODE_RUN_FAILED program failure is preserved with its diagnostics and logs', async () => {
  const f = fixture()
  f.state.transportFailure = 'code run failed (exception): ReferenceError: nope\nCaptured output:\nhello log'
  const run = await startRun(f)
  let nextCalls = 0
  const result = await f.state.toolsExecute(
    { agent: f.child, name: 'run_code', arguments: { code: 'throw new Error("nope")' }, signal: new AbortController().signal },
    async () => { nextCalls += 1; return { isError: false, value: 'stock' } },
  )
  assert.equal(nextCalls, 0, 'a program failure still never falls through to the deployment runtime')
  assert.equal(result.isError, true)
  assert.deepEqual(result.error.info, { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' }, 'the stable DSH code is preserved')
  assert.match(result.content[0].text, /code run failed \(exception\): ReferenceError: nope/)
  assert.match(result.content[0].text, /hello log/, 'captured logs reach the reviewer for self-correction')
  assert.equal(result.content[0].text.includes('Review data unavailable'), false, 'a program failure is not misreported as a scope denial')
  await finish(f, run)
})

test('an unrecognized host error stays the fixed DENIED envelope', async () => {
  const f = fixture()
  f.state.transportArbitrary = '/host/secret stack boom'
  const run = await startRun(f)
  let nextCalls = 0
  const result = await f.state.toolsExecute(
    { agent: f.child, name: 'run_code', arguments: { code: 'return 1' }, signal: new AbortController().signal },
    async () => { nextCalls += 1; return { isError: false, value: 'stock' } },
  )
  assert.equal(nextCalls, 0)
  assert.equal(result.isError, true)
  assert.equal(result.error.info, undefined, 'only the verified CODE_RUN_FAILED class is typed')
  assert.match(result.content[0].text, /Review data unavailable or outside allowed scope/)
  assert.equal(result.content[0].text.includes('/host'), false)
  await finish(f, run)
})

test('a program failure longer than the output bound is truncated, not passed through unbounded', async () => {
  const f = fixture()
  f.state.transportFailure = 'code run failed (output-limit): ' + 'x'.repeat(600000)
  const run = await startRun(f)
  const result = await f.state.toolsExecute(
    { agent: f.child, name: 'run_code', arguments: { code: 'return 1' }, signal: new AbortController().signal },
    async () => { throw new Error('must not fall through') },
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /\[program failure truncated\]$/)
  assert.ok(result.content[0].text.length <= 512 * 1024 + 40, 'bounded by the runner output budget plus the marker')
  await finish(f, run)
})

test('disposal keeps the hook registered but inert until the child is quiescent', async () => {
  const f = fixture()
  const run = await startRun(f)
  const pending = run.dispose()
  // The listener must still be registered (removing it early would expose the
  // deployment runtime to a live child) but must already deny.
  assert.equal(f.state.hookDisposed, false, 'hook stays registered while the child may still run')
  const hook = f.state.toolsExecute
  let nextCalls = 0
  const result = await hook(
    { agent: f.child, name: 'run_code', arguments: { code: 'return 1' }, signal: new AbortController().signal },
    async () => { nextCalls += 1; return { isError: false, value: 'stock' } },
  )
  assert.equal(nextCalls, 0)
  assert.equal(result.isError, true)
  assert.equal(f.state.hookDisposed, false, 'still inert-but-registered before quiescence')
  f.state.idleResolve?.()
  await pending
  assert.equal(f.state.hookDisposed, true, 'hook disposed only after quiescence')
  assert.equal(f.state.privateRuntimeDisposed, 1)
})

test('cancellation cancels the child, reports aborted, and unbinds exactly once', async () => {
  const f = fixture({ turnEndKind: 'aborted' })
  const run = await startRun(f)
  f.controller.abort()
  const result = await run.result
  assert.equal(result.stopReason, 'aborted')
  assert.deepEqual(f.state.calls.find((call) => call.op === 'cancel').reason, { kind: 'parent' })
  await run.dispose()
  await run.dispose()
  assert.equal(f.state.unbound.length, 1, 'dispose is idempotent and unbinds once')
  assert.equal(f.state.unbound[0], run.id)
  assert.equal(f.state.calls.filter((call) => call.op === 'handle.dispose').length, 1)
  assert.equal(f.state.privateRuntimeDisposed, 1, 'runtime disposed on cancellation')
})

test('bind failure rolls the unpublished child back without driving it or building a runtime', async () => {
  const f = fixture()
  f.state.failBind = true
  const provider = await createRestrictedReviewProvider(f.callbacks)
  await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_BACKEND_UNAVAILABLE')
  assert.equal(f.state.unbound.length, 1, 'failed binding is unbound')
  assert.equal(typeof f.state.unbound[0], 'string')
  assert.equal(f.state.calls.some((call) => call.op === 'followup'), false, 'no model request after rollback')
  assert.equal(f.state.calls.some((call) => call.op === 'handle.dispose'), false)
  assert.equal(f.state.calls.some((call) => call.op === 'createReviewCodeRuntime'), false, 'runtime is built only after a successful binding')
})

test('an unavailable runtime or tools module fails before any child is created', async () => {
  for (const [label, options] of [['runtime module', { runtimeMode: 'missing' }], ['tools module', { toolsMode: 'missing' }]]) {
    const f = fixture(options)
    const provider = await createRestrictedReviewProvider(f.callbacks)
    await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_MODULE_MISSING', label)
    assert.equal(f.state.createOptions.length, 0, label + ': no unpublished child is minted')
    assert.equal(f.state.calls.some((call) => call.op === 'followup'), false, label)
    assert.equal(f.state.unbound.length, 0, label)
  }
})

test('a missing control.guard fails a tooled phase before any child is created', async () => {
  const f = fixture({ guard: false })
  const provider = await createRestrictedReviewProvider(f.callbacks)
  await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_GUARD_UNAVAILABLE')
  assert.equal(f.state.createOptions.length, 0)
  assert.equal(f.state.calls.some((call) => call.op === 'followup'), false)
  assert.equal(f.state.unbound.length, 0)
})

test('a missing or mismatched root codeRuntime fails the tooled phase before its first request', async () => {
  for (const [label, rootRuntime] of [['missing', null], ['wrong language', { language: 'python', run() {} }], ['no run()', { language: 'typescript' }]]) {
    const f = fixture({ rootRuntime })
    const provider = await createRestrictedReviewProvider(f.callbacks)
    await assert.rejects(provider.start(f.request), (error) => error.code === (rootRuntime === null ? 'CIEL_REVIEW_SERVICE_NOT_READY' : 'CIEL_REVIEW_RUNTIME_INCOMPATIBLE'), label)
    assert.equal(f.state.createOptions.length, 1, label + ': the unpublished child is rolled back')
    assert.equal(f.state.calls.some((call) => call.op === 'followup'), false, label + ': no model request')
    assert.deepEqual(f.state.unbound, [f.state.createOptions[0].sessionId], label + ': rolled back')
    assert.equal(f.state.calls.some((call) => call.op === 'createReviewCodeRuntime'), false, label)
    assert.equal(f.state.calls.some((call) => call.op === 'assertRuntimeCompatible'), false, label + ': the runner preflights the root runtime instead of trusting the allow-on-undefined helper')
  }
})

test('a private runtime shape mismatch or compat failure disposes the runtime and rolls back', async () => {
  for (const [label, options] of [['shape mismatch', { runtimeMode: 'badshape' }], ['compat failure', { compatThrows: true }]]) {
    const f = fixture(options)
    if (options.compatThrows) f.state.compatThrows = true
    const provider = await createRestrictedReviewProvider(f.callbacks)
    await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_RUNTIME_INCOMPATIBLE', label)
    assert.equal(f.state.calls.some((call) => call.op === 'followup'), false, label)
    assert.equal(f.state.privateRuntimeDisposed, 1, label + ': the constructed runtime is disposed on rollback')
    assert.equal(f.state.unbound.length, 1, label + ': unbound once')
  }
})

test('private registry construction failure rolls back and awaits runtime disposal', async () => {
  const f = fixture({ toolsMode: 'throws' })
  const provider = await createRestrictedReviewProvider(f.callbacks)
  await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_REGISTRY_INIT_FAILED')
  assert.equal(f.state.calls.some((call) => call.op === 'followup'), false)
  // The fake runtime yields one setImmediate before recording disposal, so a
  // settled count at rejection proves the rollback AWAITED dispose().
  assert.equal(f.state.privateRuntimeDisposed, 1, 'rollback awaited runtime disposal')
  assert.equal(f.state.unbound.length, 1)
})

test('a guard denial before publication creates no agent and no binding', async () => {
  const f = fixture()
  f.control.operation.check = () => { throw new Error('guard closed') }
  const provider = await createRestrictedReviewProvider(f.callbacks)
  await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_ACCESS_LIMITED')
  assert.equal(f.state.createOptions.length, 0, 'no unpublished child is minted after a guard denial')
  assert.equal(f.state.unbound.length, 0)
  assert.equal(f.state.calls.some((call) => call.op === 'followup'), false)
})

test('an already-aborted request fails before claiming control', async () => {
  const f = fixture()
  f.controller.abort()
  const provider = await createRestrictedReviewProvider(f.callbacks)
  await assert.rejects(provider.start(f.request), (error) => error.code === 'CIEL_REVIEW_CANCELLED')
  assert.equal(f.state.calls.some((call) => call.op === 'claim'), false)
  assert.equal(f.state.unbound.length, 0)
})

test('deadline expiry stays distinct from permission denial and user cancellation during creation', async () => {
  for (const aborted of [false, true]) {
    const f = fixture()
    if (aborted) f.controller.abort(new Error('review timeout'))
    else f.control.operation.check = () => { throw new Error('review timeout') }
    const provider = await createRestrictedReviewProvider(f.callbacks)
    await assert.rejects(provider.start(f.request), error => error.code === 'CIEL_REVIEW_TIMEOUT')
    assert.equal(f.state.createOptions.length, 0)
  }
})

test('toolFilter deny narrows both registries to exactly the permitted readers', async () => {
  const denied = fixture()
  const deniedRun = await startRun(denied, { toolFilter: { allow: ['read', 'grep', 'glob'], deny: ['grep'] } })
  assert.deepEqual(denied.state.tools.registered.map((tool) => tool.name), ['read', 'glob'])
  assert.deepEqual(denied.privateNames(), ['read', 'glob'])
  await finish(denied, deniedRun)
})

test('the private guard is the fail-closed control.guard closure', async () => {
  const f = fixture()
  const run = await startRun(f)
  assert.equal(f.state.privateToolsInstance.guard, f.control.guard)
  f.state.guardDenial = 'this review phase cannot execute that tool'
  assert.equal(f.state.privateToolsInstance.guard({ agent: f.child, name: 'read' }), 'this review phase cannot execute that tool')
  assert.equal(f.state.calls.some((call) => call.op === 'control.guard'), true)
  await finish(f, run)
})

test('the descriptor is appended once, inside the first entering pre-step', async () => {
  const f = fixture()
  const run = await startRun(f)
  const next = async () => ({ kind: 'enter' })
  await f.state.preStep({ agent: f.child }, next)
  await f.state.preStep({ agent: f.child }, next)
  await f.state.preStep({ agent: f.child }, async () => ({ kind: 'skip' }))
  const appended = f.child.session.appended.filter((entry) => entry.type === 'subagent/descriptor')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].data.provider, 'ciel-review-private')
  assert.equal(appended[0].data.mode, 'one-shot')
  await finish(f, run)
})
