// Host-side resource RPC tests: readReview/readEvidence/readAdvice over the
// REAL record-store with a temporary DSH_HOME. No filesystem mocks: valid
// fixtures go through the production store (persistReview/persistAdvice), and
// corruption/privacy cases are seeded through the store's documented on-disk
// envelope so the RPC read path is exercised exactly as production sees it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  AdvisorReviewService,
  Config,
  persistAdvice,
  persistReview,
} from '../index.js'
import { createEvidenceLedger } from '../review-evidence.js'
import { RECORD_SCHEMA_VERSION, recordRoot, writeRecord } from '../record-store.js'

const previousHome = process.env.DSH_HOME
const home = await mkdtemp(join(tmpdir(), 'ciel-resource-rpc-'))
process.env.DSH_HOME = home
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

const ctx = new Context()
const service = new AdvisorReviewService(ctx, new Set(), () => Config({}), new Set(), {})

const sha = (text) => createHash('sha256').update(text).digest('hex')
const hashName = (id) => createHash('sha256').update(id, 'utf8').digest('base64url') + '.json'
const recordFile = (kind, sessionId, id) => join(recordRoot(), kind, sessionId, hashName(id))
const SECRET = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2'

const sourceRecord = (id, content, extra = {}) => ({
  id,
  kind: 'source',
  origin: 'review-tool',
  tool: 'read',
  path: '/project/a.js',
  startLine: 1,
  endLine: 1,
  content,
  contentSha256: sha(content),
  status: 'available',
  ...extra,
})

/** Commit a review + its evidence through the production write path. */
async function commitReview(sessionId, reviewId, evidenceRecords = [], extra = {}) {
  await persistReview(sessionId, {
    reviewId,
    evidenceRecords,
    verdict: 'pass',
    annotations: [],
    createdAt: 1,
    ...extra,
  })
}

/** Seed a crafted review + evidence archive that persistReview would reject. */
async function seedCrafted(sessionId, reviewId, records, reviewExtra = {}) {
  await writeRecord('reviews', sessionId, reviewId, {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sessionId,
    reviewId,
    evidenceIds: records.map((record) => record.id),
    annotations: [],
    verdict: 'pass',
    createdAt: 1,
    ...reviewExtra,
  })
  await writeRecord('evidence', sessionId, reviewId, { reviewId, records })
}

// ── readReview ───────────────────────────────────────────────────────────

test('readReview returns the committed schema-v1 review and refuses foreign identities', async () => {
  const sid = 'rpc-review'
  await commitReview(sid, 'r1')
  const result = await service.readReview({ sessionId: sid, reviewId: 'r1' })
  assert.equal(result.ok, true)
  assert.equal(result.review.schemaVersion, RECORD_SCHEMA_VERSION)
  assert.equal(result.review.sessionId, sid)
  assert.equal(result.review.reviewId, 'r1')
  assert.deepEqual(result.review.evidenceIds, [])
  assert.equal((await service.readReview({ sessionId: 'other-session', reviewId: 'r1' })).ok, false)
  assert.equal((await service.readReview({ sessionId: sid, reviewId: 'r2' })).ok, false)
  assert.equal((await service.readReview({})).ok, false)
})

test('readReview rejects a wrong schemaVersion and a cross-session payload', async () => {
  const sid = 'rpc-version'
  await writeRecord('reviews', sid, 'v2', { schemaVersion: 2, sessionId: sid, reviewId: 'v2' })
  const wrongVersion = await service.readReview({ sessionId: sid, reviewId: 'v2' })
  assert.equal(wrongVersion.ok, false)
  assert.equal(wrongVersion.error, '评审记录不存在或不属于此会话')
  await writeRecord('reviews', sid, 'foreign', { schemaVersion: RECORD_SCHEMA_VERSION, sessionId: 'other', reviewId: 'foreign' })
  const crossSession = await service.readReview({ sessionId: sid, reviewId: 'foreign' })
  assert.equal(crossSession.ok, false)
  assert.equal(crossSession.error, '评审记录不存在或不属于此会话')
})

test('readReview surfaces store corruption and invalid identities as explicit failures', async () => {
  const sid = 'rpc-corrupt'
  await commitReview(sid, 'ok')
  const invalid = await service.readReview({ sessionId: '../escape', reviewId: 'ok' })
  assert.equal(invalid.ok, false)
  assert.ok(invalid.error.includes('CIEL_RECORD_INVALID_SESSION'))
  await writeFile(recordFile('reviews', sid, 'ok'), '{"reviewId": "ok"')
  const corrupt = await service.readReview({ sessionId: sid, reviewId: 'ok' })
  assert.equal(corrupt.ok, false)
  assert.ok(corrupt.error.includes('CIEL_RECORD_CORRUPT'))
})

// ── readEvidence ─────────────────────────────────────────────────────────

test('readEvidence resolves only evidence committed by that review', async () => {
  const sid = 'rpc-evidence'
  const content = 'export const answer = 42\n'
  await commitReview(sid, 'r1', [sourceRecord('e1', content)])
  const result = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(result.ok, true)
  assert.equal(result.evidence.id, 'e1')
  assert.equal(result.evidence.content, content)
  assert.equal(result.evidence.contentSha256, sha(content))
  assert.equal(result.evidence.origin, 'review-tool')
  assert.equal((await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e2' })).ok, false)
  for (const bad of ['x1', 'e0', 'e01', '', 42, null, undefined]) {
    const invalid = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: bad })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error, '无效证据标识')
  }
})

test('readEvidence enforces review, archive and dedup ownership', async () => {
  const sid = 'rpc-own'
  await commitReview(sid, 'r1', [sourceRecord('e1', 'one')])
  const foreignSession = await service.readEvidence({ sessionId: 'other-session', reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(foreignSession.ok, false)
  assert.equal(foreignSession.error, '证据不属于此评审或未被最终结果引用')
  // The archive claims a different review: refuse, never read the current file.
  await writeRecord('evidence', sid, 'r1', { reviewId: 'r2', records: [sourceRecord('e1', 'one')] })
  const foreignArchive = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(foreignArchive.ok, false)
  assert.equal(foreignArchive.error, '历史证据片段不可用；不会改读当前文件')
  // An id present in the archive but not committed by the review is not adopted.
  await commitReview(sid, 'r3', [])
  await writeRecord('evidence', sid, 'r3', { reviewId: 'r3', records: [sourceRecord('e1', 'one')] })
  const uncommitted = await service.readEvidence({ sessionId: sid, reviewId: 'r3', evidenceId: 'e1' })
  assert.equal(uncommitted.ok, false)
  assert.equal(uncommitted.error, '证据不属于此评审或未被最终结果引用')
  // Duplicate ids are ambiguous, so the whole read fails closed.
  await seedCrafted(sid, 'r4', [sourceRecord('e1', 'one'), sourceRecord('e1', 'one')])
  const duplicate = await service.readEvidence({ sessionId: sid, reviewId: 'r4', evidenceId: 'e1' })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error, '历史证据片段不可用；不会改读当前文件')
})

test('readEvidence rejects a content fingerprint mismatch', async () => {
  const sid = 'rpc-fingerprint'
  await seedCrafted(sid, 'r1', [{ ...sourceRecord('e1', 'hello'), contentSha256: sha('different') }])
  const result = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(result.ok, false)
  assert.equal(result.error, '历史证据内容与记录指纹不一致')
  await seedCrafted(sid, 'r2', [{ id: 'e1', content: 123, contentSha256: sha('123') }])
  const nonString = await service.readEvidence({ sessionId: sid, reviewId: 'r2', evidenceId: 'e1' })
  assert.equal(nonString.ok, false)
  assert.equal(nonString.error, '历史证据内容与记录指纹不一致')
})

test('readEvidence withholds sensitive content and sensitive envelopes', async () => {
  const sid = 'rpc-sensitive'
  await seedCrafted(sid, 'r1', [sourceRecord('e1', 'token: ' + SECRET)])
  const contentSensitive = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(contentSensitive.ok, false)
  assert.equal(contentSensitive.error, '历史证据因隐私检查未提供')
  assert.equal('evidence' in contentSensitive, false)
  await seedCrafted(sid, 'r2', [sourceRecord('e1', 'harmless', { note: SECRET })])
  const envelopeSensitive = await service.readEvidence({ sessionId: sid, reviewId: 'r2', evidenceId: 'e1' })
  assert.equal(envelopeSensitive.ok, false)
  assert.equal(envelopeSensitive.error, '历史证据因隐私检查未提供')
})

test('reported author evidence is stored and served without its raw text', async () => {
  const sid = 'rpc-reported'
  const raw = 'AUTHOR_RAW_SENTINEL: the file has 42 lines'
  const ledger = createEvidenceLedger({ roots: [] })
  try {
    const id = ledger.provided(raw)
    assert.equal(typeof id, 'string')
    const records = ledger.selected([id])
    await commitReview(sid, 'r1', records)
    const result = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: id })
    assert.equal(result.ok, true)
    assert.equal(result.evidence.origin, 'author-tool')
    assert.equal(result.evidence.content, '')
    assert.equal(result.evidence.contentSha256, sha(''))
    assert.ok(result.evidence.note.includes('未另行归档'))
    assert.ok(!JSON.stringify(result.evidence).includes('AUTHOR_RAW_SENTINEL'))
  } finally {
    ledger.dispose()
  }
})

test('missing evidence never backfills the current file', async () => {
  const sid = 'rpc-missing'
  await writeRecord('reviews', sid, 'r1', {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sessionId: sid,
    reviewId: 'r1',
    evidenceIds: ['e1'],
    annotations: [],
    verdict: 'pass',
    createdAt: 1,
  })
  const missing = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, '历史证据片段不可用；不会改读当前文件')
  assert.equal('evidence' in missing, false)
  await writeRecord('evidence', sid, 'r1', { reviewId: 'r1', records: [sourceRecord('e2', 'CURRENT_FILE_SENTINEL')] })
  const gone = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(gone.ok, false)
  assert.equal(gone.error, '历史证据片段不可用；不会改读当前文件')
  assert.ok(!JSON.stringify(gone).includes('CURRENT_FILE_SENTINEL'))
})

test('readEvidence surfaces a corrupt archive as an explicit failure', async () => {
  const sid = 'rpc-evidence-corrupt'
  await commitReview(sid, 'r1', [sourceRecord('e1', 'one')])
  await writeFile(recordFile('evidence', sid, 'r1'), '{"reviewId": "r1"')
  const result = await service.readEvidence({ sessionId: sid, reviewId: 'r1', evidenceId: 'e1' })
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('CIEL_RECORD_CORRUPT'))
})

// ── advice ───────────────────────────────────────────────────────────────

test('persistAdvice persists by kind:callId and readAdvice enforces ownership', async () => {
  const sid = 'rpc-advice'
  const toolText = '## [high] tool idea\nframing: f1\npitfalls: p1\nverification_target: v1'
  const commandText = '## [mid] command idea\nframing: f2\npitfalls: p2\nverification_target: v2'
  await persistAdvice(sid, 'tool', 'call-1', toolText, { requested: { provider: 'p', model: 'm' }, used: [] })
  await persistAdvice(sid, 'command', 'call-1', commandText, { used: [] })
  const tool = await service.readAdvice({ sessionId: sid, callId: 'tool:call-1' })
  assert.equal(tool.ok, true)
  assert.equal(tool.advice.callId, 'tool:call-1')
  assert.equal(tool.advice.kind, 'tool')
  assert.equal(tool.advice.text, toolText)
  assert.equal(tool.advice.items[0].tier, 'high')
  assert.equal(tool.advice.items[0].verificationTarget, 'v1')
  const command = await service.readAdvice({ sessionId: sid, callId: 'command:call-1' })
  assert.equal(command.ok, true)
  assert.equal(command.advice.text, commandText)
  assert.equal((await service.readAdvice({ sessionId: sid, callId: 'call-1' })).ok, false)
  assert.equal((await service.readAdvice({ sessionId: 'other-session', callId: 'tool:call-1' })).ok, false)
  await writeRecord('advice', sid, 'tool:foreign', { sessionId: 'other', callId: 'tool:foreign', kind: 'tool', text: 'x', createdAt: 1 })
  const foreign = await service.readAdvice({ sessionId: sid, callId: 'tool:foreign' })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.error, '顾问记录不存在或不属于此会话')
})

test('persistAdvice and readAdvice withhold sensitive advice and surface corruption', async () => {
  const sid = 'rpc-advice-sensitive'
  await assert.rejects(
    persistAdvice(sid, 'tool', 'call-1', 'key: ' + SECRET, { used: [] }),
    (error) => String(error.message).includes('敏感'),
  )
  await writeRecord('advice', sid, 'tool:secret', {
    sessionId: sid,
    callId: 'tool:secret',
    kind: 'tool',
    text: 'key: ' + SECRET,
    createdAt: 1,
  })
  const sensitive = await service.readAdvice({ sessionId: sid, callId: 'tool:secret' })
  assert.equal(sensitive.ok, false)
  assert.equal(sensitive.error, '顾问记录因隐私检查未提供')
  await writeFile(recordFile('advice', sid, 'tool:secret'), '{"torn"')
  const corrupt = await service.readAdvice({ sessionId: sid, callId: 'tool:secret' })
  assert.equal(corrupt.ok, false)
  assert.ok(corrupt.error.includes('CIEL_RECORD_CORRUPT'))
})
