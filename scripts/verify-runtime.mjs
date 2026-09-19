#!/usr/bin/env node
/** Real DSH/Cordis/agent-loop/tool-registry integration without a Web server.
 * Default is keyless scripted-model replay. --live uses ONLY the explicitly
 * allowed DeepSeek route, with native adapter retries disabled.
 * DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-runtime.mjs [--live]
 * CIEL_VERIFY_NATIVE_PEERS=1 also verifies the plugin's installed peer links,
 * without the fixture resolver substituting shared Harness modules.
 *
 * The review child runs the delivered PTC engine: the runner presents run_code
 * for every tooled phase and dispatches nested readers through the private
 * registry/runtime. The root codeRuntime here is a sentinel that records and
 * throws if a review ever reaches it; baseline cases run through the PTC helper.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
import { runRequestInputCases } from './fixtures/request-input-cases.mjs'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to a built DSH checkout')
// One identity for the shared modules: this script and the plugin must use the
// TARGET's Cordis and Typert, never a second copy from the plugin workspace.
const targetRequire = createRequire(join(checkout, 'packages/core/tools/package.json'))
const targetCordis = targetRequire.resolve('@deepseek-ai/cordis')
const targetTypert = join(checkout, 'packages/typert/protocol/lib/index.js')
const runnerUrl = new URL('../plugin/review-runner.js', import.meta.url).href
const resolutionHook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (process.env.CIEL_VERIFY_NATIVE_PEERS === '1') return nextResolve(specifier, context)
  const paths = { '@deepseek-ai/dsh-subagent': 'packages/subagent/subagent', '@deepseek-ai/dsh-llm': 'packages/llm/llm', '@deepseek-ai/dsh-tools': 'packages/core/tools' }
  if (context.parentURL === runnerUrl && paths[specifier]) return { url: pathToFileURL(join(checkout, paths[specifier], 'lib/index.js')).href, shortCircuit: true }
  if (specifier === '@deepseek-ai/cordis') return { url: pathToFileURL(targetCordis).href, shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-typert-protocol') return { url: pathToFileURL(targetTypert).href, shortCircuit: true }
  return nextResolve(specifier, context)
} })
const { Context } = await import(pathToFileURL(targetCordis).href)
// Load the plugin AFTER the hook so its static Typert import gets the target copy.
const ciel = await import(new URL('../plugin/index.js', import.meta.url).href)
const load = (relative) => import(pathToFileURL(join(checkout, relative, 'lib/index.js')).href)
const llmModule = await load('packages/llm/llm')
const { LlmAdapter, createUserMessage } = llmModule
const modules = await Promise.all([
  'packages/core/session', 'packages/core/system-prompt', 'packages/core/tools',
  'packages/core/agent', 'packages/session/session-projection', 'packages/core/agent-loop', 'packages/subagent/subagent',
  'packages/subagent/subagent-spawn-in-process', 'packages/interaction/commands',
].map(load))
const live = process.argv.includes('--live')
if (live && process.env.CIEL_ALLOW_PAID_TESTS !== '1') throw new Error('Live calls require CIEL_ALLOW_PAID_TESTS=1')
const model = 'deepseek-v4-flash-vision-exp'
const selectedCases = process.env.CIEL_VERIFY_CASES ? new Set(process.env.CIEL_VERIFY_CASES.split(',')) : null
const originalHome = process.env.DSH_HOME
const fixtureRoot = await mkdtemp(join(tmpdir(), 'ciel-assembled-'))
const home = join(fixtureRoot, 'workspace')
await mkdir(home)
process.env.DSH_HOME = join(fixtureRoot, 'state')
const fixture = join(home, 'fixture.txt')
await writeFile(fixture, 'alpha\nbeta\ngamma\n', 'utf8')
const secondFixture = join(home, 'fixture-two.txt')
await writeFile(secondFixture, 'delta\nepsilon\n', 'utf8')
// Rewritten after the review captures it, to prove the persisted receipt keeps
// the captured bytes instead of re-reading the live file.
const changingFixture = join(home, 'changing.txt')
const changingContent = 'original-content-line-1\noriginal-content-line-2\n'
await writeFile(changingFixture, changingContent, 'utf8')
// A read target long enough that every burst/sequential offset is a valid,
// non-empty read; the 3-line fixture cannot serve 75 distinct offsets.
const largeFixture = join(home, 'large.txt')
const largeFixtureLines = 120
await writeFile(largeFixture, Array.from({ length: largeFixtureLines }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n', 'utf8')
const secretFixture = join(home, '.env')
const processFixture = join(fixtureRoot, 'state', 'author-process.txt')
const processLink = join(home, 'process-link.txt')
await mkdir(join(fixtureRoot, 'state'))
await writeFile(secretFixture, 'FAKE_CREDENTIAL_MARKER_ONLY\n')
await writeFile(processFixture, 'FAKE_PROCESS_MARKER_ONLY\n')
await symlink(processFixture, processLink)
const originalFetch = globalThis.fetch
let networkRequests = 0
// A global safety check independently prevents Google or unexpected traffic.
globalThis.fetch = async (url, options) => {
  if (!live) throw new Error('Network forbidden in offline replay')
  const parsed = new URL(typeof url === 'string' ? url : url.url || String(url))
  if (parsed.origin !== 'https://api.deepseek.com' || parsed.pathname !== '/chat/completions') throw new Error('Unexpected verification endpoint')
  if (++networkRequests > 32) throw new Error('Verification batch request limit reached')
  try { return await originalFetch(url, options) } catch (error) {
    console.error('DeepSeek transport diagnostic:', { name: error.name, code: error.code, causeCode: error.cause?.code })
    throw error
  }
}
const textResponse = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
// A dossier row may only cite receipts the host actually issued. %REF% is
// replaced at stream time with the latest evidence_refs from a real read.
const withEvidenceRef = (value, ref) => {
  if (typeof value === 'string') return value.replaceAll('%REF%', ref)
  if (Array.isArray(value)) return value.map((entry) => withEvidenceRef(entry, ref))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withEvidenceRef(entry, ref)]))
  return value
}
let callId = 0
// The review child reaches the snapshot only through run_code programs; the
// delivered runner presents PTC for every tooled phase, so PTC is unconditional
// here. nativeToolResponse remains only for the direct-native-refusal case.
const SNAPSHOT_TOOLS = new Set(['read', 'grep', 'glob'])

/** One native tool-call block per name, all with the same fixture argument. */
function nativeToolResponse(names, text = '', target = fixture, argumentsOverride) {
  const chunks = text ? textResponse(text).slice(0, -1) : []
  names.forEach((name, n) => {
    const index = n + (text ? 1 : 0), id = 'call-' + (++callId)
    const args = JSON.stringify(argumentsOverride ?? { file_path: target })
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
    )
  })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

/** Build a run_code program that calls the declared snapshot tools in order. */
function ptcProgram(calls) {
  for (const call of calls) if (!SNAPSHOT_TOOLS.has(call.name)) throw new Error('PTC fixture may only call snapshot tools, got ' + call.name)
  const lines = calls.map((call, i) => `let r${i}; try { r${i} = await tools.${call.name}(${JSON.stringify(call.args ?? {})}) } catch (error) { r${i} = JSON.stringify({ error: error.message }) }`)
  lines.push(calls.length === 1 ? 'return r0' : 'return [' + calls.map((_, i) => 'r' + i).join(', ') + ']')
  return lines.join('\n')
}

/** One run_code call with an explicit program: real host execution, no fakes. */
function ptcRawResponse(code, text = '', description = 'snapshot program') {
  const chunks = text ? textResponse(text).slice(0, -1) : []
  const index = text ? 1 : 0, id = 'call-' + (++callId)
  const args = JSON.stringify({ code, description })
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name: 'run_code', argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id, name: 'run_code', arguments: args } },
  )
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

/**
 * One run_code call whose program calls the declared snapshot tools and returns
 * their JSON string results (a single string for one call, an array for many).
 * The outer run_code result therefore carries the real reader JSON, so the
 * adapter derives refs and review_time from the actual outer result.
 */
function ptcResponse(calls, text = '', description = 'snapshot batch read') {
  return ptcRawResponse(ptcProgram(calls), text, description)
}

/** Native names -> run_code programs for the delivered PTC path. */
function toolResponse(names, text = '', target = fixture) {
  return ptcResponse(names.map((name) => ({ name, args: { file_path: target } })), text)
}

/**
 * Derive evidence refs and review_time from the ACTUAL outer tool result:
 * strings may be reader JSON, arrays nest per-call results, and objects carry
 * the ledger fields. Never invents an id the host did not issue.
 */
function collectToolEvidence(value, refs, timeSamples, depth = 0) {
  if (depth > 8) return
  if (typeof value === 'string') {
    if (!value.includes('evidence_refs') && !value.includes('review_time')) return
    try { collectToolEvidence(JSON.parse(value), refs, timeSamples, depth + 1) } catch { /* plain text */ }
    return
  }
  if (Array.isArray(value)) { for (const entry of value) collectToolEvidence(entry, refs, timeSamples, depth + 1); return }
  if (!value || typeof value !== 'object') return
  if (value.review_time && typeof value.review_time === 'object') timeSamples.push(value.review_time)
  if (Array.isArray(value.evidence_refs)) for (const ref of value.evidence_refs) if (typeof ref === 'string' && !refs.includes(ref)) refs.push(ref)
  for (const entry of Object.values(value)) collectToolEvidence(entry, refs, timeSamples, depth + 1)
}

/**
 * Root/stock code-runtime sentinel. The review child must resolve its own
 * isolated runtime; if a mis-wired child reaches this one, the run is recorded
 * and throws instead of silently executing model code on the stock substrate.
 */
function createSentinelCodeRuntime(language = 'typescript') {
  const runs = []
  return {
    language,
    isolation: 'sentinel',
    runs,
    resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: null } },
    async run(request) {
      runs.push({ program: String(request?.program ?? ''), bindings: request?.bindings?.length ?? 0 })
      throw new Error('review must not execute the root/stock code runtime (sentinel)')
    },
    dispose() {},
  }
}
class ScriptedAdapter extends LlmAdapter {
  constructor(script) { super(); this.script = [...script]; this.requests = []; this.refs = []; this.lastToolResult = ''; this.notify = () => {} }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(options) {
    const leaves = []
    const timeSamples = []
    for (const message of options.messages || []) for (const block of message.content || []) {
      if (block.type === 'text') leaves.push(block.text)
      if (block.type === 'tool-result') for (const part of block.content || []) if (part.type === 'text') {
        leaves.push(part.text)
        this.lastToolResult = part.text
        collectToolEvidence(part.text, this.refs, timeSamples)
      }
    }
    const inputMarkers = Object.fromEntries(['HUMAN_TASK_MARKER', 'RUNTIME_CONTEXT_MARKER', 'OLD_ADVISOR_MARKER', 'COMMAND_QUESTION_MARKER', 'REFINEMENT_MARKER', 'NEW_TASK_MARKER', 'SUMMARY_OPINION_MARKER', 'GOAL_OBJECTIVE_MARKER'].map(marker => [marker, leaves.some(text => text.includes(marker))]))
    this.requests.push({ tools: (options.tools || []).map((tool) => tool.name), inputMarkers, timeSamples, lastToolResult: this.lastToolResult, leakedCredential: leaves.some((t) => t.includes('FAKE_CREDENTIAL_MARKER_ONLY')), leakedProcess: leaves.some((t) => t.includes('FAKE_PROCESS_MARKER_ONLY')) })
    this.notify(options)
    const item = this.script.shift()
    if (!item) throw new Error('script exhausted (unexpected model call)')
    if (item === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise((_, reject) => {
        if (options.signal.aborted) return reject(new Error('cancelled'))
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      return
    }
    const chunks = typeof item === 'function' ? item(this) : item
    const ref = this.refs.at(-1) ?? '%REF%'
    for (const chunk of chunks) { options.signal.throwIfAborted(); yield withEvidenceRef(chunk, ref) }
  }
}
const suspects = '## suspects\n- suspect: 文件行数 | block: b1 | bearing: high | falsify: read ' + fixture
const pass = '## dossier\n- result: s1 | outcome: cleared | evidence: %REF%\n## verdict: pass\nsummary: 行数正确。'
const partial = '## dossier\n- result: s1 | outcome: cleared | evidence: %REF%'
// PTC finite cases: they exercise the delivered private registry/runtime and
// run by default because every tooled review phase is PTC.
const curationProgram = [
  'const a = JSON.parse(await tools.read({ file_path: "/project/fixture.txt" }))',
  'const b = JSON.parse(await tools.read({ file_path: "/project/fixture-two.txt" }))',
  'const c = JSON.parse(await tools.read({ file_path: "/project/changing.txt" }))',
  'return { summary: "fixture " + a.total_lines + " lines; second " + b.total_lines + " lines; changing " + c.total_lines + " lines", evidence_refs: [a.evidence_refs[0], b.evidence_refs[0], c.evidence_refs[0]] }',
].join('\n')
const privacyProgram = [
  'let out',
  'try { out = await tools.read({ file_path: "/project/.env" }) } catch (error) { out = JSON.stringify({ error: error.message }) }',
  'return out',
].join('\n')
const foreignProgram = [
  'try { await tools.bash({ command: "true" }) } catch (error) { return JSON.stringify({ error: error.message }) }',
  'return "unreachable"',
].join('\n')
const failureProgram = [
  'console.log("fixture-log-before-failure")',
  'throw new Error("fixture-program-cause")',
].join('\n')
/** Every started nested dispatch must settle exactly once. */
function assertNestedSettled(context) {
  const starts = context.childToolEvents.filter((entry) => entry.type === 'tool/ptc-dispatch-start')
  const settles = context.childToolEvents.filter((entry) => entry.type === 'tool/ptc-dispatch')
  assert.equal(starts.length, settles.length, 'every started nested call has exactly one settle')
  for (const start of starts) assert.equal(settles.filter((settle) => settle.data.subCallId === start.data.subCallId).length, 1, 'nested sub-call settles exactly once')
}
const ptcCases = [
  ['ptc-accurate', [textResponse(suspects), ptcResponse([{ name: 'read', args: { file_path: '/project/fixture.txt' } }]), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, true)
      assert.equal(r.review.status, 'sound')
      assert.equal(r.review.modelRequests, 3)
      assert.equal(tools.length, 1)
      assert.deepEqual(requests.at(-1).tools, ['run_code'], 'the PTC child sees only the transport')
      assert.ok(requests.at(-1).timeSamples.at(-1).tool_calls >= 1)
      assert.equal(context.sentinelRuntime.runs.length, 0, 'the review child must not reach the root/stock sentinel')
    },
  }],
  ['ptc-curation', [textResponse(suspects), ptcRawResponse(curationProgram), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, true)
      assert.equal(r.review.status, 'sound')
      assert.equal(tools.length, 3)
      assert.equal(context.childToolEvents.filter((e) => e.type === 'tool/ptc-dispatch').length, 3)
      const outer = requests.at(-1).lastToolResult
      assert.match(outer, /fixture 3 lines/)
      assert.match(outer, /e[0-9]+/)
      assert.equal(outer.includes('alpha'), false, 'raw fixture bytes never reach the model')
      assert.equal(outer.includes('delta'), false)
      assert.equal(outer.includes('original-content'), false)
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-privacy', [textResponse(suspects), ptcRawResponse(privacyProgram), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, true)
      assert.equal(r.review.status, 'incomplete')
      assert.equal(r.review.privacy.dataLimited, true)
      assert.equal(tools.length, 0)
      assert.equal(requests.at(-1).lastToolResult.includes('FAKE_CREDENTIAL_MARKER_ONLY'), false)
      assert.match(requests.at(-1).lastToolResult, /outside allowed scope|Review data unavailable/)
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-direct-native-refusal', [textResponse(suspects), nativeToolResponse(['read']), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(tools.length, 0, 'a native read must not execute under PTC')
      assert.equal(r.review.status, 'incomplete')
      const denied = context.toolResults.find((entry) => entry.name === 'read')
      assert.ok(denied && denied.isError, 'the native read is an UNKNOWN_TOOL error')
      assert.match(denied.text, /run_code/, 'the denial names the PTC route')
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-burst75', [textResponse(suspects), ptcResponse(Array.from({ length: 75 }, (_, i) => ({ name: 'read', args: { file_path: '/project/large.txt', offset: i + 1 } }))), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, true)
      assert.equal(r.review.status, 'sound')
      assert.equal(r.review.modelRequests, 3)
      assert.equal(r.review.explore.toolCalls, 75)
      assert.equal(tools.length, 75)
      assert.equal(context.childToolEvents.filter((e) => e.type === 'tool/ptc-dispatch').length, 75)
      assert.equal(requests.at(-1).timeSamples.at(-1).tool_calls, 75)
      assert.ok(requests.at(-1).timeSamples.at(-1).remaining_ms > 0)
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-sequential70', [textResponse(suspects), ...Array.from({ length: 70 }, (_, i) => ptcResponse([{ name: 'read', args: { file_path: '/project/large.txt', offset: i + 1 } }])), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, true)
      assert.equal(r.review.status, 'sound')
      assert.equal(r.review.modelRequests, 72)
      assert.equal(r.review.explore.toolCalls, 70)
      assert.equal(tools.length, 70)
      assert.equal(requests.at(-1).timeSamples.at(-1).tool_calls, 70)
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-foreign-tool', [textResponse(suspects), ptcRawResponse(foreignProgram), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      assert.equal(tools.length, 0)
      assert.equal(r.review.status, 'incomplete')
      assert.equal(context.toolResults.some((entry) => entry.name === 'bash'), false, 'a foreign tool never executes on the host')
      assert.match(requests.at(-1).lastToolResult, /not a function|unknown|undefined|bash/i, 'the program reports the unbound tool')
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-code-run-failed', [textResponse(suspects), ptcRawResponse(failureProgram), textResponse(pass)], {
    expect: (r, tools, requests, context) => {
      const failed = context.toolResults.find((entry) => entry.name === 'run_code')
      assert.ok(failed && failed.isError, 'the failing program is an error result')
      assert.equal(failed.code, 'CODE_RUN_FAILED', 'the model keeps the typed failure code')
      assert.match(requests.at(-1).lastToolResult, /fixture-program-cause/, 'the program cause reaches the model')
      assert.match(requests.at(-1).lastToolResult, /fixture-log-before-failure/, 'captured logs reach the model')
      assert.equal(/\/home\/|deepseek-harness|node:internal/.test(requests.at(-1).lastToolResult), false, 'unrelated host details are masked')
      assert.equal(r.review.status, 'incomplete')
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-cancel-sync-loop', [textResponse(suspects), ptcRawResponse('await tools.read({ file_path: "/project/fixture.txt" })\nwhile (true) {}')], {
    cancelAfterNested: 1,
    cancelDelayMs: 50,
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, false)
      assert.equal(r.review.status, 'cancelled')
      assert.equal(r.review.modelRequests, 2, 'cancel adds no writer or request')
      assert.equal(requests.length, 3, 'draft + nomination + the tooled request only')
      assert.equal(r.review.explore?.salvaged ?? false, false)
      assert.ok(tools.length >= 1, 'the guest executed a real nested read before entering the loop')
      assert.ok(context.childToolEvents.some((e) => e.type === 'tool/ptc-dispatch' && e.data?.name === 'read'), 'a worker-origin read settled before cancellation')
      assert.equal(context.sentinelRuntime.runs.length, 0, 'the review child never used the root runtime')
      assertNestedSettled(context)
    },
  }],
  ['ptc-cancel-unresolved-promise', [textResponse(suspects), ptcRawResponse('await tools.read({ file_path: "/project/fixture.txt" })\nawait new Promise(() => {})')], {
    cancelAfterNested: 1,
    cancelDelayMs: 50,
    expect: (r, tools, requests, context) => {
      assert.equal(r.review.status, 'cancelled')
      assert.equal(r.review.modelRequests, 2)
      assert.equal(requests.length, 3)
      assert.ok(tools.length >= 1, 'the guest executed a real nested read before awaiting forever')
      assert.ok(context.childToolEvents.some((e) => e.type === 'tool/ptc-dispatch' && e.data?.name === 'read'), 'a worker-origin read settled before cancellation')
      assert.equal(context.sentinelRuntime.runs.length, 0)
      assertNestedSettled(context)
    },
  }],
  ['ptc-cancel-mid-batch', [textResponse(suspects), ptcResponse(Array.from({ length: 100 }, (_, i) => ({ name: 'read', args: { file_path: '/project/large.txt', offset: i + 1 } })))], {
    cancelAfterNested: 1,
    expect: (r, tools, requests, context) => {
      assert.equal(r.review.status, 'cancelled')
      assert.equal(r.review.modelRequests, 2)
      assert.equal(requests.length, 3)
      assert.equal(context.sentinelRuntime.runs.length, 0)
      assertNestedSettled(context)
      const starts = context.childToolEvents.filter((e) => e.type === 'tool/ptc-dispatch-start').length
      assert.ok(starts >= 1 && starts < 100, 'cancel landed mid-batch, not before or after')
    },
  }],
  ['ptc-deadline-sync-loop', [textResponse(suspects), ptcRawResponse('while (true) {}')], {
    timeoutSeconds: 10,
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, false)
      assert.match(r.error, /review timeout/)
      assert.equal(r.review.modelRequests, 2, 'the 10s deadline adds no writer')
      assert.equal(requests.length, 3)
      assert.equal(context.sentinelRuntime.runs.length, 0)
      assertNestedSettled(context)
    },
  }],
  ['ptc-capability-missing', [textResponse(suspects), ptcResponse([{ name: 'read', args: { file_path: '/project/fixture.txt' } }])], {
    rootRuntime: 'none',
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, false)
      assert.equal(r.code, 'CIEL_REVIEW_SERVICE_NOT_READY')
      assert.equal(r.review.code, r.code)
      assert.equal(r.stage, 'runtime')
      assert.equal(r.review.status, 'error')
      assert.ok(requests.length <= 2, 'fails before the first tooled request')
      assert.equal(requests.every((entry) => !entry.tools.includes('run_code')), true)
      assert.equal(context.toolResults.some((entry) => entry.name === 'run_code'), false)
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-capability-language-mismatch', [textResponse(suspects), ptcResponse([{ name: 'read', args: { file_path: '/project/fixture.txt' } }])], {
    rootRuntime: 'python',
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, false)
      assert.equal(r.code, 'CIEL_REVIEW_RUNTIME_INCOMPATIBLE')
      assert.equal(r.review.code, r.code)
      assert.equal(r.stage, 'runtime')
      assert.equal(r.review.status, 'error')
      assert.ok(requests.length <= 2, 'a non-TS root runtime fails before the tooled request')
      assert.equal(requests.every((entry) => !entry.tools.includes('run_code')), true)
      assert.equal(context.toolResults.some((entry) => entry.name === 'run_code'), false)
      assert.equal(context.sentinelRuntime.runs.length, 0)
    },
  }],
  ['ptc-root-runtime-probe', [textResponse('## suspects')], {
    rootPtcProbe: true,
    expect: (r, tools, requests, context) => {
      assert.equal(r.ok, true)
      assert.equal(context.sentinelRuntime.runs.length, 0, 'the review child did not use the root runtime')
    },
  }],
]
let seq = 0
const reports = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * A cancellation that never settles must fail the case fast instead of waiting
 * for the 180s review deadline. The timer is explicitly owned and cleared; it
 * is a test bound, never a production limit.
 */
async function withCancelDeadline(promise, ms = 2000) {
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation did not settle within ' + ms + 'ms')), ms) })
  try { return await Promise.race([promise, deadline]) } finally { clearTimeout(timer) }
}
async function runCase(name, script, options = {}) {
  if (selectedCases && !selectedCases.has(name)) return
  const ctx = new Context()
  // The production server keeps Node alive; its intentionally unref'ed review
  // timer needs a ref'ed handle only in this standalone timeout fixture.
  const loopHold = options.timeoutSeconds ? setInterval(() => {}, 1000) : undefined
  let plugin, parent
  const adapter = new ScriptedAdapter([...(options.parentScript || [textResponse(options.draft || '文件 ' + fixture + ' 共 3 行。')]), ...script])
  const executed = []
  const visibleReplies = []
  const childToolEvents = []
  const toolResults = []
  // Actual-engine cancellation signals: the phase-2 run_code tool/call and the
  // Nth settled nested dispatch (mid-batch cancel).
  let nestedStarted
  const nestedStart = new Promise((resolve) => { nestedStarted = resolve })
  let nestedSettles = 0
  // Observe every child session while it is still published: runtime ownership
  // is a live registry relation, so it cannot be asserted after teardown.
  const childOwnership = []
  const createdChildIds = new Set()
  ctx.on('agent/created', ({ agent }) => {
    if (parent && agent.session.header.parentSession === parent.id) createdChildIds.add(agent.id)
  })
  let mutation
  ctx.on('tools/result', (exec, result) => {
    if (!parent || exec.agent?.session?.header?.parentSession !== parent.id) return
    toolResults.push({ name: exec.name, isError: !!result.isError, code: result.error?.info?.code, text: (result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n') })
    if (!['read', 'grep', 'glob'].includes(exec.name) || result.isError) return
    // The receipt already captured the old bytes; rewrite the live file now.
    if (options.mutateAfterRead && !mutation) mutation = writeFile(options.mutateAfterRead.path, options.mutateAfterRead.content, 'utf8')
  })
  ctx.on('session/event', (session, event) => {
    if (!parent || session.header.parentSession !== parent.id) return
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') childToolEvents.push({ type: event.type, data: event.data })
    if (event.type === 'tool/ptc-dispatch' && event.data?.isError === false && ['read', 'grep', 'glob'].includes(event.data?.name)) {
      executed.push(event.data.name)
      // The private registry's nested read never reaches the root tools/result
      // observer; mutate after the receipt captured the old bytes, same as native.
      if (options.mutateAfterRead && !mutation) mutation = writeFile(options.mutateAfterRead.path, options.mutateAfterRead.content, 'utf8')
    }
    if (event.type === 'tool/ptc-dispatch') {
      nestedSettles += 1
      if (options.cancelAfterNested && nestedSettles >= options.cancelAfterNested) nestedStarted()
    }
    const registry = ctx.get('agents')
    const live = registry.get(session.id)
    if (live) childOwnership.push({
      id: session.id,
      ownedByParent: registry.isOwnedBy(session.id, parent),
      isRoot: registry.roots().includes(live),
      roots: registry.roots().length,
    })
    if (event.type !== 'assistant/message') return
    const text = (event.data.message?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    if (text) visibleReplies.push(text)
  })
  try {
    await ctx.plugin(llmModule.default || llmModule).await()
    for (const mod of modules) await ctx.plugin(mod.default || mod, mod.name === 'agent-loop' ? { agents: [] } : {}).await()
    // Root/stock runtime sentinel: the review child must resolve its own
    // isolated runtime; reaching this one is a wiring failure, not a fallback.
    const sentinelRuntime = createSentinelCodeRuntime(options.rootRuntime === 'python' ? 'python' : 'typescript')
    if (options.rootRuntime !== 'none') {
      await ctx.plugin({ name: 'ciel-verify-sentinel-runtime', apply(c) { c.provide('ptcRuntime', sentinelRuntime) } }).await()
    }
    ctx.get('llm').registerAdapter(['fixture'], adapter)
    if (live) {
      if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required; never put it in source or argv')
      const ds = await load('packages/llm/llm-deepseek')
      const connection = ds.resolveAdapterOptions(ds.Config({ maxTokens: 4096, reasoningEffort: 'low', retryPolicy: { mode: 'normal', maxRetries: 0 } }))
      const remote = new ds.DeepSeekAdapter({
        options: () => connection,
        resolveApiKey: async () => process.env.DEEPSEEK_API_KEY,
        resolveUserId: () => 'ciel-verification',
        prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      })
      ctx.get('llm').registerAdapter(['deepseek-official'], remote)
    }
    const tools = ctx.get('tools')
    for (const toolName of ['read', 'grep', 'glob']) tools.register({
      name: toolName, description: toolName === 'read' ? 'Read the fixture file; includes numbered lines.' : 'Discover the fixture path. Only the test fixture exists.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' } }, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        if ((options.planning || options.parentTools) && exec.agent === parent) return 'Synthetic independent work completed.'
        throw new Error('Unrestricted fixture reader must never execute for a review child')
      },
    })
    if (options.planning) tools.register({
      name: 'todo_write', description: 'Record a synthetic plan.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'Synthetic plan saved.',
    })
    plugin = ctx.plugin(ciel, {
      ...ciel.Config({}), provider: 'fixture', model: 'fixed', criticProvider: live ? 'deepseek-official' : 'fixture',
      criticModel: live ? model : 'fixed', criticEffort: live ? 'low' : 'provider',
      criticExploreBudget: options.legacyQueries, criticMaxTokens: 4096, criticMaxRequests: options.legacyRequests,
      criticTimeoutSeconds: options.timeoutSeconds ?? 180,
      guidanceEnabled: false, planReminderEnabled: Boolean(options.planning),
      ...(options.advisor ? { requireExploration: false, enforceFollowupGap: false } : {}),
    })
    await plugin.await()
    parent = await ctx.get('agentLoop').create('verify-' + (++seq), { provider: 'fixture', model: 'fixed' }, { cwd: home })
    if (options.setupParent) await options.setupParent({ ctx, parent, adapter, load, createUserMessage, checkout })
    if (options.parentContext) parent.ctx.get('systemPrompt').context({ name: 'fixture-context', order: 10, text: options.parentContext })
    if (options.planning || options.parentTools) parent.ctx.get('tools').presentAs('native')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: options.request || '核对文件行数，必要时读取文件。' }], source: options.requestSource || { kind: 'user' } }))
    await parent.whenIdle()
    if (options.legacyAdvice) {
      // Reproduce the retired producer's persisted event shapes, never register
      // or execute the removed command. The real steer crosses a native turn.
      if (options.legacyAdvice === 'matched') parent.session.append('command/run', { commandId: 'old-command', name: 'advise', args: 'COMMAND_QUESTION_MARKER', source: { kind: 'user' } })
      parent.steer({ id: 'advise-old123', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text:
        '[advisor:advise-result] 用户通过 /advise 命令向顾问模型发起咨询，结果如下' +
        '（用户已在卡片中看到同样的内容；请结合当前工作自行采纳或讨论，不必复述原文）：\n\n' +
        '问题：COMMAND_QUESTION_MARKER\n\n顾问回答：\nOLD_ADVISOR_MARKER',
      }] })
      await parent.whenIdle()
    }
    const prepared = options.prepareReview ? await options.prepareReview({ ctx, parent, adapter, load, createUserMessage, checkout }) : undefined
    if (prepared?.parent) {
      parent = prepared.parent
      createdChildIds.clear()
      childOwnership.length = 0
    }
    const target = prepared?.target || parent.session.snapshotEvents().findLast((e) => e.type === 'assistant/message')
    assert.ok(target?.data.message.id, 'fixture parent produced a draft')
    const request = { sessionId: parent.id, messageId: target.data.message.id }
    const service = ctx.get('advisorReview')
    if (options.planning) {
      const events = parent.session.snapshotEvents()
      const reminders = events.filter(event => event.type === 'user/message' && event.data.source?.sections?.some(section => section.name === 'advisor:plan-reminder'))
      assert.equal(reminders.length, 1, 'exactly one durable reminder after planning')
      assert.equal(ciel.reminderTextFor(parent, () => ({ enabled: true, planReminderEnabled: true })), '', 'fresh readers see the consumed reminder')
      assert.equal(ciel.gateFacts(parent).settledThisTurn, 0, 'rejected consultation does not spend quota')
      if (options.planning === 'rejected') assert.ok(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('context is required:')))
      assert.equal(adapter.script.length, 0)
      assert.equal(ctx.get('agents').list().length, 1)
      assert.equal(service.coordinator.activeOperations.size, 0)
      reports.push({ name, passed: true, reminders: reminders.length, settledConsultations: 0, modelRequests: adapter.requests.length })
      console.log(name, JSON.stringify(reports.at(-1)))
      return
    }
    if (options.privateAdvisor) {
      const outcome = await tools.execute({ agent: parent, callId: 'private-advisor', name: 'ask_advisor', signal: new AbortController().signal, arguments: { question: 'Check the fixture.', context: 'API_KEY=FAKE_CREDENTIAL_MARKER_ONLY' } })
      assert.equal(outcome.isError, true)
      assert.match(outcome.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'), /疑似凭据/)
      assert.equal(adapter.requests.length, 1, 'only the fake parent draft, no advisor request')
      assert.equal(service.coordinator.activeOperations.size, 0)
      reports.push({ name, passed: true, advisorRequests: 0 })
      console.log(name, JSON.stringify(reports.at(-1)))
      return
    }
    if (options.removedCommand) {
      const commands = ctx.get('commands')
      assert.equal(commands.find(parent, 'advise'), undefined)
      assert.equal(commands.list(parent).some(command => command.name === 'advise'), false)
      const before = parent.session.snapshotEvents().length
      assert.equal(await commands.execute(parent, '/advise Check this offline fixture.', [], new AbortController().signal), undefined)
      await parent.whenIdle()
      assert.equal(parent.session.snapshotEvents().length, before, 'removed command appends no events or feedback')
      assert.equal(adapter.requests.length, 1, 'only the fixture parent request; removed command starts no model')
      assert.equal(ctx.get('agents').list().length, 1)
      assert.equal(service.coordinator.activeOperations.size, 0)
      reports.push({ name, passed: true, registered: false, advisorRequests: 0 })
      console.log(name, JSON.stringify(reports.at(-1)))
      return
    }
    if (options.advisor) {
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => tools.execute({
        agent: parent, callId: 'advice-' + i, name: 'ask_advisor', signal: new AbortController().signal,
        arguments: { question: 'What should be verified?', context: 'Fixed offline fixture inspected.' },
      })))
      assert.equal(results.filter((r) => !r.isError).length, 1, 'only one simultaneous consultation may execute')
      const accepted = results.find((r) => !r.isError)
      assert.deepEqual(accepted.value.modelUsage, { requested: { provider: 'fixture', model: 'fixed' }, used: [{ provider: 'fixture', model: 'fixed' }] }, 'advisor captures actual response source')
      assert.deepEqual(accepted.meta.modelUsage, accepted.value.modelUsage, 'durable tool presentation stores the same provenance')
      const deniedUsage = await service.callModelUsage({ sessionId: parent.id, kind: 'tool', id: 'advice-1' })
      assert.deepEqual(deniedUsage.modelUsage.used, [], 'a rejected parallel call does not claim model execution')
      assert.equal(adapter.requests.length, 2, 'fixture draft plus exactly one advisor request')
      assert.equal(service.coordinator.activeOperations.size, 0)
      assert.equal(ctx.get('agents').list().length, 1)
      reports.push({ name, passed: true, accepted: 1, rejected: 3, advisorRequests: 1 })
      console.log(name, JSON.stringify(reports.at(-1)))
      return
    }
    let reached
    const childRequest = new Promise((r) => { reached = r })
    adapter.notify = () => reached()
    if (live && options.cancel) ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject.id !== parent.id && frame.type === 'chunk') reached()
    })
    let catalogAttempts = 0
    const append = parent.session.append
    if (options.failCatalogAt) parent.session.append = function (type, ...args) {
      if (type === 'subagent/catalog' && ++catalogAttempts === options.failCatalogAt) throw new Error('fixture catalog append failure')
      return append.call(this, type, ...args)
    }
    const reviewRequestOffset = adapter.requests.length
    const expectedRoots = ctx.get('agents').roots()
    let result
    try {
      const pending = service.start(request)
      if (options.cancel) { await childRequest; await service.cancel(request) }
      if (options.cancelAfterNested) {
        // Cancel only after the guest actually entered the engine: the first
        // nested read must settle first, then a controlled fixture delay lets
        // the guest resume into the loop before cancellation.
        await nestedStart
        if (options.cancelDelayMs) await sleep(options.cancelDelayMs)
        const cancelAt = Date.now()
        await service.cancel(request)
        result = await withCancelDeadline(pending, 2000)
        assert.ok(Date.now() - cancelAt < 2000, 'cancellation settled within 2s of the cancel source')
      } else {
        result = await pending
      }
    } finally { parent.session.append = append }
    const catalog = parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')
    assert.equal(new Set(catalog.map(event => event.data.childId)).size, catalog.length, 'each successful local child contributes exactly one parent catalog fact')
    assert.ok(catalog.every(event => createdChildIds.has(event.data.childId) && event.data.mode === 'one-shot'), 'catalog names only real one-shot children of this parent')
    assert.equal(catalog.length, createdChildIds.size - (options.failCatalogAt ? 1 : 0), 'only successful starts enter the catalog')
    if (options.failCatalogAt) assert.equal(catalogAttempts, options.failCatalogAt, 'catalog failure does not retry or publish compensating facts')
    if (result.review?.explore) {
      assert.equal(result.review.explore.limitMode, 'time')
      assert.equal(result.review.explore.budget, undefined)
      assert.ok(result.review.explore.toolCalls >= executed.length, 'query telemetry includes allowed attempts that returned an error; executed lists successful reads only')
    }
    assert.equal(service.coordinator.inFlight.size, 0)
    assert.equal(service.coordinator.children.size, 0)
    assert.equal(service.coordinator.pendingReviewControls.size, 0)
    assert.equal(sentinelRuntime.runs.length, 0, 'the review child must never execute the root/stock runtime')
    if (!options.refusedBeforeSpawn) assert.ok(createdChildIds.size > 0, 'a published review child was created: ' + JSON.stringify({ name, error: result.error }))
    if (!options.failCatalogAt && !options.refusedBeforeSpawn) assert.ok(childOwnership.length > 0, 'a published review child was observed while running')
    assert.ok(childOwnership.every((entry) => entry.ownedByParent && !entry.isRoot && entry.roots === expectedRoots.length), 'review child must be parent-owned and never a runtime root: ' + JSON.stringify(childOwnership))
    assert.ok(adapter.requests.every((r) => !r.leakedCredential && !r.leakedProcess), 'no fake credential or author process content reaches child input')
    if (!live && !options.refusedBeforeSpawn && (!options.failCatalogAt || adapter.requests.length > reviewRequestOffset)) assert.deepEqual(adapter.requests[reviewRequestOffset].tools, [], 'first review request is tool-free before any model dispatch')
    if (adapter.requests.length > reviewRequestOffset + 1) assert.deepEqual(adapter.requests[reviewRequestOffset + 1].tools, ['run_code'], 'PTC verification phase sees only the transport')
    assert.equal(service.coordinator.activeOperations.size, 0, 'catalog errors also release operation ownership')
    if (result.ok) {
      assert.ok(result.review.modelUsage.used.length > 0, 'successful review records actual child response routes')
      assert.equal(result.review.modelUsage.requested.provider, live ? 'deepseek-official' : 'fixture')
    }
    if (result.review?.outcomes) {
      assert.equal(result.review.stats.checked, result.review.suspects.total, 'host ledger cannot expand the nominated pool')
      assert.ok(result.review.annotations.every((a) => result.review.outcomes.some((o) => o.id === a.suspect && o.outcome === 'defect')), 'only defect ids may annotate')
    }
    assert.equal(ctx.get('agents').list().length, expectedRoots.length, 'only fixture roots remain; review child handles drained')
    assert.deepEqual(ctx.get('agents').roots(), expectedRoots, 'review teardown preserves the fixture roots')
    assert.equal(await readFile(secondFixture, 'utf8'), 'delta\nepsilon\n')
    assert.equal(await readFile(fixture, 'utf8'), 'alpha\nbeta\ngamma\n', 'fixture remained unchanged')
    reports.push({ name, ok: result.ok, status: result.review?.status, verdict: result.review?.verdict, coverage: result.review?.coverage, requestContext: result.review?.requestContext, stats: result.review?.stats, requests: result.review?.modelRequests, toolBodies: executed.length, salvaged: !!result.review?.explore?.salvaged, annotations: result.review?.annotations?.map((a) => ({ severity: a.severity, title: a.title, evidence: a.evidence, comment: a.comment })), error: result.error, code: result.code, stage: result.stage })
    console.log(name, JSON.stringify(reports.at(-1)))
    if (live && result.review?.coverage === 'partial') console.log('incomplete-response-diagnostic', JSON.stringify(visibleReplies))
    try {
      if (mutation) await mutation
      if (options.expect) await options.expect(result, executed, adapter.requests, { service, parent, request, sentinelRuntime, childToolEvents, toolResults, adapter })
      if (options.rootPtcProbe) {
        const rootTools = ctx.get('tools')
        const lift = parent.ctx.get('tools').presentAs('ptc')
        try {
          const probe = await rootTools.execute({ agent: parent, callId: 'root-ptc-probe', name: 'run_code', signal: new AbortController().signal, arguments: { code: 'return 1', description: 'root runtime probe' } })
          assert.equal(probe.isError, true, 'the root/stock runtime must fail closed for a root PTC call')
          const probeText = probe.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
          assert.match(probeText, /sentinel|root\/stock code runtime/i)
          assert.equal(sentinelRuntime.runs.length, 1, 'the root sentinel observed exactly the root probe')
        } finally { lift() }
      }
      reports.at(-1).passed = true
    } catch (error) {
      reports.at(-1).passed = false
      reports.at(-1).failure = error.message
      reports.at(-1).visibleReplies = visibleReplies
      if (process.env.CIEL_VERIFY_KEEP_GOING !== '1') throw error
    }
  } finally {
    if (loopHold !== undefined) clearInterval(loopHold)
    if (plugin) {
      await plugin.dispose()
      assert.equal(ctx.get('subagents').getProvider('ciel-review-private'), undefined, 'private backend belongs to Ciel, not the calling session or root')
    }
    await ctx.fiber.dispose()
  }
}
try {
  if (live) {
    await runCase('live-accurate', [], { expect: (r, tools) => { assert.equal(r.ok, true); assert.equal(r.review.verdict, 'pass'); assert.equal(r.review.coverage, 'complete'); assert.equal(r.review.stats.confirmed, 0); assert.ok(tools.length > 0) } })
    await runCase('live-wrong-count', [], { draft: '文件 ' + fixture + ' 共 900 行，已核实。', expect: (r) => { assert.equal(r.ok, true); assert.ok(r.review.annotations.length > 0); assert.ok(r.review.annotations.every((a) => a.evidence)) } })
    await runCase('live-honest-abstention', [], { request: '不要调用工具；如果不知道 ' + fixture + ' 的行数，就诚实说明无法确认，不要猜。', draft: '我没有读取文件，因此无法确认它的行数。', expect: (r) => { assert.equal(r.ok, true); assert.equal(r.review.verdict, 'pass'); assert.equal(r.review.annotations.length, 0) } })
    await runCase('live-stream-cancel', [], { cancel: true, expect: (r) => { assert.equal(r.review.status, 'cancelled'); assert.equal(r.review.modelRequests, 1) } })
  } else {
    await runRequestInputCases({ runCase, textResponse, nativeToolResponse, suspects, toolResponse, pass })
    for (const planning of ['normal', 'rejected']) {
      const parentScript = [
        ...(planning === 'rejected' ? [nativeToolResponse(['ask_advisor'], '', fixture, { question: 'Which boundary?', context: '' })] : []),
        nativeToolResponse(['todo_write'], '', fixture, {}), nativeToolResponse(['read']), textResponse('Synthetic plan complete.'),
      ]
      await runCase('scripted-planning-' + planning, [], { planning, parentScript })
    }
    await runCase('scripted-request-source-isolation', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
      request: 'HUMAN_TASK_MARKER Verify the file count.', parentContext: 'RUNTIME_CONTEXT_MARKER',
      expect: (result, _tools, requests) => {
        assert.equal(requests[0].inputMarkers.RUNTIME_CONTEXT_MARKER, true, 'actual native context reached the author')
        for (const request of requests.slice(1)) {
          assert.equal(request.inputMarkers.HUMAN_TASK_MARKER, true)
          assert.equal(request.inputMarkers.RUNTIME_CONTEXT_MARKER, false, 'runtime context is not a human requirement')
        }
        assert.deepEqual(result.review.requestContext, { mode: 'current-turn', limited: false })
        assert.equal(result.review.status, 'sound')
      },
    })
    for (const legacyAdvice of ['matched', 'unmatched']) await runCase('scripted-request-legacy-' + legacyAdvice,
      [textResponse('文件 ' + fixture + ' 共 3 行。'), textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
        request: 'HUMAN_TASK_MARKER Verify the file count.', legacyAdvice,
        expect: (result, _tools, requests) => {
          assert.equal(requests[1].inputMarkers.OLD_ADVISOR_MARKER, true, 'real steer reached the author')
          for (const request of requests.slice(2)) {
            assert.equal(request.inputMarkers.OLD_ADVISOR_MARKER, false)
            assert.equal(request.inputMarkers.HUMAN_TASK_MARKER, legacyAdvice === 'matched')
            assert.equal(request.inputMarkers.COMMAND_QUESTION_MARKER, legacyAdvice === 'matched')
          }
          assert.equal(result.review.requestContext.limited, legacyAdvice !== 'matched')
          assert.equal(result.review.status, legacyAdvice === 'matched' ? 'sound' : 'incomplete')
          if (legacyAdvice !== 'matched') assert.match(result.review.coverageNote, /用户请求上下文/)
        },
      })
    await runCase('scripted-request-missing-human', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
      request: 'RUNTIME_CONTEXT_MARKER', requestSource: { kind: 'plugin', plugin: 'fixture-notice' },
      expect: (result, _tools, requests) => {
        for (const request of requests.slice(1)) assert.equal(request.inputMarkers.RUNTIME_CONTEXT_MARKER, false)
        assert.deepEqual(result.review.requestContext, { mode: 'missing', limited: true, reasons: ['missing-input'] })
        assert.equal(result.review.status, 'incomplete')
        assert.match(result.review.coverageNote, /请补充明确请求后重新评审/)
      },
    })
    for (const phase of [1, 2]) await runCase('scripted-catalog-failure-phase-' + phase, [textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
      failCatalogAt: phase,
      expect: (result) => { assert.equal(result.ok, false); assert.equal(result.review.status, 'error'); assert.equal(result.review.explore?.salvaged ?? false, false) },
    })
    await runCase('scripted-accurate', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], { expect: (r, tools) => { assert.equal(r.review.status, 'sound'); assert.equal(r.review.modelRequests, 3); assert.equal(tools.length, 1) } })
    await runCase('scripted-placeholder-token-draft', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
      draft: '启动网址示例 http://127.0.0.1:3080/?token=… 只是占位符，不是真实凭据。',
      expect: (r) => { assert.equal(r.ok, true) },
    })
    await runCase('scripted-real-token-draft-refused', [], {
      draft: '真实形状的令牌：http://127.0.0.1:3080/?token=' + 'A'.repeat(43),
      refusedBeforeSpawn: true,
      expect: (r, _tools, requests) => { assert.equal(r.ok, false); assert.match(r.error, /疑似凭据/); assert.equal(requests.length, 1) },
    })
    await runCase('scripted-burst-without-query-cap', [textResponse(suspects), toolResponse(Array(75).fill('read')), textResponse(pass)], {
      legacyQueries: 20, legacyRequests: 2,
      expect: (r, tools) => { assert.equal(r.review.status, 'sound'); assert.equal(tools.length, 75); assert.equal(r.review.modelRequests, 3) },
    })
    await runCase('scripted-seventy-requests', [textResponse(suspects), ...Array.from({ length: 70 }, () => toolResponse(['read'])), textResponse(pass)], {
      legacyQueries: 1, legacyRequests: 2,
      expect: (r, tools, requests) => {
        assert.equal(r.review.status, 'sound')
        assert.equal(tools.length, 70)
        assert.equal(r.review.modelRequests, 72)
        assert.equal(requests.at(-1).timeSamples.at(-1).tool_calls, 70)
        assert.ok(requests.at(-1).timeSamples.at(-1).remaining_ms > 0)
      },
    })
    await runCase('scripted-legacy-zero-keeps-reading-enabled', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
      legacyQueries: 0, legacyRequests: 2,
      expect: (r, tools) => { assert.equal(r.review.status, 'sound'); assert.equal(tools.length, 1) },
    })
    await runCase('scripted-time-feedback', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], {
      expect: (r, tools, requests) => {
        assert.equal(r.review.status, 'sound')
        const feedback = requests.at(-1).timeSamples.at(-1)
        assert.equal(feedback.limit_ms, 180000)
        assert.ok(feedback.remaining_ms > 0 && feedback.remaining_ms <= feedback.limit_ms)
        assert.equal(feedback.tool_calls, 1)
        assert.match(feedback.instruction, /counts are telemetry only/)
      },
    })
    await runCase('scripted-checkpoint-keeps-working', [textResponse(suspects), toolResponse(['read']), toolResponse(['read'], partial), toolResponse(['read'], 'I will inspect another file.'), textResponse(pass)], {
      legacyQueries: 1,
      expect: (r, tools, requests) => {
        assert.equal(r.review.status, 'sound')
        assert.equal(tools.length, 3)
        assert.equal(r.review.modelRequests, 5)
        assert.equal(r.review.explore.salvaged, undefined)
        assert.deepEqual([...requests.at(-1).tools].sort(), ['run_code'])
      },
    })
    await runCase('scripted-timeout-no-extra-writer', [textResponse(suspects), 'hang'], {
      timeoutSeconds: 10,
      expect: (r, tools) => { assert.equal(r.ok, false); assert.match(r.error, /review timeout/); assert.equal(r.review.modelRequests, 2); assert.equal(tools.length, 0) },
    })
    await runCase('scripted-evidence-fidelity', [textResponse(suspects), toolResponse(['read'], '', changingFixture), textResponse(pass)], {
      mutateAfterRead: { path: changingFixture, content: 'mutated-after-capture\n' },
      expect: async (r, tools, requests, context) => {
        assert.equal(r.ok, true)
        assert.equal(r.review.status, 'sound')
        assert.equal(tools.length, 1)
        assert.equal(await readFile(changingFixture, 'utf8'), 'mutated-after-capture\n', 'the live file changed after capture')
        const stored = await context.service.readEvidence({ sessionId: context.parent.id, reviewId: r.review.reviewId, evidenceId: 'e1' })
        assert.equal(stored.ok, true)
        assert.equal(stored.evidence.content, changingContent, 'readEvidence keeps the captured bytes, never the live file')
        assert.equal(stored.evidence.contentSha256, createHash('sha256').update(changingContent).digest('hex'))
        assert.equal(stored.evidence.path, '/project/changing.txt')
      },
    })
    await runCase('scripted-forged-reference', [textResponse(suspects), toolResponse(['read']), textResponse('## dossier\n- result: s1 | outcome: cleared | evidence: e99\n## verdict: pass\nsummary: 伪造引用。')], {
      expect: (r, tools) => {
        assert.equal(r.ok, true)
        assert.equal(r.review.status, 'incomplete')
        assert.equal(r.review.coverage, 'partial')
        assert.equal(r.review.sound, false)
        assert.equal(r.review.stats.unchecked, 1)
        assert.equal(r.review.outcomes[0].outcome, 'unchecked')
        assert.deepEqual(r.review.outcomes[0].evidenceRefs, [])
        assert.equal(r.review.annotations.length, 0)
        assert.equal(tools.length, 1, 'the read really ran; the forged id still cannot cite it')
      },
    })
    await runCase('scripted-cancel', ['hang'], { cancel: true, expect: (r) => { assert.equal(r.review.status, 'cancelled'); assert.equal(r.review.modelRequests, 1) } })
    await runCase('scripted-advisor-concurrency', [textResponse('## [high] Boundary\nframing: fixed fixture\npitfalls: concurrency\nverification_target: one request')], { advisor: true })
    await runCase('scripted-advise-removed', [], { removedCommand: true })
    await runCase('scripted-sensitive-advisor-input', [], { privateAdvisor: true })
    for (const [name, path] of [['dotenv', secretFixture], ['author-record', processFixture], ['symlink', processLink], ['invalid-query', null]]) {
      await runCase('scripted-private-' + name, [textResponse(suspects), toolResponse(['read'], '', path), textResponse(pass)], { expect: (r, tools, requests) => {
        assert.equal(r.ok, true)
        assert.equal(r.review.status, 'incomplete')
        assert.equal(r.review.coverage, 'partial')
        assert.equal(r.review.privacy.dataLimited, true)
        assert.equal(tools.length, 0)
        // Denied/invalid nested reads now project a safe JSON error that still
        // carries review_time, so the deadline telemetry assertion applies to
        // both native and PTC paths.
        const feedback = requests.at(-1).timeSamples.at(-1)
        assert.ok(feedback, 'even denied/malformed queries return remaining time')
        assert.equal(feedback.limit_ms, 180000)
        assert.ok(feedback.remaining_ms >= 0 && feedback.remaining_ms <= feedback.limit_ms)
      } })
    }
    for (const [name, script, options] of ptcCases) await runCase(name, script, options)
  }
  assert.ok(reports.length > 0, 'at least one selected scenario must run')
  console.log('evaluated', reports.length, 'scenarios; passed:', reports.filter((r) => r.passed).length, '; network requests:', networkRequests)
  if (reports.some((r) => !r.passed)) process.exitCode = 1
} finally {
  try {
    if (process.env.CIEL_VERIFY_REPORT) {
      const report = { contract: 'v4.1-ledger', transport: 'ptc', model: live ? model : 'scripted', live, networkRequests, reports }
      await writeFile(process.env.CIEL_VERIFY_REPORT, JSON.stringify(report, null, 2).replaceAll(home, '{FIXTURE_ROOT}') + '\n')
    }
  } finally {
    console.log('batch network requests:', networkRequests)
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome
    resolutionHook.deregister()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}
