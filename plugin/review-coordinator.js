import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { reviewErrorDetails, reviewFailure, classifyReviewFailure } from './review-errors.js'
import { createReviewOperation } from './review-operation.js'
import { reviewMessageKey as reviewKey } from './review-identity.js'
import { requestContextNote } from './review-input.js'
import { createReviewCorpus, detectSensitiveText } from './review-corpus.js'
import { createRestrictedReviewProvider } from './review-runner.js'
import { createEvidenceLedger, evidenceCorpus, groundReview } from './review-evidence.js'
import { RECORD_SCHEMA_VERSION } from './record-store.js'
import { reviewRepository } from './review-repository.js'
import { createModelUsage, captureModelUsage, modelUsageSnapshot } from './model-usage.js'
import { draftText, sessionEvents, advisorTargets, splitMarkdownBlocks, turnEvidence, outputText, childErrorDetail, parseSuspectResponse, triageSuspects, createReviewObserver, parseCriticReview, reviewCoverage, criticExplorePersona, CRITIC_PROMPT_SUFFIX, CRITIC_PERSONA, RUBRIC_ADDENDUM, CRITIC_SUSPECT_PROMPT_SUFFIX, CRITIC_SUSPECT_PERSONA, CRITIC_VERIFY_PROMPT_SUFFIX, REVIEW_TOOL_DENIAL, REVIEW_SOURCE_TOOLS } from './review-content.js'

/**
 * Corpus-prep failures are surfaced as fixed text selected only by the module's
 * stable code+reason pair. The thrown message/stack and any host path never
 * reach the client. Anything unrecognized keeps the original generic fallback.
 */
const CORPUS_PREP_ERROR_FALLBACK = '无法安全准备评审资料区；请确认项目目录及隔离运行环境，没有启动模型或退回普通文件读取'
const CORPUS_PREP_ERROR_TEXT = Object.freeze({
  'CIEL_REVIEW_ACCESS_LIMITED/ROOT_TOO_BROAD': '评审目录范围过大（包含用户主目录或系统级目录）；请在具体项目目录新建会话，并检查额外评审目录配置后重试。没有启动模型或退回普通文件读取',
})
function corpusPrepErrorText(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  const reason = error !== null && typeof error === 'object' && typeof error.reason === 'string' ? error.reason : ''
  return CORPUS_PREP_ERROR_TEXT[code + '/' + reason] || CORPUS_PREP_ERROR_FALLBACK
}

// Stage failures carry only the already public diagnostic. Publication belongs
// to start's terminal handler, never to a phase or a parser.
class ReviewStageFailure extends Error {
  constructor(error, context = '') {
    const detail = reviewErrorDetails(error?.code)
    const message = detail?.error || String(error?.message || error)
    super(context ? context + ': ' + message : message)
    if (detail) Object.assign(this, { code: detail.code, retryable: detail.retryable, stage: error.stage })
  }
}
const fail = (error, context) => { throw error instanceof ReviewStageFailure ? error : new ReviewStageFailure(error, context) }

export class ReviewCoordinator {
  constructor(ctx, liveCriticChildren, getConfig, activeOperations = new Set(), isolation = {}) {
    this.ctx = ctx
    this.ownerCtx = ctx
    this.liveCriticChildren = liveCriticChildren
    this.getConfig = getConfig
    this.activeOperations = activeOperations
    this.inFlight = new Map()
    this.activeSessions = new Set()
    this.children = new Map()
    this.guardAvailable = false
    this.pendingReviewControls = new Map()
    this.backendPromise = null
    this.createCorpus = isolation.createCorpus || createReviewCorpus
    this.createProvider = isolation.createProvider || createRestrictedReviewProvider
    // 契约 v3 进展通道（轮询制）：messageId → 在途评审的实时探索计数。
    this.progressByMessage = new Map()
    this.repository = isolation.repository || reviewRepository
  }

  /** Register a Ciel-only provider; no unrestricted spawn fallback is permitted. */
  async ensureReviewBackend() {
    if (this.backendPromise) return this.backendPromise
    const pending = (async () => {
      const subagents = this.ownerCtx.get('subagents')
      if (!this.guardAvailable) throw reviewFailure('CIEL_REVIEW_GUARD_UNAVAILABLE', 'guard')
      if (!subagents) throw reviewFailure('CIEL_REVIEW_SERVICE_NOT_READY', 'provider')
      if (typeof subagents.registerProvider !== 'function') throw reviewFailure('CIEL_REVIEW_INTERFACE_MISMATCH', 'provider')
      const provider = await this.createProvider({
        claimControl: (request) => {
          const control = this.pendingReviewControls.get(request.label)
          if (!control || control.parent !== request.parent || control.abort.signal !== request.signal) return null
          control.operation.check()
          this.pendingReviewControls.delete(request.label)
          return control
        },
        bindControl: (control, child) => {
          if (!this.guardAvailable) throw reviewFailure('CIEL_REVIEW_GUARD_UNAVAILABLE', 'guard')
          if (!child?.id) throw reviewFailure('CIEL_REVIEW_INTERFACE_MISMATCH', 'create')
          control.operation.check()
          control.childId = child.id
          // Exact-object ownership: the private child registry gate requires
          // exec.agent === this reference, not just a matching id.
          control.child = child
          control.bound = true
          this.children.set(child.id, control)
          this.liveCriticChildren.add(child.id)
        },
        unbindControl: (control, id) => {
          control.bound = false
          control.child = undefined
          this.children.delete(id)
          this.liveCriticChildren.delete(id)
        },
      })
      if (!this.guardAvailable) throw reviewFailure('CIEL_REVIEW_GUARD_UNAVAILABLE', 'guard')
      const dispose = subagents.registerProvider(provider)
      this.ownerCtx.effect(() => () => {
        dispose()
        this.backendPromise = null
        for (const op of this.inFlight.values()) op.cancel('plugin stopped')
      }, 'Ciel: restricted review provider')
      return provider.name
    })()
    this.backendPromise = pending
    try { return await pending } catch (error) {
      if (this.backendPromise === pending) this.backendPromise = null
      throw classifyReviewFailure(error, 'CIEL_REVIEW_BACKEND_UNAVAILABLE', error?.stage || 'provider')
    }
  }

  /**
   * Runs synchronously before a tracked child's actual tool body. Fail-open for
   * agents this service does not track, so normal sessions keep working. A
   * private child-scoped registry MUST use the fail-closed control.guard
   * closure instead of this method.
   */
  guard(exec) {
    const c = this.children.get(exec.agent?.id)
    if (!c) return undefined
    try { c.operation.check() } catch (error) { return error.message }
    // The PTC transport is the only model-direct call that may execute and is
    // never a source query; a nested dispatch always carries the outer token.
    if (exec.name === 'run_code' && exec.parent === undefined) {
      if (!c.allowTools) {
        c.operation.cancel('unexpected tool in review: ' + exec.name)
        return REVIEW_TOOL_DENIAL
      }
      return undefined
    }
    if (!c.allowTools || !REVIEW_SOURCE_TOOLS.includes(exec.name)) {
      c.operation.cancel('unexpected tool in review: ' + exec.name)
      return REVIEW_TOOL_DENIAL
    }
    c.used += 1
    if (c.diagnostics) c.diagnostics.toolCalls = c.used
    return undefined
  }

  beforeRequest(id) {
    const c = this.children.get(id)
    if (!c) return
    if (this.getConfig().enabled === false) c.operation.cancel('Ciel disabled')
    c.operation.beforeRequest()
  }

  async cancel(request) {
    const operation = this.inFlight.get(reviewKey(request?.sessionId, request?.messageId))
    if (!operation) return { ok: true, cancelled: false }
    const cancelled = operation.cancel('review cancelled by user')
    return { ok: true, cancelled, phase: operation.phase() }
  }

  /**
   * 契约 v3 进展通道（0.13.0，轮询制）：评审在途期间客户端每 2s 拉一次，
   * 徽标从黑盒等待升级为「排查 k/预算」实时计数。设计权衡（2026-09-05
   * 实拍后修订）：agent-team 邮箱通道因上游 tryMembership 竞态（挂载
   * 即概率性打死所有一次性 spawn）且 spawnTeammate 不支持按次 pin
   * 路由，被轮询制取代——零实验依赖、路由 pin 完整保留；team 接线
   * 推迟到上游修复后，见 docs/iteration-critic-ux.md。
   */
  async progress(request) {
    const messageId = String(request && request.messageId || '')
    const p = this.progressByMessage.get(reviewKey(request?.sessionId, messageId))
    if (p === undefined) return { inFlight: false }
    const remainingMs = p.operation.remainingMs()
    return {
      inFlight: true,
      explore: p.explore,
      limitMode: 'time',
      timeoutSeconds: p.limits.timeoutSeconds,
      remainingMs,
      modelRequests: p.operation.requests(),
      ...(p.phase === undefined ? {} : { phase: p.phase }),
      ...(p.suspects === undefined ? {} : { suspects: p.suspects }),
      toolCalls: p.toolCalls(),
      action: typeof p.action === 'function' ? p.action() : { kind: 'thinking' },
      elapsedMs: p.limits.timeoutSeconds * 1000 - remainingMs,
    }
  }

  /** Run the critic over one assistant message and persist the review. */
  async start(request) {
    if (!request || typeof request.sessionId !== 'string' || typeof request.messageId !== 'string') return { ok: false, error: 'sessionId and messageId required' }
    const cfg = this.getConfig()
    const modelUsage = createModelUsage(cfg.criticProvider, cfg.criticModel)
    if (cfg.enabled === false) return { ok: false, error: 'Ciel disabled', modelUsage }
    if (!this.guardAvailable) return { ok: false, ...reviewErrorDetails('CIEL_REVIEW_GUARD_UNAVAILABLE') }
    const sessionId = request.sessionId
    const messageId = request.messageId
    const key = reviewKey(sessionId, messageId)
    const agents = this.ctx.get('agents')
    const subagents = this.ctx.get('subagents')
    if (agents === undefined || subagents === undefined) {
      return { ok: false, ...reviewErrorDetails('CIEL_REVIEW_SERVICE_NOT_READY') }
    }
    const agent = agents.get(sessionId)
    if (agent === undefined) return { ok: false, error: 'session is not live: ' + sessionId }
    const events = sessionEvents(agent.session)
    if (!Array.isArray(events)) return { ok: false, error: 'session events unreadable' }
    let target
    for (const event of events) {
      if (event && event.type === 'assistant/message' && event.data && event.data.message && event.data.message.id === messageId) {
        target = event
      }
    }
    if (target === undefined) return { ok: false, error: 'no assistant message with id ' + messageId }
    const draft = draftText(target)
    if (draft === '') return { ok: false, error: 'that message has no reviewable text' }
    if (this.activeSessions.has(sessionId)) return { ok: false, error: 'review already in flight for this session' }
    const timeoutMs = (cfg.criticTimeoutSeconds ?? 180) * 1000
    const limits = { mode: 'time', timeoutSeconds: timeoutMs / 1000 }
    const operation = createReviewOperation({ timeoutMs })
    this.inFlight.set(key, operation)
    this.activeSessions.add(sessionId)
    this.activeOperations.add(operation)
    const stageControls = new Map()
    let corpus
    let evidenceWithheld = false
    let dataLimited = false
    let requestContext = { mode: 'missing', limited: true }
    // Owned scalar telemetry survives child disposal; never persist queries,
    // file contents, reasoning or transient child sessions in an error record.
    const diagnostics = { phase: 0, toolCalls: 0, limitMode: 'time', timeoutMs }
    const reviewId = 'r-' + randomUUID()
    const receiptLedger = createEvidenceLedger({ roots: [
      { virtual: '/project', actual: agent.session?.header?.cwd },
      ...(cfg.criticAdditionalRoots || []).map((actual, i) => ({ virtual: '/external-' + (i + 1), actual })),
    ] })
    const publishFailure = async (error) => {
      const detail = reviewErrorDetails(error?.code)
      const message = detail?.error || String(error?.message || error)
      const publicError = message
      for (const control of stageControls.values()) captureModelUsage(modelUsage, control.run)
      this.ctx.logger?.warn('dsh-advisor: review.start failed: %s', publicError)
      const cancelled = operation.reason() === 'review cancelled by user' || operation.reason() === 'Ciel disabled' || operation.reason() === 'plugin stopped'
      const entry = { sessionId, reviewId, messageId, anchorSeq: target.seq, status: cancelled ? 'cancelled' : 'error', error: publicError, ...(detail ? { code: detail.code, retryable: detail.retryable, stage: error.stage } : {}), annotations: [], modelRequests: operation.requests(), modelUsage: modelUsageSnapshot(modelUsage), limits, diagnostics: { ...diagnostics }, createdAt: Date.now() }
      try { await this.repository.persistReview(sessionId, entry) } catch (e) { this.ctx.logger?.warn('dsh-advisor: review persist failed: %s', e && e.message) }
      return { ok: false, error: entry.error, ...(detail ? { code: detail.code, retryable: detail.retryable, stage: error.stage } : {}), review: entry }
    }
    try {
      const targets = advisorTargets(events, target)
      const draftBlocks = splitMarkdownBlocks(draft)
      // Read-only visibility plus a separate synchronous execution guard.
      // The sampler below is diagnostic; it is not the spending authority.
      const explore = cfg.criticExploreEnabled !== false
      // 共享上下文（请求/摘要/引用/顾问清单/块地图/草稿）——v2 单段与 v4
      // 两阶段的每个 spawn 都以此为底。
      let baseContext = ''
      let suspectContext = ''
      try {
        const evidence = turnEvidence(events, target, { protectInputs: true })
        evidenceWithheld = evidence.withheld
        requestContext = evidence.requestContext
        const providedText = (evidence.quotes || []).map(q => q.text).join('\n')
        const authorRef = receiptLedger.provided(providedText)
        if (evidence.sensitiveInput || detectSensitiveText(draft)) return await fail('本次输入含疑似凭据，未发送给评审；请先去除敏感内容')
        if (evidence.request !== '') {
          baseContext += 'Request being answered:\n"""\n' + evidence.request + '\n"""\n\n'
        }
        if (requestContext.limited) baseContext += 'Human request context is missing, ambiguous, replaced, truncated or contains non-text input that is not supplied here. Judge only the supplied text; do not reconstruct user requirements from runtime context, advisor opinions or the author\'s process. This cannot establish full task compliance.\n\n'
        suspectContext = baseContext
        let draftContext = 'Draft block map:\n'
        for (const b of draftBlocks) draftContext += b.id + ': ' + b.type + '\n'
        draftContext += '\nDraft under review:\n"""\n' + draft + '\n"""'
        suspectContext += draftContext
        if (authorRef) baseContext += 'Host evidence reference ' + authorRef + ' identifies the provided author tool quotes below (not independently rerun). Use it only for claims settled by those quotes.\n'
        baseContext += 'Tool activity in the same turn (verdict digest, not full output):\n' + evidence.tools + '\n\n'
        if (Array.isArray(evidence.quotes) && evidence.quotes.length > 0) {
          baseContext += 'Full outputs of this turn\'s NON-REPRODUCIBLE tool calls (verbatim quotes — the world cannot re-produce these byte-for-byte, so cross-check draft claims against them directly before spending time on another read):\n'
          for (const q of evidence.quotes) {
            baseContext += '\n### ' + q.name + (q.isError ? ' (ERROR)' : '') + ' output:\n"""\n' + q.text + '\n"""\n'
          }
          baseContext += '\n'
        }
        if (targets.items.length > 0) {
          baseContext += 'Advisor verification list (pre-declared by the consulted advisor; cross-check per your instructions):\n'
          for (const it of targets.items) {
            baseContext += '- [' + String(it.tier || 'low') + '] ' + String(it.title || '（无标题）') + ' — 验证目标: ' + String(it.verificationTarget) + '\n'
          }
          baseContext += '\n'
        }
        baseContext += 'Draft block map (cite these ids in each annotation\'s `block:` field):\n'
        for (const b of draftBlocks) baseContext += b.id + ': ' + b.type + '\n'
        baseContext += '\nDraft under review:\n"""\n' + draft + '\n"""'
      } catch (evidenceError) {
        return fail(evidenceError, 'evidence assembly failed')
      }
      if (detectSensitiveText(baseContext) || detectSensitiveText(suspectContext)) return await fail('本次输入含疑似凭据，未发送给评审；请先去除敏感内容')
      const backendName = await this.ensureReviewBackend()
      if (explore) {
        try {
          const root = agent.session?.header?.cwd
          const fileView = agent.ctx?.get('fs') ?? this.ctx.get('fs')
          if (fileView !== undefined && (typeof root !== 'string' || typeof fileView.processPathFromHostPath !== 'function' || fileView.processPathFromHostPath(root) !== resolvePath(root))) {
            return await fail('当前文件视图不是本机文件系统，不能安全建立评审副本；没有启动模型')
          }
          corpus = await this.createCorpus({
            root: agent.session?.header?.cwd,
            additionalRoots: cfg.criticAdditionalRoots || [],
            protectedRoots: [process.env.DSH_HOME || join(homedir(), '.dsh')],
            signal: operation.signal,
          })
          corpus = evidenceCorpus(corpus, receiptLedger)
        } catch (error) {
          if (error instanceof ReviewStageFailure) throw error
          operation.check()
          return await fail(corpusPrepErrorText(error))
        }
      }
      operation.check()
      if (corpus) {
        baseContext += '\nReview file access is limited to an immutable source/documentation snapshot. Host-authoritative path mapping (aliases of the SAME captured files, not different files):\n'
        baseContext += '/project = ' + agent.session.header.cwd + '\n'
        for (const [i, root] of (cfg.criticAdditionalRoots || []).entries()) baseContext += '/external-' + (i + 1) + ' = ' + root + '\n'
        baseContext += 'Your `run_code` program reaches the snapshot only through the declared read/grep/glob tools; those tools accept these virtual paths OR the original approved absolute paths and never access the live filesystem. Parse each tool result with JSON.parse. For example, /project/a.js is the captured version of a.js under the mapped project directory. Successful snapshot reads establish file existence and captured contents at review start; do not reject equivalent mapped paths as unrelated. Use read metadata/content for line counts; no shell/ls/wc is available. grep uses literal substrings, not regular expressions. A denied or truncated query means limited evidence, not that the claim is false.\n'
      }
      if (evidenceWithheld) baseContext += '\nSome author tool results were withheld for privacy. Do not infer success, failure, or correctness from missing evidence.\n'
      if (detectSensitiveText(baseContext)) return await fail('资料区说明含疑似凭据，未发送给评审；请检查目录配置')
      const releaseRun = async (run) => {
        const control = stageControls.get(run.id)
        captureModelUsage(modelUsage, run)
        try { await run.dispose() } finally {
          if (control) {
            dataLimited ||= control.accessLimited
            operation.signal.removeEventListener('abort', control.onCancel)
          }
          this.children.delete(run.id)
          stageControls.delete(run.id)
          this.liveCriticChildren.delete(run.id)
        }
      }
      const spawnOnce = async (spec) => {
        operation.check()
        if (this.getConfig().enabled === false) { operation.cancel('Ciel disabled'); operation.check() }
        const abort = spec.abort || new AbortController()
        const onCancel = () => abort.abort(operation.signal.reason)
        operation.signal.addEventListener('abort', onCancel, { once: true })
        let run
        const label = 'ciel-review-' + spec.label + '-' + randomUUID()
        // `guard` is the fail-closed gate a private child-scoped registry
        // attaches during setup: it refuses anything that is not this exact
        // bound child before delegating the shared policy. Registration may
        // precede bindControl; nothing executes until bound.
        const control = {
          parent: agent, corpus, operation, abort, onCancel, used: 0, timeoutMs, diagnostics,
          allowTools: spec.toolFilter.allow.length > 0, bound: false, child: undefined, accessLimited: false,
          guard: (exec) => {
            const owned = this.children.get(exec?.agent?.id) === control
            if (!control.bound || !owned || exec?.agent !== control.child) return REVIEW_TOOL_DENIAL
            return this.guard(exec)
          },
        }
        this.pendingReviewControls.set(label, control)
        try {
          run = await subagents.start(backendName, {
            label, parent: agent, signal: abort.signal,
            prompt: [{ type: 'text', text: spec.prompt }],
            agentOptions: { ...spec.agentOptions, maxTokens: Math.min(spec.agentOptions.maxTokens, cfg.criticMaxTokens ?? 16384) },
            persona: spec.persona, maxDepth: 1, toolFilter: spec.toolFilter,
          })
          control.run = run
          stageControls.set(run.id, control)
          if (!control.bound || this.children.get(run.id) !== control) throw new Error('restricted review setup did not bind before publication')
          operation.check()
          return run
        } catch (error) {
          operation.signal.removeEventListener('abort', onCancel)
          if (run) await releaseRun(run)
          throw error
        } finally {
          this.pendingReviewControls.delete(label)
        }
      }
      const awaitRun = async (run) => {
        try {
          const result = await run.result
          operation.check()
          return { result, text: outputText(result.output), detail: childErrorDetail(run) }
        } finally { await releaseRun(run) }
      }

      let text = ''
      let toolCalls = 0
      let suspectsMeta
      let allSuspects = []
      let selectedSuspects = []
      if (!explore) {
        // ── v2 单段路径（探索关闭）──
        let run
        try {
          run = await spawnOnce({
            label: 'critic',
            prompt: baseContext + CRITIC_PROMPT_SUFFIX,
            agentOptions: { provider: cfg.criticProvider, model: cfg.criticModel, maxTokens: 4096 },
            persona: CRITIC_PERSONA + RUBRIC_ADDENDUM,
            toolFilter: { allow: [] },
          })
        } catch (spawnError) {
          return await fail(spawnError, 'critic spawn failed')
        }
        this.progressByMessage.set(key, { explore, limits, operation, startedAt: Date.now(), toolCalls: () => 0, action: () => ({ kind: 'thinking' }) })
        const { result, text: out, detail } = await awaitRun(run)
        if (result.stopReason !== 'completed') {
          return await fail('critic ended with "' + result.stopReason + '"' + (detail === '' ? '' : ': ' + detail))
        }
        if (out === '') return await fail('critic returned an empty answer (reasoning only, no visible text)')
        text = out
      } else {
        // ── 契约 v4 两阶段 ──
        const progress = { explore, limits, operation, phase: 1, suspects: 0, startedAt: Date.now(), toolCalls: () => 0, action: () => ({ kind: 'thinking' }) }
        this.progressByMessage.set(key, progress)
        // 阶段 1：存疑（无工具、便宜，产出结构化疑点清单）
        diagnostics.phase = 1
        let suspects = []
        try {
          const run1 = await spawnOnce({
            label: 'critic-suspects',
            prompt: suspectContext + CRITIC_SUSPECT_PROMPT_SUFFIX,
            agentOptions: { provider: cfg.criticProvider, model: cfg.criticModel, maxTokens: 4096 },
            persona: CRITIC_SUSPECT_PERSONA,
            toolFilter: { allow: [] },
          })
          const r1 = await awaitRun(run1)
          if (r1.result.stopReason !== 'completed') return await fail('suspect phase ended with "' + r1.result.stopReason + '": ' + r1.detail)
          const parsedSuspects = parseSuspectResponse(r1.text)
          if (!parsedSuspects.ok) return await fail('suspect phase format error: ' + parsedSuspects.error)
          suspects = parsedSuspects.suspects.map((s, i) => ({ ...s, id: 's' + (i + 1), block: draftBlocks.some((b) => b.id === s.block) ? s.block : undefined }))
          allSuspects = suspects
        } catch (suspectError) {
          return await fail(suspectError, 'suspect phase failed')
        }
        // Prioritize the fixed suspect pool without withholding any by query count.
        const triage = triageSuspects(suspects)
        selectedSuspects = triage.chosen
        suspectsMeta = { total: suspects.length, triaged: triage.chosen.length, skipped: triage.skipped.length }
        if (triage.chosen.length > 0) {
          let listText = 'Ordered suspect list (' + triage.chosen.length + ' suspects given to you). All nominated suspects are included; leave any unsettled at the deadline unchecked.\n'
          triage.chosen.forEach((s, i) => {
            listText += s.id + '. ' + (s.block ? '[' + s.block + '] ' : '') + s.suspect + ' — falsify: ' + (s.falsify || '（未给出）') + '\n'
          })
          progress.phase = 2
          diagnostics.phase = 2
          progress.suspects = triage.chosen.length
          // Phase 2: restricted readers under the same operation deadline.
          let run2
          const phase2Abort = new AbortController()
          try {
            run2 = await spawnOnce({
              label: 'critic',
              prompt: baseContext + '\n\n' + listText + CRITIC_VERIFY_PROMPT_SUFFIX,
              agentOptions: { provider: cfg.criticProvider, model: cfg.criticModel, maxTokens: 16384 },
              persona: criticExplorePersona(timeoutMs / 1000),
              toolFilter: { allow: ['read', 'grep', 'glob'] },
              abort: phase2Abort,
            })
          } catch (spawnError) {
            return await fail(spawnError, 'critic spawn failed')
          }
          const observer = createReviewObserver({ agents, runId: run2.id })
          const phaseControl = stageControls.get(run2.id)
          progress.toolCalls = () => phaseControl?.used ?? observer.calls()
          progress.action = () => observer.action()
          try {
            const result = await run2.result
            toolCalls = phaseControl?.used ?? observer.stop()
            diagnostics.toolCalls = toolCalls
            operation.check()
            text = outputText(result.output)
            if (result.stopReason !== 'completed') return await fail('critic ended with "' + result.stopReason + '": ' + childErrorDetail(run2))
            if (text === '') return await fail('critic returned an empty answer')
          } finally {
            observer.stop()
            await releaseRun(run2)
          }
        }
      }
      if (explore && suspectsMeta?.triaged === 0 && text === '') {
        text = '## verdict: pass\nsummary: 存疑阶段未提出疑点；未进行独立核实。\nstats: 排查 0 · 证伪 0 · 排除 0 · 未查 0'
      }
      operation.check()
      const parsed = groundReview(parseCriticReview(text, draft, draftBlocks, { explore, strict: true, ...(explore ? { selected: selectedSuspects, allSuspects } : {}) }), receiptLedger)
      if (!parsed.valid) return await fail('critic format error: exactly one valid verdict section is required')
      const coverage = reviewCoverage(parsed, { explore, suspects: suspectsMeta })
      dataLimited ||= Boolean(corpus?.publicInfo().truncated)
      if (dataLimited || evidenceWithheld) {
        if (coverage.coverage === 'complete') coverage.coverage = 'partial'
        coverage.coverageNote = [coverage.coverageNote, dataLimited ? '资料读取受到范围或大小限制，不能作为完整核实' : '', evidenceWithheld ? '部分作者工具输出因隐私检查未提供，不能用缺失证据断言正误' : ''].filter(Boolean).join('；')
      }
      if (requestContext.limited) {
        if (coverage.coverage === 'complete') coverage.coverage = 'partial'
        coverage.coverageNote = [coverage.coverageNote, requestContextNote(requestContext)].filter(Boolean).join('；')
      }
      parsed.stats = coverage.stats
      const annotations = parsed.annotations
      const sound = coverage.coverage === 'complete' && parsed.verdict === 'pass' && annotations.length === 0
      // A free-form summary cannot certify withheld claims around the ledger.
      const summary = parsed.outcomes
        ? (parsed.stats.checked === 0 ? '未提出可证伪疑点；未进行独立核实。'
          : '复核记录：' + parsed.stats.checked + ' 项疑点，' + parsed.stats.confirmed + ' 项确认问题，' + parsed.stats.excluded + ' 项排除，' + parsed.stats.unchecked + ' 项未查。')
        : parsed.summary
      const entry = {
        schemaVersion: RECORD_SCHEMA_VERSION, sessionId, reviewId, messageId, anchorSeq: target.seq, workspaceRoot: agent.session?.header?.cwd,
        evidenceRecords: parsed.evidenceRecords, evidenceIds: parsed.evidenceRecords.map(record => record.id),
        status: coverage.coverage === 'partial' ? 'incomplete' : sound ? 'sound' : annotations.length ? 'completed' : 'unverified',
        coverage: coverage.coverage,
        requestContext,
        ...(coverage.coverageNote ? { coverageNote: coverage.coverageNote } : {}),
        ...(parsed.verdictAdjusted ? { verdictAdjusted: true } : {}),
        ...(parsed.outcomes ? { outcomes: parsed.outcomes, ignoredAnnotations: parsed.ignoredAnnotations } : {}),
        modelRequests: operation.requests(),
        limits,
        modelUsage: modelUsageSnapshot(modelUsage),
        privacy: { mode: corpus ? 'restricted-snapshot' : 'no-file-tools', dataLimited, evidenceWithheld, ...(corpus ? { scope: corpus.publicInfo() } : {}) },
        sound,
        ...(parsed.verdict === undefined ? {} : { verdict: parsed.verdict }),
        ...(summary === '' ? {} : { summary }),
        // New exploratory stats are counted from the host-owned identity
        // ledger. Tool counts are a distinct resource metric, never progress
        // through the suspect pool or a monetary budget.
        ...(parsed.stats === undefined ? {} : { stats: parsed.stats }),
        ...(explore ? { explore: { limitMode: 'time', toolCalls, timeoutSeconds: limits.timeoutSeconds } } : {}),
        // 契约 v4：阶段 1 清单元数据（总数/送审/预截取未查）——统计诚实的
        // M/Z 的持久化地面真值。
        ...(suspectsMeta === undefined ? {} : { suspects: suspectsMeta }),
        // 块地图（仅 id+type）——浏览器端用同一序号空间把 gutter 徽章对到
        // 渲染 DOM 的顶层块；块解析失败的批注退回旧 proximity 定位。
        ...(draftBlocks.length === 0 ? {} : { blocks: draftBlocks.map((b) => ({ id: b.id, type: b.type })) }),
        annotations,
        // ③深化：本次评审携带的顾问验证目标条数（0 = 无清单，基线行为）——
        // 评估回路的地面真值：回传数据可与清单有无交叉分析批注质量。
        targetsProvided: targets.items.length,
        createdAt: Date.now(),
      }
      // raw 回退只服务于「无 verdict 且零批注」的未解析形态（completed-unparsed）；
      // v2 pass（零批注但 verdict 有效）的 verdict/summary 已在卡头，raw 是噪音。
      if (annotations.length === 0 && parsed.verdict === undefined) entry.raw = text.slice(0, 2000)
      try {
        await this.repository.persistReview(sessionId, entry, operation)
      } catch (persistError) {
        return await fail(persistError, 'review persistence failed')
      }
      const { evidenceRecords: _privateEvidence, ...publicEntry } = entry
      return { ok: true, review: publicEntry }
    } catch (error) {
      return await publishFailure(error instanceof ReviewStageFailure ? error : new ReviewStageFailure(error, 'unexpected'))
    } finally {
      // All stage handles are awaited before the operation leaves the registry.
      for (const [id, c] of stageControls) {
        c.abort.abort()
        try { await c.run.dispose() } catch (error) { this.ctx.logger?.warn('Ciel child cleanup failed: %s', error.message) }
        operation.signal.removeEventListener('abort', c.onCancel)
        this.children.delete(id)
        this.liveCriticChildren.delete(id)
      }
      try { corpus?.dispose() } catch { this.ctx.logger?.warn('Ciel: corpus cleanup failed') }
      try { receiptLedger.dispose() } catch { this.ctx.logger?.warn('Ciel: receipt ledger cleanup failed') }
      for (const [label, control] of this.pendingReviewControls) if (control.operation === operation) this.pendingReviewControls.delete(label)
      operation.dispose()
      this.activeOperations.delete(operation)
      this.inFlight.delete(key)
      this.activeSessions.delete(sessionId)
      this.progressByMessage.delete(key)
    }
  }

}
