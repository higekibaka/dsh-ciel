import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertLosslessJson,
  assertRuntimeCompatible,
  createReviewCodeRuntime,
  REVIEW_RUNTIME_ISOLATION,
  REVIEW_RUNTIME_LANGUAGE,
  snapshotLosslessJson,
} from '../ptc-runtime.js'

const soon = (ms = 5000) => () => Date.now() + ms
const TOOL_CALL_ERROR = { name: 'ToolCallError', memberNameProperty: 'toolName' }
/** Build a functions map that treats every name as an ordinary own property
 *  (object literals special-case __proto__). */
function names(entries) {
  const out = Object.create(null)
  for (const [name, fn] of entries) Object.defineProperty(out, name, { enumerable: true, writable: true, configurable: true, value: fn })
  return out
}
const toolNamespace = (functions, errorClass) => [{ global: 'tools', functions, ...errorClass === undefined ? {} : { errorClass } }]
const runtimeWith = (options = {}) => createReviewCodeRuntime({ deadlineAt: soon(), ...options })
const execute = (runtime, program, bindings, signal) => runtime.run({ program, bindings: bindings ?? [], signal: signal ?? new AbortController().signal })

test('descriptors and option contract', async () => {
  const runtime = runtimeWith()
  assert.equal(runtime.language, REVIEW_RUNTIME_LANGUAGE)
  assert.equal(runtime.isolation, REVIEW_RUNTIME_ISOLATION)
  assert.equal(typeof runtime.run, 'function')
  assert.equal(typeof runtime.dispose, 'function')
  assert.throws(() => createReviewCodeRuntime({}), /deadlineAt/)
  assert.throws(() => createReviewCodeRuntime({ deadlineAt: soon(), maxOutputBytes: 0 }), /positive number/)
  assert.throws(() => createReviewCodeRuntime({ deadlineAt: soon(), maxLogBytes: -1 }), /positive number/)
  assert.throws(() => assertRuntimeCompatible(undefined, { language: 'typescript' }), /private review runtime is unavailable/)
  assert.throws(() => assertRuntimeCompatible({ language: 'typescript' }, undefined), /deployment code runtime is unavailable/)
  assert.throws(() => assertRuntimeCompatible({ language: 'python' }, { language: 'typescript' }), /does not match/)
  assert.doesNotThrow(() => assertRuntimeCompatible({ language: 'typescript' }, { language: 'typescript' }))
})

test('resolved PTC requests execute under the shared review budget and reject authority overrides', async () => {
  const deadline = Date.now() + 5000
  const runtime = runtimeWith({ deadlineAt: () => deadline })
  try {
    const spec = runtime.resolve({ program: 'return await tools.echo({ value: 42 })', bindings: toolNamespace({ echo: async value => value }) })
    assert.equal(spec.cwd, process.cwd())
    assert.ok(spec.timeoutMs > 0 && spec.timeoutMs <= 5000)
    const result = await runtime.run(spec)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.value, { value: 42 })
    assert.throws(() => runtime.resolve({ program: '', bindings: [], timeoutMs: null }), /shared review deadline/)
    assert.throws(() => runtime.resolve({ program: '', bindings: [], sandboxPolicy: { mode: 'danger-full-access' } }), /sandboxPolicy/)
  } finally {
    await runtime.dispose()
  }
})

test('binding namespaces fail closed without spawning a worker', async () => {
  const runtime = runtimeWith()
  const fn = async () => null
  const cases = [
    ['duplicate global', [{ global: 'tools', functions: names([['a', fn]]) }, { global: 'tools', functions: names([['b', fn]]) }], /duplicate binding global/],
    ['invalid identifier', [{ global: '$tools', functions: names([['a', fn]]) }], /not a usable identifier/],
    ['reserved global', [{ global: 'console', functions: names([['a', fn]]) }], /reserved binding global/],
    ['reserved word', [{ global: 'await', functions: names([['a', fn]]) }], /not a usable identifier/],
    ['non-function member', [{ global: 'tools', functions: names([['a', 1]]) }], /must be a function/],
    ['error class name', toolNamespace(names([['a', fn]]), { name: '1Bad', memberNameProperty: 'toolName' }), /error class/],
    ['error member reserved', toolNamespace(names([['a', fn]]), { name: 'ToolCallError', memberNameProperty: 'name' }), /member property/],
    ['error member dunder', toolNamespace(names([['a', fn]]), { name: 'ToolCallError', memberNameProperty: '__x__' }), /member property/],
    ['error class collides', toolNamespace(names([['a', fn]]), { name: 'tools', memberNameProperty: 'toolName' }), /duplicate injected global/],
  ]
  for (const [label, bindings, match] of cases) {
    await assert.rejects(runtime.run({ program: 'return 1', bindings, signal: new AbortController().signal }), match, label)
  }
})

test('bindings are real promises: then/catch, Promise.all concurrency, for-await', async () => {
  const runtime = runtimeWith()
  // Deterministic overlap proof: both host calls must enter before either is
  // released. No wall-clock threshold, so slow CI worker/WASM init cannot flake
  // this test; the owned timer only turns a never-overlapping hang into a failure.
  let entered = 0
  let releaseBarrier
  const barrier = new Promise((resolve) => { releaseBarrier = resolve })
  const barrierTimer = setTimeout(() => releaseBarrier(new Error('host concurrency barrier timed out: the two slow calls never overlapped')), 3000)
  const slow = async args => {
    entered += 1
    if (entered === 2) { clearTimeout(barrierTimer); releaseBarrier() }
    const outcome = await barrier
    if (outcome instanceof Error) throw outcome
    return { v: args.v }
  }
  let result
  try {
    result = await execute(runtime, [
      "const p = tools.echo({ v: 'a' })",
      'const isPromise = p instanceof Promise',
      "const viaThen = await p.then(r => r.v + '!').catch(() => 'caught')",
      "const [x, y] = await Promise.all([tools.slow({ v: 'x' }), tools.slow({ v: 'y' })])",
      'const seen = []',
      'for await (const item of [tools.echo({ v: "d" }), tools.echo({ v: "e" })]) seen.push(item.v)',
      "let caught = null; try { await tools.fail({}) } catch (error) { caught = { name: error.name, toolName: error.toolName, message: error.message } }",
      'return { isPromise, viaThen, x: x.v, y: y.v, seen, caught }',
    ].join('\n'), toolNamespace(names([
      ['echo', async args => ({ v: args.v })],
      ['slow', slow],
      ['fail', async () => { throw new Error('host said no') }],
    ]), TOOL_CALL_ERROR))
  } finally { clearTimeout(barrierTimer) }
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.equal(entered, 2, 'both host calls entered before either was released')
  assert.equal(result.value.isPromise, true)
  assert.equal(result.value.viaThen, 'a!')
  assert.equal(result.value.x, 'x')
  assert.equal(result.value.y, 'y')
  assert.deepEqual(result.value.seen, ['d', 'e'])
  assert.deepEqual(result.value.caught, { name: 'ToolCallError', toolName: 'fail', message: 'host said no' })
})

test('ordinary own names survive: __proto__, constructor, then, hasOwnProperty', async () => {
  const calls = []
  const runtime = runtimeWith()
  const result = await execute(runtime, [
    "const out = {}",
    "out.proto = (await tools.__proto__({ v: 'p' })).v",
    "out.ctor = (await tools.constructor({ v: 'c' })).v",
    "out.then = (await tools.then({ v: 't' })).v",
    "out.hasOwn = (await tools.hasOwnProperty({ v: 'h' })).v",
    'out.protoIsFunction = typeof tools.__proto__ === "function"',
    'return out',
  ].join('\n'), toolNamespace(names(['__proto__', 'constructor', 'then', 'hasOwnProperty'].map(name => [name, async args => { calls.push(name); return { v: args.v } }])), TOOL_CALL_ERROR))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value, { proto: 'p', ctor: 'c', then: 't', hasOwn: 'h', protoIsFunction: true })
  assert.deepEqual(calls.sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'then'])
})

test('error class named __proto__ is defined as an own global property', async () => {
  const result = await execute(runtimeWith(), [
    "try { await tools.reject({}) } catch (error) { return { name: error.name, toolName: error.toolName } }",
    'return { escaped: true }',
  ].join('\n'), toolNamespace(names([['reject', async () => { throw new Error('nope') }]]), { name: '__proto__', memberNameProperty: 'toolName' }))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value, { name: '__proto__', toolName: 'reject' })
})

test('strict lossless JSON rejects lossy arguments before the binding runs', async () => {
  let called = 0
  const runtime = runtimeWith()
  const cases = [
    ['undefined field', 'return await tools.probe({ a: undefined })', /undefined/],
    ['NaN', 'return await tools.probe({ a: NaN })', /non-finite/],
    ['Infinity', 'return await tools.probe({ a: Infinity })', /non-finite/],
    ['bigint', 'return await tools.probe({ a: 1n })', /bigint/],
    ['sparse array', 'const a = [1]; a[3] = 2; return await tools.probe({ a })', /sparse|missing/],
    ['cycle', 'const a = {}; a.self = a; return await tools.probe({ a })', /cyclic/],
    ['Date', 'return await tools.probe({ a: new Date() })', /non-plain/],
  ]
  for (const [label, body, match] of cases) {
    const result = await execute(runtime, 'try { ' + body + ' } catch (error) { return error.message }', toolNamespace(names([['probe', async () => { called += 1; return null }]]), TOOL_CALL_ERROR))
    assert.equal(result.error, undefined, label + ': ' + JSON.stringify(result.error))
    assert.equal(called, 0, label + ' must not reach the host binding')
    assert.match(String(result.value), match, label)
  }
})

test('strict lossless JSON rejects lossy binding results and completion values', async () => {
  const result = await execute(runtimeWith(), [
    "try { await tools.badResult({}) } catch (error) { return { message: error.message, name: error.name } }",
  ].join('\n'), toolNamespace(names([['badResult', async () => ({ ok: undefined })]]), TOOL_CALL_ERROR))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.match(String(result.value.message), /lossless JSON/)
  const completion = await execute(runtimeWith(), 'return { ok: NaN }')
  assert.equal(completion.error?.kind, 'invalid-output')
  assert.match(completion.error.message, /lossless JSON/)
  const bigint = await execute(runtimeWith(), 'return { ok: 1n }')
  assert.equal(bigint.error?.kind, 'invalid-output')
})

test('combined output cap and log flood fail closed with retained logs', async () => {
  const flood = await execute(runtimeWith({ maxOutputBytes: 2048, maxLogBytes: 256 }), 'for (let i = 0; i < 500; i++) console.log("x".repeat(200)); return "done"')
  assert.equal(flood.error?.kind, 'output-limit')
  assert.ok(flood.logs.length > 0 && flood.logs.length < 500)
  const hugeValue = await execute(runtimeWith({ maxOutputBytes: 1024 }), 'return "y".repeat(5000)')
  assert.equal(hugeValue.error?.kind, 'output-limit')
})

test('guest has no ambient Node globals and cannot escape via constructors or import', async () => {
  const result = await execute(runtimeWith(), [
    'const probe = { process: typeof process, require: typeof require, fetch: typeof fetch, module: typeof module, globalProcess: typeof globalThis.process }',
    'const attempt = source => { try { return String(Function(source)()) } catch (error) { return "THREW:" + error.message } }',
    'probe.fn = attempt("return typeof process")',
    'probe.ctor = attempt("return typeof require")',
    'probe.selfCtor = (() => { try { return String(this.constructor.constructor("return typeof process")()) } catch (error) { return "THREW:" + error.message } })()',
    'probe.asyncCtor = await (async () => { try { return String(await Object.getPrototypeOf(async function(){}).constructor("return typeof process")()) } catch (error) { return "THREW:" + error.message } })()',
    'try { await import("node:fs"); probe.importFs = "ESCAPED" } catch (error) { probe.importFs = "DENIED" }',
    'try { await import("quickjs-emscripten"); probe.importQjs = "ESCAPED" } catch (error) { probe.importQjs = "DENIED" }',
    'return probe',
  ].join('\n'))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value, {
    process: 'undefined', require: 'undefined', fetch: 'undefined', module: 'undefined', globalProcess: 'undefined',
    fn: 'undefined', ctor: 'undefined', selfCtor: 'undefined', asyncCtor: 'undefined',
    importFs: 'DENIED', importQjs: 'DENIED',
  })
})

test('abort before, during and after a run', async () => {
  const runtime = runtimeWith()
  const bindings = toolNamespace(names([['ping', async () => ({ ok: true })]]), TOOL_CALL_ERROR)
  const pre = new AbortController()
  pre.abort('pre-aborted')
  const before = await runtime.run({ program: 'return 1', bindings, signal: pre.signal })
  assert.equal(before.error?.kind, 'abort')
  assert.equal(before.logs.length, 0)

  let ticks = 0
  const interval = setInterval(() => { ticks += 1 }, 25)
  const controller = new AbortController()
  setTimeout(() => controller.abort('user cancel'), 150)
  const started = Date.now()
  const during = await runtime.run({ program: 'while (true) {}', bindings, signal: controller.signal })
  const elapsed = Date.now() - started
  clearInterval(interval)
  assert.equal(during.error?.kind, 'abort')
  assert.ok(elapsed < 1500, 'abort must terminate promptly, took ' + elapsed)
  assert.ok(ticks >= 2, 'host must stay responsive during a sync guest loop, ticks=' + ticks)

  const after = new AbortController()
  const completed = await runtime.run({ program: 'return 7', bindings, signal: after.signal })
  assert.equal(completed.value, 7)
  after.abort('too late')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(completed.value, 7)
})

test('deadline terminates sync loops and unresolved promises with no execution grace', async () => {
  const runtime = createReviewCodeRuntime({ deadlineAt: () => Date.now() + 600 })
  const started = Date.now()
  const busy = await runtime.run({ program: 'while (true) {}', bindings: [], signal: new AbortController().signal })
  const elapsed = Date.now() - started
  assert.equal(busy.error?.kind, 'timeout')
  assert.ok(elapsed >= 550 && elapsed < 1300, 'deadline kill at ~600ms, took ' + elapsed)

  const pendingStart = Date.now()
  const pending = await runtime.run({
    program: 'return await tools.never({})',
    bindings: toolNamespace(names([['never', () => new Promise(() => {})]]), TOOL_CALL_ERROR),
    signal: new AbortController().signal,
  })
  assert.equal(pending.error?.kind, 'timeout')
  assert.ok(Date.now() - pendingStart < 1300, 'unresolved promise must not outlive the deadline')

  // No hidden per-run CPU quota: a 300ms busy loop under a 5s deadline succeeds.
  const ok = await execute(runtimeWith(), 'const end = Date.now() + 300; while (Date.now() < end) {} return "survived"')
  assert.equal(ok.error, undefined, JSON.stringify(ok.error))
  assert.equal(ok.value, 'survived')
})

test('repeated cleanup, dispose waits for settlement, run-after-dispose', async () => {
  const runtime = runtimeWith(8000)
  for (let index = 0; index < 4; index += 1) {
    const result = await execute(runtime, 'return ' + index)
    assert.equal(result.value, index)
  }
  const inFlight = execute(runtime, 'while (true) {}')
  let settled = false
  void inFlight.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 100))
  await runtime.dispose()
  const result = await inFlight
  assert.equal(result.error?.kind, 'abort')
  assert.equal(settled, true, 'dispose() must wait for the run to settle')
  await assert.rejects(execute(runtime, 'return 1'), /after dispose/)
})

test('guest mutation cannot alter host state', async () => {
  const hostState = { nested: { value: 'original' }, list: [1, 2] }
  const received = []
  const result = await execute(runtimeWith(), [
    "const first = await tools.state({})",
    "first.nested.value = 'mutated'",
    'first.list.push(99)',
    'const second = await tools.state({})',
    'return { second, detached: second.nested.value }',
  ].join('\n'), toolNamespace(names([['state', async args => { received.push(args); return hostState }]]), TOOL_CALL_ERROR))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value.second, { nested: { value: 'original' }, list: [1, 2] })
  assert.equal(result.value.detached, 'original')
  assert.deepEqual(hostState, { nested: { value: 'original' }, list: [1, 2] })

  const argResult = await execute(runtimeWith(), [
    'const payload = { nested: { value: "sent" } }',
    'await tools.capture(payload)',
    'payload.nested.value = "changed after the call"',
    'return "done"',
  ].join('\n'), toolNamespace(names([['capture', async args => { received.push(args); return null }]]), TOOL_CALL_ERROR))
  assert.equal(argResult.error, undefined, JSON.stringify(argResult.error))
  assert.deepEqual(received.at(-1), { nested: { value: 'sent' } })
})

test('TypeScript programs are type-stripped inside the trusted worker', async () => {
  const result = await execute(runtimeWith(), [
    'interface Point { x: number; y: number }',
    'type Pair<T> = [T, T]',
    'const point = { x: 1, y: 2 } as Point',
    'const pair = [point.x, point.y] as Pair<number>',
    'function sum(values: number[]): number { return values.reduce((a, b) => a + b, 0) }',
    'return { sum: sum(pair), label: "ok" satisfies string }',
  ].join('\n'))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value, { sum: 3, label: 'ok' })
  const syntax = await execute(runtimeWith(), 'const = = =')
  assert.equal(syntax.error?.kind, 'exception')
})

test('logs preserve emission order and results stay lossless', async () => {
  const result = await execute(runtimeWith(), [
    'console.log("first")',
    'console.log("second", 2)',
    'return { ok: true, nested: [1, "two", null] }',
  ].join('\n'))
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.logs, ['first', 'second 2'])
  assert.deepEqual(result.value, { ok: true, nested: [1, 'two', null] })
  assert.throws(() => assertLosslessJson({ a: undefined }), /undefined/)
  assert.deepEqual(snapshotLosslessJson({ a: [1, { b: 'c' }] }), { a: [1, { b: 'c' }] })
  assert.deepEqual(snapshotLosslessJson({ __proto__: null, a: 1 }), { a: 1 })
})
