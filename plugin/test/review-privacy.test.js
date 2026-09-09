import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { turnEvidence } from '../index.js'
import { reviewHarness, SUSPECT, verdict } from './host-harness.js'

const previousHome = process.env.DSH_HOME
const home = await mkdtemp(join(tmpdir(), 'ciel-privacy-test-'))
process.env.DSH_HOME = home
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})
const secret = 'FAKE_SECRET_TEST_VALUE_NOT_REAL'
function eventsFor(name, output, args = '') {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Check the source.' }] } },
    { seq: 2, type: 'tool/call', data: { name, callId: 'call', arguments: args } },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ toolCallId: 'call', content: [{ type: 'text', text: output }] }] } } },
  ]
}
const target = { seq: 4, data: { turn: 1 } }

test('normal terminal evidence stays available while filesystem snippets are not copied', () => {
  const bash = turnEvidence(eventsFor('bash', 'PASS 4 tests'), target, { protectInputs: true })
  assert.equal(bash.withheld, false)
  assert.equal(bash.quotes[0].text, 'PASS 4 tests')
  const file = turnEvidence(eventsFor('read', 'SOURCE_BODY_SENTINEL'), target, { protectInputs: true })
  assert.equal(file.quotes.length, 0)
  assert.ok(!file.tools.includes('SOURCE_BODY_SENTINEL'))
  assert.match(file.tools, /read: ok/)
})

test('continuation digest keeps earlier process private without asserting tests never happened', async (t) => {
  const h = await reviewHarness([SUSPECT, '## dossier\n- result: s1 | outcome: unchecked | evidence: none\n## verdict: pass\nsummary: no current evidence'])
  t.after(() => h.dispose())
  const events = h.parent.session.snapshotEvents()
  const draft = events.pop()
  events.push({ seq: 4, type: 'turn/end', data: { turn: 1 } },
    { seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } })
  draft.seq = 7; draft.data.turn = 2
  draft.data.message.content[0].text = '201 项测试、15 个离线流程通过。'
  events.push(draft)
  const evidence = turnEvidence(events, draft, { protectInputs: true })
  assert.match(evidence.tools, /NOT evidence that work or tests did not happen/)
  assert.doesNotMatch(evidence.tools, /NONE|any draft claim.*unsupported/)
  assert.deepEqual(evidence.quotes, [], 'do not expose earlier author process to avoid an accusation')
  const result = await h.start()
  const investigator = h.requests[1]
  assert.match(investigator.persona, /older report or a DIFFERENT test suite is not a contradiction/)
  assert.match(investigator.persona, /Positive evidence of an actual contradiction/)
  assert.doesNotMatch(investigator.persona, /phrase as fact|treat such claims as conditional risks/)
  assert.ok(!investigator.prompt[0].text.includes('AUTHOR_EVIDENCE_SENTINEL'))
  assert.equal(result.review.stats.unchecked, 1)
  assert.equal(result.review.annotations.length, 0)
  assert.equal(result.review.sound, false)
})

test('credential content anywhere in original tool output is withheld before clipping', () => {
  const result = turnEvidence(eventsFor('bash', 'ordinary\n'.repeat(2000) + 'API_KEY=' + secret), target, { protectInputs: true })
  assert.equal(result.withheld, true)
  assert.deepEqual(result.quotes, [])
  assert.ok(!result.tools.includes(secret))
})

test('process-record and environment commands are not forwarded as ordinary evidence', () => {
  for (const args of ['cat ~/.dsh/sessions/record', 'cat ~/.bashrc', 'cat .env', 'cat config/credentials.json', 'cat server.key', 'printenv', 'echo $DSH_HOME']) {
    const result = turnEvidence(eventsFor('bash', 'FAKE_PRIVATE_PROCESS_SENTINEL', args), target, { protectInputs: true })
    assert.equal(result.withheld, true)
    assert.ok(!result.tools.includes('FAKE_PRIVATE_PROCESS_SENTINEL'))
    assert.deepEqual(result.quotes, [])
  }
})

test('other agent output and unknown process tools do not enter the evidence digest', () => {
  for (const name of ['subagent', 'session_query', 'ask_advisor']) {
    const result = turnEvidence(eventsFor(name, 'FAKE_PROCESS_SENTINEL'), target, { protectInputs: true })
    assert.equal(result.withheld, true)
    assert.ok(!result.tools.includes('FAKE_PROCESS_SENTINEL'))
  }
})

test('request and draft credentials prevent any model request', async (t) => {
  for (const where of ['request', 'draft']) {
    const h = await reviewHarness([])
    t.after(() => h.dispose())
    const events = h.parent.session.snapshotEvents()
    if (where === 'request') events[1].data.content[0].text = 'safe '.repeat(800) + 'API_KEY=' + secret
    else events[4].data.message.content[0].text = 'API_KEY=' + secret
    const result = await h.start()
    assert.equal(result.ok, false)
    assert.match(result.error, /未发送/)
    assert.equal(h.requests.length, 0)
    assert.ok(!result.error.includes(secret))
    assert.equal(h.service.activeOperations.size, 0)
  }
})

test('withheld author evidence yields incomplete coverage, not a clean certification', async (t) => {
  const h = await reviewHarness([SUSPECT, verdict()])
  t.after(() => h.dispose())
  h.parent.session.snapshotEvents()[3].data.message.content[0].content[0].text = 'API_KEY=' + secret
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.privacy.evidenceWithheld, true)
  assert.equal(result.review.coverage, 'partial')
  assert.equal(result.review.sound, false)
  assert.ok(h.requests.every((r) => r.prompt.every((b) => !b.text.includes(secret))))
})

test('backend or corpus failure never falls back to normal spawn and does not leak diagnostics', async (t) => {
  for (const stage of ['backend', 'corpus']) {
    const h = await reviewHarness([])
    t.after(() => h.dispose())
    if (stage === 'backend') h.service.createProvider = async () => { throw new Error('/fake/private/path ' + secret) }
    else h.service.createCorpus = async () => { throw new Error('/fake/private/path ' + secret) }
    const result = await h.start()
    assert.equal(result.ok, false)
    assert.equal(h.requests.length, 0)
    assert.ok(!result.error.includes(secret) && !result.error.includes('/fake/private/path'))
    assert.equal(h.service.pendingReviewControls.size, 0)
    assert.equal(h.service.activeOperations.size, 0)
  }
})

test('a remote filesystem view cannot be mistaken for a same-named local host directory', async (t) => {
  const h = await reviewHarness([])
  t.after(() => h.dispose())
  h.parent.ctx = { get: (name) => name === 'fs' ? { processPathFromHostPath: () => undefined } : undefined }
  let captured = false
  h.service.createCorpus = async () => { captured = true; throw new Error('must not touch host directory') }
  const result = await h.start()
  assert.equal(result.ok, false)
  assert.match(result.error, /不是本机文件系统/)
  assert.equal(captured, false)
  assert.equal(h.requests.length, 0)
})

test('one snapshot is shared across stages and disposed once at operation end', async (t) => {
  const h = await reviewHarness([SUSPECT, verdict()])
  t.after(() => h.dispose())
  let built = 0, disposed = 0
  h.service.createCorpus = async () => { built++; return { publicInfo: () => ({ fileCount: 1, byteCount: 10, roots: ['/project'], truncated: false }), dispose() { disposed++ } } }
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(built, 1); assert.equal(disposed, 1)
  assert.equal(result.review.privacy.mode, 'restricted-snapshot')
  assert.match(h.requests[1].prompt[0].text, /\/project = \/fixture-project/)
  assert.match(h.requests[1].prompt[0].text, /SAME captured files/)
})
