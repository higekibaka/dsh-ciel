import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as records from './record-store.js'
import { detectSensitiveText } from './review-corpus.js'
import { modelUsageSnapshot } from './model-usage.js'
import { parseAdvisorItems } from './review-content.js'
const { RECORD_SCHEMA_VERSION, recordRoot } = records
// Shared only within one Host. This is NOT a cross-process lock.
const feedbackWrites = new Map()

export function createReviewRepository({ store = records, home } = {}) {
  const options = home === undefined ? {} : { home }
  const readRecord = (kind, session, id, opts) => store.readRecord(kind, session, id, { ...options, ...opts })
  const writeRecord = (kind, session, id, value, opts) => store.writeRecord(kind, session, id, value, { ...options, ...opts })
  const listRecords = (kind, session) => store.listRecords(kind, session, options)
  const listRecordsPage = (kind, session, opts) => store.listRecordsPage(kind, session, { ...options, ...opts })
  /** New versioned records only. Legacy dsh-advisor JSONL is deliberately not read. */
  function reviewsPath(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return undefined
    return join(recordRoot(options.home), 'reviews', sessionId)
  }
  async function readReviews(sessionId) {
    if (!reviewsPath(sessionId)) return []
    const entries = await listRecords('reviews', sessionId)
    if (entries.some(entry => !entry || entry.sessionId !== sessionId || typeof entry.reviewId !== 'string')) throw new Error('Invalid review record identity')
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.reviewId.localeCompare(b.reviewId))
  }
  async function persistReview(sessionId, entry, operation) {
    if (!reviewsPath(sessionId)) throw new Error('unusable session id for review storage')
    const { evidenceRecords = [], ...summary } = entry
    if (detectSensitiveText(JSON.stringify(entry))) throw new Error('评审结果含疑似敏感内容，未保存')
    const evidenceIds = evidenceRecords.map(record => record.id)
    // The summary is the commit marker. Orphaned evidence cannot be addressed
    // through the RPC because readEvidence first validates the committed review.
    await writeRecord('evidence', sessionId, entry.reviewId, { reviewId: entry.reviewId, records: evidenceRecords })
    operation?.check()
    await writeRecord('reviews', sessionId, entry.reviewId, { ...summary, schemaVersion: RECORD_SCHEMA_VERSION, sessionId, evidenceIds }, { beforeCommit: operation ? () => operation.beginCommit() : undefined })
  }
  const callRecordId = (kind, id) => kind + ':' + id
  async function persistCallModelUsage(sessionId, kind, id, usage) {
    if (!reviewsPath(sessionId) || !['tool', 'command'].includes(kind) || typeof id !== 'string' || id === '') return false
    await writeRecord('calls', sessionId, callRecordId(kind, id), { kind, id, modelUsage: modelUsageSnapshot(usage), createdAt: Date.now() })
    return true
  }
  async function readCallModelUsage(sessionId, kind, id) {
    if (!reviewsPath(sessionId) || !['tool', 'command'].includes(kind) || typeof id !== 'string' || id === '') return null
    const record = await readRecord('calls', sessionId, callRecordId(kind, id))
    return record ? modelUsageSnapshot(record.modelUsage) : null
  }
  async function persistAdvice(sessionId, kind, id, text, usage, operation) {
    if (detectSensitiveText(text)) throw new Error('顾问输出含疑似敏感内容，未保存')
    const callId = callRecordId(kind, id)
    const parsed = parseAdvisorItems(text)
    await writeRecord('advice', sessionId, callId, { sessionId, callId, kind, text, ...parsed, modelUsage: modelUsageSnapshot(usage), createdAt: Date.now() }, { beforeCommit: operation ? () => operation.beginCommit() : undefined })
  }
  async function readFeedbackKeys(sessionId) {
    if (!reviewsPath(sessionId)) return new Set()
    const records = await listRecords('feedback', sessionId)
    return new Set(records.flatMap(record => Array.isArray(record?.keys) ? record.keys.filter(key => typeof key === 'string') : []))
  }
  async function readFeedbackTriage(sessionId, reviewIds) {
    const triage = new Map()
    if (!reviewsPath(sessionId)) return triage
    const records = Array.isArray(reviewIds)
      ? await Promise.all(reviewIds.map(id => readRecord('feedback', sessionId, 'review:' + id)))
      : await listRecords('feedback', sessionId)
    for (const record of records) {
      if (!record || typeof record.reviewId !== 'string' || !record.states || typeof record.states !== 'object') continue
      const states = new Map(Object.entries(record.states).filter(([index, state]) => Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < 8 && ['accept', 'dismiss'].includes(state)).map(([index, state]) => [Number(index), state]))
      triage.set(record.reviewId, { states, filter: ['all', 'blocker'].includes(record.filter) ? record.filter : undefined })
    }
    return triage
  }
  async function appendFeedback(sessionId, record) {
    const reviewId = record.triageBatch?.reviewId || record.triage?.reviewId || record.triageFilter?.reviewId
    if (!reviewId) return writeRecord('feedback', sessionId, 'keys:' + randomUUID(), record)
    const home = options.home || process.env.DSH_HOME || join(homedir(), '.dsh')
    const key = JSON.stringify([home, sessionId, reviewId]), id = 'review:' + reviewId
    const pending = (feedbackWrites.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const previous = await readRecord('feedback', sessionId, id, { home })
      const next = { reviewId, states: { ...previous?.states }, ...(previous?.filter ? { filter: previous.filter } : {}) }
      const changes = record.triageBatch?.changes || (record.triage ? [record.triage] : [])
      for (const change of changes) if (Number.isInteger(change.index) && change.index >= 0 && change.index < 8 && ['accept', 'dismiss'].includes(change.state)) next.states[change.index] = change.state
      const filter = record.triageBatch?.filter ?? record.triageFilter?.filter
      if (['all', 'blocker'].includes(filter)) next.filter = filter
      await writeRecord('feedback', sessionId, id, next, { home })
    })
    feedbackWrites.set(key, pending)
    return pending.finally(() => { if (feedbackWrites.get(key) === pending) feedbackWrites.delete(key) })
  }


  return { reviewsPath, readReviews, persistReview, persistCallModelUsage, readCallModelUsage, persistAdvice, readFeedbackKeys, readFeedbackTriage, appendFeedback, readRecord, listRecordsPage }
}

export const reviewRepository = createReviewRepository()
export const { reviewsPath, readReviews, persistReview, persistCallModelUsage, readCallModelUsage, persistAdvice, readFeedbackKeys, readFeedbackTriage, appendFeedback } = reviewRepository
