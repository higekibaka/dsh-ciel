import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createModelUsage, captureModelUsage, modelUsageSnapshot,
  persistCallModelUsage, readCallModelUsage,
} from '../index.js'
import { recordRoot } from '../record-store.js'

const previousHome = process.env.DSH_HOME
const home = await mkdtemp(join(tmpdir(), 'ciel-model-usage-'))
process.env.DSH_HOME = home
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})
const sourceEvent = (provider, model) => ({ type: 'assistant/message', data: { message: { source: { kind: 'model', provider, model }, content: [] } } })
const runWith = (events) => ({ localAgent: { session: { snapshotEvents: () => events } } })
const callRecordFile = (sessionId, kind, id) =>
  join(recordRoot(), 'calls', sessionId, createHash('sha256').update(kind + ':' + id, 'utf8').digest('base64url') + '.json')

test('requested route is not proof of model execution', () => {
  const usage = createModelUsage('requested-provider', 'requested-model')
  assert.deepEqual(captureModelUsage(usage, {}), { requested: { provider: 'requested-provider', model: 'requested-model' }, used: [] })
  const onlyContext = runWith([{ type: 'request/context', data: { provider: 'requested-provider', model: 'requested-model' } }])
  assert.deepEqual(captureModelUsage(usage, onlyContext).used, [])
})

test('actual response sources are collected across stages without replacing requested provenance', () => {
  const usage = createModelUsage('alias', 'chosen')
  const events = [sourceEvent('actual-a', 'model-a'), sourceEvent('actual-a', 'model-a')]
  captureModelUsage(usage, runWith(events))
  captureModelUsage(usage, runWith([sourceEvent('actual-b', 'model-b')]))
  const saved = modelUsageSnapshot(usage)
  assert.deepEqual(saved, { requested: { provider: 'alias', model: 'chosen' }, used: [{ provider: 'actual-a', model: 'model-a' }, { provider: 'actual-b', model: 'model-b' }] })
  events[0].data.message.source.model = 'changed-afterward'
  usage.requested.model = 'settings-changed-later'
  assert.equal(saved.requested.model, 'chosen')
  assert.equal(saved.used[0].model, 'model-a')
})

test('unrelated or malformed source data cannot manufacture a model badge', () => {
  const usage = createModelUsage('provider', 'model')
  const fake = sourceEvent('not-a-model', 'nope'); fake.data.message.source.kind = 'user'
  captureModelUsage(usage, runWith([fake, sourceEvent('', 'x'), sourceEvent('provider\nsecret', 'x')]))
  assert.deepEqual(usage.used, [])
  assert.deepEqual(modelUsageSnapshot({ requested: {}, used: [{ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }] }), { used: [{ provider: 'a', model: 'b' }] })
})

test('tool identities retain requested-only failures and reject retired command usage', async () => {
  const usage = createModelUsage('provider-a', 'model-a')
  await persistCallModelUsage('session-test', 'tool', 'same-id', usage)
  assert.deepEqual((await readCallModelUsage('session-test', 'tool', 'same-id')).used, [])
  captureModelUsage(usage, runWith([sourceEvent('provider-b', 'model-b')]))
  assert.equal(await persistCallModelUsage('session-test', 'command', 'same-id', usage), false)
  assert.equal(await readCallModelUsage('session-test', 'command', 'same-id'), null)
  assert.equal(await readCallModelUsage('session-test', 'tool', 'legacy-id'), null)
  assert.equal(await readCallModelUsage('../escape', 'tool', 'same-id'), null)
  assert.equal(await persistCallModelUsage('session-test', 'invalid', 'id', usage), false)
})

test('latest same-key usage record wins atomically without a stale fallback', async () => {
  const usage = createModelUsage('p', 'm')
  await persistCallModelUsage('usage-tail', 'tool', 'id', usage)
  assert.deepEqual((await readCallModelUsage('usage-tail', 'tool', 'id')).used, [])
  captureModelUsage(usage, runWith([sourceEvent('actual', 'resolved')]))
  await persistCallModelUsage('usage-tail', 'tool', 'id', usage)
  assert.equal((await readCallModelUsage('usage-tail', 'tool', 'id')).used[0].model, 'resolved')
})

test('provenance read failure is not silently treated as a legacy missing record', async () => {
  await persistCallModelUsage('unreadable', 'tool', 'id', createModelUsage('p', 'm'))
  await writeFile(callRecordFile('unreadable', 'tool', 'id'), '{"torn"')
  await assert.rejects(readCallModelUsage('unreadable', 'tool', 'id'), (error) => error.code === 'CIEL_RECORD_CORRUPT')
})
