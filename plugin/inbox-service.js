/**
 * Ciel inbox service — the review-intent sidecar behind the sidebar 收件箱
 * (RPC namespace `advisorReview`, methods `inboxList` / `inboxSetIntent`).
 *
 * Design posture:
 *   - The service READS the existing per-review records (kind `reviews`) and
 *     returns a bounded projection. It never copies review bodies, evidence
 *     text, source code, prompts or model output anywhere.
 *   - Per-annotation intents live in their own small record kind (`inbox`),
 *     one record per review: { reviewId, reviewFingerprint, revision, intents,
 *     updatedAt }. It deliberately does NOT reuse the legacy `feedback`
 *     accept/dismiss WAL and never reads it.
 *   - `reviewFingerprint` is a deterministic digest of the stored review value.
 *     A write must present the CURRENT fingerprint. A stored intent set bound
 *     to a DIFFERENT fingerprint is an explicit `fingerprint_mismatch` on both
 *     read and write — never a silent reset to all-pending. The first version
 *     has no implicit re-base; recovery would be a separate explicit reset.
 *   - `revision` is a per-review compare-and-swap counter. Same-review writes
 *     are serialized through a module-level queue so concurrent callers that
 *     present the same expectedRevision cannot both win — including across
 *     separate service instances in one process.
 *   - No model calls, no tool calls, no draft mutation. Every failure is an
 *     explicit `{ ok:false, code, error }` with a body-free message.
 *
 * `options.home` is the test-only store injection (same contract as
 * record-store); production callers omit it. `options.writeRecord` is a
 * test-only write seam used to exercise the write-failure path deterministically.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RecordStoreError, listRecordEntriesPage, readRecord, writeRecord } from './record-store.js'

/** The only legal per-annotation intents. pending is the implicit default. */
export const INBOX_INTENTS = Object.freeze(['pending', 'planned', 'rejected'])

/** Page sizing: the inbox default and hard maximum are the same 25. */
export const INBOX_PAGE_DEFAULT_LIMIT = 25
export const INBOX_PAGE_MAX_LIMIT = 25

/** Bounded projections: no field may echo an unbounded stored string. */
export const INBOX_SUMMARY_MAX = 600
export const INBOX_ERROR_MAX = 500
export const INBOX_TITLE_MAX = 200
export const INBOX_ANCHOR_MAX = 400
export const INBOX_COMMENT_MAX = 1200
export const INBOX_MAX_EVIDENCE_IDS = 16
export const INBOX_MAX_ANNOTATIONS = 64

/** Evidence ids are host-issued references (eN independent, aN author), never body text. */
const EVIDENCE_ID_PATTERN = /^[ea][1-9][0-9]*$/
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const FINGERPRINT_DOMAIN = 'ciel-inbox-review-v1\n'
const INDEX_KEY_PATTERN = /^(0|[1-9][0-9]*)$/

/** Stable machine codes and their bounded, body-free messages. */
const MESSAGES = Object.freeze({
  invalid_request: '收件箱请求格式无效',
  invalid_session: '会话标识无效',
  invalid_limit: '分页大小必须是 1 到 25 之间的整数',
  invalid_cursor: '分页游标无效',
  invalid_review_id: '评审标识无效',
  invalid_fingerprint: '评审内容指纹无效',
  invalid_revision: '期望版本无效',
  invalid_index: '批注序号无效',
  invalid_intent: '意向取值无效',
  review_not_found: '评审记录不存在或不属于此会话',
  review_identity: '评审记录身份与请求不一致',
  fingerprint_mismatch: '评审内容已变化，内容指纹不匹配；请刷新后重试',
  revision_conflict: '评审意向已被其他操作更新；请刷新后重试',
  revision_exhausted: '评审意向版本已达安全上限，无法继续递增',
  record_corrupt: '收件箱或评审记录损坏、身份不符或状态失配；未作降级处理',
  write_failed: '收件箱写入失败；状态未更新',
  store_error: '记录存储不可用',
})

const STORE_CODES = Object.freeze({
  CIEL_RECORD_INVALID_SESSION: 'invalid_session',
  CIEL_RECORD_INVALID_LIMIT: 'invalid_limit',
  CIEL_RECORD_INVALID_CURSOR: 'invalid_cursor',
  CIEL_RECORD_INVALID_HOME: 'store_error',
  CIEL_RECORD_INVALID_KIND: 'store_error',
  CIEL_RECORD_INVALID_ID: 'invalid_review_id',
  CIEL_RECORD_INVALID_VALUE: 'store_error',
  CIEL_RECORD_CORRUPT: 'record_corrupt',
  CIEL_RECORD_VERSION: 'record_corrupt',
  CIEL_RECORD_IDENTITY: 'record_corrupt',
  CIEL_RECORD_CHANGED: 'record_corrupt',
  CIEL_RECORD_TOO_LARGE: 'record_corrupt',
  CIEL_RECORD_ENUM_LIMIT: 'store_error',
  CIEL_RECORD_UNSAFE_PATH: 'store_error',
  CIEL_RECORD_LIST_LIMIT: 'store_error',
  CIEL_RECORD_LIST_BYTES: 'store_error',
})

/** An explicit, body-free contract failure. */
class InboxError extends Error {
  constructor(code) {
    const message = MESSAGES[code] || MESSAGES.store_error
    super(message)
    this.name = 'InboxError'
    this.code = code
    this.stack = 'InboxError: ' + message
  }
}

function fail(code) {
  throw new InboxError(code)
}

function failure(error, forcedCode) {
  let code = forcedCode
  if (code === undefined) {
    if (error instanceof RecordStoreError) code = STORE_CODES[error.code] || 'store_error'
    else if (error instanceof Error && typeof error.code === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, error.code)) code = error.code
    else code = 'store_error'
  }
  return { ok: false, code, error: MESSAGES[code] || MESSAGES.store_error }
}

function invalid(code) {
  return { ok: false, code, error: MESSAGES[code] }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deterministic JSON: keys sorted recursively so equal content always hashes equal. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',') + ']'
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}'
}

/**
 * Server-side deterministic content identity of one stored review value.
 * Any change to the review content (annotations included) changes the digest.
 */
export function reviewFingerprint(review) {
  return createHash('sha256').update(FINGERPRINT_DOMAIN + canonicalize(review), 'utf8').digest('hex')
}

function inboxLimit(limit) {
  if (limit === undefined || limit === null) return INBOX_PAGE_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > INBOX_PAGE_MAX_LIMIT) fail('invalid_limit')
  return limit
}

function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function evidenceIdsOf(annotation) {
  if (!Array.isArray(annotation.evidenceRefs)) return []
  const ids = []
  for (const id of annotation.evidenceRefs) {
    if (typeof id !== 'string' || !EVIDENCE_ID_PATTERN.test(id) || ids.includes(id)) continue
    ids.push(id)
    if (ids.length >= INBOX_MAX_EVIDENCE_IDS) break
  }
  return ids
}

/** One annotation element must be an object with only string display fields. */
function assertAnnotationShape(annotation) {
  if (!isPlainObject(annotation)) fail('record_corrupt')
  for (const key of ['severity', 'title', 'anchor', 'comment']) {
    if (annotation[key] !== undefined && typeof annotation[key] !== 'string') fail('record_corrupt')
  }
}

/** The write and list paths share this exact element check, so neither can accept what the other rejects. */
function assertAnnotationsShape(annotations) {
  if (!Array.isArray(annotations)) fail('record_corrupt')
  if (annotations.length > INBOX_MAX_ANNOTATIONS) fail('record_corrupt')
  for (const annotation of annotations) assertAnnotationShape(annotation)
}

/** Reject a stored review whose value is not even the shape the record kind promises. */
function assertReviewValue(sessionId, value) {
  if (!isPlainObject(value)) fail('record_corrupt')
  if (value.sessionId !== sessionId) fail('review_identity')
  if (typeof value.reviewId !== 'string' || value.reviewId === '') fail('record_corrupt')
  if (typeof value.messageId !== 'string' || value.messageId === '') fail('record_corrupt')
  if (typeof value.status !== 'string' || value.status === '') fail('record_corrupt')
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) fail('record_corrupt')
  assertAnnotationsShape(value.annotations)
  for (const key of ['verdict', 'summary', 'error', 'coverage']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') fail('record_corrupt')
  }
  if (value.anchorSeq !== undefined && !Number.isInteger(value.anchorSeq)) fail('record_corrupt')
}

/**
 * Validate a stored inbox value regardless of whether its fingerprint still
 * matches. A corrupt or out-of-enum stored state is an explicit failure, never
 * silently downgraded to "all pending".
 */
function assertInboxValue(value, reviewId) {
  if (!isPlainObject(value)) fail('record_corrupt')
  if (value.reviewId !== reviewId) fail('record_corrupt')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) fail('record_corrupt')
  if (typeof value.reviewFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.reviewFingerprint)) fail('record_corrupt')
  if (!isPlainObject(value.intents)) fail('record_corrupt')
  const intents = {}
  for (const [key, intent] of Object.entries(value.intents)) {
    if (!INDEX_KEY_PATTERN.test(key)) fail('record_corrupt')
    const index = Number(key)
    if (!Number.isSafeInteger(index)) fail('record_corrupt')
    if (!INBOX_INTENTS.includes(intent)) fail('record_corrupt')
    if (intent !== 'pending') intents[index] = intent
  }
  return { revision: value.revision, reviewFingerprint: value.reviewFingerprint, intents }
}

/** Only a state bound to the CURRENT review may rely on its indices existing. */
function assertIntentIndices(intents, annotationCount) {
  for (const key of Object.keys(intents)) {
    if (Number(key) >= annotationCount) fail('record_corrupt')
  }
}

function projectAnnotation(annotation, index, intents) {
  assertAnnotationShape(annotation)
  const item = {
    index,
    severity: annotation.severity === 'blocker' ? 'blocker' : 'nit',
    title: boundedString(annotation.title, INBOX_TITLE_MAX),
    anchor: boundedString(annotation.anchor, INBOX_ANCHOR_MAX),
    comment: boundedString(annotation.comment, INBOX_COMMENT_MAX),
    intent: intents[index] || 'pending',
  }
  const evidenceIds = evidenceIdsOf(annotation)
  if (evidenceIds.length > 0) item.evidenceIds = evidenceIds
  return item
}

/** Build one bounded list item; reads exactly one inbox record for the revision/intents. */
async function projectReview(sessionId, entry, options) {
  const value = entry.value
  assertReviewValue(sessionId, value)
  if (entry.id !== value.reviewId) fail('review_identity')
  const fingerprint = reviewFingerprint(value)
  const storedInbox = await readRecord('inbox', sessionId, value.reviewId, options)
  let revision = 0
  let intents = {}
  if (storedInbox !== null) {
    const stored = assertInboxValue(storedInbox, value.reviewId)
    // A stored intent set bound to a different review content is a visible
    // conflict, never a silent reset to all-pending.
    if (stored.reviewFingerprint !== fingerprint) fail('fingerprint_mismatch')
    assertIntentIndices(stored.intents, value.annotations.length)
    revision = stored.revision
    intents = stored.intents
  }
  const annotations = value.annotations.map((annotation, index) => projectAnnotation(annotation, index, intents))
  return {
    sessionId,
    reviewId: value.reviewId,
    messageId: value.messageId,
    ...(value.anchorSeq === undefined ? {} : { anchorSeq: value.anchorSeq }),
    createdAt: value.createdAt,
    status: value.status,
    ...(value.verdict === undefined ? {} : { verdict: value.verdict }),
    ...(value.summary === undefined || value.summary === '' ? {} : { summary: value.summary.slice(0, INBOX_SUMMARY_MAX) }),
    ...(value.error === undefined || value.error === '' ? {} : { error: value.error.slice(0, INBOX_ERROR_MAX) }),
    ...(value.coverage === undefined ? {} : { coverage: value.coverage }),
    reviewFingerprint: fingerprint,
    revision,
    annotations,
  }
}

/**
 * One page of the session inbox, ordered by the stable hashed review filename.
 *
 * @param {{ sessionId?: string, cursor?: string|null, limit?: number }} request
 * @param {{ home?: string }} [options] test-only home injection
 * @returns {Promise<{ ok: true, sessionId: string, reviews: unknown[], nextCursor: string|null, limited: boolean } | { ok: false, code: string, error: string }>}
 */
export async function listInbox(request, options = {}) {
  try {
    const sessionId = request?.sessionId
    const limit = inboxLimit(request?.limit)
    const page = await listRecordEntriesPage('reviews', sessionId, { ...options, cursor: request?.cursor, limit })
    const reviews = []
    // Sequential on purpose: a corrupt page fails the whole request explicitly
    // rather than racing to a partial list.
    for (const entry of page.entries) reviews.push(await projectReview(sessionId, entry, options))
    return { ok: true, sessionId, reviews, nextCursor: page.nextCursor, limited: page.limited }
  } catch (error) {
    return failure(error)
  }
}

const inboxWrites = new Map()

function queueKey(sessionId, reviewId, options) {
  const home = options && options.home !== undefined
    ? String(options.home)
    : (process.env.DSH_HOME || join(homedir(), '.dsh'))
  return home + '\u0000' + String(sessionId) + '\u0000' + reviewId
}

/** Serialize same-review read-modify-write, module-wide (so instances share it). */
function withQueue(key, task) {
  const previous = inboxWrites.get(key) || Promise.resolve()
  const pending = previous.catch(() => {}).then(task)
  inboxWrites.set(key, pending)
  return pending.finally(() => {
    if (inboxWrites.get(key) === pending) inboxWrites.delete(key)
  })
}

/**
 * Compare-and-swap one annotation intent for one review.
 *
 * @param {{ sessionId?: string, reviewId?: string, reviewFingerprint?: string, expectedRevision?: number, index?: number, intent?: string }} request
 * @param {{ home?: string, writeRecord?: Function }} [options] test-only injection
 * @returns {Promise<{ ok: true, sessionId: string, reviewId: string, reviewFingerprint: string, revision: number, intents: Record<string, string> } | { ok: false, code: string, error: string }>}
 */
export async function setInboxIntent(request, options = {}) {
  try {
    const sessionId = request?.sessionId
    const reviewId = request?.reviewId
    const fingerprint = request?.reviewFingerprint
    const expectedRevision = request?.expectedRevision
    const index = request?.index
    const intent = request?.intent
    if (typeof reviewId !== 'string' || reviewId === '' || reviewId.length > 512 || reviewId.includes('\u0000')) return invalid('invalid_review_id')
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) return invalid('invalid_fingerprint')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return invalid('invalid_revision')
    if (!Number.isSafeInteger(index) || index < 0 || index > INBOX_MAX_ANNOTATIONS) return invalid('invalid_index')
    if (!INBOX_INTENTS.includes(intent)) return invalid('invalid_intent')

    const write = typeof options.writeRecord === 'function' ? options.writeRecord : writeRecord
    const storeOptions = options.home === undefined ? {} : { home: options.home }

    return await withQueue(queueKey(sessionId, reviewId, options), async () => {
      const review = await readRecord('reviews', sessionId, reviewId, storeOptions)
      if (review === null) return invalid('review_not_found')
      assertReviewValue(sessionId, review)
      // readRecord already bound the envelope id to reviewId; the value must
      // agree, exactly as the list path checks entry.id against value.reviewId.
      if (review.reviewId !== reviewId) return invalid('review_identity')
      const currentFingerprint = reviewFingerprint(review)
      if (currentFingerprint !== fingerprint) return invalid('fingerprint_mismatch')
      if (index >= review.annotations.length) return invalid('invalid_index')

      const storedInbox = await readRecord('inbox', sessionId, reviewId, storeOptions)
      let baseRevision = 0
      let baseIntents = {}
      if (storedInbox !== null) {
        const stored = assertInboxValue(storedInbox, reviewId)
        // Stale state is refused explicitly; an implicit re-base would silently
        // discard the user's recorded intent, so the first version omits it.
        if (stored.reviewFingerprint !== currentFingerprint) return invalid('fingerprint_mismatch')
        assertIntentIndices(stored.intents, review.annotations.length)
        baseRevision = stored.revision
        baseIntents = { ...stored.intents }
      }
      if (expectedRevision !== baseRevision) return invalid('revision_conflict')
      if (!Number.isSafeInteger(baseRevision + 1)) return invalid('revision_exhausted')

      const nextIntents = { ...baseIntents }
      if (intent === 'pending') delete nextIntents[index]
      else nextIntents[index] = intent
      const revision = baseRevision + 1
      try {
        await write('inbox', sessionId, reviewId, {
          reviewId,
          reviewFingerprint: currentFingerprint,
          revision,
          intents: nextIntents,
          updatedAt: Date.now(),
        }, storeOptions)
      } catch (writeError) {
        return failure(writeError, 'write_failed')
      }
      return { ok: true, sessionId, reviewId, reviewFingerprint: currentFingerprint, revision, intents: nextIntents }
    })
  } catch (error) {
    return failure(error)
  }
}
