import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { createHash } from 'node:crypto'
import { detectSensitiveText } from './review-corpus.js'
import { RECORD_SCHEMA_VERSION } from './record-store.js'
import { listInbox, setInboxIntent } from './inbox-service.js'
import { ReviewCoordinator } from './review-coordinator.js'

/**
 * Mark one prototype method as a direct Remote endpoint without decorator
 * syntax: the Remote decorator only schedules an initializer through the
 * standard decorator context, so we synthesize that context, collect the
 * initializer, and the constructor runs it against the instance (it marks the
 * shared prototype — Map-keyed, idempotent across constructions).
 */
function remoteMarker(prototype, name) {
  let initializer
  Remote(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn) { initializer = fn },
  })
  return initializer
}

/**
 * The advisorReview Remote facade: review, records, draft and inbox endpoints, callable from
 * the browser card through the Typert gateway (strict descriptors registered
 * by apply below; the gateway resolves receiver contexts itself). The binding
 * comes from the TypertRemoteService base — the exact shape validateBinding
 * requires.
 */
export class AdvisorReviewService extends TypertRemoteService {
  /**
   * @param ctx - host context (agents/subagents are read lazily per call).
   * @param liveCriticChildren - shared set for the effort pin listener.
   * @param getConfig - thunk returning the LATEST resolved settings (the
   *   settings scope resyncs after construction, so capture the thunk, never
   *   a snapshot).
   */
  constructor(ctx, liveCriticChildren, getConfig, activeOperations = new Set(), isolation = {}) {
    super(ctx, 'advisorReview')
    this.getConfig = getConfig
    this.coordinator = new ReviewCoordinator(ctx, liveCriticChildren, getConfig, activeOperations, isolation)
    this.repository = this.coordinator.repository
    this.inboxOptions = isolation.inboxHome === undefined ? {} : { home: isolation.inboxHome }
    // Per-session dedup ledgers, each a Promise<Set> so concurrent first
    // touches share one WAL read and one Set instance.
    this.sentBySession = new Map()
    this.triageBySession = new Map()
    // SRC-fallback markers: let the gateway claim these endpoints even if the
    // strict descriptor registration lost a boot race.
    remoteMarker(Object.getPrototypeOf(this), 'list').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'start').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'feedback').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'prepareFeedback').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'triage').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'progress').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'cancel').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'callModelUsage').call(this)
    for (const method of ['readReview', 'readEvidence', 'readAdvice', 'inboxList', 'inboxSetIntent']) remoteMarker(Object.getPrototypeOf(this), method).call(this)
  }

  start(request) { return this.coordinator.start(request) }
  cancel(request) { return this.coordinator.cancel(request) }
  progress(request) { return this.coordinator.progress(request) }

  async readReview(request) {
    try {
      const { sessionId, reviewId } = request || {}
      const review = await this.repository.readRecord('reviews', sessionId, reviewId)
      if (!review || review.schemaVersion !== RECORD_SCHEMA_VERSION || review.sessionId !== sessionId || review.reviewId !== reviewId) return { ok: false, error: '评审记录不存在或不属于此会话' }
      const triage = (await this.repository.readFeedbackTriage(sessionId, [reviewId])).get(reviewId)
      return { ok: true, review: { ...review, triage: triage ? { states: Object.fromEntries(triage.states), filter: triage.filter } : { states: {} } } }
    } catch (error) { return { ok: false, error: '评审记录不可用：' + (error.code || '读取失败') } }
  }
  async readEvidence(request) {
    try {
      const { sessionId, reviewId, evidenceId } = request || {}
      if (typeof evidenceId !== 'string' || !/^[ea][1-9][0-9]*$/.test(evidenceId)) return { ok: false, error: '无效证据标识' }
      const result = await this.readReview({ sessionId, reviewId })
      if (!result.ok || !result.review.evidenceIds?.includes(evidenceId)) return { ok: false, error: '证据不属于此评审或未被最终结果引用' }
      const archive = await this.repository.readRecord('evidence', sessionId, reviewId)
      const found = archive?.reviewId === reviewId && archive.records?.filter(record => record.id === evidenceId)
      if (!found || found.length !== 1) return { ok: false, error: '历史证据片段不可用；不会改读当前文件' }
      const evidence = found[0]
      if (typeof evidence.content !== 'string' || createHash('sha256').update(evidence.content).digest('hex') !== evidence.contentSha256) return { ok: false, error: '历史证据内容与记录指纹不一致' }
      if (detectSensitiveText(evidence.content) || detectSensitiveText(JSON.stringify(evidence))) return { ok: false, error: '历史证据因隐私检查未提供' }
      return { ok: true, evidence }
    } catch (error) { return { ok: false, error: '历史证据不可用：' + (error.code || '读取失败') } }
  }
  /** 夏尔收件箱：一页评审（有界投影）+ 每项意向；不返回 raw、证据原文或源码。 */
  async inboxList(request) {
    return listInbox(request, this.inboxOptions)
  }

  /** 夏尔收件箱：按内容指纹 + revision CAS 设置单条批注意向；不写 feedback、不调用模型。 */
  async inboxSetIntent(request) {
    return setInboxIntent(request, this.inboxOptions)
  }

  async readAdvice(request) {
    try {
      const { sessionId, callId } = request || {}
      const advice = await this.repository.readRecord('advice', sessionId, callId)
      if (!advice || advice.sessionId !== sessionId || advice.callId !== callId) return { ok: false, error: '顾问记录不存在或不属于此会话' }
      if (detectSensitiveText(advice.text)) return { ok: false, error: '顾问记录因隐私检查未提供' }
      return { ok: true, advice }
    } catch (error) { return { ok: false, error: '顾问记录不可用：' + (error.code || '读取失败') } }
  }

  async callModelUsage(request) {
    try {
      return { modelUsage: await this.repository.readCallModelUsage(request?.sessionId, request?.kind, request?.id) }
    } catch {
      return { ok: false, error: 'model usage record unavailable' }
    }
  }

  /** The dedup ledger for one session, seeded from the WAL on first touch. */
  sentSet(sessionId) {
    const sid = String(sessionId || '')
    let pending = this.sentBySession.get(sid)
    if (pending === undefined) {
      pending = this.repository.readFeedbackKeys(sid).catch((error) => { if (this.sentBySession.get(sid) === pending) this.sentBySession.delete(sid); throw error })
      this.sentBySession.set(sid, pending)
    }
    return pending
  }

  /** The triage ledger for one session, seeded from the WAL on first touch. */
  triageSet(sessionId) {
    const sid = String(sessionId || '')
    let pending = this.triageBySession.get(sid)
    if (pending === undefined) {
      pending = this.repository.readFeedbackTriage(sid).catch((error) => { if (this.triageBySession.get(sid) === pending) this.triageBySession.delete(sid); throw error })
      this.triageBySession.set(sid, pending)
    }
    return pending
  }

  /** List every persisted review of one session (sidecar store — the session need not be live). */
  async list(request) {
    const sessionId = request?.sessionId
    const page = await this.repository.listRecordsPage('reviews', sessionId, { cursor: request?.cursor, limit: request?.limit })
    const entries = page.values
    if (entries.some(entry => !entry || entry.sessionId !== sessionId || typeof entry.reviewId !== 'string')) throw new Error('Invalid review record identity')
    const triage = await this.repository.readFeedbackTriage(sessionId, entries.map(entry => entry.reviewId))
    const triageOut = Object.fromEntries([...triage].map(([id, value]) => [id, { states: Object.fromEntries(value.states), ...(value.filter ? { filter: value.filter } : {}) }]))
    return { reviews: entries.map(entry => ({ ...entry, time: entry.createdAt })), sentKeys: [], triage: triageOut, nextCursor: page.nextCursor, limited: page.limited }
  }

  /**
   * Persist one triage batch from the card (0.12.0 ④): per-annotation
   * accept/dismiss and/or the review's filter, appended to the same feedback
   * WAL as the dedup keys. Last write wins by construction (read side is
   * last-wins), so replays and repaints stay idempotent in effect.
   */
  async triage(request) {
    const sessionId = request?.sessionId, reviewId = request?.reviewId
    const changes = Array.isArray(request?.changes) ? request.changes : []
    const filter = request?.filter
    if (typeof reviewId !== 'string' || reviewId === '' || changes.length > 8 || (filter !== undefined && !['all', 'blocker'].includes(filter))) return { ok: false, error: 'invalid review triage request' }
    const key = JSON.stringify([sessionId, reviewId])
    this.triageOperations ||= new Map()
    const pending = (this.triageOperations.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      try {
        const review = await this.repository.readRecord('reviews', sessionId, reviewId)
        if (!review || review.sessionId !== sessionId || review.reviewId !== reviewId || !Array.isArray(review.annotations)) return { ok: false, error: 'stored review not found' }
        if (changes.some(change => !change || !Number.isInteger(change.index) || change.index < 0 || change.index >= review.annotations.length || !['accept', 'dismiss'].includes(change.state))) return { ok: false, error: 'annotation index or state is invalid' }
        await this.repository.appendFeedback(sessionId, { triageBatch: { reviewId, changes, filter } })
        this.triageBySession.delete(sessionId)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '分诊保存失败：' + (error.code || error.message || 'unknown') }
      }
    })
    this.triageOperations.set(key, pending)
    return pending.finally(() => { if (this.triageOperations.get(key) === pending) this.triageOperations.delete(key) })
  }

  /** Compatibility tombstone: stale clients must NEVER dispatch a model turn. */
  async feedback() {
    return { ok: false, error: '自动回传已停用；请刷新页面，使用“填入输入框”后手动发送。' }
  }

  /** Prepare a draft from persisted annotations; no dispatch and no sent WAL. */
  async prepareFeedback(request) {
    try {
      if (this.getConfig().enabled === false) return { ok: false, error: 'Ciel disabled' }
      const sessionId = request && request.sessionId
      const reviewId = typeof request.reviewId === 'string' ? request.reviewId : ''
      const stored = await this.repository.readRecord('reviews', sessionId, reviewId)
      if (!stored || !Array.isArray(stored.annotations)) return { ok: false, error: 'stored review not found' }
      if (request.messageId && request.messageId !== stored.messageId) return { ok: false, error: 'review/message mismatch' }
      const indices = new Set((Array.isArray(request.items) ? request.items : []).map((item) => item?.index))
      const items = [...indices].filter((i) => Number.isInteger(i) && i >= 0 && i < stored.annotations.length)
        .map((index) => ({ ...stored.annotations[index], index }))
      if (items.length === 0) return { ok: false, error: 'no annotations selected' }
      const lines = [
        '[advisor:review-feedback] 请核对以下评审批注，只修复证据成立的问题；批注可能有误，不要照单全收：',
        '原消息: ' + stored.messageId + ' · 评审: ' + reviewId,
        '证据是批评者引用的发现，仍需核对与当前工作是否相符；不要因批注存在就盲目修改。',
      ]
      for (const item of items) {
        lines.push('')
        lines.push('### [' + (item.severity === 'blocker' ? 'blocker' : 'nit') + '] ' + String(item.title || '（无标题）'))
        if (item.block) lines.push('block: ' + String(item.block))
        if (item.anchor) lines.push('anchor: ' + String(item.anchor))
        if (item.evidence) lines.push('evidence: ' + String(item.evidence))
        if (item.comment) lines.push('comment: ' + String(item.comment))
      }
      return { ok: true, sessionId, reviewId, messageId: stored.messageId, text: lines.join('\n'), count: items.length }

    } catch (error) {
      return { ok: false, error: String(error && error.message || error) }
    }
  }
}
