/**
 * Ciel review code runtime — worker-hosted QuickJS/WASM implementation of the
 * DSH PTC execution seam (`ctx.ptcRuntime`, formerly `ctx.codeRuntime`).
 *
 * One fresh worker per run hosts one QuickJS instance. The worker is trusted
 * (Node builtins: type stripping, QuickJS module loading); the guest program
 * has no ambient Node globals and reaches the host only through lossless-JSON
 * async bindings. This is a containment boundary for a restricted review child,
 * not a general sandbox: the guest cannot read files, spawn processes, use the
 * network, or import modules.
 *
 * The runtime owns no time budget of its own. The caller supplies an absolute
 * `deadlineAt()` read at each run start — the review operation's REMAINING
 * shared time. There is no per-run CPU quota and no hidden default deadline.
 * @module dsh-ciel/ptc-runtime
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

/** Language of the programs this runtime executes (seam descriptor). */
export const REVIEW_RUNTIME_LANGUAGE = 'typescript'
/** Substrate descriptor (seam: informational, not a security claim). */
export const REVIEW_RUNTIME_ISOLATION = 'worker-thread+quickjs'

/** Resolved once from THIS module's location; callers cannot select a path. */
const WORKER_PATH = fileURLToPath(new URL('./ptc-runtime-worker.mjs', import.meta.url))

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const DUNDER_MEMBER = /^__.+__$/
/** Seam-shared reserved globals (see @deepseek-ai/dsh-ptc-runtime). */
const RESERVED_BINDING_GLOBALS = new Set(['console', '__dsh_main__', '__builtins__', '__name__', '__debug__'])
/** Seam-shared error-member exclusions. */
const RESERVED_ERROR_MEMBERS = new Set(['name', 'message', 'stack', 'args', 'with_traceback', 'add_note'])
/** ECMAScript ∪ Python reserved words (seam portability contract). */
const PORTABLE_RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except', 'from',
  'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'match', 'type', '_',
])

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_MAX_LOG_BYTES = 64 * 1024
const DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_STACK_BYTES = 1024 * 1024

/**
 * Strict lossless-JSON validation (exported for tests and callers that bridge
 * values into the runtime). Rejects anything `JSON.stringify` would silently
 * change or drop. Returns a detached null-prototype clone.
 * @param value - candidate value.
 * @returns the detached clone.
 * @throws TypeError with the JSON path of the first violation.
 */
export function snapshotLosslessJson(value) {
  return snapshot(value, '$', new Set())
}

/** Assert {@link snapshotLosslessJson} accepts `value`; returns nothing. */
export function assertLosslessJson(value) {
  snapshotLosslessJson(value)
}

function snapshot(value, path, seen) {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean': case 'string': return value
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(path + ': non-finite number is not lossless JSON')
      return value
    case 'undefined': throw new TypeError(path + ': undefined is not lossless JSON')
    case 'bigint': throw new TypeError(path + ': bigint is not lossless JSON')
    case 'function': throw new TypeError(path + ': function is not lossless JSON')
    case 'symbol': throw new TypeError(path + ': symbol is not lossless JSON')
    default: break
  }
  if (seen.has(value)) throw new TypeError(path + ': cyclic reference is not lossless JSON')
  seen.add(value)
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(path + ': symbol-keyed properties are not lossless JSON')
    if (Array.isArray(value)) {
      if (Object.getOwnPropertyNames(value).filter(key => key !== 'length').length !== value.length) throw new TypeError(path + ': sparse array or extra own property is not lossless JSON')
      const out = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError(path + '[' + index + ']: missing enumerable value is not lossless JSON')
        }
        out.push(snapshot(descriptor.value, path + '[' + index + ']', seen))
      }
      return out
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new TypeError(path + ': non-plain object is not lossless JSON')
    const out = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(path + '.' + key + ': non-enumerable or accessor property is not lossless JSON')
      }
      Object.defineProperty(out, key, { enumerable: true, writable: true, configurable: true, value: snapshot(descriptor.value, path + '.' + key, seen) })
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** Validate one binding namespace list, fail-closed on contract misuse. */
function validateBindings(bindings) {
  if (!Array.isArray(bindings)) throw new TypeError('code runtime bindings must be an array')
  const globals = new Set()
  const errorClassNames = new Set()
  const namespaces = []
  for (const namespace of bindings) {
    if (typeof namespace !== 'object' || namespace === null) throw new TypeError('binding namespace must be an object')
    const global = namespace.global
    if (typeof global !== 'string' || !IDENTIFIER.test(global) || PORTABLE_RESERVED_WORDS.has(global)) {
      throw new TypeError('binding global ' + JSON.stringify(global) + ' is not a usable identifier')
    }
    if (RESERVED_BINDING_GLOBALS.has(global)) throw new TypeError('reserved binding global ' + JSON.stringify(global))
    if (globals.has(global)) throw new TypeError('duplicate binding global ' + JSON.stringify(global))
    globals.add(global)
    if (typeof namespace.functions !== 'object' || namespace.functions === null) throw new TypeError('binding namespace ' + JSON.stringify(global) + ' must declare functions')
    const names = []
    for (const name of Object.keys(namespace.functions)) {
      if (typeof namespace.functions[name] !== 'function') throw new TypeError('binding ' + JSON.stringify(global + '.' + name) + ' must be a function')
      names.push(name)
    }
    let errorClassName
    let errorMember
    const descriptor = namespace.errorClass
    if (descriptor !== undefined) {
      if (typeof descriptor !== 'object' || descriptor === null) throw new TypeError('binding errorClass must be an object')
      if (typeof descriptor.name !== 'string' || !IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new TypeError('binding error class ' + JSON.stringify(descriptor.name) + ' is not a usable identifier')
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || globals.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new TypeError('duplicate injected global ' + JSON.stringify(descriptor.name))
      }
      const member = descriptor.memberNameProperty
      if (typeof member !== 'string' || member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new TypeError('binding error member property ' + JSON.stringify(member) + ' is not usable')
      }
      errorClassNames.add(descriptor.name)
      errorClassName = descriptor.name
      errorMember = member
    }
    namespaces.push({ global, names, ...errorClassName === undefined ? {} : { errorClassName, errorMember } })
  }
  return namespaces
}

/** Parse one inbound worker message; junk returns undefined (hostile peer). */
function parseWorkerMessage(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined
  const message = raw
  if (message.type === 'call') {
    if (typeof message.id !== 'number' || typeof message.global !== 'string' || typeof message.name !== 'string' || typeof message.wire !== 'string') return undefined
    return { type: 'call', id: message.id, global: message.global, name: message.name, wire: message.wire }
  }
  if (message.type === 'done') {
    const logs = Array.isArray(message.logs) ? message.logs.filter(entry => typeof entry === 'string') : []
    if (message.error === undefined) return { type: 'done', logs, ...message.value === undefined ? {} : { value: message.value } }
    const error = message.error
    if (typeof error !== 'object' || error === null) return undefined
    const kinds = ['exception', 'timeout', 'abort', 'worker-exit', 'invalid-output', 'output-limit']
    if (!kinds.includes(error.kind) || typeof error.message !== 'string') return undefined
    return { type: 'done', logs, error: { kind: error.kind, message: error.message } }
  }
  return undefined
}

/**
 * Create the Ciel review code runtime.
 *
 * @param options - runtime configuration.
 * @param options.deadlineAt - REQUIRED absolute epoch-ms deadline, read at each
 *   run start. The caller derives it from the review operation's remaining
 *   shared time; the runtime never invents a per-run budget.
 * @param options.maxOutputBytes - combined cap for logs + completion value / failure message.
 * @param options.maxLogBytes - per-log-entry cap.
 * @param options.memoryLimitBytes - QuickJS heap cap.
 * @param options.maxStackBytes - QuickJS stack cap.
 * @returns a CodeRuntime-shaped service object with an extra `dispose()`.
 */
export function createReviewCodeRuntime(options = {}) {
  const { deadlineAt, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, maxLogBytes = DEFAULT_MAX_LOG_BYTES, memoryLimitBytes = DEFAULT_MEMORY_LIMIT_BYTES, maxStackBytes = DEFAULT_MAX_STACK_BYTES } = options
  if (typeof deadlineAt !== 'function') throw new TypeError('createReviewCodeRuntime requires deadlineAt(): an absolute epoch-ms deadline is the only time budget')
  for (const [name, value] of Object.entries({ maxOutputBytes, maxLogBytes, memoryLimitBytes, maxStackBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('createReviewCodeRuntime option ' + name + ' must be a positive number')
  }
  const live = new Set()
  let disposed = false
  return {
    language: REVIEW_RUNTIME_LANGUAGE,
    isolation: REVIEW_RUNTIME_ISOLATION,
    /** Resolve the shared review deadline; this guest has no filesystem authority. */
    resolve(request) {
      if (request.sandboxPolicy !== undefined) throw new TypeError('review runtime does not support sandboxPolicy')
      if (request.timeoutMs !== undefined) throw new TypeError('review runtime uses the shared review deadline; timeoutMs is unsupported')
      const remainingMs = deadlineAt() - Date.now()
      if (!Number.isFinite(remainingMs)) throw new TypeError('deadlineAt() must return a finite epoch-ms number')
      return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: Math.max(1, remainingMs) }
    },
    /** Terminate every in-flight run and wait for the workers to exit. */
    async dispose() {
      disposed = true
      const runs = [...live]
      await Promise.allSettled(runs.map(run => run.abort('runtime disposed')))
      // abort() already returns the termination promise; this second pass closes
      // the race where a run entered `live` while the first snapshot was taken.
      await Promise.allSettled([...live].map(run => run.finished))
    },
    async run(request) {
      if (disposed) throw new Error('dsh-ciel: run() after dispose()')
      if (typeof request !== 'object' || request === null || typeof request.program !== 'string') throw new TypeError('code runtime run() requires a program string')
      const namespaces = validateBindings(request.bindings)
      const signal = request.signal
      const deadlineAtMs = deadlineAt()
      if (!Number.isFinite(deadlineAtMs)) throw new TypeError('deadlineAt() must return a finite epoch-ms number')
      if (signal?.aborted) return { logs: [], error: { kind: 'abort', message: String(signal.reason ?? 'aborted') } }

      const worker = new Worker(WORKER_PATH, {
        workerData: {
          program: request.program,
          namespaces,
          deadlineAt: deadlineAtMs,
          maxOutputBytes,
          maxLogBytes,
          memoryLimitBytes,
          maxStackBytes,
        },
        env: {},
        execArgv: ['--no-warnings'],
        resourceLimits: { maxOldGenerationSizeMb: Math.max(32, Math.ceil(memoryLimitBytes / (1024 * 1024)) + 64) },
      })

      return await new Promise(resolve => {
        let settled = false
        let finishResolve
        const finished = new Promise(settle => { finishResolve = settle })
        const logs = []
        const answered = new Set()
        // The run resolves only after worker termination completes, so dispose()
        // (and any caller awaiting run()) observes a fully quiesced substrate and
        // no late binding can be answered after settlement.
        const finish = result => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          clearTimeout(deadlineTimer)
          void worker.terminate().finally(() => {
            live.delete(handle)
            resolve(result)
            finishResolve()
          })
        }
        const abort = reason => {
          finish({ logs: [...logs], error: { kind: 'abort', message: String(reason) } })
          return finished
        }
        const handle = { abort, finished }
        live.add(handle)
        const onAbort = () => { void abort(signal?.reason ?? 'aborted') }
        signal?.addEventListener('abort', onAbort, { once: true })
        // Termination starts AT the absolute deadline; there is no execution
        // grace, so an unresolved guest promise cannot outlive the shared budget.
        const deadlineTimer = setTimeout(() => {
          finish({ logs: [...logs], error: { kind: 'timeout', message: 'review deadline reached' } })
        }, Math.max(0, deadlineAtMs - Date.now()))

        const reply = payload => {
          if (settled) return
          worker.postMessage({ type: 'reply', id: payload.id, ok: payload.ok, ...payload.ok ? { value: payload.value } : { message: payload.message, ...payload.toolName === undefined ? {} : { toolName: payload.toolName } } })
        }
        worker.on('message', raw => {
          const message = parseWorkerMessage(raw)
          if (message === undefined) return
          if (message.type === 'done') {
            logs.push(...message.logs)
            if (message.error !== undefined) { finish({ logs: [...logs], error: message.error }); return }
            if (message.value === undefined) { finish({ logs: [...logs] }); return }
            let value
            try { value = snapshotLosslessJson(message.value) }
            catch (error) { finish({ logs: [...logs], error: { kind: 'invalid-output', message: String(error && error.message || error) } }); return }
            finish({ logs: [...logs], value })
            return
          }
          if (message.type !== 'call' || settled) return
          if (answered.has(message.id)) return
          answered.add(message.id)
          const namespace = namespaces.find(candidate => candidate.global === message.global)
          const functions = request.bindings.find(candidate => candidate.global === message.global)?.functions
          const fn = namespace !== undefined && functions !== undefined && Object.hasOwn(functions, message.name) ? functions[message.name] : undefined
          if (typeof fn !== 'function') {
            reply({ id: message.id, ok: false, message: 'unknown binding ' + JSON.stringify(message.global + '.' + message.name), toolName: message.name })
            return
          }
          void (async () => {
            let args
            try { args = snapshotLosslessJson(JSON.parse(message.wire)) }
            catch (error) {
              reply({ id: message.id, ok: false, message: 'tool arguments must be lossless JSON: ' + String(error && error.message || error), toolName: message.name })
              return
            }
            try {
              const value = await fn(args)
              const detached = snapshotLosslessJson(value)
              reply({ id: message.id, ok: true, value: detached })
            } catch (error) {
              // Preserve the member name on rejection so the guest's injected
              // error class exposes it through memberNameProperty.
              reply({ id: message.id, ok: false, message: String(error && error.message || error), toolName: message.name })
            }
          })()
        })
        // Substrate failures are host data: never forward worker/module paths
        // or stacks to the model. Guest/prelude messages stay intact.
        worker.on('error', () => finish({ logs: [...logs], error: { kind: 'worker-exit', message: 'review runtime substrate failed' } }))
        worker.on('exit', () => finish({ logs: [...logs], error: { kind: 'worker-exit', message: 'review runtime worker exited before completing' } }))
      })
    },
  }
}

/** True when the private runtime can stand in for the deployment runtime's
 *  model-facing SDK flavor (the SDK section is generated by the host registry). */
export function assertRuntimeCompatible(privateRuntime, deploymentRuntime) {
  if (privateRuntime === undefined) throw new Error('dsh-ciel: private review runtime is unavailable')
  if (deploymentRuntime === undefined) throw new Error('dsh-ciel: deployment code runtime is unavailable; ptc presentation cannot be generated')
  if (privateRuntime.language !== deploymentRuntime.language) {
    throw new Error('dsh-ciel: private review runtime language ' + JSON.stringify(privateRuntime.language) + ' does not match the deployment code runtime ' + JSON.stringify(deploymentRuntime.language))
  }
}

export default createReviewCodeRuntime
