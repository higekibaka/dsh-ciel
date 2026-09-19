import { REVIEW_METHODS, reviewInvocation } from './review-protocol.js'
// dsh-ciel host half: a pre-planning advisor for DeepSeek Harness agents.
// (0.11.0 起由 dsh-advisor 更名为 dsh-ciel——大贤者夏尔；settings 命名空间同版
//  迁移 `advisor` → `ciel`（旧节自动迁入，为 omdsh-dev/dsh-advisor 让名），
//  sidecar 目录 $DSH_HOME/dsh-advisor/、消息标签 [advisor:*]、typert 契约 id
//  均为数据连续性保留旧名。)
//
// What this plugin contributes, all at the host layer:
//   1. the `ask_advisor` tool — one synchronous consultation with a second,
//      knowledge-rich model that returns ideas and knowledge, never steps;
//   2. the `advisor:guidance` prompt section — the consultation protocol
//      (when to call, explore-first ordering, bounded follow-ups);
//   3. the `ciel` settings namespace — edited from Settings → 夏尔 Ciel,
//      applied to later consultations after explicit Save, without restart;
//
// Every registered settings namespace is served to configuration pages, so
// the browser card pairs with `ciel` directly; the dormant `ciel` directory
// entry below exists only for Models-page presence (the same seam
// dsh-vision-router uses).

import Schema from '@deepseek-ai/schemastery'
// Resolved through the shared profiles node_modules fallback (the app's own
// dependency graph) — deliberately NOT declared in package.json so no second
// copy with its own registry state gets installed beside the app's.
import { createReviewOperation } from './review-operation.js'
import { detectSensitiveText } from './review-corpus.js'
import { userText } from './review-input.js'
import { listInbox, setInboxIntent } from './inbox-service.js'
import { AdvisorReviewService } from './review-service.js'
import { MODEL_USAGE_SCHEMA, createModelUsage, modelUsageSnapshot, captureModelUsage } from './model-usage.js'
import { outputText, childErrorDetail, criticExplorePersona, toolEventView, createReviewObserver, parseSuspectList, triageSuspects, parseOutcomeRows, recoverCitedDossier, reconcileReviewLedger, parseCriticReview, parseSuspectResponse, reviewCoverage, splitMarkdownBlocks, parseAdvisorItems, advisorTargets, turnEvidence } from './review-content.js'
import { gateFacts, reminderTextFor, createConsultationGate } from './advisor-state.js'
import { reviewsPath, readReviews, persistReview, persistCallModelUsage, readCallModelUsage, persistAdvice, readFeedbackTriage, appendFeedback } from './review-repository.js'

/** Cordis plugin name. */
export const name = 'dsh-ciel'

/** Advisor persona: the ideas-only output contract for the child agent. */
const ADVISOR_PERSONA =
  'You are a senior technical advisor consulted BEFORE planning begins. ' +
  'Offer: alternative problem framings, relevant domain knowledge and prior art, ' +
  'common pitfalls, cross-domain analogies, and the evaluation dimensions an ' +
  'expert would check. Output ideas and knowledge ONLY — never step-by-step ' +
  'plans, never code, never tool usage instructions. Output at most six items, ' +
  'each in EXACTLY this Markdown shape — field keys stay English verbatim, ' +
  'the content goes in the question\'s language:\n\n' +
  '## [high] short title\n' +
  'framing: the core direction or mechanism — one short paragraph\n' +
  'pitfalls: known failure modes of this direction — one short paragraph\n' +
  'verification_target: what the caller should verify against the environment\n\n' +
  'The tier tag is mandatory: [high] established domain consensus, [mid] ' +
  'grounded but context-dependent judgment, [low] extrapolation or ' +
  'cross-domain analogy — and never give numeric scores. If the question ' +
  'lies outside your reliable knowledge, say so plainly, tag the affected ' +
  'items [low], and never invent specific names, links, version numbers, or ' +
  'studies — cross-domain analogies from fields you do know remain welcome. ' +
  'You have no internet or environment access: ' +
  'if the question hinges on time-sensitive facts (versions, availability, ' +
  'pricing) the caller did not supply, declare that gap at the top of your ' +
  'answer.'

/** Guidance prompt section text: the consultation protocol for the caller. */
const GUIDANCE_TEXT =
  'You have an `ask_advisor` tool connected to a second model chosen for ' +
  'knowledge breadth. The advisor gives ideas, not plans; its value is ' +
  'diversity — directions your own priors would not sample first.\n\n' +
  'WHEN to consult (at most once per planning phase, and only for ' +
  'knowledge-heavy tasks): an open solution space (architecture, technology ' +
  'selection, data modeling, scene/aesthetic composition — several ' +
  'fundamentally different routes exist); ' +
  'an unfamiliar domain where your training knowledge is thin; a highly ' +
  'irreversible decision (migrations, external contracts); or a difficult ' +
  'diagnosis where ordinary approaches have already failed twice.\n\n' +
  'Do NOT consult when the answer is inside the environment (inspect the ' +
  'code instead), for mechanical pattern-fixed tasks, or for small tasks ' +
  'where one consultation costs more than the task itself. Judge the ' +
  'decision space, not the prompt length: a one-line request can hide a ' +
  'large open design, and a long spec can hide zero decisions. Do NOT ' +
  'consult about errors in a spec: factual conflicts go to evidence ' +
  '(inspect or verify yourself), tradeoff conflicts go to the user (ask or ' +
  'note in the plan); the advisor enters only when fixing the error reopens ' +
  'a design space.\n\n' +
  'HOW to consult: (1) Explore first — gather concrete environment facts ' +
  '(code structure, versions, constraints) BEFORE calling, and run any web ' +
  'lookups for time-sensitive facts yourself: the advisor has no internet ' +
  'access, so everything it needs must arrive in your context; if the domain ' +
  'is unfamiliar to you, do a short research pass first and pass the digest; ' +
  'ungrounded ' +
  'questions get generic answers. (2) One divergent consultation: pass the ' +
  'goal, the facts you found, and the constraints; expect framings, prior ' +
  'art, pitfalls, and evaluation dimensions — never steps. (3) Work ' +
  'independently: filter the ideas, verify each claim against the real ' +
  'environment (the advisor can hallucinate plausible knowledge), and sketch ' +
  'the plan yourself. (4) At most two targeted follow-ups per planning ' +
  'phase; each follow-up must carry NEW facts discovered since the last ' +
  'call and must ask a specific question. Never paste your draft plan back ' +
  'to the advisor — reviewing drafts is a different role. (5) Own the ' +
  'result: in the final plan, state which advisor ideas you adopted or ' +
  'rejected, and why.\n\n' +
  'If `ask_advisor` fails or its route is unavailable, plan on your own and ' +
  'note that the advisor was unavailable.'

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('允许 Ciel 顾问咨询、评审及准备批注草稿；批注须由用户手动发送。关闭取消本插件在途模型调用，不改变模型配置'),
  advisorTimeoutSeconds: Schema.number().step(1).min(10).max(600).default(180)
    .description('一次 ask_advisor 顾问咨询的总时限，秒；取消或超时不会自动重试'),
  criticTimeoutSeconds: Schema.number().step(1).min(10).max(600).default(180)
    .description('一次完整评审的总时限（秒，含准备资料、存疑和核实）；查询与模型请求次数只统计，超时停止，不自动重试'),
  // Legacy keys remain accepted so existing settings files still load.
  // They are hidden, have no defaults, and never affect a new review.
  criticMaxRequests: Schema.number().hidden()
    .description('旧版兼容字段，已停用：评审只按总时限控制执行预算'),
  criticMaxTokens: Schema.number().step(1).min(256).max(32768).default(16384)
    .description('每次模型响应的输出长度上限；存疑最多 4096。这是单条响应大小保护，不限制请求次数或整次评审用量'),
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
  criticProvider: Schema.string().default('google')
    .description('批评者路由的提供方（0.9.1 起可配；跨家族路由的纠错收益最高）'),
  criticModel: Schema.string().default('gemini-3.8-flash')
    .description('批评者模型 id'),
  criticEffort: Schema.union(['provider', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .default('medium')
    .description('批评者思考深度：provider 跟随提供方默认（不注入）；其余档位注入评审子代理的每个请求，模型不支持的档位会报错（gemini-3.8-flash 仅支持 low/medium/high）'),
  criticExploreEnabled: Schema.boolean().default(true)
    .description('探索型批评者（0.13.0）：评审时对可证伪疑点做只读定点核实（PTC run_code 内调用 read/grep/glob 快照工具，世界可碰、过程不许碰）；关闭后退回纯草稿裁决'),
  criticExploreBudget: Schema.number().hidden()
    .description('旧版兼容字段，已停用（包括旧值 0）；是否查文件只由 criticExploreEnabled 控制'),
  criticAdditionalRoots: Schema.array(Schema.string()).default([])
    .description('可选：额外允许评审查阅的源码目录，每项为绝对路径；不允许主目录、凭据或会话状态目录。默认仅当前项目。修改只影响后续评审'),
})

/**
 * ask_advisor canonical output: the caller model receives the raw prose
 * verbatim (render below — byte-identical to the pre-0.6.0 string result),
 * while the parsed structure rides tool/result.meta via presentationMeta.
 * Parse once in execute(); UI cards (M3-④) and the critic's rubric input
 * (M3-③ 输入三件套之"当时的顾问输出") then read the same items without
 * re-parsing — the UIR spine on the harness's own channel.
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
    },
    required: ['text', 'items', 'issues'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => ({ v: 1, items: value.items, issues: value.issues, ...(value.modelUsage ? { modelUsage: modelUsageSnapshot(value.modelUsage) } : {}) }),
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
    settings.register('advisor', Config)
  } catch {
    // Another plugin owns `advisor` (or the stored section is malformed
    // beyond schema repair) — nothing here is ours to move.
    return false
  }
  const legacyUser = settingsUserSection(settings, 'advisor')
  const cielUser = settingsUserSection(settings, 'ciel')
  if (Object.keys(legacyUser).length === 0 || Object.keys(cielUser).length > 0) return false
  await cielScope.update(legacyUser)
  return true
}

// Named exports for the unit tests (the loader only consumes apply/inject).
export {
  migrateLegacyAdvisorSettings,
  createModelUsage,
  captureModelUsage,
  modelUsageSnapshot,
  persistCallModelUsage,
  persistAdvice,
  readCallModelUsage,
  settingsUserSection,
  parseAdvisorItems,
  advisorTargets,
  userText,
  reviewsPath,
  readReviews,
  persistReview,
  splitMarkdownBlocks,
  parseCriticReview,
  criticExplorePersona,
  createReviewObserver,
  turnEvidence,
  parseSuspectList,
  parseSuspectResponse,
  parseOutcomeRows,
  recoverCitedDossier,
  reconcileReviewLedger,
  reviewCoverage,
  createReviewOperation,
  createConsultationGate,
  gateFacts,
  reminderTextFor,
  toolEventView,
  AdvisorReviewService,
  triageSuspects,
  appendFeedback,
  readFeedbackTriage,
  listInbox,
  setInboxIntent,
}

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
  let current = () => config
  const beginAdvisorCall = (signal) => {
    const operation = createReviewOperation({ timeoutMs: (current().advisorTimeoutSeconds ?? 180) * 1000, maxRequests: 1 })
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
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('ciel', Config, { base: config })
    current = () => scope.get()
    sctx.effect(
      () => () => {
        current = () => config
      },
      'dsh-ciel: settings fallback',
    )
    scope.watch(() => {
      resyncGuidance()
      if (current().enabled === false) for (const operation of activeOperations) operation.cancel('Ciel disabled')
    })

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
  ctx.on('agent/created', ({ agent }) => {
    const sp = agent && agent.ctx && agent.ctx.get('systemPrompt')
    if (sp === undefined) return
    sp.context({
      name: 'advisor:plan-reminder',
      order: 90,
      text: () => reminderTextFor(agent, current),
    })
  })

  // ── Models-page presence: one dormant directory entry so the deployment's
  // provider directory lists the advisor route beside the real providers
  // (settings namespaces themselves need no such help since every registered
  // namespace is served to configuration pages). The llm service is a sibling
  // row whose registration order is not ours to know, so this waits for it
  // through ctx.inject instead of reading it eagerly.
  ctx.inject(['llm'], (lctx) => {
    try {
      const directory = lctx.llm.registerConfigurableProviders([
        {
          provider: 'ciel',
          displayName: '夏尔 Ciel · 顾问（规划前咨询）',
          settingsNs: 'ciel',
          settingsPath: [],
        },
      ])
      lctx.effect(() => directory, 'dsh-ciel: configurable provider directory')
    } catch (error) {
      ctx.logger?.warn(
        'dsh-ciel: configurable provider registration failed: %s',
        error && error.message ? error.message : String(error),
      )
    }
  })

  // ── reasoning-effort injection. AgentOptions carries no effort field, so a
  // child built with an explicit provider/model selection runs at the
  // provider's default thinking behavior — which is what made
  // google/gemini-3.7-flash fail (pi-ai maps "no effort" to a MINIMAL
  // thinkingLevel; per the official thinking docs 3.7-flash supports only
  // low/medium/high and minimal returns an error, default On (medium)).
  // The `agent/request` waterfall reaches
  // every agent from this host scope and its payload carries the subject
  // agent, so one listener can pin the configured effort onto exactly the
  // live advisor children tracked below. `provider` (or an empty value)
  // leaves the request untouched.
  const liveAdvisorChildren = new Map()
  ctx.on('agent/request', async (payload, next) => {
    const agent = payload && payload.agent
    if (agent === undefined || !liveAdvisorChildren.has(agent.id)) return next()
    const operation = liveAdvisorChildren.get(agent.id)
    if (current().enabled === false) operation.cancel('Ciel disabled')
    operation.beforeRequest()
    const effort = current().reasoningEffort
    if (effort === undefined || effort === '' || effort === 'provider') return next()
    const resolved = await next()
    return { ...resolved, reasoningEffort: effort }
  })

  // ── M3-③ critic: effort pin for critic children, driven by the
  // criticEffort setting (0.9.1). Default 'medium' — the documented
  // gemini-3.7-flash default; 'low' was the 0.5.0 workaround for the MINIMAL
  // rejection and trades review quality for latency, which misannotations do
  // not repay. 'provider'/empty leaves the request untouched. The strict
  // Remote descriptors and the service itself follow.
  const liveCriticChildren = new Set()
  ctx.on('agent/request', async (payload, next) => {
    const agent = payload && payload.agent
    if (agent === undefined || !liveCriticChildren.has(agent.id)) return next()
    reviewService.coordinator.beforeRequest(agent.id)
    const effort = current().criticEffort
    if (effort === undefined || effort === '' || effort === 'provider') return next()
    const resolved = await next()
    return { ...resolved, reasoningEffort: effort }
  })
  // Strict descriptors into the typert registry — through ctx.inject because
  // the registry's mount time is not ours to know (bare ctx.get loses boot
  // races; observed live on this very composition).
  ctx.inject(['typert'], (tctx) => {
    tctx.effect(
      () => tctx.typert.register({
        package: 'dsh-advisor',
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: REVIEW_METHODS.map(reviewInvocation),
      }),
      'dsh-advisor: review remote descriptors',
    )
  })
  const reviewService = new AdvisorReviewService(ctx, liveCriticChildren, () => current(), activeOperations)
  ctx.inject(['tools'], (tctx) => {
    if (typeof tctx.tools.guard !== 'function') return
    tctx.tools.guard((exec) => {
      const advisor = liveAdvisorChildren.get(exec.agent?.id)
      if (advisor) { advisor.cancel('unexpected tool in advisor'); return 'advisor has no tools' }
      return reviewService.coordinator.guard(exec)
    })
    reviewService.coordinator.guardAvailable = true
    tctx.effect(() => () => {
      reviewService.coordinator.guardAvailable = false
      for (const operation of reviewService.coordinator.inFlight.values()) operation.cancel('tool guard unavailable')
    }, 'Ciel: review guard readiness')
  })

  // ── the ask_advisor tool. Each call is a fresh one-shot child on the spawn
  // provider: the stateless follow-up channel the consultation protocol
  // requires. Settings are read per call, so panel edits hot-apply.
  ctx.inject(['tools', 'subagents'], (tctx) => {
    tctx.tools.register({
      name: 'ask_advisor',
      description:
        'Consult a second, knowledge-rich model BEFORE planning. USE WHEN the task has an ' +
        'open design space (architecture, scene/aesthetic composition, technology ' +
        'selection, data modeling — several fundamentally different routes exist), ' +
        'touches an unfamiliar domain, carries an irreversible decision, or is a ' +
        'difficult diagnosis after ordinary approaches failed twice; SKIP mechanical, ' +
        'fully-specified, or small-scope tasks — judge the decision space, not the ' +
        'prompt length (a one-line request can hide a large open design). Do NOT ' +
        'consult about errors in a spec: factual conflicts go to evidence (inspect or ' +
        'verify yourself), tradeoff conflicts go to the user. The advisor has no ' +
        'internet: research unfamiliar domains and time-sensitive facts yourself ' +
        'first, then pass the goal, the established facts, and the constraints; ' +
        'receive framings, prior art, pitfalls, and evaluation dimensions — ideas ' +
        'only, never steps. At most one consultation per planning phase plus two ' +
        'follow-ups; follow-ups are separate calls, each with new facts and one ' +
        'specific question (never a draft plan). When you use its ideas, state ' +
        'which you adopted or rejected.',
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
        if (cfg.enabled === false) throw new Error('Ciel disabled')
        if (!reviewService.coordinator.guardAvailable) throw new Error('Ciel requires tools.guard() before model calls')
        // ── Mechanized negative gates (prompt text advises; these decide).
        // Gate order is cheapest-first; each error teaches the remedy.
        if (typeof args.context !== 'string' || args.context.trim() === '') {
          throw new Error(
            'context is required: pass the facts already established in the ' +
              'environment (explore first — ungrounded questions get generic answers)',
          )
        }
        if (detectSensitiveText(String(args.question || '')) || detectSensitiveText(args.context)) throw new Error('咨询输入含疑似凭据，未发送给顾问；请先去除敏感内容')
        const facts = gateFacts(parent)
        if (facts === undefined) {
          throw new Error('advisor telemetry unavailable; refusing an unmetered consultation')
        } else {
          if (cfg.requireExploration && !facts.explorationDone) {
            throw new Error(
              'explore first: no non-advisor tool call has run in this session yet. ' +
                'Inspect the environment (read/search/run) before consulting, then ' +
                'pass what you found in context',
            )
          }
          if (facts.settledThisTurn >= cfg.maxCallsPerTurn) {
            throw new Error(
              `advisor budget for this planning phase is exhausted ` +
                `(${facts.settledThisTurn}/${cfg.maxCallsPerTurn} consultations settled this turn). ` +
                'Work independently now; consult again in a later turn if genuinely new facts surface',
            )
          }
          if (cfg.enforceFollowupGap && facts.settledThisTurn > 0 && !facts.workSinceLast) {
            throw new Error(
              'follow-ups must be driven by NEW facts: run at least one independent ' +
                'step (read/search/run) since the last consultation before calling again',
            )
          }
        }
        const consultation = `Established facts and constraints:\n${args.context.trim()}\n\nQuestion:\n${args.question}`
        const release = consultationGate.reserve(parent, facts, cfg.maxCallsPerTurn)
        const owned = beginAdvisorCall(exec.signal)
        let run
        try {
          owned.operation.check()
          run = await tctx.subagents.start('spawn', {
          label: 'advisor',
          parent,
          signal: owned.operation.signal,
          prompt: [{ type: 'text', text: consultation }],
          agentOptions: {
            provider: cfg.provider,
            model: cfg.model,
            maxTokens: cfg.maxTokens,
          },
          persona: ADVISOR_PERSONA,
          // Absolute delegation-depth cap: each start requires the child's
          // computed depth (caller depth + 1) <= maxDepth. 0 forbids ANY
          // delegation from a top-level session ("child depth 1 exceeds
          // maxDepth 0"); 1 admits the advisor (depth 1) while forbidding
          // the advisor's own children (depth 2).
          maxDepth: 1,
          // The advisor never touches tools: time-sensitive facts are the
          // CALLER's job (search first, pass findings in context) — grounding
          // stays single-owner, and the advisor's diversity is not re-anchored
          // to the same web consensus the caller would find.
          toolFilter: { allow: [] },
        })
        // The published handle is tracked before its first request.
        liveAdvisorChildren.set(run.id, owned.operation)
        const childTools = run.localAgent?.ctx?.get('tools')
        if (typeof childTools?.presentAs === 'function') childTools.presentAs('native')
          const result = await run.result
          owned.operation.check()
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            const detail = result.stopReason === 'error' ? childErrorDetail(run) : ''
            throw new Error(
              `advisor consultation ended with "${result.stopReason}"` +
                (detail === '' ? '' : `: ${detail}`) +
                (text === '' ? '' : `; partial answer:\n${text}`),
            )
          }
          const answer = text === '' ? 'The advisor returned an empty answer.' : text
          const parsed = parseAdvisorItems(answer)
          captureModelUsage(modelUsage, run)
          try { await persistAdvice(parent.id, 'tool', exec.callId, answer, modelUsage, owned.operation) }
          catch { owned.operation.check(); ctx.logger?.warn('Ciel: advisor sidebar record could not be saved') }
          return { text: answer, items: parsed.items, issues: parsed.issues, modelUsage: modelUsageSnapshot(modelUsage) }
        } finally {
          try {
            if (run) { captureModelUsage(modelUsage, run); liveAdvisorChildren.delete(run.id); await run.dispose() }
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
