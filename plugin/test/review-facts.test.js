import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewHostFacts } from '../review-facts.js'
import { createEvidenceLedger, groundReview } from '../review-evidence.js'
import { prepareJevReview } from '../jev-review.js'

function fixture() {
  const events = [
    { seq: 0, type: 'sandbox/mode', data: { mode: 'read-only' } },
    { seq: 1, type: 'approval/policy', data: { policy: 'ask' } },
    { seq: 2, type: 'request/header', data: { header: { config: { provider: 'local', model: 'requested-model', apiKey: 'PRIVATE_KEY_NOT_TO_PROJECT' },
      tools: [{ name: 'web_search', description: 'PRIVATE_SCHEMA_TEXT', parameters: { secret: 'PRIVATE_KEY_NOT_TO_PROJECT' } }, { name: 'web_fetch' }] } } },
    { seq: 3, time: 100, type: 'assistant/message', data: { message: { id: 'm1', source: { kind: 'model', provider: 'local', model: 'actual-model', replayState: 'PRIVATE_REPLAY' } } } },
    { seq: 4, type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { seq: 5, type: 'approval/policy', data: { policy: 'never' } },
    { seq: 6, type: 'request/header', data: { header: { config: { provider: 'future', model: 'future-model' }, tools: [] } } },
  ]
  return { events, target: events[3] }
}
const byTopic = facts => Object.fromEntries(facts.map(fact => [fact.topic, JSON.parse(fact.content)]))

test('historical projection exposes only actual/requested routes, policy enums and declared tool names', () => {
  const { events, target } = fixture(), facts = reviewHostFacts(events, target), data = byTopic(facts)
  assert.deepEqual(data['model-route'].responseRoute, { provider: 'local', model: 'actual-model' })
  assert.deepEqual(data['model-route'].requestedRoute, { provider: 'local', model: 'requested-model' })
  assert.equal(data['session-policy'].sandboxMode, 'read-only')
  assert.equal(data['session-policy'].approvalPolicy, 'ask')
  assert.deepEqual(data['tool-declarations'].names, ['web_fetch', 'web_search'])
  assert.equal(data['tool-declarations'].scope, 'model-direct-request-tools')
  assert.equal(data['model-route'].observedAt, 100)
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_|future-model|danger-full-access/)
})

test('missing history never borrows current defaults or infers nested PTC tools', () => {
  const { events, target } = fixture()
  events[2].data.header.tools = [{ name: 'run_code' }]
  const data = byTopic(reviewHostFacts(events.slice(2, 4), target))
  assert.equal(data['session-policy'], undefined)
  assert.deepEqual(data['tool-declarations'].names, ['run_code'])
  assert.match(data['tool-declarations'].limitations, /does not enumerate nested/)
  delete target.data.message.source
  const minimal = byTopic(reviewHostFacts([target], target))
  assert.deepEqual(minimal, {})
})

test('invalid latest values and malformed history do not revive older metadata', () => {
  const { events, target } = fixture()
  events[0].data.mode = 'made-up'
  events[1].data.policy = 'auto'
  events[2].data.header.tools[0].name = 'sk-' + 'A'.repeat(40)
  const facts = byTopic(reviewHostFacts(events, target))
  assert.equal(facts['session-policy'], undefined)
  assert.equal(facts['tool-declarations'], undefined)
  assert.deepEqual(reviewHostFacts([events[1], events[0], target], target), [])
  assert.deepEqual(reviewHostFacts(events, { ...target, data: { message: { id: 'other' } } }), [])
})

test('new metadata and recorded tool receipts are inspectable, grounded and eligible for Jev', () => {
  const { events, target } = fixture(), ledger = createEvidenceLedger()
  const fact = ledger.hostFact(reviewHostFacts(events, target)[0])
  const quote = ledger.providedQuote({ name: 'bash', text: 'kernel 6.18.33\nproject-a\nproject-b\n', sourceSeq: 2, observedAt: 90, truncated: false })
  assert.equal(fact.kind, 'host-fact')
  assert.equal(quote.kind, 'tool-output')
  assert.match(quote.content, /project-b/)
  const parsed = groundReview({ outcomes: [{ id: 's1', outcome: 'cleared', evidence: fact.id }, { id: 's2', outcome: 'cleared', evidence: quote.id }], annotations: [] }, ledger)
  assert.deepEqual(parsed.ledgerIssues, [], 'provenance is not a blanket completeness veto')
  const prepared = prepareJevReview({ parsed,
    suspects: [{ id: 's1', block: 'b1', claim: 'actual-model' }, { id: 's2', block: 'b2', claim: 'kernel 6.18.33' }],
    blocks: [{ id: 'b1', text: 'actual-model' }, { id: 'b2', text: 'kernel 6.18.33' }],
  })
  assert.ok(prepared.checks.every(check => check.status === 'pending'))
  assert.equal(prepared.request.state.items.s1.evidence[0].temporal, 'target-reply-history')
  assert.equal(prepared.request.state.items.s2.evidence[0].origin, 'session-tool')
  assert.match(prepared.request.questions.s1.instructions, /not prove successful execution/)
  assert.doesNotMatch(JSON.stringify(prepared.request), /PRIVATE_|requestedRoute.*apiKey/)
  ledger.dispose()
})

test('automatic metadata reserves archive capacity for subsequent source evidence', () => {
  const ledger = createEvidenceLedger({ limits: { maxTotalBytes: 20, maxSnippetBytes: 20 } })
  const quote = ledger.providedQuote({ name: 'bash', text: '1234567890ABCDEFGHIJ' })
  assert.equal(quote.content, '1234567890')
  assert.equal(quote.truncated, true)
  assert.equal(ledger.providedQuote({ name: 'bash', text: 'different output' }), null)
  const read = ledger.record('read', {}, { file_path: '/project/a.txt', offset: 1, total_lines: 1, content: 'abcdefghij', truncated: false })
  assert.equal(read.evidence_refs.length, 1)
  assert.equal(ledger.get(read.evidence_refs[0]).truncated, false)
  assert.equal(ledger.stats().bytes, 20)
  ledger.dispose()
})

test('truncated, empty and sensitive new receipts are never complete Jev inputs', () => {
  const ledger = createEvidenceLedger()
  assert.equal(ledger.providedQuote({ name: 'bash', text: 'API_KEY=FAKE_CREDENTIAL_MARKER_ONLY' }), null)
  assert.equal(ledger.providedQuote({ name: 'unknown', text: 'some output' }), null)
  const quote = ledger.providedQuote({ name: 'bash', text: 'first page', truncated: true })
  const parsed = groundReview({ outcomes: [{ id: 's1', outcome: 'cleared', evidence: quote.id }], annotations: [] }, ledger)
  assert.ok(parsed.ledgerIssues.some(issue => issue.includes('限制')))
  const prepared = prepareJevReview({ parsed, suspects: [{ id: 's1', block: 'b1', claim: 'first page' }], blocks: [{ id: 'b1', text: 'first page' }] })
  assert.equal(prepared.checks[0].reason, 'limited-evidence')
  ledger.dispose()
})
