// Ciel: planning advisor, with optional context checks and read-only history.
import { randomUUID } from 'node:crypto'
import { hostSchemastery } from './runtime.js'
import { ADVISOR_METHODS, advisorInvocation, ADVISOR_DECISION_SCHEMA } from './advisor-protocol.js'
import { createAdvisorOperation } from './advisor-operation.js'
import { detectSensitiveText } from './sensitive-text.js'
import { prepareAdvisorDecision, checkAdvisorWithDecision, renderAdvisorDecision } from './decision-advisor.js'
import { DECISION_MODEL, DECISION_ENDPOINT, DECISION_MODEL_PATTERN, DECISION_KEY_PATTERN, DECISION_ENDPOINT_PATTERN, resolveDecisionConnection } from './decision-config.js'
import { AdvisorService } from './advisor-service.js'
import { MODEL_USAGE_SCHEMA, createModelUsage, modelUsageSnapshot, captureModelUsage } from './model-usage.js'
import { outputText, childErrorDetail, parseAdvisorItems, toolEventView } from './advisor-content.js'
import { gateFacts, reminderTextFor, createConsultationGate } from './advisor-state.js'
import { persistCallModelUsage, readCallModelUsage, persistAdvice } from './advisor-repository.js'

/** Cordis plugin name. */
export const name = 'dsh-ciel'

/** Advisor persona: the ideas-only output contract for the child agent. */
const ADVISOR_PERSONA =
  "You are a senior technical advisor consulted BEFORE planning begins. Offer alternative problem framings, relevant domain knowledge, prior art, common pitfalls, cross-domain analogies, and expert evaluation dimensions. Output ideas and knowledge ONLY—never step-by-step plans, never code, never tool usage instructions.\n" +
  "\n" +
  "Output at most six items in EXACTLY this Markdown format (keep English field keys verbatim; write content in the question's language):\n" +
  "\n" +
  "## [high] short title\n" +
  "framing: the core direction or mechanism — one short paragraph\n" +
  "pitfalls: known failure modes of this direction — one short paragraph\n" +
  "verification_target: what the caller should verify against the environment\n" +
  "\n" +
  "The tier tag is mandatory:\n" +
  "- [high]: Established domain consensus.\n" +
  "- [mid]: Grounded but context-dependent judgment.\n" +
  "- [low]: Extrapolation or cross-domain analogy.\n" +
  "Never provide numeric scores.\n" +
  "\n" +
  "If the question lies outside your reliable knowledge, state so plainly, tag affected items [low], and never invent names, links, version numbers, or studies (cross-domain analogies from familiar fields remain welcome). You have no internet or environment access: if the question hinges on missing time-sensitive facts (versions, availability, pricing), declare that gap at the very top of your answer."

/** Guidance prompt section text: the consultation protocol for the caller. */
const GUIDANCE_TEXT =
  "The `ask_advisor` tool connects to a second model chosen for knowledge breadth. The advisor gives ideas, not plans; its value is diversity—directions your own priors would not sample first.\n" +
  "\n" +
  "WHEN to consult (at most once per planning phase, strictly for knowledge-heavy tasks):\n" +
  "- Open solution spaces with fundamentally divergent routes (architecture, technology selection, data modeling, scene/aesthetic composition).\n" +
  "- Unfamiliar domains where your training knowledge is thin.\n" +
  "- Highly irreversible decisions (migrations, external contracts).\n" +
  "- Difficult diagnoses where ordinary approaches have already failed twice.\n" +
  "\n" +
  "Do NOT consult when the answer is inside the environment (inspect code instead), for mechanical pattern-fixed tasks, or for small tasks where consultation overhead exceeds task value. Judge the decision space, not prompt length: a one-line request can hide a large open design, while a long spec can hide zero decisions. Do NOT consult on spec errors: resolve factual conflicts via inspection and tradeoff conflicts with the user; the advisor enters only if resolving the error reopens an open design space.\n" +
  "\n" +
  "HOW to consult:\n" +
  "1. Explore first: Gather concrete environment facts (code structure, versions, constraints) and research time-sensitive facts beforehand. The advisor has no internet access; ungrounded questions get generic answers. For unfamiliar domains, perform a brief research pass and provide the digest in `context`.\n" +
  "2. Divergent consultation (once): Pass the goal, discovered facts, and constraints. Expect alternative framings, prior art, common pitfalls, and evaluation dimensions—never step-by-step procedures.\n" +
  "3. Work independently: Filter ideas, verify claims against the real environment (advisors can hallucinate plausible knowledge), and synthesize the plan yourself.\n" +
  "4. Targeted follow-ups (at most two per phase): Each follow-up must introduce NEW facts discovered since the last call and ask a specific question. Never send draft plans to the advisor—reviewing drafts is a separate role.\n" +
  "5. Own the result: In your final plan, state which advisor ideas you adopted or rejected, and why.\n" +
  "\n" +
  "If `ask_advisor` fails or its route is unavailable, plan on your own and note that the advisor was unavailable."

// DSH 0.1.7 wraps live fields in stable references. Keep plain snapshots at
// Ciel's operation boundaries; older DSH installations still pass plain values.
export function configValues(config) {
  return Object.fromEntries(Object.entries(config || {}).map(([key, value]) => [key,
    value && typeof value.get === 'function' ? value.get() : value]))
}
// One Schema identity with the Harness process: cordis and the settings service
// validate this plugin's config with the copy they imported, not a second one.
const Schema = hostSchemastery()

const configFields = {
  enabled: Schema.boolean().default(true)
    .description('允许 Ciel 顾问咨询。关闭取消本插件在途模型调用，不改变模型配置'),
  advisorTimeoutSeconds: Schema.number().step(1).min(10).max(600).default(180)
    .description('一次 ask_advisor 的总时限，秒；网络重试遵循提供方策略，共享此时限，取消或超时后停止'),
  provider: Schema.string().default('kimi-coding')
    .description('顾问模型的提供方路由（须是设置 → 模型 中已注册的 provider）'),
  model: Schema.string().default('kimi-for-coding')
    .description('顾问模型 id；跨家族模型多样性收益更大'),
  maxTokens: Schema.number().min(256).max(32768).default(4096)
    .description('顾问单次回答的输出上限'),
  maxCallsPerTurn: Schema.number().step(1).min(1).max(20).default(3)
    .description('每个 turn（≈一个规划阶段）的顾问调用硬上限：1 次发散 + 追问预算；超出即拒绝'),
  requireExploration: Schema.boolean().default(true)
    .description('首次咨询前要求本会话已有至少一次非顾问工具调用（先探查后咨询）'),
  enforceFollowupGap: Schema.boolean().default(true)
    .description('同一 turn 内两次咨询之间要求至少一次独立工作动作（追问须由新事实驱动）'),
  planReminderEnabled: Schema.boolean().default(true)
    .description('检测到本 turn 开始规划（todo_write / exit_plan_mode）且尚未咨询时，在下一步装配里注入一次提醒；机制零语义判断'),
  reasoningEffort: Schema.union(['provider', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .default('provider')
    .description('顾问思考深度：provider 跟随提供方默认；其余档位注入该次咨询的每个请求，模型不支持的档位会报错'),
  guidanceEnabled: Schema.boolean().default(true)
    .description('向系统提示词注入顾问使用协议（触发判据与追问预算）'),
  decisionApiKey: Schema.string().max(4096).pattern(DECISION_KEY_PATTERN).role('secret')
    .description('Gemini API 密钥；保存在本机 DSH 配置，设置读取不回传原值。未配置时回退到 DSH 凭据服务与 GEMINI_API_KEY / GOOGLE_API_KEY（仅官方端点），不是加密保险库'),
  decisionEndpoint: Schema.string().max(2048).pattern(DECISION_ENDPOINT_PATTERN).default(DECISION_ENDPOINT)
    .description('Gemini Decisions API 完整 HTTPS 地址，不追加路径；仅支持 Gemini Developer API（v1beta/decisions）。自定义地址会收到密钥和检查原文，须另填密钥，不复用宿主或环境凭据'),
  decisionModel: Schema.string().pattern(DECISION_MODEL_PATTERN).default(DECISION_MODEL)
    .description('顾问建议检查的 Gemini Decision 模型 ID；默认 gemini-decision-1，保存后下次检查使用'),
  advisorDecisionEnabled: Schema.boolean().default(false)
    .description('顾问回答后用 Gemini Decisions API 对照本次问题和背景检查建议；将这些内容发送给 Google，产生额外 API 用量。独立开关，默认关闭；仅检查背景一致性，不独立核实事实，不改写建议。关闭取消在途检查'),
}
const LegacyConfig = Schema.object(configFields)
export const Config = Schema.object(Object.fromEntries(Object.entries(configFields).map(([key, field]) => [key,
  typeof field.volatile === 'function' ? field.volatile() : field])))

/**
 * ask_advisor keeps the raw prose unchanged. When enabled, the caller model
 * also receives a separately labeled Gemini Decision context check before that
 * prose, while the parsed structure rides tool/result.meta via presentationMeta.
 */
const advisorOutput = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tier: { type: 'string', enum: ['high', 'mid', 'low'] },
            title: { type: 'string' },
            framing: { type: 'string' },
            pitfalls: { type: 'string' },
            verificationTarget: { type: 'string' },
          },
          required: ['tier', 'title', 'framing', 'pitfalls', 'verificationTarget'],
          additionalProperties: false,
        },
      },
      issues: { type: 'array', items: { type: 'string' } },
      modelUsage: MODEL_USAGE_SCHEMA,
      decision: ADVISOR_DECISION_SCHEMA,
    },
    required: ['text', 'items', 'issues'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: (value.decision ? renderAdvisorDecision(value.decision) + '\n\n' : '') + value.text }],
  presentationMeta: (_args, value) => ({ v: 1, items: value.items, issues: value.issues, ...(value.modelUsage ? { modelUsage: modelUsageSnapshot(value.modelUsage) } : {}), ...(value.decision ? { decision: value.decision } : {}) }),
}

/** Flatten a subagent result's output blocks into one plain-text answer. */
// ── legacy namespace migration (0.11.0). Pure seam, unit-tested with fakes:
// given the settings service and the live `ciel` scope, read the pre-rename
// `advisor` raw user section through a temporary registration (owned by a
// throwaway fiber, see apply) and copy its overrides into `ciel` — but only
// while `ciel` carries no user section of its own. Returns true when a copy
// happened. The legacy settings.yaml section is deliberately LEFT in place:
// a downgrade (or the omdsh-dev plugin the name was cleared for) can still
// read it, and a failed copy loses nothing by construction.
function settingsUserSection(settings, ns) {
  const descriptor = settings.describe().find((d) => String(d.ns) === ns)
  return descriptor && descriptor.user && typeof descriptor.user === 'object'
    ? descriptor.user
    : {}
}

async function migrateLegacyAdvisorSettings(settings, cielScope) {  try {
    settings.register('advisor', LegacyConfig)
  } catch {
    // Another plugin owns `advisor` (or the stored section is malformed
    // beyond schema repair) — nothing here is ours to move.
    return false
  }
  const legacyUser = settingsUserSection(settings, 'advisor')
  const cielUser = settingsUserSection(settings, 'ciel')
  if (Object.keys(legacyUser).length === 0 || Object.keys(cielUser).length > 0) return false
  await cielScope.update(Object.fromEntries(Object.entries(legacyUser).filter(([key]) => Object.hasOwn(configFields, key))))
  return true
}

export { migrateLegacyAdvisorSettings, createModelUsage, captureModelUsage, modelUsageSnapshot, persistCallModelUsage, persistAdvice, readCallModelUsage, settingsUserSection, parseAdvisorItems, createAdvisorOperation, createConsultationGate, gateFacts, reminderTextFor, toolEventView, AdvisorService }

export function apply(ctx, config) {
  const activeOperations = new Set()
  const consultationGate = createConsultationGate()
  ctx.effect(() => async () => {
    const pending = [...activeOperations]
    for (const operation of pending) operation.cancel('plugin stopped')
    await Promise.all(pending.map((operation) => operation.done))
  }, 'Ciel: cancel and drain owned model calls')
  // ── settings seam: the resolved `ciel` section (schema defaults over the
  // composition entry over the user document) feeds every later consultation.
  // (0.11.0 renamed the namespace `advisor` → `ciel` to clear the collision
  // with omdsh-dev/dsh-advisor; the legacy section is migrated below.)
  // Wired through ctx.inject so the plugin still activates when the settings
  // service is absent (the composition config then stands alone).
  let current = () => configValues(config)
  const beginAdvisorCall = (signal) => {
    const operation = createAdvisorOperation({ timeoutMs: (current().advisorTimeoutSeconds ?? 180) * 1000 })
    const onAbort = () => operation.cancel('advisor cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    activeOperations.add(operation)
    return { operation, finish: () => {
      signal?.removeEventListener('abort', onAbort)
      operation.dispose()
      activeOperations.delete(operation)
    } }
  }
  let resyncGuidance = () => {}
  const advisorDecisionControllers = new Set()
  const settingsChanged = () => {
    resyncGuidance()
    if (current().enabled === false) for (const operation of activeOperations) operation.cancel('Ciel disabled')
    if (current().advisorDecisionEnabled !== true) for (const controller of advisorDecisionControllers) controller.abort()
  }
  ctx.on('loader/volatile-update', settingsChanged)
  ctx.inject(['settings'], (sctx) => {
    if (typeof sctx.settings.configure === 'function') {
      if (!Config.dict.advisorDecisionEnabled.meta.volatile) throw new Error('Ciel settings on DSH 0.1.7 require @deepseek-ai/schemastery >=3.18.3')
      sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
      return
    }
    const scope = sctx.settings.register('ciel', LegacyConfig, { base: configValues(config) })
    current = () => configValues(scope.get())
    sctx.effect(
      () => () => {
        current = () => configValues(config)
      },
      'dsh-ciel: settings fallback',
    )
    scope.watch(settingsChanged)

    // ── legacy migration: the temporary `advisor` registration is owned by
    // this throwaway fiber, so disposing it after the copy attempt frees the
    // name again for omdsh-dev/dsh-advisor. Self-dispose always fires one
    // microtask later, after sctx.plugin() has returned the fiber.
    let migrationFiber = null
    migrationFiber = sctx.plugin({
      name: 'dsh-ciel: legacy advisor settings migration',
      inject: ['settings'],
      apply(mctx) {
        const finish = () => {
          const fiber = migrationFiber
          if (fiber !== null) void fiber.dispose()
        }
        void migrateLegacyAdvisorSettings(mctx.settings, scope)
          .then((moved) => {
            if (moved) mctx.logger?.info?.('dsh-ciel: migrated legacy advisor settings into the ciel namespace')
          }, (error) => {
            mctx.logger?.warn?.(
              'dsh-ciel: legacy advisor settings migration skipped: %s',
              error && error.message ? error.message : String(error),
            )
          })
          .then(finish, finish)
      },
    })
  })

  // ── guidance prompt section, gated by the guidanceEnabled setting. Host-layer
  // registration makes the protocol visible to every agent; toggling the
  // setting re-registers the section without a restart. Like every sibling
  // service this composition shares, systemPrompt's readiness at our apply()
  // is not ours to know: a bare ctx.get can lose the boot race (observed live
  // — the section silently never registered while the inject-fed tool worked),
  // so this waits through ctx.inject exactly like the llm seam below.
  ctx.inject(['systemPrompt'], (spctx) => {
    let dispose = null
    resyncGuidance = () => {
      if (dispose !== null) {
        dispose()
        dispose = null
      }
      if (current().enabled !== false && current().guidanceEnabled) {
        dispose = spctx.systemPrompt.section({
          name: 'advisor:guidance',
          order: 40,
          text: GUIDANCE_TEXT,
        })
      }
    }
    resyncGuidance()
    spctx.effect(
      () => () => {
        if (dispose !== null) dispose()
      },
      'dsh-advisor: guidance section',
    )
  })

  // ── plan-moment reminder (option B): the mechanism never judges task
  // content; it watches the caller's BEHAVIOR. Each agent gets an AGENT-SCOPED
  // prompt context whose text self-evaluates on every assembly: when this turn
  // shows a planning signal (todo_write / exit_plan_mode) and no advisor call
  // yet, the runtime-context snapshot carries the reminder — the criteria
  // re-appear at the decision point instead of lying buried in the system
  // prompt. This must be per-agent, not a host waterfall: the
  // system-prompt/assemble dispatch is scope-filtered, so a host listener
  // never sees preset-mounted agents' assemblies (verified live by probe),
  // while an agent-scoped context rides the agent's own layer — and contexts
  // survive complete presets where sections do not. All conditions read the
  // agent's durable session log (including the reminder's own marker, so it
  // fires at most once per turn and survives compaction/restart), and the
  // registration unwinds with the agent.
  const liveAdvisorChildren = new Map()
  function configureAdvisorChildAgent(agent, childState) {
    if (!agent || childState.configuredAgent === agent) return
    childState.configuredAgent = agent
    childState.localAgent = agent
    const selection = childState.requestedSelection
    if (selection?.reasoningEffort !== undefined && typeof agent.model?.select === 'function') {
      const currentSelection = typeof agent.model.current === 'function' ? agent.model.current() : undefined
      if (currentSelection?.reasoningEffort !== selection.reasoningEffort) {
        try {
          agent.model.select(selection)
        } catch {}
      }
    }
    const childTools = agent.ctx?.get?.('tools')
    if (typeof childTools?.presentAs === 'function') childTools.presentAs('native')
    if (typeof childTools?.restrict === 'function') childTools.restrict({ allow: [] })
    const sp = agent.ctx?.get?.('systemPrompt')
    if (typeof sp?.section === 'function') {
      const order = typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0
      sp.section({ name: 'deployment:persona-prefix', order, text: ADVISOR_PERSONA })
    }
    if (typeof agent.ctx?.on === 'function') {
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next()
        return { ...assembled, tools: [] }
      })
    }
    if (typeof agent.ctx?.effect === 'function') {
      agent.ctx.effect(() => () => {
        if (childState.modelUsage) captureModelUsage(childState.modelUsage, childState)
      }, 'Ciel: capture advisor child model usage before disposal')
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    const childState = agent && liveAdvisorChildren.get(agent.id)
    if (childState !== undefined) {
      configureAdvisorChildAgent(agent, childState)
      return
    }
    const sp = agent && agent.ctx && agent.ctx.get('systemPrompt')
    if (sp === undefined) return
    sp.context({
      name: 'advisor:plan-reminder',
      order: 90,
      text: () => reminderTextFor(agent, current),
    })
  })

  // ── reasoning-effort & pre-request admission. DSH 0.2.2+ fixes the step's
  // reasoningEffort from AgentOptions / agent.model.select() BEFORE step
  // preparation and rejects any post-lock mutation inside `agent/request`.
  // Older 0.2.0/0.2.1 hosts lack `agent.model.select` and ignore
  // `AgentOptions.reasoningEffort`, so `agent/request` remains the fallback
  // only when `agent.model.select` is absent.
  ctx.on('agent/request', async (payload, next) => {
    const agent = payload && payload.agent
    const childState = agent && liveAdvisorChildren.get(agent.id)
    if (childState === undefined) return next()
    const { operation } = childState
    if (current().enabled === false) operation.cancel('Ciel disabled')
    operation.beforeRequest()
    if (typeof agent?.model?.select === 'function') return next()
    const effort = childState.requestedSelection !== undefined ? childState.requestedSelection.reasoningEffort : current().reasoningEffort
    if (effort === undefined || effort === '' || effort === 'provider') return next()
    const resolved = await next()
    return { ...resolved, reasoningEffort: effort }
  })

  ctx.inject(['typert'], tctx => {
    tctx.effect(() => tctx.typert.register({
      package: 'dsh-advisor', face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: ADVISOR_METHODS.map(advisorInvocation),
    }), 'Ciel: advisor data descriptors')
  })
  new AdvisorService(ctx)
  let advisorGuardAvailable = false
  ctx.inject(['tools'], tctx => {
    if (typeof tctx.tools.guard !== 'function') return
    tctx.tools.guard(exec => {
      const childState = liveAdvisorChildren.get(exec.agent?.id)
      if (childState) { childState.operation.cancel('unexpected tool in advisor'); return 'advisor has no tools' }
    })
    advisorGuardAvailable = true
    tctx.effect(() => () => {
      advisorGuardAvailable = false
      for (const operation of activeOperations) operation.cancel('tool guard unavailable')
    }, 'Ciel: advisor guard readiness')
  })

  // ── the ask_advisor tool. Each call is a fresh one-shot child on the spawn
  // provider: the stateless follow-up channel the consultation protocol
  // requires. Settings are read per call, so panel edits hot-apply.
  ctx.inject(['tools', 'subagents'], (tctx) => {
    tctx.tools.register({
      name: 'ask_advisor',
      deferLoading: true,
      description: "Consult a second, knowledge-rich model BEFORE planning. USE WHEN exploring open design spaces (architecture, tech selection, data modeling, aesthetics with divergent routes), unfamiliar domains, irreversible decisions, or difficult diagnoses failing twice. SKIP mechanical, fully specified, or small-scope tasks—judge the decision space, not prompt length (a one-line prompt can hide an open design). Do NOT consult on spec errors: verify factual conflicts yourself and escalate tradeoff conflicts to the user. The advisor has no internet: inspect the environment and research unfamiliar domains and time-sensitive facts first, then pass the goal, established facts, and constraints to receive framings, prior art, pitfalls, and evaluation dimensions (ideas only, never steps). Budget: 1 consultation plus up to 2 targeted follow-ups per planning phase (each requiring new facts and a specific question; never draft plans). In your final plan, state which recommendations you adopted or rejected, and why.",
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The goal plus the specific question for the advisor.',
          },
          context: {
            type: 'string',
            description: 'Environment facts and constraints already established (explore first; REQUIRED).',
          },
        },
        required: ['question', 'context'],
        additionalProperties: false,
      },
      output: advisorOutput,
      async execute(args, exec) {
        const parent = exec && exec.agent
        if (parent === undefined) {
          throw new Error('ask_advisor requires a calling agent (exec.agent was undefined)')
        }
        const cfg = current()
        const modelUsage = createModelUsage(cfg.provider, cfg.model)
        try {
        if (cfg.enabled === false) {
          throw new Error('[ciel:gate:disabled] Ciel is disabled; enable it in Settings → Ciel advisor before consulting')
        }
        if (!advisorGuardAvailable) {
          throw new Error('[ciel:gate:guard_unavailable] Ciel needs the host tools.guard() hook before it may start a model call')
        }
        // Admission-level route check: a self-referential or empty route would
        // burn the phase budget on a provider error, so it is rejected here and
        // never counted as a settled consultation (see GATE_REJECTION_HEAD).
        if (typeof cfg.provider !== 'string' || cfg.provider.trim() === '' || cfg.provider.trim() === 'ciel'
          || typeof cfg.model !== 'string' || cfg.model.trim() === '') {
          throw new Error('[ciel:gate:invalid_route] invalid advisor route: configure a valid provider and model (provider cannot be "ciel")')
        }
        // ── Mechanized negative gates (prompt text advises; these decide).
        // Gate order is cheapest-first; each error teaches the remedy.
        if (typeof args.context !== 'string' || args.context.trim() === '') {
          throw new Error(
            '[ciel:gate:empty_context] context is required: pass the facts already established in the ' +
              'environment (explore first — ungrounded questions get generic answers)',
          )
        }
        if (detectSensitiveText(String(args.question || '')) || detectSensitiveText(args.context)) {
          throw new Error('[ciel:gate:sensitive_input] sensitive input blocked: the question or context looks like it carries a credential, so it was not sent to the advisor; remove the secret and retry')
        }
        const facts = gateFacts(parent)
        if (facts === undefined) {
          throw new Error('[ciel:gate:telemetry_unavailable] advisor telemetry unavailable; refusing an unmetered consultation')
        } else {
          if (cfg.requireExploration && !facts.explorationDone) {
            throw new Error(
              '[ciel:gate:explore_first] explore first: no non-advisor tool call has run in this session yet. ' +
                'Inspect the environment (read/search/run) before consulting, then ' +
                'pass what you found in context',
            )
          }
          if (facts.settledThisTurn >= cfg.maxCallsPerTurn) {
            throw new Error(
              `[ciel:gate:budget_exhausted] advisor budget for this planning phase is exhausted ` +
                `(${facts.settledThisTurn}/${cfg.maxCallsPerTurn} consultations settled this turn). ` +
                'Work independently now; consult again in a later turn if genuinely new facts surface',
            )
          }
          if (cfg.enforceFollowupGap && facts.settledThisTurn > 0 && !facts.workSinceLast) {
            throw new Error(
              '[ciel:gate:followup_gap] follow-ups must be driven by NEW facts: run at least one independent ' +
                'step (read/search/run) since the last consultation before calling again',
            )
          }
        }
        const consultation = `Established facts and constraints:\n${args.context.trim()}\n\nQuestion:\n${args.question}`
        const release = consultationGate.reserve(parent, facts, cfg.maxCallsPerTurn)
        const owned = beginAdvisorCall(exec.signal)
        const requestedEffort =
          cfg.reasoningEffort !== undefined && cfg.reasoningEffort !== '' && cfg.reasoningEffort !== 'provider'
            ? cfg.reasoningEffort
            : undefined
        const requestedSelection = {
          provider: cfg.provider,
          model: cfg.model,
          ...(requestedEffort !== undefined ? { reasoningEffort: requestedEffort } : {}),
        }
        const childId = randomUUID()
        const childState = { id: childId, operation: owned.operation, modelUsage, requestedSelection, localAgent: undefined, configuredAgent: undefined }
        liveAdvisorChildren.set(childId, childState)
        let run
        let disposalPromise
        const disposeRun = () => {
          if (!run || typeof run.dispose !== 'function') return Promise.resolve()
          disposalPromise ??= Promise.resolve().then(() => run.dispose())
          return disposalPromise
        }
        const onAbort = () => {
          void disposeRun().catch(() => {})
        }
        try {
          owned.operation.check()
          const startRequest = {
            parent,
            prompt: [{ type: 'text', text: consultation }],
            agentOptions: {
              ...requestedSelection,
              maxTokens: cfg.maxTokens,
            },
            // Absolute delegation-depth cap: each start requires the child's
            // computed depth (caller depth + 1) <= maxDepth. 0 forbids ANY
            // delegation from a top-level session ("child depth 1 exceeds
            // maxDepth 0"); 1 admits the advisor (depth 1) while forbidding
            // the advisor's own children (depth 2).
            maxDepth: 1,
          }
          run = await tctx.subagents.startActivation({
            provider: 'spawn',
            label: 'advisor',
            childId,
            delivery: 'caller',
            signal: owned.operation.signal,
            ...startRequest,
            request: startRequest,
          })
          if (run?.childId && run.childId !== childId) liveAdvisorChildren.set(run.childId, childState)
          if (run?.id && run.id !== childId) liveAdvisorChildren.set(run.id, childState)
          const resolvedChildAgent = run?.localAgent ?? ctx.get?.('agents')?.get?.(run?.childId ?? childId)
          if (resolvedChildAgent) configureAdvisorChildAgent(resolvedChildAgent, childState)
          owned.operation.signal.addEventListener('abort', onAbort, { once: true })
          if (owned.operation.signal.aborted) onAbort()
          if (!run || typeof run.result?.then !== 'function') {
            throw new Error('subagents.startActivation did not return a caller result promise')
          }
          const result = await run.result
          owned.operation.check()
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            const detail = result.stopReason === 'error' ? childErrorDetail(childState) : ''
            throw new Error(
              `advisor consultation ended with "${result.stopReason}"` +
                (detail === '' ? '' : `: ${detail}`) +
                (text === '' ? '' : `; partial answer:\n${text}`),
            )
          }
          const answer = text === '' ? 'The advisor returned an empty answer.' : text
          const parsed = parseAdvisorItems(answer)
          captureModelUsage(modelUsage, childState)
          let decision
          if (cfg.advisorDecisionEnabled === true) {
            const controller = new AbortController()
            advisorDecisionControllers.add(controller)
            try {
              decision = await checkAdvisorWithDecision({
                prepared: prepareAdvisorDecision({ question: args.question, context: args.context, text: answer, items: parsed.items }),
                enabled: current().advisorDecisionEnabled === true && current().enabled !== false,
                // Resolved inside checkDecisionBatch's own deadline and
                // cancellation boundary: a hanging credential store degrades
                // the optional check, never the consultation.
                resolveConnection: () => resolveDecisionConnection(current(), { ctx }),
                signal: AbortSignal.any([owned.operation.signal, controller.signal]),
                timeoutMs: Math.min(10000, owned.operation.remainingMs() - 1000),
                beforeRequest: () => owned.operation.check(),
              })
            } finally { advisorDecisionControllers.delete(controller) }
            owned.operation.check()
          }
          try { await persistAdvice(parent.id, 'tool', exec.callId, answer, modelUsage, owned.operation, decision) }
          catch { owned.operation.check(); ctx.logger?.warn('Ciel: advisor sidebar record could not be saved') }
          return { text: answer, items: parsed.items, issues: parsed.issues, modelUsage: modelUsageSnapshot(modelUsage), ...(decision ? { decision } : {}) }
        } finally {
          try {
            owned.operation.signal.removeEventListener('abort', onAbort)
            captureModelUsage(modelUsage, childState)
            liveAdvisorChildren.delete(childId)
            if (run?.childId) liveAdvisorChildren.delete(run.childId)
            if (run?.id) liveAdvisorChildren.delete(run.id)
            if (run) await disposeRun()
          } finally { owned.finish(); release() }
        }
        } finally {
          try { await persistCallModelUsage(parent.id, 'tool', exec.callId, modelUsage) }
          catch { ctx.logger?.warn('Ciel: advisor model usage record could not be saved') }
        }
      },
    })
  })
}
