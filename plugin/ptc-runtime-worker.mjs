/**
 * Ciel review code-runtime worker: a fresh worker hosts one QuickJS/WASM
 * instance per run. The worker is TRUSTED (Node builtins strip TypeScript and
 * load the pinned QuickJS module); the guest program runs inside QuickJS with
 * no ambient Node globals and reaches the host only through lossless-JSON
 * bindings implemented as REAL promises (deferred promises + pending-job
 * pumping), so Promise.all, .then/.catch and for-await all work concurrently.
 * @module dsh-ciel/ptc-runtime-worker
 */
import { parentPort, workerData } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'

/** Wrapper matching the seam's async-function-body contract; strip mode is
 *  position preserving, so the body slices back out unchanged. */
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' }

/**
 * Guest-side strict wire encoder. QuickJS `ctx.dump` may coerce invalid guest
 * values, so arguments are validated and canonicalized INSIDE the guest before
 * crossing the boundary. Rejects undefined values/properties, non-finite
 * numbers, bigint, function/symbol, sparse arrays, symbol keys, accessors,
 * non-plain objects (Date/Map/class), toJSON and cycles. Objects are rebuilt
 * with Object.defineProperty so names like `__proto__`/constructor stay own data.
 */
const GUEST_PRELUDE = `
globalThis.__dsh_encode = value => {
  const seen = new Set()
  const walk = (v, path) => {
    if (v === null) return null
    const type = typeof v
    if (type === 'boolean' || type === 'string') return v
    if (type === 'number') { if (!Number.isFinite(v)) throw new Error(path + ': non-finite number is not lossless JSON'); return v }
    if (type === 'undefined') throw new Error(path + ': undefined is not lossless JSON')
    if (type === 'bigint') throw new Error(path + ': bigint is not lossless JSON')
    if (type === 'function') throw new Error(path + ': function is not lossless JSON')
    if (type === 'symbol') throw new Error(path + ': symbol is not lossless JSON')
    if (seen.has(v)) throw new Error(path + ': cyclic reference is not lossless JSON')
    seen.add(v)
    try {
      if (Object.getOwnPropertySymbols(v).length > 0) throw new Error(path + ': symbol-keyed properties are not lossless JSON')
      if (Array.isArray(v)) {
        const own = Object.getOwnPropertyNames(v).filter(key => key !== 'length')
        if (own.length !== v.length) throw new Error(path + ': sparse array or extra own property is not lossless JSON')
        const out = []
        for (let index = 0; index < v.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(v, String(index))
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error(path + '[' + index + ']: missing enumerable value is not lossless JSON')
          out.push(walk(descriptor.value, path + '[' + index + ']'))
        }
        return out
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) throw new Error(path + ': non-plain object is not lossless JSON')
      const out = {}
      for (const key of Object.getOwnPropertyNames(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error(path + '.' + key + ': non-enumerable or accessor property is not lossless JSON')
        Object.defineProperty(out, key, { enumerable: true, writable: true, configurable: true, value: walk(descriptor.value, path + '.' + key) })
      }
      return out
    } finally { seen.delete(v) }
  }
  return JSON.stringify(walk(value, '$'))
}
globalThis.console = {
  log: (...a) => globalThis.__dsh_log(a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x) } catch { return String(x) } }).join(' ')),
  error: (...a) => globalThis.console.log(...a),
  warn: (...a) => globalThis.console.log(...a),
  info: (...a) => globalThis.console.log(...a),
}
`

/** Host-side strict lossless-JSON validation (defense in depth after the guest
 *  encoder). Returns a detached plain clone with Object.defineProperty writes. */
function snapshot(value, path, seen) {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean': case 'string': return value
    case 'number':
      if (!Number.isFinite(value)) throw new Error(path + ': non-finite number is not lossless JSON')
      return value
    case 'undefined': throw new Error(path + ': undefined is not lossless JSON')
    case 'bigint': throw new Error(path + ': bigint is not lossless JSON')
    case 'function': throw new Error(path + ': function is not lossless JSON')
    case 'symbol': throw new Error(path + ': symbol is not lossless JSON')
    default: break
  }
  if (seen.has(value)) throw new Error(path + ': cyclic reference is not lossless JSON')
  seen.add(value)
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(path + ': symbol-keyed properties are not lossless JSON')
    if (Array.isArray(value)) {
      if (Object.getOwnPropertyNames(value).filter(key => key !== 'length').length !== value.length) throw new Error(path + ': sparse array or extra own property is not lossless JSON')
      const out = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error(path + '[' + index + ']: missing enumerable value is not lossless JSON')
        out.push(snapshot(descriptor.value, path + '[' + index + ']', seen))
      }
      return out
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new Error(path + ': non-plain object is not lossless JSON')
    const out = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error(path + '.' + key + ': non-enumerable or accessor property is not lossless JSON')
      Object.defineProperty(out, key, { enumerable: true, writable: true, configurable: true, value: snapshot(descriptor.value, path + '.' + key, seen) })
    }
    return out
  } finally { seen.delete(value) }
}

/** Combined byte ledger for logs + completion value / failure message. */
class OutputLedger {
  constructor(maxOutputBytes, maxLogBytes) {
    this.maxOutputBytes = maxOutputBytes
    this.maxLogBytes = maxLogBytes
    this.bytes = 2 // '[]'
    this.logs = []
    this.overflowed = false
  }
  log(text) {
    if (typeof text !== 'string' || this.overflowed) return
    const capped = text.length > this.maxLogBytes ? text.slice(0, this.maxLogBytes) : text
    const entryBytes = Buffer.byteLength(JSON.stringify(capped), 'utf8')
    if (this.bytes + entryBytes + 1 > this.maxOutputBytes) { this.overflowed = true; return }
    this.bytes += entryBytes + 1
    this.logs.push(capped)
  }
  success(value) {
    const encoded = value === undefined ? undefined : JSON.stringify(value)
    if (this.overflowed || (encoded !== undefined && this.bytes + Buffer.byteLength(encoded, 'utf8') > this.maxOutputBytes)) return this.limit()
    return { logs: this.logs, ...encoded === undefined ? {} : { value } }
  }
  failure(error) {
    if (this.overflowed || this.bytes + Buffer.byteLength(JSON.stringify(error.message), 'utf8') > this.maxOutputBytes) return this.limit()
    return { logs: this.logs, error }
  }
  limit() {
    const message = 'combined logs/value output exceeded ' + this.maxOutputBytes + ' bytes'
    const retained = []
    let bytes = 2
    for (const text of this.logs) {
      const entryBytes = Buffer.byteLength(JSON.stringify(text), 'utf8') + 1
      if (bytes + entryBytes > this.maxOutputBytes) break
      retained.push(text)
      bytes += entryBytes
    }
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}

async function run() {
  const ledger = new OutputLedger(workerData.maxOutputBytes, workerData.maxLogBytes)
  const finish = payload => { parentPort.postMessage({ type: 'done', ...payload }) }
  let QuickJS
  try {
    const mod = await import('quickjs-emscripten')
    QuickJS = await mod.newQuickJSWASMModule()
  } catch (error) {
    finish({ logs: [], error: { kind: 'worker-exit', message: 'review runtime substrate unavailable' } })
    return
  }
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(workerData.memoryLimitBytes)
  runtime.setMaxStackSize(workerData.maxStackBytes)
  runtime.setInterruptHandler(() => Date.now() >= workerData.deadlineAt)
  const ctx = runtime.newContext()
  const owned = []
  const pendingCalls = new Map()
  let nextCallId = 0
  const keep = handle => { owned.push(handle); return handle }

  parentPort.on('message', message => {
    if (typeof message !== 'object' || message === null || message.type !== 'reply' || typeof message.id !== 'number') return
    const deferred = pendingCalls.get(message.id)
    if (deferred === undefined) return
    pendingCalls.delete(message.id)
    const payload = message.ok === true
      ? { ok: true, value: message.value }
      : { ok: false, message: typeof message.message === 'string' ? message.message : 'binding failed', ...message.toolName === undefined ? {} : { toolName: message.toolName } }
    deferred.resolve(ctx.newString(JSON.stringify(payload)))
    runtime.executePendingJobs()
  })

  try {
    const base = keep(ctx.evalCode(GUEST_PRELUDE))
    if (base.error) {
      const dumped = ctx.dump(base.error)
      base.error.dispose()
      finish(ledger.failure({ kind: 'exception', message: 'prelude: ' + String(dumped && dumped.message || dumped) }))
      return
    }
    const logFn = ctx.newFunction('__dsh_log', handle => { ledger.log(ctx.getString(handle)) })
    logFn.consume(handle => ctx.setProp(ctx.global, '__dsh_log', handle))

    for (const namespace of workerData.namespaces) {
      const errorClassCode = namespace.errorClassName === undefined
        ? ''
        : 'Object.defineProperty(globalThis, ' + JSON.stringify(namespace.errorClassName) + ', { enumerable: true, writable: true, configurable: true, value: class extends Error { constructor(message, member) { super(message); this.name = ' + JSON.stringify(namespace.errorClassName) + '; if (member !== undefined) Object.defineProperty(this, ' + JSON.stringify(namespace.errorMember) + ', { enumerable: true, writable: true, configurable: true, value: member }) } } });'
      const assignments = []
      namespace.names.forEach((name, index) => {
        const hostName = '__dsh_host_' + index + '_' + namespace.index
        const fn = ctx.newFunction(hostName, argsHandle => {
          const wire = ctx.getString(argsHandle)
          const deferred = ctx.newPromise()
          const id = ++nextCallId
          pendingCalls.set(id, deferred)
          parentPort.postMessage({ type: 'call', id, global: namespace.global, name, wire })
          return deferred.handle
        })
        fn.consume(handle => ctx.setProp(ctx.global, hostName, handle))
        const errorName = namespace.errorClassName === undefined ? undefined : namespace.errorClassName
        const throwCode = errorName === undefined
          ? 'throw new Error(r.message)'
          : 'throw new globalThis[' + JSON.stringify(errorName) + '](r.message, r.toolName)'
        assignments.push('Object.defineProperty(__ns, ' + JSON.stringify(name) + ', { enumerable: true, value: async (args) => { let wire; try { wire = __dsh_encode(args === undefined ? {} : args) } catch (error) { ' + (errorName === undefined ? 'throw error' : 'throw new globalThis[' + JSON.stringify(errorName) + '](error.message)') + ' } const r = JSON.parse(await ' + hostName + '(wire)); if (!r.ok) { ' + throwCode + ' } return r.value } })')
      })
      const namespaceCode = 'const __ns = Object.create(null);' + assignments.join(';') + ';Object.defineProperty(globalThis, ' + JSON.stringify(namespace.global) + ', { enumerable: true, value: __ns });'
      const prelude = keep(ctx.evalCode(errorClassCode + namespaceCode))
      if (prelude.error) {
        const dumped = ctx.dump(prelude.error)
        prelude.error.dispose()
        finish(ledger.failure({ kind: 'exception', message: 'prelude: ' + String(dumped && dumped.message || dumped) }))
        return
      }
    }

    let body
    try {
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + workerData.program + STRIP_WRAP.suffix)
      body = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length)
    } catch (error) {
      finish(ledger.failure({ kind: 'exception', message: 'program did not survive the type strip: ' + String(error && error.message || error) }))
      return
    }
    const evaluated = keep(ctx.evalCode('(async () => {' + body + '\n})()', 'program.ts'))
    if (evaluated.error) {
      const dumped = ctx.dump(evaluated.error)
      evaluated.error.dispose()
      const message = String(dumped && dumped.message || dumped)
      finish(ledger.failure({ kind: /interrupt/i.test(message) ? 'timeout' : 'exception', message }))
      return
    }
    const promiseHandle = keep(evaluated.value)
    let state = ctx.getPromiseState(promiseHandle)
    while (state.type === 'pending') {
      if (Date.now() >= workerData.deadlineAt) {
        finish(ledger.failure({ kind: 'timeout', message: 'review deadline reached' }))
        return
      }
      runtime.executePendingJobs()
      state = ctx.getPromiseState(promiseHandle)
      if (state.type === 'pending') await new Promise(resolve => setImmediate(resolve))
    }
    if (state.type === 'rejected') {
      const dumped = ctx.dump(state.error)
      state.error.dispose()
      const message = String(dumped && dumped.message || dumped)
      finish(ledger.failure({ kind: /interrupt/i.test(message) ? 'timeout' : 'exception', message }))
      return
    }
    // Validate the completion value INSIDE the guest: ctx.dump() silently
    // coerces (NaN -> null, undefined properties dropped), so the guest strict
    // encoder owns the completion boundary too. Host-side snapshot re-validates.
    const valueHandle = state.value
    if (ctx.typeof(valueHandle) === 'undefined') { valueHandle.dispose(); finish(ledger.success(undefined)); return }
    ctx.setProp(ctx.global, '__dsh_result', valueHandle)
    valueHandle.dispose()
    const encodedResult = keep(ctx.evalCode('__dsh_encode(globalThis.__dsh_result)'))
    if (encodedResult.error) {
      const dumped = ctx.dump(encodedResult.error)
      encodedResult.error.dispose()
      finish(ledger.failure({ kind: 'invalid-output', message: 'program completion must be lossless JSON: ' + String(dumped && dumped.message || dumped) }))
      return
    }
    let value
    try { value = snapshot(JSON.parse(ctx.getString(encodedResult.value)), '$', new Set()) }
    catch (error) { finish(ledger.failure({ kind: 'invalid-output', message: 'program completion must be lossless JSON: ' + String(error && error.message || error) })); return }
    finish(ledger.success(value))
  } catch (error) {
    const message = String(error && error.message || error)
    finish(ledger.failure({ kind: /interrupt/i.test(message) ? 'timeout' : 'exception', message }))
  } finally {
    for (const deferred of pendingCalls.values()) { try { deferred.dispose() } catch {} }
    for (const handle of owned.reverse()) { try { handle.dispose() } catch {} }
    try { ctx.dispose() } catch {}
    try { runtime.dispose() } catch {}
  }
}

void run()
