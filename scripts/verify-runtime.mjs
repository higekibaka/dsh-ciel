#!/usr/bin/env node
/** Real DSH/Cordis/agent-loop/tool-registry integration without a Web server.
 * Default is keyless scripted-model replay. --live uses ONLY the explicitly
 * allowed DeepSeek route, with native adapter retries disabled.
 * DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-runtime.mjs [--live]
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import * as ciel from '../plugin/index.js'
const require = createRequire(new URL('../plugin/package.json', import.meta.url))
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to a built DSH checkout')
const load = (relative) => import(pathToFileURL(join(checkout, relative, 'lib/index.js')).href)
const llmModule = await load('packages/llm/llm')
const { LlmAdapter, createUserMessage } = llmModule
const modules = await Promise.all([
  'packages/core/session', 'packages/core/system-prompt', 'packages/core/tools',
  'packages/core/agent', 'packages/session/session-projection', 'packages/core/agent-loop', 'packages/subagent/subagent',
  'packages/subagent/subagent-spawn-in-process',
].map(load))
const live = process.argv.includes('--live')
if (live && process.env.CIEL_ALLOW_PAID_TESTS !== '1') throw new Error('Live calls require CIEL_ALLOW_PAID_TESTS=1')
const model = 'deepseek-v4-flash-vision-exp'
const selectedCases = process.env.CIEL_VERIFY_CASES ? new Set(process.env.CIEL_VERIFY_CASES.split(',')) : null
const originalHome = process.env.DSH_HOME
const home = await mkdtemp(join(tmpdir(), 'ciel-assembled-'))
process.env.DSH_HOME = home
const fixture = join(home, 'fixture.txt')
await writeFile(fixture, 'alpha\nbeta\ngamma\n', 'utf8')
const secondFixture = join(home, 'fixture-two.txt')
await writeFile(secondFixture, 'delta\nepsilon\n', 'utf8')
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
let callId = 0
function toolResponse(names, text = '') {
  const chunks = text ? textResponse(text).slice(0, -1) : []
  names.forEach((name, n) => {
    const index = n + (text ? 1 : 0), id = 'call-' + (++callId)
    const args = JSON.stringify({ file_path: fixture })
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
    )
  })
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}
class ScriptedAdapter extends LlmAdapter {
  constructor(script) { super(); this.script = [...script]; this.requests = []; this.notify = () => {} }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(options) {
    this.requests.push(options); this.notify(options)
    const item = this.script.shift()
    if (!item) throw new Error('script exhausted (unexpected model call)')
    if (item === 'live-salvage') {
      if (!this.remote) throw new Error('missing authorized salvage adapter')
      yield* this.remote.stream(options)
      return
    }
    if (item === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise((_, reject) => {
        if (options.signal.aborted) return reject(new Error('cancelled'))
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
      return
    }
    for (const chunk of item) { options.signal.throwIfAborted(); yield chunk }
  }
}
const suspects = '## suspects\n- suspect: 文件行数 | block: b1 | bearing: high | falsify: read ' + fixture
const pass = '## dossier\n- result: s1 | outcome: cleared | evidence: read ' + fixture + ':1-3 confirms three lines\n## verdict: pass\nsummary: 行数正确。'
const partial = '## dossier\n- result: s1 | outcome: cleared | evidence: read ' + fixture + ':1-3 confirms three lines'
let seq = 0
const reports = []
async function runCase(name, script, options = {}) {
  if (selectedCases && !selectedCases.has(name)) return
  const ctx = new Context()
  let plugin, parent
  const adapter = new ScriptedAdapter([textResponse(options.draft || '文件 ' + fixture + ' 共 3 行。'), ...script])
  const executed = []
  const visibleReplies = []
  ctx.on('session/event', (session, event) => {
    if (!parent || session.header.parentSession !== parent.id || event.type !== 'assistant/message') return
    const text = (event.data.message?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    if (text) visibleReplies.push(text)
  })
  try {
    await ctx.plugin(llmModule.default || llmModule).await()
    for (const mod of modules) await ctx.plugin(mod.default || mod, mod.name === 'agent-loop' ? { agents: [] } : {}).await()
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
      if (options.hybridSalvage) {
        // Deterministically trigger the breaker through the real tool runtime;
        // only the final writer uses the paid adapter (one HTTP request).
        const hybrid = new ScriptedAdapter(script)
        hybrid.remote = remote
        Object.defineProperty(hybrid, 'retryPolicy', { value: connection.retryPolicy })
        hybrid.resolveModel = (provider, id) => remote.resolveModel(provider, id)
        ctx.get('llm').registerAdapter(['deepseek-official'], hybrid)
      } else {
        ctx.get('llm').registerAdapter(['deepseek-official'], remote)
      }
    }
    const tools = ctx.get('tools')
    for (const toolName of ['read', 'grep', 'glob']) tools.register({
      name: toolName, description: toolName === 'read' ? 'Read the fixture file; includes numbered lines.' : 'Discover the fixture path. Only the test fixture exists.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' } }, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const target = args.file_path || args.path || fixture
        if (![fixture, secondFixture, home].includes(resolve(target))) throw new Error('Outside the verification fixtures')
        executed.push(toolName)
        if (toolName !== 'read') return fixture + '\n' + secondFixture
        if (resolve(target) === home) throw new Error('read requires one file, not a directory')
        const body = await readFile(resolve(target), 'utf8')
        const lines = body.trimEnd().split('\n')
        return lines.map((line, i) => (i + 1) + ': ' + line).join('\n') + '\n(End of file - total ' + lines.length + ' lines)'
      },
    })
    plugin = ctx.plugin(ciel, {
      ...ciel.Config({}), provider: 'fixture', model: 'fixed', criticProvider: live ? 'deepseek-official' : 'fixture',
      criticModel: live ? model : 'fixed', criticEffort: live ? 'low' : 'provider',
      criticExploreBudget: options.budget ?? 5, criticMaxTokens: 4096, criticMaxRequests: 10,
      guidanceEnabled: false, planReminderEnabled: false,
      ...(options.advisor ? { requireExploration: false, enforceFollowupGap: false } : {}),
    })
    await plugin.await()
    parent = await ctx.get('agentLoop').create('verify-' + (++seq), { provider: 'fixture', model: 'fixed' }, { cwd: home })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: options.request || '核对文件行数，必要时读取文件。' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const target = parent.session.snapshotEvents().findLast((e) => e.type === 'assistant/message')
    assert.ok(target?.data.message.id, 'fixture parent produced a draft')
    const request = { sessionId: parent.id, messageId: target.data.message.id }
    const service = ctx.get('advisorReview')
    if (options.advisor) {
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => tools.execute({
        agent: parent, callId: 'advice-' + i, name: 'ask_advisor', signal: new AbortController().signal,
        arguments: { question: 'What should be verified?', context: 'Fixed offline fixture inspected.' },
      })))
      assert.equal(results.filter((r) => !r.isError).length, 1, 'only one simultaneous consultation may execute')
      assert.equal(adapter.requests.length, 2, 'fixture draft plus exactly one advisor request')
      assert.equal(service.activeOperations.size, 0)
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
    const pending = service.start(request)
    if (options.cancel) { await childRequest; await service.cancel(request) }
    const result = await pending
    assert.ok(executed.length <= (options.budget ?? 5), 'tool bodies never exceed budget')
    assert.equal(service.inFlight.size, 0)
    assert.equal(service.children.size, 0)
    if (result.review?.outcomes) {
      assert.equal(result.review.stats.checked, result.review.suspects.total, 'host ledger cannot expand the nominated pool')
      assert.ok(result.review.annotations.every((a) => result.review.outcomes.some((o) => o.id === a.suspect && o.outcome === 'defect')), 'only defect ids may annotate')
    }
    assert.equal(ctx.get('agents').list().length, 1, 'only the fixture parent remains; child handles drained')
    assert.equal(await readFile(secondFixture, 'utf8'), 'delta\nepsilon\n')
    assert.equal(await readFile(fixture, 'utf8'), 'alpha\nbeta\ngamma\n', 'fixture remained unchanged')
    reports.push({ name, ok: result.ok, status: result.review?.status, verdict: result.review?.verdict, coverage: result.review?.coverage, stats: result.review?.stats, requests: result.review?.modelRequests, toolBodies: executed.length, salvaged: !!result.review?.explore?.salvaged, annotations: result.review?.annotations?.map((a) => ({ severity: a.severity, title: a.title, evidence: a.evidence, comment: a.comment })), error: result.error })
    console.log(name, JSON.stringify(reports.at(-1)))
    if (live && result.review?.coverage === 'partial') console.log('incomplete-response-diagnostic', JSON.stringify(visibleReplies))
    try {
      if (options.expect) options.expect(result, executed, adapter.requests)
      reports.at(-1).passed = true
    } catch (error) {
      reports.at(-1).passed = false
      reports.at(-1).failure = error.message
      reports.at(-1).visibleReplies = visibleReplies
      if (process.env.CIEL_VERIFY_KEEP_GOING !== '1') throw error
    }
  } finally {
    if (plugin) await plugin.dispose()
    await ctx.fiber.dispose()
  }
}
try {
  if (live) {
    await runCase('live-accurate', [], { expect: (r, tools) => { assert.equal(r.ok, true); assert.equal(r.review.verdict, 'pass'); assert.equal(r.review.coverage, 'complete'); assert.equal(r.review.stats.confirmed, 0); assert.ok(tools.length > 0) } })
    await runCase('live-wrong-count', [], { draft: '文件 ' + fixture + ' 共 900 行，已核实。', expect: (r) => { assert.equal(r.ok, true); assert.ok(r.review.annotations.length > 0); assert.ok(r.review.annotations.every((a) => a.evidence)) } })
    await runCase('live-honest-abstention', [], { request: '不要调用工具；如果不知道 ' + fixture + ' 的行数，就诚实说明无法确认，不要猜。', draft: '我没有读取文件，因此无法确认它的行数。', expect: (r) => { assert.equal(r.ok, true); assert.equal(r.review.verdict, 'pass'); assert.equal(r.review.annotations.length, 0) } })
    await runCase('live-limited-coverage', [], { budget: 1, draft: '文件 ' + fixture + ' 共 3 行。另一个文件 ' + secondFixture + ' 共 2 行。', expect: (r) => { assert.equal(r.review.sound, false); assert.ok(r.review.status === 'incomplete' || (r.review.status === 'error' && /budget exceeded/.test(r.error))); if (r.ok) { assert.ok(r.review.stats.unchecked > 0); assert.equal(r.review.annotations.length, 0) } } })
    await runCase('live-stream-cancel', [], { cancel: true, expect: (r) => { assert.equal(r.review.status, 'cancelled'); assert.equal(r.review.modelRequests, 1) } })
    await runCase('live-salvage-writer', [textResponse(suspects), toolResponse(['read']), toolResponse(['read'], partial), 'live-salvage'], { budget: 1, hybridSalvage: true, expect: (r) => { assert.equal(r.ok, true); assert.equal(r.review.explore.salvaged, true); assert.equal(r.review.status, 'incomplete'); assert.equal(r.review.stats.excluded, 1); assert.equal(r.review.annotations.length, 0); assert.equal(r.review.modelRequests, 4) } })
  } else {
    await runCase('scripted-accurate', [textResponse(suspects), toolResponse(['read']), textResponse(pass)], { expect: (r, tools) => { assert.equal(r.review.status, 'sound'); assert.equal(r.review.modelRequests, 3); assert.equal(tools.length, 1) } })
    await runCase('scripted-burst-limit', [textResponse(suspects), toolResponse(['read', 'read'])], { budget: 1, expect: (r) => { assert.equal(r.ok, false); assert.match(r.error, /budget exceeded/); assert.equal(r.review.modelRequests, 2) } })
    await runCase('scripted-salvage', [textResponse(suspects), toolResponse(['read']), toolResponse(['read'], partial), textResponse(pass)], { budget: 1, expect: (r) => { assert.equal(r.ok, true); assert.equal(r.review.status, 'incomplete'); assert.equal(r.review.explore.salvaged, true); assert.equal(r.review.modelRequests, 4) } })
    await runCase('scripted-cancel', ['hang'], { cancel: true, expect: (r) => { assert.equal(r.review.status, 'cancelled'); assert.equal(r.review.modelRequests, 1) } })
    await runCase('scripted-advisor-concurrency', [textResponse('## [high] Boundary\nframing: fixed fixture\npitfalls: concurrency\nverification_target: one request')], { advisor: true })
  }
  assert.ok(reports.length > 0, 'at least one selected scenario must run')
  console.log('evaluated', reports.length, 'scenarios; passed:', reports.filter((r) => r.passed).length, '; network requests:', networkRequests)
  if (reports.some((r) => !r.passed)) process.exitCode = 1
} finally {
  try {
    if (process.env.CIEL_VERIFY_REPORT) {
      const report = { contract: 'v4.1-ledger', model: live ? model : 'scripted', live, networkRequests, reports }
      await writeFile(process.env.CIEL_VERIFY_REPORT, JSON.stringify(report, null, 2).replaceAll(home, '{FIXTURE_ROOT}') + '\n')
    }
  } finally {
    console.log('batch network requests:', networkRequests)
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome
    await rm(home, { recursive: true, force: true })
  }
}
