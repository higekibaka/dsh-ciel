// Ciel: planning advisor, with optional context checks and read-only history.
import Schema from '@deepseek-ai/schemastery'
import { ADVISOR_METHODS, advisorInvocation, ADVISOR_JEV_SCHEMA } from './advisor-protocol.js'
import { createAdvisorOperation } from './advisor-operation.js'
import { detectSensitiveText } from './sensitive-text.js'
import { prepareAdvisorJev, checkAdvisorWithJev, renderAdvisorJev } from './jev-advisor.js'
import { JEV_MODEL, JEV_ENDPOINT, JEV_MODEL_PATTERN, JEV_KEY_PATTERN, JEV_ENDPOINT_PATTERN, jevConnection } from './jev-config.js'
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
  jevApiKey: Schema.string().max(4096).pattern(JEV_KEY_PATTERN).role('secret')
    .description('Jev API 密钥；保存在本机 DSH 配置，设置读取不回传原值。未配置时回退到 TYPESAFE_API_KEY（仅官方接口），不是加密保险库'),
  jevEndpoint: Schema.string().max(2048).pattern(JEV_ENDPOINT_PATTERN).default(JEV_ENDPOINT)
    .description('Jev 完整 HTTPS 接口地址，不追加路径；必须兼容 TypeSafe systemone 协议。自定义地址会收到密钥和检查原文，须另填密钥，不复用环境变量'),
  jevModel: Schema.string().pattern(JEV_MODEL_PATTERN).default(JEV_MODEL)
    .description('顾问建议检查的 Jev 模型 ID；保存后下次检查使用'),
  advisorJevEnabled: Schema.boolean().default(false)
    .description('顾问回答后用 Jev 对照本次问题和背景检查建议；将这些内容发送给 TypeSafe，产生额外 API 用量。独立开关，默认关闭；仅检查背景一致性，不独立核实事实，不改写建议。关闭取消在途检查'),
}
const LegacyConfig = Schema.object(configFields)
export const Config = Schema.object(Object.fromEntries(Object.entries(configFields).map(([key, field]) => [key,
  typeof field.volatile === 'function' ? field.volatile() : field])))

/**
 * ask_advisor keeps the raw prose unchanged. When enabled, the caller model
 * also receives a separately labeled Jev context check before that prose,
 * while the parsed structure rides tool/result.meta via presentationMeta.
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
      jev: ADVISOR_JEV_SCHEMA,
    },
    required: ['text', 'items', 'issues'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: (value.jev ? renderAdvisorJev(value.jev) + '\n\n' : '') + value.text }],
  presentationMeta: (_args, value) => ({ v: 1, items: value.items, issues: value.issues, ...(value.modelUsage ? { modelUsage: modelUsageSnapshot(value.modelUsage) } : {}), ...(value.jev ? { jev: value.jev } : {}) }),
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
  const advisorJevControllers = new Set()
  const settingsChanged = () => {
    resyncGuidance()
    if (current().enabled === false) for (const operation of activeOperations) operation.cancel('Ciel disabled')
    if (current().advisorJevEnabled !== true) for (const controller of advisorJevControllers) controller.abort()
  }
  ctx.on('loader/volatile-update', settingsChanged)
  ctx.inject(['settings'], (sctx) => {
    if (typeof sctx.settings.configure === 'function') {
      if (!Config.dict.advisorJevEnabled.meta.volatile) throw new Error('Ciel settings on DSH 0.1.7 require @deepseek-ai/schemastery >=3.18.3')
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
      const operation = liveAdvisorChildren.get(exec.agent?.id)
      if (operation) { operation.cancel('unexpected tool in advisor'); return 'advisor has no tools' }
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
        if (cfg.enabled === false) throw new Error('Ciel disabled')
        if (!advisorGuardAvailable) throw new Error('Ciel requires tools.guard() before model calls')
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
          let jev
          if (cfg.advisorJevEnabled === true) {
            const controller = new AbortController()
            advisorJevControllers.add(controller)
            try {
              jev = await checkAdvisorWithJev({
                ...jevConnection(current()),
                prepared: prepareAdvisorJev({ question: args.question, context: args.context, text: answer, items: parsed.items }),
                enabled: current().advisorJevEnabled === true && current().enabled !== false,
                signal: AbortSignal.any([owned.operation.signal, controller.signal]),
                timeoutMs: Math.min(10000, owned.operation.remainingMs() - 1000),
                beforeRequest: () => owned.operation.check(),
              })
            } finally { advisorJevControllers.delete(controller) }
            owned.operation.check()
          }
          try { await persistAdvice(parent.id, 'tool', exec.callId, answer, modelUsage, owned.operation, jev) }
          catch { owned.operation.check(); ctx.logger?.warn('Ciel: advisor sidebar record could not be saved') }
          return { text: answer, items: parsed.items, issues: parsed.issues, modelUsage: modelUsageSnapshot(modelUsage), ...(jev ? { jev } : {}) }
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
