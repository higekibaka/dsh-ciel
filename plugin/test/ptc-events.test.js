import test from 'node:test'
import assert from 'node:assert/strict'
import { toolEventView, gateFacts, advisorTargets, turnEvidence, createReviewObserver } from '../index.js'
const NL = String.fromCharCode(10)
const answer = ['## [high] 检查边界','framing: 多看一种情况','pitfalls: 别漏空值','verification_target: 验证空值'].join(NL)
const start = (seq, id, name, args = {}) => ({ seq, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'outer', subCallId: id, name, arguments: args } })
const end = (seq, id, name, text, isError = false) => ({ seq, type: 'tool/ptc-dispatch', data: { parentCallId: 'outer', subCallId: id, name, arguments: {}, isError, content: [{ type: 'text', text }] } })
const turn = { seq: 0, type: 'turn/start', data: { turn: 1 } }
const wrapper = { seq: 1, type: 'tool/call', data: { callId: 'outer', name: 'run_code' } }
const target = { seq: 20, type: 'assistant/message', data: { turn: 1 } }

test('PTC wrapper alone is not exploration; an actual dispatched read is', () => {
  const events = [turn, wrapper]
  const parent = { session: { snapshotEvents: () => events } }
  assert.equal(gateFacts(parent).explorationDone, false)
  events.push(start(2, 'read-1', 'read', { file_path: 'file.txt' }), end(3, 'read-1', 'read', 'contents'))
  assert.equal(gateFacts(parent).explorationDone, true)
})
test('PTC consultations count exact sub-call results and enforce independent work', () => {
  const events = [turn, wrapper, start(2, 'r1', 'read'), end(3, 'r1', 'read', 'x'), start(4, 'a1', 'ask_advisor'), end(5, 'a1', 'ask_advisor', answer)]
  const parent = { session: { snapshotEvents: () => events } }
  assert.equal(gateFacts(parent).settledThisTurn, 1)
  assert.equal(gateFacts(parent).workSinceLast, false)
  events.push({ seq: 6, type: 'tool/call', data: { name: 'run_code', callId: 'outer-2' } })
  assert.equal(gateFacts(parent).workSinceLast, false)
  events.push(start(7, 'r2', 'grep'))
  assert.equal(gateFacts(parent).workSinceLast, true)
})
test('advisor targets are recovered only from matched successful PTC advisor output', () => {
  const events = [turn, start(2, 'a1', 'ask_advisor'), end(3, 'a1', 'ask_advisor', answer)]
  assert.equal(advisorTargets(events, target).items[0].verificationTarget, '验证空值')
  assert.match(advisorTargets(events, target).from, /^same-turn/)
  assert.equal(advisorTargets([turn, end(3, 'a1', 'ask_advisor', answer)], target).items.length, 0)
  assert.equal(advisorTargets([turn, start(2, 'a1', 'read'), end(3, 'a1', 'ask_advisor', answer)], target).items.length, 0)
  assert.equal(advisorTargets([turn, start(2, 'a1', 'ask_advisor'), end(3, 'a1', 'ask_advisor', answer, true)], target).items.length, 0)
})
test('event adaptation is read-only and idempotent with native events', () => {
  const events = [turn, wrapper, start(2, 'r1', 'read'), end(3, 'r1', 'read', 'x')]
  const before = JSON.stringify(events)
  const view = toolEventView(events)
  assert.equal(JSON.stringify(events), before)
  assert.deepEqual(toolEventView(view), view)
  assert.equal(view[2].data.callId, 'r1')
  assert.equal(view[3].data.message.content[0].toolCallId, 'r1')
})
test('PTC terminal evidence is quoted, while private sources and file bodies remain hidden', () => {
  const events = [turn, start(2, 'b1', 'bash', { command: 'unit-test' }), end(3, 'b1', 'bash', '7 passed'), start(4, 'r1', 'read'), end(5, 'r1', 'read', 'FILE_BODY_PRIVATE_TO_AUTHOR'), start(6, 'b2', 'bash', { command: 'printenv' }), end(7, 'b2', 'bash', 'PRIVATE_ENV_SENTINEL')]
  const result = turnEvidence(events, target, { protectInputs: true })
  assert.equal(result.quotes.length, 1)
  assert.equal(result.quotes[0].text, '7 passed')
  assert.equal(result.withheld, true)
  assert.ok(!JSON.stringify(result).includes('FILE_BODY_PRIVATE_TO_AUTHOR'))
  assert.ok(!JSON.stringify(result).includes('PRIVATE_ENV_SENTINEL'))
})
test('ordinary PTC wrapper output is not a privacy incident, but sensitive output still is', () => {
  const result = text => ({ seq: 4, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'outer', content: [{ type: 'text', text }] }] } } })
  const events = [turn, wrapper, start(2, 'r1', 'read'), end(3, 'r1', 'read', 'ordinary file')]
  const normal = turnEvidence([...events, result('ordinary wrapper output')], target, { protectInputs: true })
  assert.equal(normal.withheld, false)
  assert.equal(normal.quotes.length, 0)
  assert.ok(!normal.tools.includes('ordinary wrapper output'))
  assert.equal(turnEvidence([...events, result('API_KEY="FAKE_CREDENTIAL_123"')], target, { protectInputs: true }).withheld, true)
})
test('sensitive-input rejections do not spend consultation quota', () => {
  const events = [turn, start(1, 'a1', 'ask_advisor'), end(2, 'a1', 'ask_advisor', 'Error: 咨询输入含疑似凭据，未发送给顾问', true)]
  assert.equal(gateFacts({ session: { snapshotEvents: () => events } }).settledThisTurn, 0)
})
test('the review observer excludes the outer run_code transport and narrates nested source calls', async () => {
  const events = [
    turn,
    wrapper,
    start(2, 'r1', 'read', { file_path: '/project/a.js' }),
    end(3, 'r1', 'read', '{"evidence_refs":["e1"]}'),
    start(4, 'g1', 'grep', { pattern: 'needle' }),
    end(5, 'g1', 'grep', '{"evidence_refs":["e2"]}'),
  ]
  const agents = { get: () => ({ session: { snapshotEvents: () => events } }) }
  const observer = createReviewObserver({ agents, runId: 'child', intervalMs: 5 })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(observer.calls(), 2, 'nested source dispatches count; run_code does not')
  assert.equal(observer.action().kind, 'thinking')
  assert.equal(observer.action().last.name, 'grep')
  assert.equal(observer.action().last.target, 'needle')
  assert.equal(observer.stop(), 2)
})
test('an outer transport call alone is not a source action', async () => {
  const events = [turn, wrapper]
  const agents = { get: () => ({ session: { snapshotEvents: () => events } }) }
  const observer = createReviewObserver({ agents, runId: 'child', intervalMs: 5 })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(observer.stop(), 0)
  assert.deepEqual(observer.action(), { kind: 'thinking' })
})
