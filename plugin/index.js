// dsh-advisor host half: a pre-planning advisor for DeepSeek Harness agents.
//
// What this plugin contributes, all at the host layer:
//   1. the `ask_advisor` tool — one synchronous consultation with a second,
//      knowledge-rich model that returns ideas and knowledge, never steps;
//   2. the `advisor:guidance` prompt section — the consultation protocol
//      (when to call, explore-first ordering, bounded follow-ups);
//   3. the `advisor` settings namespace — edited from Settings → Plugins →
//      dsh-advisor, hot-applied to every later consultation without restart.
//
// The settings namespace reaches the browser through the model-provider
// exposure path: the API proxy serves exactly the configurable-provider
// namespaces, so this plugin registers a dormant `advisor` directory entry
// whose settingsNs is this namespace (the same seam dsh-vision-router uses).

import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'dsh-advisor'

/** Advisor persona: the ideas-only output contract for the child agent. */
const ADVISOR_PERSONA =
  'You are a senior technical advisor consulted BEFORE planning begins. ' +
  'Offer: alternative problem framings, relevant domain knowledge and prior art, ' +
  'common pitfalls, cross-domain analogies, and the evaluation dimensions an ' +
  'expert would check. Output ideas and knowledge ONLY — never step-by-step ' +
  'plans, never code, never tool usage instructions. Keep each idea to one ' +
  'short paragraph, at most six items total. Tag every item with a confidence ' +
  'tier — [high] established domain consensus, [mid] grounded but ' +
  'context-dependent judgment, [low] extrapolation or cross-domain analogy — ' +
  'and never give numeric scores. If the question lies outside your reliable ' +
  'knowledge, say so plainly, tag the affected items [low], and never invent ' +
  'specific names, links, version numbers, or studies — cross-domain analogies ' +
  'from fields you do know remain welcome. You have no internet or environment ' +
  'access: ' +
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
  provider: Schema.string().default('kimi-coding')
    .description('顾问模型的提供方路由（须是设置 → 模型 中已注册的 provider）'),
  model: Schema.string().default('kimi-for-coding')
    .description('顾问模型 id；跨家族模型多样性收益更大'),
  maxTokens: Schema.number().min(256).max(32768).default(4096)
    .description('顾问单次回答的输出上限'),
  maxCallsPerTurn: Schema.number().min(1).max(20).default(3)
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
})

/** Shared string-output contract for the tool definition. */
const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** Flatten a subagent result's output blocks into one plain-text answer. */
function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** Collapse whitespace and clip a diagnostic string to one readable line. */
function clip(text, max = 300) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/**
 * Unwrap nested provider envelopes (`{"error":{"message":"{\"error":…"}}}` —
 * adapters sometimes stringify an upstream body into their own message) down
 * to the innermost plain message, then clip it.
 */
function unwrapErrorMessage(message) {
  let text = String(message === undefined || message === null ? '' : message)
  for (let depth = 0; depth < 3; depth += 1) {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{')) break
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      break
    }
    const inner = parsed && typeof parsed === 'object'
      ? (parsed.error && parsed.error.message !== undefined ? parsed.error.message : parsed.message)
      : undefined
    if (typeof inner !== 'string' || inner === text) break
    text = inner
  }
  return clip(text)
}

/**
 * Best-effort terminal-error detail from a one-shot child's own log. The run
 * result carries only a stopReason, but the child records `turn/end` with the
 * model/transport failure before the run settles, and `run.localAgent` keeps
 * the session reachable until disposal. Reads leaf fields only; any shape
 * surprise degrades to the bare stopReason, never to a secondary failure.
 */
function childErrorDetail(run) {
  const agent = run.localAgent
  if (agent === undefined) return ''
  let events
  try {
    events = agent.session.events
  } catch {
    return ''
  }
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'turn/end') continue
    const reason = event.data && event.data.reason
    if (reason && reason.kind === 'error' && reason.error !== undefined) {
      const message = typeof reason.error === 'object' && reason.error !== null
        ? reason.error.message
        : reason.error
      return unwrapErrorMessage(message)
    }
    return ''
  }
  return ''
}

/**
 * Consultation-gate facts, read STATELESSLY from the caller's own session log
 * (no plugin-side ledger to leak or reset): how many advisor calls already
 * settled this turn, whether any non-advisor tool ever ran in the session,
 * and whether independent work happened after the last settled consultation.
 * A call counts once its tool/result lands, so the in-flight call never gates
 * itself, and failed consultations still consume budget (no retry storms).
 * Telemetry surprises degrade to `undefined` — gates fail OPEN to the
 * prompt-layer protocol, never to a phantom rejection.
 */
function gateFacts(parent) {
  try {
    const session = parent && parent.session
    const events = session && session.events
    if (!Array.isArray(events)) return undefined
    let turnStart = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index] && events[index].type === 'turn/start') {
        turnStart = index
        break
      }
    }
    const thisTurn = turnStart < 0 ? events : events.slice(turnStart)
    const callName = (event) =>
      event && event.type === 'tool/call' && event.data ? event.data.name : undefined
    const isAdvisorCall = (event) => callName(event) === 'ask_advisor'
    const isWorkCall = (event) => {
      const name = callName(event)
      return name !== undefined && name !== 'ask_advisor'
    }
    const settledIds = new Set()
    for (const event of events) {
      if (!event || event.type !== 'tool/result') continue
      const content = event.data && event.data.message && event.data.message.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part && part.type === 'tool-result' && typeof part.toolCallId === 'string') {
          settledIds.add(part.toolCallId)
        }
      }
    }
    let settledThisTurn = 0
    let lastSettledAdvisor = -1
    thisTurn.forEach((event, index) => {
      if (isAdvisorCall(event) && settledIds.has(event.data.callId)) {
        settledThisTurn += 1
        lastSettledAdvisor = index
      }
    })
    return {
      settledThisTurn,
      explorationDone: events.some(isWorkCall),
      workSinceLast: lastSettledAdvisor < 0 || thisTurn.slice(lastSettledAdvisor + 1).some(isWorkCall),
    }
  } catch {
    return undefined
  }
}

/** One-shot reminder rendered by the agent-scoped context when planning starts unconsulted. */
const PLAN_REMINDER_TEXT =
  '[advisor:plan-reminder] Planning has started in this turn and the advisor ' +
  'has not been consulted. If this task involves an open design space, an ' +
  'unfamiliar domain, an irreversible decision, or a difficult diagnosis — ' +
  'and the task is bigger than one consultation round-trip — call ' +
  'ask_advisor now with the facts you have gathered. Judge the decision ' +
  'space, not the prompt length: a one-line request can hide a large open ' +
  'design. If the task is mechanical or fully specified, ignore this reminder.'

/**
 * Self-evaluating text for the per-agent reminder context: the reminder string
 * exactly when this turn shows a planning signal with no consultation and no
 * reminder yet, `''` (excluded from the snapshot) otherwise. Every condition
 * reads the durable session log, including the reminder's own
 * `[advisor:plan-reminder]` marker in an earlier snapshot — at-most-once per
 * turn, immune to compaction and process restarts; any surprise hides the
 * reminder rather than blocking a request.
 */
function reminderTextFor(agent, current) {
  try {
    if (!current().planReminderEnabled) return ''
    const events = agent.session && agent.session.events
    if (!Array.isArray(events)) return ''
    let turnStart = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index] && events[index].type === 'turn/start') {
        turnStart = index
        break
      }
    }
    if (turnStart < 0) return ''
    let planning = false
    for (let index = turnStart; index < events.length; index += 1) {
      const event = events[index]
      if (!event) continue
      if (event.type === 'tool/call' && event.data) {
        if (event.data.name === 'ask_advisor') return ''
        if (event.data.name === 'todo_write' || event.data.name === 'exit_plan_mode') planning = true
      } else if (event.type === 'user/message') {
        const content = event.data && event.data.content
        if (
          Array.isArray(content) &&
          content.some(
            (part) => part && typeof part.text === 'string' && part.text.includes('[advisor:plan-reminder]'),
          )
        ) {
          return ''
        }
      }
    }
    return planning ? PLAN_REMINDER_TEXT : ''
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  // ── settings seam: the resolved `advisor` section (schema defaults over the
  // composition entry over the user document) feeds every later consultation.
  // Wired through ctx.inject so the plugin still activates when the settings
  // service is absent (the composition config then stands alone).
  let current = () => config
  let resyncGuidance = () => {}
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('advisor', Config, { base: config })
    current = () => scope.get()
    sctx.effect(
      () => () => {
        current = () => config
      },
      'dsh-advisor: settings fallback',
    )
    scope.watch(() => resyncGuidance())
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
      if (current().guidanceEnabled) {
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

  // ── namespace exposure: the API proxy serves settings describe/mutate only
  // for configurable-provider namespaces (plus a fixed product allowlist), so
  // the Web card finds `advisor` through this dormant directory entry. The llm
  // service is a sibling row whose registration order is not ours to know, so
  // this waits for it through ctx.inject instead of reading it eagerly.
  ctx.inject(['llm'], (lctx) => {
    try {
      const directory = lctx.llm.registerConfigurableProviders([
        {
          provider: 'advisor',
          displayName: '顾问（规划前咨询）',
          settingsNs: 'advisor',
          settingsPath: [],
        },
      ])
      lctx.effect(() => directory, 'dsh-advisor: configurable provider directory')
    } catch (error) {
      ctx.logger?.warn(
        'dsh-advisor: configurable provider registration failed: %s',
        error && error.message ? error.message : String(error),
      )
    }
  })

  // ── reasoning-effort injection. AgentOptions carries no effort field, so a
  // child built with an explicit provider/model selection runs at the
  // provider's default thinking behavior — which is what made
  // google/gemini-3.7-flash fail (pi-ai maps "no effort" to a MINIMAL
  // thinkingLevel that model rejects). The `agent/request` waterfall reaches
  // every agent from this host scope and its payload carries the subject
  // agent, so one listener can pin the configured effort onto exactly the
  // live advisor children tracked below. `provider` (or an empty value)
  // leaves the request untouched.
  const liveAdvisorChildren = new Set()
  ctx.on('agent/request', async (payload, next) => {
    const agent = payload && payload.agent
    if (agent === undefined || !liveAdvisorChildren.has(agent.id)) return next()
    const effort = current().reasoningEffort
    if (effort === undefined || effort === '' || effort === 'provider') return next()
    const resolved = await next()
    return { ...resolved, reasoningEffort: effort }
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
      output: stringOutput,
      async execute(args, exec) {
        const parent = exec && exec.agent
        if (parent === undefined) {
          throw new Error('ask_advisor requires a calling agent (exec.agent was undefined)')
        }
        const cfg = current()
        // ── Mechanized negative gates (prompt text advises; these decide).
        // Gate order is cheapest-first; each error teaches the remedy.
        if (typeof args.context !== 'string' || args.context.trim() === '') {
          throw new Error(
            'context is required: pass the facts already established in the ' +
              'environment (explore first — ungrounded questions get generic answers)',
          )
        }
        const facts = gateFacts(parent)
        if (facts === undefined) {
          if (ctx.logger && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn('dsh-advisor: session telemetry unreadable; consultation gates fail open')
          }
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
        const run = await tctx.subagents.start('spawn', {
          label: 'advisor',
          parent,
          signal: exec.signal,
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
        // Track before the first child request can race: publication resolves
        // start() before the prompt followup reaches the child's loop.
        liveAdvisorChildren.add(run.id)
        try {
          const result = await run.result
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            const detail = result.stopReason === 'error' ? childErrorDetail(run) : ''
            throw new Error(
              `advisor consultation ended with "${result.stopReason}"` +
                (detail === '' ? '' : `: ${detail}`) +
                (text === '' ? '' : `; partial answer:\n${text}`),
            )
          }
          return text === '' ? 'The advisor returned an empty answer.' : text
        } finally {
          liveAdvisorChildren.delete(run.id)
          await run.dispose()
        }
      },
    })
  })
}
