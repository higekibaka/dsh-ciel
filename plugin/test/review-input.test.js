import test from 'node:test'
import assert from 'node:assert/strict'
import { projectReviewRequest } from '../review-input.js'
import { gateFacts, reminderTextFor, turnEvidence } from '../index.js'

const turn = (seq, n) => ({ seq, type: 'turn/start', data: { turn: n } })
const human = (seq, text, source = { kind: 'user' }, id = 'human-' + seq) => ({ seq, type: 'user/message', data: { id, source, content: [{ type: 'text', text }] } })
const target = (seq, n) => ({ seq, type: 'assistant/message', data: { turn: n } })
const command = (seq, args) => ({ seq, type: 'command/run', data: { commandId: 'command-' + seq, name: 'advise', args, source: { kind: 'user' } } })
const legacy = (seq, question = 'Check boundary', answer = 'ADVISOR_OPINION') => human(seq,
  '[advisor:advise-result] 用户通过 /advise 命令向顾问模型发起咨询，结果如下' +
  '（用户已在卡片中看到同样的内容；请结合当前工作自行采纳或讨论，不必复述原文）：\n\n' +
  '问题：' + question + '\n\n顾问回答：\n' + answer, { kind: 'user' }, 'advise-old123')

test('only attributed human inputs before the target enter the request', () => {
  const events = [turn(0, 1), human(1, 'HUMAN'), human(2, 'RUNTIME', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }),
    human(3, 'GOAL_CONTINUATION', { kind: 'goal' }), human(4, 'OTHER_AGENT', { kind: 'subagent' }), human(10, 'FUTURE')]
  const before = JSON.stringify(events)
  assert.deepEqual(projectReviewRequest(events, target(9, 1)), { text: 'HUMAN', texts: ['HUMAN'], context: { mode: 'current-turn', limited: true, reasons: ['goal-unmatched'] } })
  assert.equal(JSON.stringify(events), before)
})
test('human quoting a plugin marker is still a human request', () => {
  const input = 'Explain [advisor:plan-reminder] and [advisor:advise-result] markers.'
  assert.equal(projectReviewRequest([turn(0, 1), human(1, input)], target(2, 1)).text, input)
  assert.ok(projectReviewRequest([turn(0, 1), { ...legacy(1), data: { ...legacy(1).data, id: 'normal-human-id' } }], target(2, 1)).text.includes('ADVISOR_OPINION'))
})
test('matching durable legacy command recovers human origin and question without its answer', () => {
  const events = [turn(0, 1), human(1, 'ORIGINAL_TASK'), command(3, ' Check boundary '), turn(4, 2), legacy(5)]
  const projected = projectReviewRequest(events, target(6, 2))
  assert.equal(projected.text, 'ORIGINAL_TASK\n---\nCheck boundary')
  assert.deepEqual(projected.context, { mode: 'legacy-command', limited: false })
  assert.ok(!JSON.stringify(projected).includes('ADVISOR_OPINION'))
  // command/done need not exist yet: the retired handler steered before saving.
})
test('unknown legacy steer fails closed without borrowing another human task', () => {
  const events = [turn(0, 1), human(1, 'UNRELATED'), command(3, 'different question'), turn(4, 2), legacy(5)]
  assert.deepEqual(projectReviewRequest(events, target(6, 2)).context, { mode: 'missing', limited: true, reasons: ['legacy-unmatched', 'missing-input'] })
  assert.equal(projectReviewRequest(events, target(6, 2)).text, '')
})
test('current human task wins over a late result from an earlier command', () => {
  const events = [turn(0, 1), human(1, 'OLD_TASK'), command(3, 'Check boundary'), turn(4, 2), human(5, 'NEW_TASK'), legacy(6)]
  assert.equal(projectReviewRequest(events, target(7, 2)).text, 'NEW_TASK')
})
test('request context does not reuse another session or later target state', () => {
  const a = [turn(0, 1), human(1, 'A'), command(2, 'Check boundary'), turn(3, 2), legacy(4)]
  assert.match(projectReviewRequest(a, target(5, 2)).text, /^A/)
  const b = [turn(0, 1), human(1, 'B')]
  assert.equal(projectReviewRequest(b, target(2, 1)).text, 'B')
  assert.equal(projectReviewRequest(a, target(2, 1)).text, 'A')
})
test('unknown source and plugin-only continuations are explicitly incomplete', () => {
  const event = human(2, 'UNATTRIBUTED'); delete event.data.source
  const result = projectReviewRequest([turn(0, 1), human(1, 'known'), event], target(3, 1))
  assert.equal(result.text, 'known'); assert.equal(result.context.limited, true)
  const continuation = [turn(0, 1), human(1, 'OLD'), turn(2, 2), human(3, 'summary', { kind: 'plugin', plugin: 'compact' })]
  assert.deepEqual(projectReviewRequest(continuation, target(4, 2)).context, { mode: 'missing', limited: true, reasons: ['missing-input'] })
})
test('bounded request retains recent instructions and privacy checks inspect before clipping', () => {
  const events = [turn(0, 1), ...Array.from({ length: 10 }, (_, n) => human(n + 1, 'instruction-' + n + ' '.repeat(500)))]
  const result = projectReviewRequest(events, target(12, 1))
  assert.ok(result.text.length <= 3000); assert.ok(result.text.includes('instruction-9')); assert.equal(result.context.limited, true)
  const secret = 'safe '.repeat(800) + 'API_KEY=FAKE_SECRET_TEST_VALUE_NOT_REAL'
  const projected = turnEvidence([turn(0, 1), human(1, secret)], target(2, 1), { protectInputs: true })
  assert.equal(projected.sensitiveInput, true)
  assert.ok(!projected.request.includes('FAKE_SECRET'))
})

const call = (seq, name, id = name + seq) => ({ seq, type: 'tool/call', data: { name, callId: id } })
const result = (seq, id, text, isError) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: id, isError, content: [{ type: 'text', text }] }] } } })
const current = () => ({ enabled: true, planReminderEnabled: true })
const agent = events => ({ session: { snapshotEvents: () => events } })
const reminder = events => reminderTextFor(agent(events), current)
test('a rejected attempt neither spends quota nor suppresses a planning reminder', () => {
  for (const rejection of ['context is required:', 'explore first:', '咨询输入含疑似凭据']) {
    const events = [turn(0, 1), call(1, 'ask_advisor', 'a'), result(2, 'a', 'Error: ' + rejection, true), call(3, 'todo_write')]
    assert.equal(gateFacts(agent(events)).settledThisTurn, 0)
    assert.match(reminder(events), /\[advisor:plan-reminder\]/)
  }
})
test('pending calls and accepted failures suppress repeat reminders; a later turn can remind', () => {
  const events = [turn(0, 1), call(1, 'todo_write'), call(2, 'ask_advisor', 'a')]
  assert.equal(gateFacts(agent(events)).pendingThisTurn, 1)
  assert.equal(reminder(events), '')
  events.push(result(3, 'a', 'advisor consultation ended with "error": provider failed', true))
  assert.equal(gateFacts(agent(events)).settledThisTurn, 1); assert.equal(reminder(events), '')
  events.push(turn(4, 2), call(5, 'todo_write'))
  assert.match(reminder(events), /\[advisor:plan-reminder\]/)
})
test('successful advisor prose cannot impersonate an admission rejection', () => {
  const events = [turn(0, 1), call(1, 'ask_advisor', 'a'), result(2, 'a', 'context is required: in the proposed API', false), call(3, 'todo_write')]
  assert.equal(gateFacts(agent(events)).settledThisTurn, 1); assert.equal(reminder(events), '')
})
test('only a durable native reminder snapshot spends the one-shot reminder', () => {
  const events = [turn(0, 1), human(1, '[advisor:plan-reminder]'), call(2, 'todo_write')]
  assert.ok(reminder(events))
  events.push(human(3, '[advisor:plan-reminder]', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'unrelated', text: '[advisor:plan-reminder]' }] }))
  assert.ok(reminder(events))
  events.push(human(4, '[advisor:plan-reminder]', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'advisor:plan-reminder', text: '[advisor:plan-reminder]' }] }))
  assert.equal(reminder(events), '')
  assert.equal(reminderTextFor(agent(events), () => ({ enabled: false, planReminderEnabled: true })), '')
})
test('PTC rejection has the same reminder and quota semantics as native execution', () => {
  const events = [turn(0, 1), { seq: 1, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'outer', subCallId: 'a', name: 'ask_advisor' } },
    { seq: 2, type: 'tool/ptc-dispatch', data: { parentCallId: 'outer', subCallId: 'a', name: 'ask_advisor', isError: true, content: [{ type: 'text', text: 'Error: context is required:' }] } },
    { seq: 3, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'outer', subCallId: 'plan', name: 'todo_write' } }]
  assert.equal(gateFacts(agent(events)).settledThisTurn, 0); assert.ok(reminder(events))
})

const goalChange = (seq, { id = 'g1', revision = 1, objective = 'Declared objective', operation = 'create', phase = 'active' } = {}) => ({
  seq, type: 'goal/change', data: { kind: 'goal/change', version: 1, operation,
    goal: { id, revision, objective, phase, maxGoalRounds: 10 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 },
})
const goalRound = (seq, { id = 'g1', revision = 1, round = 1 } = {}) => human(seq, 'GENERATED_GOAL_PROMPT', { kind: 'goal', goalId: id, revision, round })
function compact(events, shadowedSeqs) {
  const seq = events.at(-1).seq + 1, compactionId = 'compact-' + seq
  const start = shadowedSeqs[0], end = shadowedSeqs.at(-1)
  events.push({ seq, type: 'compaction/start', data: { compactionId } },
    { seq: seq + 1, type: 'compaction/summary', data: { compactionId, shadowedRange: { start, end }, shadowedSeqs } },
    { ...human(seq + 2, 'MODEL_SUMMARY_OPINION', { kind: 'plugin', plugin: 'compact', compactionId }),
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [seq, seq + 1, ...shadowedSeqs] })
  return seq + 2
}
test('nested verified compaction preserves exact human inputs without importing summaries', () => {
  const events = [turn(0, 1), human(1, 'TASK'), human(2, 'RUNTIME', { kind: 'plugin', plugin: 'runtime' })]
  const first = compact(events, [1, 2])
  events.push(human(first + 1, 'LATER_CONSTRAINT'))
  const second = compact(events, [first, first + 1])
  const result = projectReviewRequest(events, target(second + 1, 1))
  assert.equal(result.text, 'TASK\n---\nLATER_CONSTRAINT')
  assert.deepEqual(result.context, { mode: 'current-turn', limited: false })
})
test('PTC log-only results do not become surface nodes inside a compaction span', () => {
  const events = [turn(0, 1), human(1, 'TASK'), result(2, 'nested', 'PTC', false), human(3, 'ADDENDUM')]
  compact(events, [1, 3])
  assert.equal(projectReviewRequest(events, target(7, 1)).text, 'TASK\n---\nADDENDUM')
})
test('uncorrelated replacement revokes the old request even when its copied source claims user', () => {
  for (const source of [{ kind: 'user' }, { kind: 'plugin', plugin: 'compact', compactionId: 'unmatched' }]) {
    const events = [turn(0, 1), human(1, 'REVOKED'), { ...human(2, 'REPLACEMENT_OPINION', source), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] }]
    const result = projectReviewRequest(events, target(3, 1))
    assert.equal(result.text, '')
    assert.ok(result.context.reasons.includes('replaced-input'))
  }
})
test('compaction after an old draft cannot change that draft request', () => {
  const events = [turn(0, 1), human(1, 'ORIGINAL'), target(2, 1), turn(3, 2), human(4, 'FUTURE')]
  compact(events, [1, 2, 4])
  assert.deepEqual(projectReviewRequest(events, target(2, 1)).context, { mode: 'current-turn', limited: false })
  assert.equal(projectReviewRequest(events, target(2, 1)).text, 'ORIGINAL')
})
test('malformed replacement metadata refuses request recovery instead of reusing stale input', () => {
  const events = [turn(0, 1), human(1, 'OLD'), { ...human(2, 'REPLACEMENT'), surfaceOp: { op: 'replace', startSeq: 999, endSeq: 1 } }]
  const result = projectReviewRequest(events, target(3, 1))
  assert.equal(result.text, '')
  assert.ok(result.context.reasons.includes('invalid-history'))
})
test('a matching native goal round carries the original task and ordered human refinements', () => {
  const events = [turn(0, 1), human(1, 'TASK'), goalChange(2), turn(3, 2), human(4, 'REFINEMENT'), turn(5, 3), goalRound(6), human(7, 'STEERING')]
  const projected = projectReviewRequest(events, target(8, 3))
  assert.equal(projected.text, 'TASK\n---\nREFINEMENT\n---\nSTEERING')
  assert.deepEqual(projected.context, { mode: 'goal-continuation', limited: false })
  assert.ok(!JSON.stringify(projected).includes('Declared objective'))
  assert.ok(!JSON.stringify(projected).includes('GENERATED_GOAL_PROMPT'))
  // A human-led turn itself is not silently expanded into the active goal.
  assert.equal(projectReviewRequest(events, target(5, 2)).text, 'REFINEMENT')
})
test('goal task recovery survives nested compaction of its human origin', () => {
  const events = [turn(0, 1), human(1, 'TASK'), goalChange(2)]
  const checkpoint = compact(events, [1])
  events.push(turn(checkpoint + 1, 2), goalRound(checkpoint + 2))
  const result = projectReviewRequest(events, target(checkpoint + 3, 2))
  assert.equal(result.text, 'TASK'); assert.equal(result.context.limited, false)
})
test('goal revision, identity, phase and clear tombstones prevent unrelated task recovery', () => {
  for (const change of [goalChange(2, { revision: 2 }), goalChange(2, { id: 'other' }), goalChange(2, { phase: 'complete' }),
    { seq: 2, type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g1', revision: 2 } } }]) {
    const events = [turn(0, 1), human(1, 'UNRELATED'), change, turn(3, 2), goalRound(4)]
    const result = projectReviewRequest(events, target(5, 2))
    assert.equal(result.text, ''); assert.ok(result.context.reasons.includes('goal-unmatched'))
  }
})
test('changed objective needs a fresh human anchor while cap-only revisions keep the task', () => {
  const events = [turn(0, 1), human(1, 'OLD_TASK'), goalChange(2), goalChange(3, { operation: 'edit', revision: 2 }), turn(4, 2), goalRound(5, { revision: 2 })]
  assert.equal(projectReviewRequest(events, target(6, 2)).text, 'OLD_TASK')
  events[3] = goalChange(3, { operation: 'edit', revision: 2, objective: 'DIFFERENT_OBJECTIVE' })
  const missing = projectReviewRequest(events, target(6, 2))
  assert.equal(missing.text, ''); assert.ok(missing.context.reasons.includes('goal-origin-missing'))
  const freshEvents = [turn(0, 1), human(1, 'OLD_TASK'), goalChange(2), human(3, 'NEW_TASK'),
    goalChange(4, { operation: 'edit', revision: 2, objective: 'DIFFERENT_OBJECTIVE' }), turn(5, 2), goalRound(6, { revision: 2 })]
  const fresh = projectReviewRequest(freshEvents, target(7, 2))
  assert.equal(fresh.text, 'NEW_TASK'); assert.equal(fresh.context.limited, false)
})
test('a later goal or human task cannot leak into an earlier continuation draft', () => {
  const events = [turn(0, 1), human(1, 'FIRST'), goalChange(2), turn(3, 2), goalRound(4), target(5, 2), turn(6, 3), human(7, 'SECOND'), goalChange(8, { id: 'g2' }), turn(9, 4), goalRound(10, { id: 'g2' })]
  assert.equal(projectReviewRequest(events, target(5, 2)).text, 'FIRST')
  assert.equal(projectReviewRequest(events, target(11, 4)).text, 'SECOND')
})
test('resuming after human input during a pause preserves only known goal context and marks it partial', () => {
  const events = [turn(0, 1), human(1, 'TASK'), goalChange(2), goalChange(3, { operation: 'pause', revision: 2, phase: 'paused' }),
    turn(4, 2), human(5, 'UNLINKED_PAUSED_TASK'), goalChange(6, { operation: 'resume', revision: 3 }), turn(7, 3), goalRound(8, { revision: 3 })]
  const projected = projectReviewRequest(events, target(9, 3))
  assert.equal(projected.text, 'TASK')
  assert.ok(projected.context.reasons.includes('goal-origin-missing'))
})
test('ordinary plugin continuation and an unlinked human continue never borrow an old task', () => {
  const events = [turn(0, 1), human(1, 'UNRELATED'), turn(2, 2), human(3, 'continue')]
  assert.equal(projectReviewRequest(events, target(4, 2)).text, 'continue')
  events[3] = human(3, 'CONTINUE_INJECTION', { kind: 'plugin', plugin: 'fixture' })
  assert.equal(projectReviewRequest(events, target(4, 2)).text, '')
})
test('non-text input cannot silently claim a complete textual task review', () => {
  const image = human(1, 'Compare the attached image'); image.data.content.push({ type: 'image', url: 'fixture://image' })
  const projected = projectReviewRequest([turn(0, 1), image], target(2, 1))
  assert.equal(projected.text, 'Compare the attached image')
  assert.ok(projected.context.reasons.includes('non-text-input'))
})
