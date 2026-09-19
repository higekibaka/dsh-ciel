import { reviewFailure, classifyReviewFailure } from './review-errors.js'
import { randomUUID } from 'node:crypto'

const NAME = 'ciel-review-private'
const DENIED = 'Review data unavailable or outside allowed scope'
const MAX_OUTPUT = 512 * 1024
const READERS = ['read', 'grep', 'glob']
const REVIEW_LANGUAGE = 'typescript'
const CODE_RUN_FAILED = 'CODE_RUN_FAILED'
const CODE_RUN_FAILED_NAME = 'CodeRunFailedError'
const text = value => [{ type: 'text', text: value }]
function failure(message = DENIED, code = 'CIEL_REVIEW_ACCESS_LIMITED') {
  const error = new Error(message)
  error.code = code
  error.stack = 'Error: ' + message
  return error
}
function check(control, signal) {
  const timedOut = () => control.operation.reason?.() === 'review timeout' || signal.reason?.message === 'review timeout'
  if (signal.aborted) throw reviewFailure(timedOut() ? 'CIEL_REVIEW_TIMEOUT' : 'CIEL_REVIEW_CANCELLED', 'create')
  try { if (control.operation.check() === false) throw failure() }
  catch (error) { throw classifyReviewFailure(error, timedOut() || error?.message === 'review timeout' ? 'CIEL_REVIEW_TIMEOUT' : 'CIEL_REVIEW_ACCESS_LIMITED', 'guard') }
}
function noteLimited(control, error) {
  if (error?.code === 'CIEL_REVIEW_ACCESS_LIMITED') control.accessLimited = true
}
const virtualPath = { type: 'string', description: 'Snapshot path under virtual /project or approved /external-1, /external-2, … roots, OR the original approved absolute path from the host mapping (the same captured file). Relative paths use /project. No parent traversal.' }
const specs = {
  read: {
    description: 'Read frozen UTF-8 source from the Ciel in-memory review snapshot only, not the live filesystem. Returns a JSON string — call JSON.parse. Fields: file_path, offset (1-based), total_lines, content, truncated, evidence_refs (host receipt ids for the cited spans), evidence_instruction, and review_time (limit_ms, remaining_ms, tool_calls, model_requests, instruction). Paths are virtual /project or approved /external-1 roots. Excluded or out-of-scope files are unavailable.',
    parameters: { type: 'object', properties: { file_path: virtualPath, offset: { type: 'integer', minimum: 1, description: 'First line, 1-based; default 1.' }, limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum lines; default snapshot bound (at most 2000).' } }, required: ['file_path'], additionalProperties: false },
  },
  grep: {
    description: 'Search only copied in-memory Ciel review source using a LITERAL substring, NOT a regular expression. Returns a JSON string — call JSON.parse. Fields: matches (each with file_path, line_number, line, evidence_ref), truncated, evidence_refs (host receipt ids), evidence_instruction, and review_time (limit_ms, remaining_ms, tool_calls, model_requests, instruction). Virtual roots: /project and approved /external-1, /external-2, … .',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Nonempty literal substring (case-sensitive), not regex.' }, path: virtualPath, include: { type: 'string', description: 'Optional relative glob filter; supports *, ?, ** path segments, not regex or braces.' } }, required: ['pattern'], additionalProperties: false },
  },
  glob: {
    description: 'Find only copied in-memory Ciel review source paths; never enumerate the live filesystem. Returns a JSON string — call JSON.parse. Fields: paths (virtual), truncated, evidence_refs (host receipt ids), evidence_instruction, and review_time (limit_ms, remaining_ms, tool_calls, model_requests, instruction). Supports *, ? and ** path segments (no braces). Default root /project; approved additional roots /external-1, /external-2, … .',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Relative glob; * and ? within a segment, ** across path segments; a basename-only pattern matches at any depth.' }, path: virtualPath }, required: ['pattern'], additionalProperties: false },
  },
}
function reviewTime(control) {
  return {
    limit_ms: control.timeoutMs,
    remaining_ms: control.operation.remainingMs(),
    tool_calls: control.used,
    model_requests: control.operation.requests(),
    instruction: 'Query and model-request counts are telemetry only. Continue checking within the remaining time; finish the dossier and verdict before the deadline. Leave unresolved suspects unchecked.',
  }
}
function reader(name, control, signal, child) {
  return {
    name,
    ...specs[name],
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      try {
        if (exec.agent !== child || !control.allowTools || exec.signal.aborted) throw failure()
        check(control, signal)
        // The synchronous parent guard owns permission, deadline and query
        // accounting. These methods read copied data only.
        const value = control.corpus[name](args)
        if (value.truncated) control.accessLimited = true
        // Corpus responses are owned JSON; deadline metadata is separate from
        // captured source content and does not spend another model request.
        const rendered = JSON.stringify({ ...value, review_time: reviewTime(control) })
        if (typeof rendered !== 'string' || rendered.length > MAX_OUTPUT) throw failure()
        check(control, signal)
        return rendered
      } catch (error) {
        noteLimited(control, error)
        throw failure()
      }
    },
    // Also covers validation, guard, cancellation and pipeline errors that
    // bypass execute/post-execute. Never show raw host paths or error stacks.
    finalizeContent: (_exec, result) => {
      if (!result.isError) return undefined
      control.accessLimited = true
      return text(JSON.stringify({ error: DENIED, review_time: reviewTime(control) }))
    },
  }
}
function stopReason(kind) {
  switch (kind) {
    case 'completed': return 'completed'
    case 'blocked': return 'refusal'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    default: return 'error'
  }
}
// The fixed model-facing delegation-scope statement the official composition
// registers on every in-process child. Registered manually (not via
// applyChildComposition) so the reader realm never joins its parent's preset
// composition; the wording is kept identical to the shared constant.
const SUBAGENT_DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.'

/**
 * Inert private prompt sink. The private child-scoped ToolRuntime registers its
 * SDK/collapse sections and tool-schema provider here; none of it may reach the
 * real deployment prompt, so every registration is swallowed and only the
 * section-order lookups the registry performs synchronously are answered.
 * @returns the minimal systemPrompt surface ToolRuntime requires.
 */
function privatePromptSink() {
  const orders = { TOOLS_SDK: 900, PTC_ONLY: 899 }
  return {
    tools() { return () => {} },
    section() { return () => {} },
    getSectionOrder(name) { return Object.hasOwn(orders, name) ? orders[name] : 1000 },
  }
}

/**
 * Program-facing failure envelope. A nested reader rejection crosses the
 * runtime binding as `ToolCallError.message`; the host binding sends
 * `result.error.message` verbatim, which for validation/pre-policy/guard
 * failures bypasses the reader's own `execute` and its sanitized content. The
 * envelope is fixed, bounded and host-path/stack free, and still carries the
 * shared review clock so a program can read its remaining time.
 */
function bindingFailure(control) {
  return failure(JSON.stringify({ error: DENIED, review_time: reviewTime(control) }))
}

/**
 * Route the official program-execution failure by its stable machine code,
 * never by parsing a message. `CodeRunFailedError`
 * (packages/core/tools/src/ptc.ts) extends HarnessError with code
 * 'CODE_RUN_FAILED' and carries the failure kind, the substrate message and
 * the captured logs, so the reviewer can correct its own program. Any other
 * thrown value (lifecycle, capability, guard, private availability, or an
 * unrecognized code) returns undefined and stays the fixed DENIED envelope.
 * The message is bounded so one tool result cannot exceed the runner's output
 * budget; the runtime owns bounding/sanitizing the substrate message itself.
 */
function programFailure(error) {
  if (error === null || typeof error !== 'object' || error.code !== CODE_RUN_FAILED) return undefined
  const message = typeof error.message === 'string' ? error.message : ''
  if (message === '') return undefined
  return message.length > MAX_OUTPUT ? message.slice(0, MAX_OUTPUT) + '\n[program failure truncated]' : message
}

/**
 * Wrap one allowed snapshot reader binding so every rejection is projected.
 * The shared operation is checked before and after the binding: cancellation
 * or an expired deadline must never look like a successful read, the wrapper
 * never resets the deadline, and only the fixed envelope ever escapes.
 */
function sanitizedBinding(fn, control, signal) {
  return async (args) => {
    try {
      check(control, signal)
      const value = await fn(args)
      check(control, signal)
      return value
    } catch {
      // Never resolve: a failed nested dispatch stays a rejection, and the
      // runtime/worker still own the ToolCallError kind and toolName.
      throw bindingFailure(control)
    }
  }
}

/**
 * Rebuild a run request with only the allowed snapshot readers wrapped. The
 * binding namespaces and `errorClass` descriptor are preserved by identity, so
 * the worker keeps minting the same `ToolCallError` and the runtime keeps
 * resolving binding names as own properties.
 */
function withSanitizedBindings(request, control, signal) {
  if (request === null || typeof request !== 'object' || !Array.isArray(request.bindings)) return request
  const bindings = request.bindings.map((namespace) => {
    if (namespace === null || typeof namespace !== 'object') return namespace
    const source = namespace.functions
    if (source === null || typeof source !== 'object') return namespace
    const functions = Object.create(null)
    for (const name of Object.keys(source)) {
      const fn = source[name]
      functions[name] = typeof fn === 'function' && READERS.includes(name)
        ? sanitizedBinding(fn, control, signal)
        : fn
    }
    return { ...namespace, functions }
  })
  return { ...request, bindings }
}

/**
 * Host-owned projection of the private runtime. Only the run seam is wrapped;
 * language/isolation and dispose stay the runtime's own, so the registry's
 * language check and our teardown see the real runtime.
 */
function projectReviewRuntime(runtime, control, signal) {
  return {
    language: runtime.language,
    isolation: runtime.isolation,
    resolve: (request) => runtime.resolve(request),
    run: (request) => runtime.run(withSanitizedBindings(request, control, signal)),
    dispose: () => runtime.dispose(),
  }
}

/** True when a runtime object satisfies the public code-runtime seam we require. */
function usableRuntime(runtime) {
  return runtime !== undefined && runtime !== null
    && runtime.language === REVIEW_LANGUAGE
    && typeof runtime.run === 'function'
}

/**
 * Lazily resolve the optional review-only modules. Called only for a tooled
 * phase, so a history-only install never resolves the code runtime or the
 * optional tools peer; a missing/mismatched module fails the phase closed
 * before any child is created.
 */
async function loadTooledModules() {
  let runtime, tools
  try {
    ;[runtime, tools] = await Promise.all([import('./ptc-runtime.js'), import('@deepseek-ai/dsh-tools')])
  } catch { throw reviewFailure('CIEL_REVIEW_MODULE_MISSING', 'dependencies') }
  if (typeof runtime?.createReviewCodeRuntime !== 'function' || typeof tools?.ToolRuntime !== 'function') {
    throw reviewFailure('CIEL_REVIEW_INTERFACE_MISMATCH', 'dependencies')
  }
  return {
    createReviewCodeRuntime: runtime.createReviewCodeRuntime,
    assertRuntimeCompatible: typeof runtime.assertRuntimeCompatible === 'function' ? runtime.assertRuntimeCompatible : undefined,
    ToolRuntime: tools.ToolRuntime,
  }
}

/** Dispose the scoped hook exactly once. */
function closeHook(state) {
  if (state.hookClosed) return
  state.hookClosed = true
  try { state.hookDispose?.() } catch { /* scope teardown owns the listener */ }
}

/**
 * Release the private runtime and every private-context registration exactly
 * once; the normal-completion path and the rollback path both call it.
 */
async function disposeTooled(state) {
  if (state === undefined || state.disposed === true) return
  state.disposed = true
  state.closed = true
  closeHook(state)
  const runtime = state.privateRuntime
  state.privateRuntime = undefined
  state.privateTools = undefined
  try {
    const disposing = runtime?.dispose?.()
    if (disposing !== undefined && typeof disposing.then === 'function') await disposing
  } catch { /* runtime teardown failures stay contained */ }
  for (const dispose of state.disposers.reverse()) {
    try { dispose() } catch { /* private scope teardown */ }
  }
}

/**
 * Build the private code-runtime realm for one tooled review child and install
 * the scoped outer-transport bridge. Every step is synchronous and completes
 * before agents.create publishes the child, so a failure here denies the phase
 * before its first model request and leaves nothing running.
 *
 * The private realm is isolated by service label (tools/codeRuntime/
 * systemPrompt), so its registry, runtime and generated SDK never reach the
 * deployment or the child's real prompt. The child's OWN registry still
 * presents the official PTC transport, which is why the outer run_code is
 * intercepted on the child scope and delegated to the private registry's own
 * transport definition; the deployment's (bash-equivalent) runtime is never
 * reached for this child, and a bridge failure denies instead of falling
 * through.
 * @param options - bound child, control, tooled modules and allowed readers.
 * @returns owned hook/runtime state for dispose or rollback cleanup.
 */
function attachTooledRuntime({ childCtx, child, control, signal, enabled, modules, onState }) {
  const { createReviewCodeRuntime, assertRuntimeCompatible, ToolRuntime } = modules
  const runtimeService = childCtx.get('ptcRuntime') === undefined ? 'codeRuntime' : 'ptcRuntime'
  const deploymentRuntime = childCtx.get(runtimeService)
  if (!deploymentRuntime) throw reviewFailure('CIEL_REVIEW_SERVICE_NOT_READY', 'runtime')
  if (!usableRuntime(deploymentRuntime)) throw reviewFailure('CIEL_REVIEW_RUNTIME_INCOMPATIBLE', 'runtime')
  let privateRuntime
  try {
    privateRuntime = createReviewCodeRuntime({ deadlineAt: () => Date.now() + control.operation.remainingMs() })
  } catch { throw reviewFailure('CIEL_REVIEW_RUNTIME_INIT_FAILED', 'runtime') }
  // Ownership transfers to the caller BEFORE the first fallible step, so the
  // async rollback path can AWAIT runtime disposal instead of firing it and
  // hoping. This function never disposes asynchronously itself.
  const state = { disposed: false, closed: false, bound: false, hookClosed: false, privateRuntime, privateTools: undefined, hookDispose: undefined, disposers: [] }
  if (typeof onState === 'function') onState(state)
  if (!usableRuntime(privateRuntime) || typeof privateRuntime.dispose !== 'function') throw reviewFailure('CIEL_REVIEW_RUNTIME_INCOMPATIBLE', 'runtime')
  try { assertRuntimeCompatible?.(privateRuntime, deploymentRuntime) } catch { throw reviewFailure('CIEL_REVIEW_RUNTIME_INCOMPATIBLE', 'runtime') }
  const privateCtx = childCtx.isolate('tools').isolate(runtimeService).isolate('systemPrompt')
  state.disposers.push(privateCtx.provide('systemPrompt', privatePromptSink()))
  // Provide the host-projected runtime: the private registry still resolves
  // language/isolation from it, but every allowed reader rejection crossing
  // the guest binding is sanitized first.
  state.disposers.push(privateCtx.provide(runtimeService, projectReviewRuntime(privateRuntime, control, signal)))
  let privateTools
  try { privateTools = new ToolRuntime(privateCtx, { mode: 'native' }) }
  catch { throw reviewFailure('CIEL_REVIEW_REGISTRY_INIT_FAILED', 'registry') }
  state.privateTools = privateTools
  privateTools.presentAs('ptc')
  privateTools.restrict({ allow: [] })
  for (const name of enabled) privateTools.register(reader(name, control, signal, child))
  privateTools.guard(control.guard)
  // Scoped to this child's context: the hook sees only this child's tool
  // executions and disposes with the child scope fiber.
  state.hookDispose = childCtx.on('tools/execute', async (exec, next) => {
    // Only the exact bound child's run_code is ours; any other call (another
    // agent, another tool) keeps the normal path.
    if (exec === undefined || exec === null || exec.agent !== child || exec.name !== 'run_code') return next()
    // From here the call is the review child's run_code transport: it must
    // NEVER fall through to the deployment runtime.
    try {
      if (state.closed || state.bound !== true || control.allowTools !== true) throw failure()
      check(control, signal)
      const deployment = childCtx.get(runtimeService)
      if (deployment === undefined || deployment === null || deployment.language !== state.privateRuntime?.language) throw failure()
      const privateToolsRef = state.privateTools
      const definition = privateToolsRef?.get?.('run_code', child)
      if (definition === undefined || typeof definition.execute !== 'function' || typeof definition.output?.render !== 'function') throw failure()
      const value = await definition.execute(exec.arguments, exec)
      if (state.closed) throw failure()
      return { isError: false, value, content: definition.output.render(exec.arguments, value) }
    } catch (error) {
      noteLimited(control, error)
      // A typed official program-execution failure carries the failure kind and
      // the captured logs the reviewer needs to fix its program; route on the
      // stable code only. Every lifecycle/capability/guard/private-availability
      // failure keeps the fixed DENIED envelope.
      const program = programFailure(error)
      if (program !== undefined) {
        return {
          isError: true,
          error: { message: program, info: { name: CODE_RUN_FAILED_NAME, code: CODE_RUN_FAILED } },
          content: text('Error: ' + program),
        }
      }
      return { isError: true, error: { message: DENIED }, content: text('Error: ' + DENIED) }
    }
  })
  state.bound = true
  return state
}

/**
 * Lazy capability factory: history-only Ciel installs need not resolve these
 * shared DSH modules. The caller registers the returned one-shot provider only
 * after its global synchronous guard exists; no backend fallback is safe.
 *
 * claimControl is synchronous and must consume an exact pending
 * parent/label/signal capability, returning a per-run owned mutable control.
 * bindControl is synchronous, must bind that control to the unpublished child,
 * and must throw if the global guard is not active. unbindControl may be async;
 * it is called only after failed creation rollback or full run quiescence.
 * Corpus lifetime belongs to the parent operation, NOT this stage runner.
 *
 * A tooled phase additionally requires the deployment's shared root
 * codeRuntime (language typescript), the optional review-only runtime/tools
 * modules, and a synchronous control.guard; all are resolved before the child
 * is created. A no-tool phase stays native with no readers and no code runtime.
 */
export async function createRestrictedReviewProvider({ claimControl, bindControl, unbindControl } = {}) {
  if (![claimControl, bindControl, unbindControl].every(fn => typeof fn === 'function')) throw reviewFailure('CIEL_REVIEW_INTERFACE_MISMATCH', 'dependencies')
  let subagent, llm
  try {
    ;[subagent, llm] = await Promise.all([import('@deepseek-ai/dsh-subagent'), import('@deepseek-ai/dsh-llm')])
    for (const name of ['appendDelegatedPolicyOverrides', 'captureDelegatedPolicyOverrides', 'childSessionMeta', 'resolveChildAgentOptions', 'resolveChildDepth', 'assertSubagentMaxDepth', 'finalAssistantOutput']) {
      if (typeof subagent[name] !== 'function') throw reviewFailure('CIEL_REVIEW_INTERFACE_MISMATCH', 'dependencies')
    }
    if (typeof llm.createUserMessage !== 'function') throw reviewFailure('CIEL_REVIEW_INTERFACE_MISMATCH', 'dependencies')
  } catch (error) { throw classifyReviewFailure(error, 'CIEL_REVIEW_MODULE_MISSING', 'dependencies') }
  return {
    name: NAME,
    inheritsParentContext: false,
    capabilities: { agentOptions: true, persona: true, toolFilter: true, depthLimit: true, outputSchema: false },
    async start(request) {
      let control, childId, bindingAttempted = false, handle, tooledState, settled = false
      try {
        // All authority and policy capture precedes the first await in start.
        if (request.signal.aborted) throw reviewFailure(request.signal.reason?.message === 'review timeout' ? 'CIEL_REVIEW_TIMEOUT' : 'CIEL_REVIEW_CANCELLED', 'create')
        if (request.outputSchema !== undefined) throw failure()
        control = claimControl(request)
        if (!control || typeof control.then === 'function' || typeof control.operation?.check !== 'function' || typeof control.allowTools !== 'boolean') throw failure()
        // A corpus (and its frozen method surface) is required for any tooled
        // phase: the reviewer must only query the immutable snapshot, so an
        // absent/invalid corpus is denied before any prompt. A no-tool phase
        // may run without one — the reviewer never queries it.
        const usableCorpus = control.corpus && [...READERS, 'publicInfo'].every(name => typeof control.corpus[name] === 'function')
        if (!usableCorpus && control.allowTools) throw failure()
        const tooled = control.allowTools === true
        if (tooled) {
          // The fail-closed private gate and the shared-deadline clock are
          // required before a tooled phase may start; both are caller-owned.
          if (typeof control.guard !== 'function') throw reviewFailure('CIEL_REVIEW_GUARD_UNAVAILABLE', 'guard')
          if (typeof control.operation.remainingMs !== 'function') throw failure()
        }
        const enabled = tooled ? READERS.filter(name => (!request.toolFilter?.allow || request.toolFilter.allow.includes(name)) && !request.toolFilter?.deny?.includes(name)) : []
        const modules = tooled ? await loadTooledModules() : undefined
        check(control, request.signal)
        subagent.assertSubagentMaxDepth(request.maxDepth)
        const parent = request.parent
        const depth = subagent.resolveChildDepth(parent, request.maxDepth)
        const inherited = subagent.captureDelegatedPolicyOverrides(parent)
        childId = randomUUID()
        const descriptor = request.descriptor
        if (descriptor?.mode !== 'one-shot' || descriptor.provider !== NAME) throw failure()
        // The restricted reader realm never joins its parent's preset
        // composition: ToolRuntime restrict() filters only the INHERITED
        // surface (the global layer plus ancestor scope layers), never the
        // scope's OWN layer. Standard applyChildComposition joins the parent's
        // preset into the child's own scope, so every preset tool would land
        // in the child's own layer and survive restrict({ allow: [] }). Compose
        // deliberately instead: register only the fixed delegation context,
        // an optional shadowing persona, the official PTC transport (tooled) or
        // native presentation (no-tool), deny every global body, and register
        // exactly the allowed corpus readers.
        const meta = subagent.childSessionMeta(parent, depth, false)
        // Composition was NOT joined, so the durable header must not claim the
        // parent's preset — a cold read would otherwise rebuild the child's
        // turns under a tool/persona set it never had.
        delete meta.agentPreset
        handle = await parent.ctx.agents.create({
          sessionId: childId,
          // Runtime ownership is explicit in DSH 0.1.5+: the durable
          // parentSession metadata records lineage but does NOT establish the
          // registry's owner relation, so the live parent must be named here.
          parentAgent: parent,
          // Fresh spawn: no seed or parent messages, activation boundary zero.
          meta,
          agentOptions: subagent.resolveChildAgentOptions(parent, request.agentOptions, depth),
          signal: request.signal,
          setup(childCtx, child) {
            check(control, request.signal)
            bindingAttempted = true
            bindControl(control, child)
            subagent.appendDelegatedPolicyOverrides(child.session, inherited)
            childCtx.systemPrompt.context({
              name: 'subagent:delegation',
              order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
              text: SUBAGENT_DELEGATION_CONTEXT,
            })
            if (request.persona !== undefined) {
              childCtx.systemPrompt.section({
                name: 'deployment:persona-prefix',
                order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
                text: request.persona,
              })
            }
            // Tooled: the child's own registry presents the official PTC
            // transport and the SDK generated from the ROOT (deployment)
            // runtime language; the private realm is built before publication.
            // No-tool: native presentation, no readers, no runtime.
            childCtx.tools.presentAs(tooled ? 'ptc' : 'native')
            // Hide every inherited/global body, even when a corpus reader is
            // omitted. Child-local definitions shadow the originals by name.
            childCtx.tools.restrict({ allow: [] })
            for (const name of enabled) childCtx.tools.register(reader(name, control, request.signal, child))
            if (tooled) {
              tooledState = attachTooledRuntime({
                childCtx, child, control, signal: request.signal, enabled, modules,
                // Record ownership before the first fallible step so the async
                // rollback below can AWAIT runtime disposal.
                onState: (state) => { tooledState = state },
              })
            }
            if (control.corpus && control.corpus.publicInfo().truncated) control.accessLimited = true
            let appended = false
            childCtx.on('agent/pre-step', async ({ agent }, next) => {
              const decision = await next()
              if (!appended && decision.kind === 'enter') {
                appended = true
                agent.session.append('subagent/descriptor', descriptor)
              }
              return decision
            })
            // The official creation transaction revalidates after its await,
            // immediately before publication (without driving the child here).
            return { commit() { check(control, request.signal) } }
          },
        })
      } catch (error) {
        if (control && typeof control.then !== 'function') noteLimited(control, error)
        if (tooledState) await disposeTooled(tooledState)
        // agents.create rejects only after its unpublished rollback is quiet.
        if (bindingAttempted) {
          try { await unbindControl(control, childId) } catch { throw reviewFailure('CIEL_REVIEW_CLEANUP_FAILED', 'cleanup') }
        }
        throw classifyReviewFailure(error, 'CIEL_REVIEW_BACKEND_UNAVAILABLE', error?.stage || 'create')
      }
      const child = handle.agent
      let cancelled = false, disposal
      const onAbort = () => { cancelled = true; child.cancel({ kind: 'parent' }) }
      request.signal.addEventListener('abort', onAbort, { once: true })
      // Close the official creation-listener → run-listener cancellation gap.
      if (request.signal.aborted) onAbort()
      const result = (async () => {
        try {
          if (!cancelled) {
            child.followup(llm.createUserMessage({ content: request.prompt, source: { kind: 'user' } }))
            await child.whenIdle()
          }
          const own = child.session.snapshotEvents(0)
          // Exactly one submitted turn and no seed; read only the end's kind.
          const end = own.findLast(event => event.type === 'turn/end')
          const recorded = stopReason(end?.data.reason.kind)
          return {
            output: subagent.finalAssistantOutput(own) ?? [],
            stopReason: cancelled && recorded !== 'completed' ? 'aborted' : recorded,
          }
        } catch (error) { throw classifyReviewFailure(error, 'CIEL_REVIEW_EXECUTION_FAILED', 'run') }
        finally {
          settled = true
          request.signal.removeEventListener('abort', onAbort)
        }
      })()
      return {
        id: childId,
        localAgent: child,
        result,
        dispose() {
          if (!disposal) disposal = (async () => {
            request.signal.removeEventListener('abort', onAbort)
            cancelled = true
            // Prevent transport FIRST when disposal lands while the child is
            // still live: the hook stays REGISTERED (removing it early would
            // let a later outer run_code fall through to the deployment
            // runtime) but denies from now on; the shared operation is
            // cancelled only if this run has not settled.
            if (tooledState) {
              tooledState.closed = true
              if (!settled && typeof control.operation?.cancel === 'function') {
                try { control.operation.cancel('review runtime disposed') } catch { /* already cancelled */ }
              }
            }
            // Start both settlements before awaiting either; never unregister
            // the parent's guard binding while child work may still execute.
            const settledRun = await Promise.allSettled([handle.dispose(), result])
            if (tooledState) await disposeTooled(tooledState)
            try { await unbindControl(control, childId) } catch { throw reviewFailure('CIEL_REVIEW_CLEANUP_FAILED', 'cleanup') }
            if (settledRun[0].status === 'rejected') throw reviewFailure('CIEL_REVIEW_CLEANUP_FAILED', 'cleanup')
          })()
          return disposal
        },
      }
    },
  }
}
