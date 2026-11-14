import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AdvisorService } from '../advisor-service.js'
import { parseAdvisorResult } from '../advisor-protocol.js'

const ADVICE = { sessionId: 's1', callId: 'tool:c1', kind: 'tool', createdAt: 1, text: 'Saved advice', items: [], issues: [] }
const CREDENTIAL_SHAPED = 'postgres://appuser:apppass@db.internal:5432/app'

function service(overrides = {}) {
  return new AdvisorService(new Context(), {
    async readRecord() { return null },
    async readCallModelUsage() { return null },
    ...overrides,
  })
}

function corrupt(code) {
  const error = new Error('synthetic failure')
  error.code = code
  return error
}

test('a missing or foreign record reports CIEL_ADVICE_NOT_FOUND', async () => {
  const missing = await service().readAdvice({ sessionId: 's1', callId: 'tool:c1' })
  assert.deepEqual(missing, { ok: false, code: 'CIEL_ADVICE_NOT_FOUND', error: '顾问记录不存在或不属于此会话' })
  const foreign = await service({ async readRecord() { return { ...ADVICE, sessionId: 'other' } } })
    .readAdvice({ sessionId: 's1', callId: 'tool:c1' })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.code, 'CIEL_ADVICE_NOT_FOUND', 'an identity mismatch is a miss, not a leak')
})

test('a credential-shaped record reports CIEL_ADVICE_SENSITIVE without echoing it', async () => {
  const result = await service({ async readRecord() { return { ...ADVICE, text: CREDENTIAL_SHAPED } } })
    .readAdvice({ sessionId: 's1', callId: 'tool:c1' })
  assert.deepEqual(result, { ok: false, code: 'CIEL_ADVICE_SENSITIVE', error: '顾问记录因隐私检查未提供' })
  assert.equal(JSON.stringify(result).includes('apppass'), false)
})

test('an unreadable record store reports CIEL_ADVICE_UNAVAILABLE and keeps the cause code', async () => {
  const result = await service({ async readRecord() { throw corrupt('CIEL_RECORD_CORRUPT') } })
    .readAdvice({ sessionId: 's1', callId: 'tool:c1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CIEL_ADVICE_UNAVAILABLE')
  assert.match(result.error, /^顾问记录不可用：CIEL_RECORD_CORRUPT$/)
})

test('a successful read keeps the established shape and adds no code', async () => {
  const result = await service({ async readRecord() { return ADVICE } }).readAdvice({ sessionId: 's1', callId: 'tool:c1' })
  assert.deepEqual(result, { ok: true, advice: ADVICE })
  assert.equal('code' in result, false)
})

test('model usage failures report CIEL_USAGE_UNAVAILABLE while reads keep their own shape', async () => {
  const failed = await service({ async readCallModelUsage() { throw corrupt('CIEL_RECORD_CORRUPT') } })
    .callModelUsage({ sessionId: 's1', kind: 'tool', id: 'c1' })
  assert.deepEqual(failed, { ok: false, code: 'CIEL_USAGE_UNAVAILABLE', error: 'model usage record unavailable' })
  const recorded = { requested: { provider: 'p', model: 'm' }, used: [{ provider: 'p', model: 'm' }] }
  const read = await service({ async readCallModelUsage() { return recorded } })
    .callModelUsage({ sessionId: 's1', kind: 'tool', id: 'c1' })
  assert.deepEqual(read, { modelUsage: recorded })
})

test('every service failure stays acceptable to the published protocol', async () => {
  const results = [
    await service().readAdvice({ sessionId: 's1', callId: 'tool:c1' }),
    await service({ async readRecord() { return { ...ADVICE, text: CREDENTIAL_SHAPED } } }).readAdvice({ sessionId: 's1', callId: 'tool:c1' }),
    await service({ async readRecord() { throw corrupt('CIEL_RECORD_CORRUPT') } }).readAdvice({ sessionId: 's1', callId: 'tool:c1' }),
    await service({ async readCallModelUsage() { throw corrupt('CIEL_RECORD_CORRUPT') } }).callModelUsage({ sessionId: 's1', kind: 'tool', id: 'c1' }),
  ]
  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(typeof result.code, 'string')
    parseAdvisorResult('readAdvice', result)
    parseAdvisorResult('callModelUsage', result)
  }
  assert.deepEqual(results.map((result) => result.code), [
    'CIEL_ADVICE_NOT_FOUND',
    'CIEL_ADVICE_SENSITIVE',
    'CIEL_ADVICE_UNAVAILABLE',
    'CIEL_USAGE_UNAVAILABLE',
  ])
})
