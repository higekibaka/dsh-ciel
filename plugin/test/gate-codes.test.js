import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GATE_REJECTION_HEAD, createConsultationGate } from '../advisor-state.js'

/** Admission refusals: they teach a remedy and never spend the turn budget. */
const GATE_CODES = [
  'disabled',
  'guard_unavailable',
  'invalid_route',
  'empty_context',
  'sensitive_input',
  'telemetry_unavailable',
  'explore_first',
  'budget_exhausted',
  'followup_gap',
  'in_flight',
]

/** The heads old session logs actually contain; replay must not change meaning. */
const LEGACY_HEADS = [
  'context is required: pass the facts already established in the environment',
  'explore first: no non-advisor tool call has run in this session yet.',
  'follow-ups must be driven by NEW facts: run at least one independent step',
  'advisor budget for this planning phase is exhausted (3/3 consultations settled this turn).',
  'advisor consultation already in flight for this session',
  'advisor telemetry unavailable; refusing an unmetered consultation',
  'invalid advisor route: configure a valid provider and model',
  '咨询输入含疑似凭据，未发送给顾问',
  'Ciel disabled',
  'Ciel requires tools.guard() before model calls',
]

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const stateSource = readFileSync(new URL('../advisor-state.js', import.meta.url), 'utf8')
const shipped = indexSource + stateSource

test('every admission refusal opens with its stable machine prefix', () => {
  for (const code of GATE_CODES) {
    const head = '[ciel:gate:' + code + '] '
    assert.ok(GATE_REJECTION_HEAD.test(head + 'any remedy text'), code + ' matches bare')
    assert.ok(GATE_REJECTION_HEAD.test('Error: ' + head + 'any remedy text'), code + ' matches behind the host Error prefix')
  }
  assert.equal(GATE_REJECTION_HEAD.test('[ciel:gate:] no code'), false, 'a prefix without a code is not a gate rejection')
  assert.equal(GATE_REJECTION_HEAD.test('Error: [ciel:gate:Budget] not-a-code'), false, 'codes stay lower-case snake_case')
})

test('historical English and Chinese heads still replay as gate rejections', () => {
  for (const head of LEGACY_HEADS) {
    assert.ok(GATE_REJECTION_HEAD.test(head), head)
    assert.ok(GATE_REJECTION_HEAD.test('Error: ' + head), 'Error: ' + head)
  }
})

test('a real advisor execution failure is never mistaken for a gate rejection', () => {
  for (const head of [
    'provider failed',
    'advisor consultation ended with "error": upstream exploded',
    'The advisor returned an empty answer.',
    'subagents.startActivation did not return a caller result promise',
  ]) {
    assert.equal(GATE_REJECTION_HEAD.test(head), false, head)
  }
})

test('reservation refusals carry the machine prefix instead of bare prose', () => {
  const gate = createConsultationGate()
  const parent = {}
  const facts = { turnKey: 1, settledThisTurn: 0 }
  assert.throws(
    () => gate.reserve(parent, undefined, 1),
    (error) => error.message.startsWith('[ciel:gate:telemetry_unavailable] '),
  )
  const release = gate.reserve(parent, facts, 1)
  assert.throws(
    () => gate.reserve(parent, facts, 1),
    (error) => error.message.startsWith('[ciel:gate:in_flight] '),
  )
  release()
  assert.throws(
    () => gate.reserve(parent, facts, 1),
    (error) => error.message.startsWith('[ciel:gate:budget_exhausted] '),
  )
})

test('the shipped sources use exactly these codes and no misspelled variant', () => {
  const found = [...shipped.matchAll(/\[ciel:gate:([a-z0-9_]+)\]/g)].map((match) => match[1])
  assert.deepEqual([...new Set(found)].sort(), [...GATE_CODES].sort())
})

test('the sensitive-input refusal is protocol English and the Chinese throw is gone', () => {
  assert.match(
    indexSource,
    /\[ciel:gate:sensitive_input\] sensitive input blocked: the question or context looks like it carries a credential/,
  )
  assert.equal(indexSource.includes("throw new Error('咨询输入含疑似凭据"), false, 'no admission refusal is thrown in Chinese anymore')
})
