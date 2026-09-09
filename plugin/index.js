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
//   4. the `/advise` human command — auto-assembled context, card render,
//      steer re-injection (0.10.0).
//
// Every registered settings namespace is served to configuration pages, so
// the browser card pairs with `ciel` directly; the dormant `ciel` directory
// entry below exists only for Models-page presence (the same seam
// dsh-vision-router uses).

import Schema from '@deepseek-ai/schemastery'
// Resolved through the shared profiles node_modules fallback (the app's own
// dependency graph) — deliberately NOT declared in package.json so no second
// copy with its own registry state gets installed beside the app's.
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createReviewCorpus, detectSensitiveText } from './review-corpus.js'
import { createRestrictedReviewProvider } from './review-runner.js'
import { createEvidenceLedger, evidenceCorpus, evidenceRefs, groundReview } from './review-evidence.js'
import { recordRoot, writeRecord, readRecord, listRecords, listRecordsPage, RECORD_SCHEMA_VERSION } from './record-store.js'

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
    .description('一次顾问咨询（含 /advise）的总时限，秒；取消或超时不会自动重试'),
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

/** Owned per-call provenance. Requested settings are never treated as execution evidence. */
const MODEL_ROUTE_SCHEMA = {
  type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } },
  required: ['provider', 'model'], additionalProperties: false,
}
const MODEL_USAGE_SCHEMA = {
  type: 'object', properties: { requested: MODEL_ROUTE_SCHEMA, used: { type: 'array', items: MODEL_ROUTE_SCHEMA } },
  required: ['used'], additionalProperties: false,
}
function modelRoute(provider, model) {
  const valid = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
  return valid(provider) && valid(model) ? { provider: provider.trim(), model: model.trim() } : undefined
}
function createModelUsage(provider, model) {
  const requested = modelRoute(provider, model)
  return { ...(requested ? { requested } : {}), used: [] }
}
function modelUsageSnapshot(usage) {
  const requested = modelRoute(usage?.requested?.provider, usage?.requested?.model)
  const used = [], seen = new Set()
  for (const item of Array.isArray(usage?.used) ? usage.used : []) {
    const route = modelRoute(item?.provider, item?.model)
    if (!route) continue
    const key = route.provider + '\u0000' + route.model
    if (seen.has(key)) continue
    seen.add(key); used.push(route)
    if (used.length >= 32) break
  }
  return { ...(requested ? { requested } : {}), used }
}
function captureModelUsage(usage, run) {
  try {
    for (const event of sessionEvents(run?.localAgent?.session) || []) {
      if (event?.type !== 'assistant/message') continue
      const source = event.data?.message?.source
      if (source?.kind !== 'model') continue
      const route = modelRoute(source.provider, source.model)
      if (route && !usage.used.some((item) => item.provider === route.provider && item.model === route.model) && usage.used.length < 32) usage.used.push(route)
    }
  } catch { /* Unavailable execution evidence stays requested-only; never infer settings. */ }
  return modelUsageSnapshot(usage)
}

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
 * /advise 的上下文自动装配（P3，advcmd 原型移植）：倒序扫会话事件，取最近
 * ≤8 条用户/助手可见文本，总量封顶 ~1800 字符（与 ask_advisor 的 context
 * 参数同级预算）。只读叶字段，任何一步异常都降级为空串而不是炸掉命令。
 */
function assembleAdviseContext(agent) {
  try {
    const session = agent && agent.session
    const events = sessionEvents(session)
    if (!Array.isArray(events)) return ''
    const parts = []
    let budget = 1800
    for (let i = events.length - 1; i >= 0 && budget > 0 && parts.length < 8; i -= 1) {
      const ev = events[i]
      if (!ev || !ev.data) continue
      let role = null
      if (ev.type === 'user/message') role = '用户'
      else if (ev.type === 'assistant/message') role = '助手'
      if (role === null) continue
      const text = userText(ev)
      if (text === '') continue
      const clipped = clip(text, Math.min(400, budget))
      if (clipped === '') continue
      parts.unshift(role + '：' + clipped)
      budget -= clipped.length
    }
    return parts.join('\n')
  } catch {
    return ''
  }
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
    events = sessionEvents(agent.session)
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
 * Consultation inputs reconstructed from the caller's session log, augmented
 * by createConsultationGate's in-memory reservations: calls already settled
 * this turn, whether any non-advisor tool ever ran in the session,
 * and whether independent work happened after the last settled consultation.
 * A call counts once its tool/result lands, so the in-flight call never gates
 * itself. Only REAL consultations count: a call rejected by one of these
 * gates (a form error, not a consultation) neither burns budget nor arms the
 * follow-up gap — observed live, where an empty-context rejection poisoned
 * the model's immediate, correctly-filled retry. A call that passed the gates
 * and then failed at the provider still counts (no retry storms). Telemetry
 * surprises return `undefined`; new consultations fail closed rather than
 * spending against an unknown budget.
 */
const GATE_REJECTION_HEAD = /^(?:Error: )?(?:context is required:|explore first:|follow-ups must be driven by NEW facts:|advisor budget for this planning phase is exhausted|advisor consultation already in flight|advisor telemetry unavailable|咨询输入含疑似凭据|Ciel disabled|Ciel requires tools\.guard)/

function gateFacts(parent) {
  try {
    const session = parent && parent.session
    const events = sessionEvents(session)
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
      return name !== undefined && name !== 'ask_advisor' && name !== 'run_code'
    }
    const resultHeads = new Map()
    for (const event of events) {
      if (!event || event.type !== 'tool/result') continue
      const content = event.data && event.data.message && event.data.message.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part && part.type === 'tool-result' && typeof part.toolCallId === 'string') {
          const text = (Array.isArray(part.content) ? part.content : [])
            .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
            .join('')
          resultHeads.set(part.toolCallId, text.slice(0, 160))
        }
      }
    }
    let settledThisTurn = 0
    let lastSettledAdvisor = -1
    thisTurn.forEach((event, index) => {
      if (!isAdvisorCall(event)) return
      const head = resultHeads.get(event.data.callId)
      if (head === undefined || GATE_REJECTION_HEAD.test(head)) return
      settledThisTurn += 1
      lastSettledAdvisor = index
    })
    return {
      turnKey: turnStart < 0 ? 'no-turn' : (events[turnStart].seq ?? events[turnStart].data?.turn ?? turnStart),
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
    if (current().enabled === false || !current().planReminderEnabled) return ''
    const events = sessionEvents(agent.session)
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

// ═══════════════════════ M3-③ 批评者：锚定批注评审 ═══════════════════════
// Ported from the live-tested annrev dynamic prototype (prototypes/
// annotation-review). The browser button calls the `advisorReview` Remote
// namespace below; every review persists to a per-session sidecar JSONL
// store (see persistReview) and hydrates back across restarts.
//
// 0.9.1: the critic route is CONFIGURABLE (criticProvider/criticModel/
// criticEffort in the advisor settings namespace) — the hard-coded constants
// became a defect the day gemini-3.7-flash returned 503 under load and the
// user found no knob that reached the critic (the card only drove the
// advisory route). Cross-family routing stays the design default; the
// settings description says so.

/** Critic persona: convergent red-line annotations, visible text only. */
const CRITIC_NO_TOOLS_CLAUSE =
  'You have NO tools: never plan or attempt tool calls; judge from the ' +
  'draft, the provided evidence, and your own knowledge.'

const CRITIC_PERSONA =
  'You are a convergent plan critic. You receive a DRAFT (a reply a model ' +
  'is about to show the user), the REQUEST it answers, and the VERDICT-LEVEL ' +
  'tool activity of the turn that produced it. Your only job is to find what ' +
  'is wrong, missing, or unverified in the draft — red-line annotations, ' +
  'never a rewrite, never an alternative plan of your own. ' +
  CRITIC_NO_TOOLS_CLAUSE + ' Your deliverable is your VISIBLE reply ' +
  'text — private reasoning without a visible answer is a failed review. ' +
  'Open your reply with the verdict header, then one annotation per issue, ' +
  'each field on its own line:\n\n' +
  '## verdict: pass\n' +
  'summary: one-sentence overall judgment of the draft\n\n' +
  '### [blocker] short title\n' +
  'block: b2\n' +
  'anchor: a verbatim quote copied character-for-character from THAT block\n' +
  'comment: what is wrong or missing, and why it matters\n\n' +
  'The verdict is "pass" when no blocker is found (nits allowed) and ' +
  '"changes" when at least one blocker exists. The block field names the ' +
  'draft block from the BLOCK MAP (provided with the draft) that carries ' +
  'the issue; quote the anchor from inside that same block — omit the ' +
  'anchor when the whole block is the issue, and never invent one.\n\n' +
  'Severity: [blocker] means acting on the draft without fixing this is ' +
  'likely to fail or cause real damage; [nit] means worth fixing but not ' +
  'blocking. Rules: at most 8 annotations — most good reviews need 1-4; ' +
  'every annotation spends the reader\'s attention, and a wrong or vacuous ' +
  'one costs more than a missing one. Every anchor MUST be an exact ' +
  'substring of the draft (copy it, never paraphrase, never translate). ' +
  'The anchor quotes ONLY the draft section — NEVER the request or the ' +
  'tool-activity evidence: those are context, citable inside the comment, ' +
  'never anchorable. ' +
  'Write every title and comment in the SAME LANGUAGE as the draft (a ' +
  'Chinese draft gets Chinese annotations). Critique the draft itself, not ' +
  'the topic in general; no compliments, no summaries, no step-by-step ' +
  'fixes — name the problem and the reason, the author owns the remedy. ' +
  'When the provided evidence supports an annotation, cite it (the request ' +
  'text, or which tool result showed what). Missing evidence is NOT a ' +
  'defect, even for a load-bearing claim. A turn-local digest is incomplete: ' +
  'no matching test/action in it does not prove non-execution or fabrication. ' +
  'Do not turn unknowns into conditional warnings or nits. Require positive ' +
  'contradictory evidence for a defect; leave unresolved claims unverified. ' +
  'Product facts about this environment ' +
  'you may rely on — never second-guess them: the chat UI supports image ' +
  'attachments (users can paste screenshots); replies render in a web UI ' +
  'whose action area can carry plugin-registered buttons and cards, and ' +
  'plugins can add inline marks (underlines, badges) to rendered text; ' +
  'session history persists across restarts; static host-bundle plugins ' +
  'take effect only after a DSH restart while dynamic Cordis packages ' +
  'hot-swap without one. If the draft is sound, use the pass verdict ' +
  'header and a one-sentence summary in the draft\'s language, ' +
  'plus at most 3 [nit] annotations for concrete, evidenced nonblocking defects, not unknowns.'

/** Advisor targets nominate checks, never prove that the author skipped them. */
const RUBRIC_ADDENDUM =
  '\n\nADVISOR VERIFICATION LIST: when present, this list supplies targets ' +
  'to verify against the world, NOT evidence of an author mistake. The ' +
  'tool digest covers ONLY the current turn and may be clipped or withheld; ' +
  'continuation replies can summarize earlier work without repeating tests. ' +
  'NEVER infer non-execution, fabricated results, or a skipped obligation ' +
  'from absent tool activity. A matching command name alone also does not ' +
  'prove success: use its actual result if provided. If the available ' +
  'evidence cannot settle a target, it remains unchecked, not an annotation. ' +
  'An older report or a DIFFERENT test suite is not a contradiction of a ' +
  'newer run: compare artifact, suite, scope and run identity before using ' +
  'counts as counter-evidence. A missing search hit or unavailable report ' +
  'in the restricted snapshot does not prove the report/run never existed. ' +
  'Do not demand access to author process or session history to resolve it. ' +
  'Positive evidence of an actual contradiction may still justify a defect.'

const CRITIC_PROMPT_SUFFIX =
  '\n\nWrite the verdict header and annotations now as your visible reply. ' +
  'You have no tools; judge from the draft and the provided request/tool ' +
  'evidence.'

/**
 * 契约 v4（0.15.0）两阶段显式化：阶段 1「存疑」独立成无工具 spawn，只交
 * 结构化疑点清单——阶段边界由编排强制（根治单回合步骤塌缩），清单随后
 * 经 host 按 bearing 排序，全部送入核实；不再按查询次数截取清单。
 * 阶段 2 沿用只读工具条款替换（同一常量拼装，replace 恒命中）。
 */
const CRITIC_SUSPECT_PERSONA =
  'You are phase 1 (SUSPECT) of a two-phase convergent review. You receive ' +
  'a DRAFT (a reply a model is about to show the user), the REQUEST it ' +
  'answers, and a block map of the draft. Author tool evidence and advisor ' +
  'opinions are intentionally withheld until phase 2. List every suspicion worth falsifying ' +
  'about the draft: concrete factual assertions about the world (counts, ' +
  'sizes, versions, paths, quotes, behavior) — EVEN when hedged as ' +
  'estimates or from-memory guesses; claims of having run, tested, or ' +
  'verified something that phase 2 should cross-check against evidence; load-bearing ' +
  'omissions a reader would act on. You have NO tools: never plan or ' +
  'attempt tool calls. NO verdicts, NO fixes, NO commentary — suspicions ' +
  'only; a suspicion is not a defect, phase 2 will settle each. You ' +
  'NOMINATE, you do not judge: a claim that appears well supported in the ' +
  'draft is STILL a suspect when it is concrete and load-bearing — ' +
  'settling (confirm OR falsify) is phase 2\'s job, and a confirmation ' +
  'is a verdict too. When in doubt, list it. At most ' +
  '8 suspects, most drafts need 1-4; zero is a valid answer. Output ONLY ' +
  'this format, one per line:\n\n' +
  '## suspects\n' +
  '- suspect: <one line, in the draft\'s language> | block: bN | bearing: high|low | falsify: <cheapest way to settle it, one line>\n\n' +
  'The block names the draft block carrying the suspect claim (from the ' +
  'block map; omit only when the whole draft is the issue). bearing:high ' +
  'means the user\'s next action collapses if the claim is false. When ' +
  'nothing is falsifiable, output the header alone.'

const CRITIC_SUSPECT_PROMPT_SUFFIX =
  '\n\nList the suspects now in the specified format — nothing else.'

/** 阶段 2 契约：清单驱动核实 + dossier/verdict 两段（v3 全部纪律继承）。 */
const VERIFICATION_LEDGER_CONTRACT =
  '\n\nRESULT CONTRACT (v4.1, authoritative over earlier formatting rules): ' +
  'Each selected suspect has a HOST-ASSIGNED id such as s1. Return exactly ' +
  'one result row per SELECTED id. NEVER invent ids, add new suspects, or ' +
  'return annotations for a withheld, cleared, or unchecked suspect. ' +
  'The host computes all counts; do NOT output a stats line. Use exactly:\n\n' +
  '## dossier\n' +
  '- result: s1 | outcome: cleared | evidence: <host evidence IDs, e.g. e1>\n' +
  '- result: s2 | outcome: defect | evidence: <host evidence IDs, e.g. e2>\n' +
  '- result: s3 | outcome: unchecked | evidence: none\n\n' +
  '## verdict: pass|changes\n' +
  'summary: <one sentence>\n\n' +
  '### [blocker] title\n' +
  'suspect: s2\n' +
  'block: b2\n' +
  'evidence: <the same host evidence IDs for s2>\n' +
  'anchor: <verbatim quote from that suspect\'s draft block>\n' +
  'comment: <the defect and why it matters>\n\n' +
  'Only defect results may have annotations (blocker or nit), and every ' +
  'defect must have an annotation. A TRUE draft claim is cleared, NOT a ' +
  'defect. Unchecked means evidence did not settle the suspicion; it ' +
  'MUST NOT become a conditional risk, warning, suggestion or nit. ' +
  'Never relabel an unchecked/withheld claim with another suspect id. ' +
  'Settled outcomes require comma-separated HOST evidence IDs (e1,e2 or a1), not free-form paths or invented quotes. read/grep/glob results are JSON strings: JSON.parse them and cite only the returned evidence_refs, quoting the original relevant snippet with its path and line span and surfacing any truncated/limited flag instead of inventing content. Explain the inference in the annotation comment, not the evidence field. Severity and ' +
  'evidence are separate: every annotation includes its proof. Output ' +
  'the two sections even when no issues survive; never a SOUND-only reply.'

const CRITIC_VERIFY_CONTRACT =
  '\n\nVERIFY CONTRACT: verify ONLY the ordered selected suspects, cheapest ' +
  'first, within the review deadline. A provided verbatim tool quote ' +
  'may settle a suspicion without another read; cite its host a-prefixed reference and identify the decisive fact in your explanation. ' +
  'NEVER investigate your own instructions or this review contract. ' +
  'There is NO tool-call or model-request count quota. Reach the snapshot only ' +
  'through a `run_code` program and JSON.parse each nested read/grep/glob result. ' +
  'Read as needed within the remaining time; parsed results carry host-owned ' +
  'review_time metadata (remaining_ms, tool_calls, model_requests). Finish the dossier and verdict ' +
  'before remaining_ms reaches zero; the host stops all work at the deadline. ' +
  'Leave unresolved claims unchecked instead of rushing to certify them. ' +
  'After settling a suspect and BEFORE another tool call, emit a visible ' +
  '## dossier section with its cited result row as a checkpoint; do not ' +
  'checkpoint guesses or unfinished claims. Repeat all selected rows in ' +
  'the final dossier. Earlier allowances for conditional ' +
  'unverified-claim annotations do NOT apply in this verification mode.' +
  VERIFICATION_LEDGER_CONTRACT

const CRITIC_VERIFY_PROMPT_SUFFIX =
  '\n\nVerify the suspects in order by calling `run_code` with read/grep/glob ' +
  'programs before the deadline, then emit the dossier and verdict sections as ' +
  'your visible reply.'

function criticExploreToolsClause(timeoutSeconds) {
  return 'You reach the READ-ONLY snapshot only through `run_code`: a direct read/grep/glob call fails. ' +
    'Inside the program call the declared tools and JSON.parse their JSON string result, e.g. ' +
    '`const r = JSON.parse(await tools.read({ file_path: "/project/a.js" }))`; grep takes a literal substring, glob matches paths. ' +
    'Emit for the model the original relevant snippet with its path and 1-based line span, plus each result\'s host evidence_refs (e1, e2, …) and any truncated/limited flag; never invent content the snapshot did not return. ' +
    'There are no writes, no shell and no session history. The ENTIRE review has a shared ' + timeoutSeconds +
    '-second deadline, including source capture and nomination; this stage does not reset it. ' +
    'Query and model-request counts are telemetry only, not stopping limits.'
}

function criticExplorePersona(timeoutSeconds = 180) {
  return CRITIC_PERSONA.replace(CRITIC_NO_TOOLS_CLAUSE, criticExploreToolsClause(timeoutSeconds)) + RUBRIC_ADDENDUM + CRITIC_VERIFY_CONTRACT
}

/** A codec that passes values through — both halves are first-party here. */
const PASS_CODEC = { parse: (value) => value }

/** Build one strict invocation descriptor for the advisorReview namespace. */
function reviewInvocation(method) {
  return {
    id: `dsh-advisor#advisorReview/${method}`,
    service: 'advisorReview',
    namespace: 'advisorReview',
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: `dsh-advisor/${method}Request`, schema: PASS_CODEC },
      },
    ],
    result: { mode: 'strict', typeSymbol: `dsh-advisor/${method}Result`, schema: PASS_CODEC },
  }
}

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

/** Extract the reviewable draft text from an assistant/message event. */
function draftText(event) {
  const content = event.data && event.data.message && event.data.message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Session 事件读取（双形态兼容）：0.1.3 起 `Session.events` 数组属性退役，
 * 由 `snapshotEvents()` 方法（frozen 快照）接任；旧运行时回退原属性。
 * 只读消费，快照与原数组同等对待。
 */
/** Read-only adapter for the native and V3 PTC tool event vocabularies.
 * This never appends synthetic events to the session or guesses model identity.
 * A PTC result is accepted only after its exact matching dispatch start.
 */
function toolEventView(events) {
  if (!Array.isArray(events)) return events
  const starts = new Map()
  let turn, step
  return events.map(event => {
    if (event?.type === 'turn/start') turn = event.data?.turn
    if (event?.type === 'step/start') step = event.data?.step
    if (event?.type === 'tool/ptc-dispatch-start' && typeof event.data?.subCallId === 'string') {
      const data = event.data
      starts.set(data.subCallId, data)
      return { ...event, type: 'tool/call', data: { turn, step, callId: data.subCallId, name: data.name, arguments: JSON.stringify(data.arguments) } }
    }
    if (event?.type === 'tool/ptc-dispatch' && typeof event.data?.subCallId === 'string') {
      const data = event.data, start = starts.get(data.subCallId)
      if (!start || start.name !== data.name || start.parentCallId !== data.parentCallId) return event
      const meta = data.name === 'ask_advisor' && !data.isError
        ? { v: 1, ...parseAdvisorItems(outputText(data.content)) } : undefined
      return { ...event, type: 'tool/result', data: { turn, step, ...(meta ? { meta } : {}), message: { content: [{ type: 'tool-result', toolCallId: data.subCallId, content: data.content, isError: data.isError }] } } }
    }
    return event
  })
}
function sessionEvents(session) {
  if (!session) return undefined
  if (typeof session.snapshotEvents === 'function') return toolEventView(session.snapshotEvents())
  const events = session.events
  return Array.isArray(events) ? toolEventView(events) : undefined
}

/**
 * The reviewer's only snapshot-query tools. The PTC transport (`run_code`) is
 * the model-direct call that carries nested dispatches, not a source query:
 * the observer and the guard count only the nested source readers.
 */
const REVIEW_SOURCE_TOOLS = Object.freeze(['read', 'grep', 'glob'])
/** One fixed denial for every review tool refusal; leaks no host detail. */
const REVIEW_TOOL_DENIAL = 'this review phase cannot execute that tool'

/**
 * 从子会话末尾的工具事件推断「当前动作」：最后一次事件是 tool/call 则该
 * 工具正在执行（带名字与目标摘要）；是 tool/result 则模型在消化上一次
 * 取证（附带刚完成的工具摘要）；尚无任何工具事件则在存疑分析。
 * 叙事进展通道的采样原子——无 team 依赖。
 */
function probeCriticAction(lastToolEvent, lastCallEvent) {
  const summarize = (e) => {
    const name = String(e.data && e.data.name || 'tool')
    let target = ''
    try {
      const args = JSON.parse(e.data && e.data.arguments || '{}')
      target = String(args.file_path || args.path || args.pattern || args.url || '')
      if (target.length > 36) target = '…' + target.slice(-35)
    } catch { /* 参数不是 JSON 就省略目标 */ }
    return { name, target }
  }
  if (lastToolEvent && lastToolEvent.type === 'tool/call') {
    return { kind: 'tool', ...summarize(lastToolEvent) }
  }
  if (lastCallEvent) return { kind: 'thinking', last: summarize(lastCallEvent) }
  return { kind: 'thinking' }
}

/**
 * Progress-only sampler. Executed queries are counted by the host guard;
 * this observer never stops a review. The shared operation deadline does.
 * @returns {{ stop(): number, calls(): number, action(): object }}
 */
function createReviewObserver(options) {
  const agents = options.agents
  const runId = options.runId
  const intervalMs = options.intervalMs || 400
  let calls = 0
  let action = { kind: 'thinking' }
  const sample = () => {
    try {
      const child = agents.get(runId)
      const evs = child && sessionEvents(child.session)
      if (!Array.isArray(evs)) return
      let n = 0
      let lastTool
      let lastCall
      for (const e of evs) {
        if (!e) continue
        // toolEventView already maps a nested tool/ptc-dispatch-start to a
        // tool/call carrying the nested tool name. The outer run_code transport
        // is not a source query and must not advance the action narration.
        if (e.type === 'tool/call') {
          if (e.data?.name === 'run_code') continue
          n += 1; lastTool = e; lastCall = e
        } else if (e.type === 'tool/result') lastTool = e
      }
      calls = n
      action = probeCriticAction(lastTool, lastCall)
    } catch { /* Progress is best-effort; the operation deadline owns cancellation. */ }
  }
  const timer = setInterval(sample, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop: () => { clearInterval(timer); sample(); return calls },
    calls: () => calls,
    action: () => action,
  }
}

/** Anchor fidelity check against the raw markdown draft (display hint only — the DOM side matches normalized text). */
function anchorInDraft(anchor, draft) {
  if (anchor === '') return false
  if (draft.includes(anchor)) return true
  const squash = (s) => s.replace(/\s+/g, ' ')
  return squash(draft).includes(squash(anchor))
}

/** Parse the critic's visible answer into structured annotations. */
function parseAnnotations(text, draft, blocks, options) {
  const explore = !!(options && options.explore)
  const heads = []
  const re = /^### \[(blocker|nit)\][ \t]*(.*)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    heads.push({ severity: m[1], title: (m[2] || '').trim(), at: m.index, end: re.lastIndex })
  }
  const blockIds = Array.isArray(blocks) ? new Set(blocks.map((b) => b.id)) : undefined
  const annotations = []
  for (let i = 0; i < heads.length; i += 1) {
    const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : text.length)
    const anchorMatch = /(?:^|\n)[ \t]*anchor:[ \t]*(.*)/.exec(body)
    const blockMatch = /(?:^|\n)[ \t]*block:[ \t]*(b\d+)[ \t]*(?:\n|$)/.exec(body)
    const evidenceMatch = /(?:^|\n)[ \t]*evidence:[ \t]*(.*)/.exec(body)
    const suspectMatch = /(?:^|\n)[ \t]*suspect:[ \t]*(s\d+)[ \t]*(?:\n|$)/i.exec(body)
    const commentMatch = /(?:^|\n)[ \t]*comment:[ \t]*([\s\S]*)/.exec(body)
    let anchor = anchorMatch ? anchorMatch[1].trim() : ''
    anchor = anchor.replace(/^["'`「『“‘]+|["'`」』”’]+$/g, '').trim()
    const comment = commentMatch ? commentMatch[1].trim() : body.trim()
    const evidence = evidenceMatch ? evidenceMatch[1].trim().slice(0, 400) : ''
    // 契约 v2 块号：非法 id（幻觉/越界）一律落 undefined，消费方退回旧
    // proximity 定位——锚定降级是常态，不是错误。
    const block = blockMatch && blockIds !== undefined && blockIds.has(blockMatch[1])
      ? blockMatch[1]
      : undefined
    // 契约 v3：探索模式下 blocker 必须引用本轮工具所得证据（反「步骤塌缩」
    // ——模型跳过核实直接臆断的高危断言），无证据者降级为 nit 而非丢弃，
    // 信号保留、阻断性剥夺。v2 模式不做此要求。
    let severity = heads[i].severity
    let downgraded
    if (explore && severity === 'blocker' && evidence === '') {
      severity = 'nit'
      downgraded = 'evidence-missing'
    }
    annotations.push({
      severity,
      title: heads[i].title.slice(0, 120),
      anchor: anchor.slice(0, 400),
      comment: comment.slice(0, 1200),
      matched: anchorInDraft(anchor, draft),
      ...(suspectMatch ? { suspect: suspectMatch[1].toLowerCase() } : {}),
      ...(block === undefined ? {} : { block }),
      ...(evidence === '' ? {} : { evidence }),
      ...(downgraded === undefined ? {} : { downgraded }),
    })
  }
  return annotations.slice(0, 8)
}

/** 契约 v3 stats 行：`stats: 排查 N · 证伪 X · 排除 Y`（容忍分隔符变体）。
 *  契约 v4 起可选第四元 `· 未查 Z`。 */
function parseStatsLine(line) {
  if (typeof line !== 'string' || line.trim() === '') return undefined
  const m = /排查\s*(\d+)\s*[·,，、]?\s*证伪\s*(\d+)\s*[·,，、]?\s*排除\s*(\d+)(?:\s*[·,，、]?\s*未查\s*(\d+))?/.exec(line)
  if (m) return { checked: Number(m[1]), confirmed: Number(m[2]), excluded: Number(m[3]), ...(m[4] === undefined ? {} : { unchecked: Number(m[4]) }) }
  const nums = (line.match(/\d+/g) || []).map(Number)
  if (nums.length >= 3) return { checked: nums[0], confirmed: nums[1], excluded: nums[2], ...(nums.length >= 4 ? { unchecked: nums[3] } : {}) }
  return undefined
}

/**
 * 契约 v4 阶段 1 疑点清单解析（容错同 parse 家族：坏行掉落，不全盘崩）：
 * `- suspect: … | block: bN | bearing: high|low | falsify: …`，字段均可缺，
 * bearing 缺省 low，至多 8 条。
 */
function parseSuspectList(text) {
  const out = []
  const re = /^- suspect:[ \t]*(.*)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const parts = m[1].split(/\s*\|\s*(?=(?:block|bearing|falsify):)/).map((p) => p.trim())
    const suspect = (parts[0] || '').trim()
    if (suspect === '') continue
    let block
    let bearing = 'low'
    let falsify = ''
    for (const part of parts.slice(1)) {
      const b = /^block:[ \t]*(b\d+)$/.exec(part)
      if (b) { block = b[1]; continue }
      const g = /^bearing:[ \t]*(high|low)$/i.exec(part)
      if (g) { bearing = g[1].toLowerCase(); continue }
      const f = /^falsify:[ \t]*(.*)$/.exec(part)
      if (f) falsify = f[1].trim()
    }
    out.push({ suspect: suspect.slice(0, 240), bearing, falsify: falsify.slice(0, 240), ...(block === undefined ? {} : { block }) })
  }
  return out.slice(0, 8)
}

/**
 * Host-owned suspect ordering: high bearing first, stable within each tier.
 * All nominated suspects enter verification; a query count cannot hide one.
 */
function triageSuspects(suspects) {
  const high = suspects.filter((s) => s.bearing === 'high')
  const low = suspects.filter((s) => s.bearing !== 'high')
  const ordered = [...high, ...low]
  return { chosen: ordered, skipped: [] }
}

/**
 * 契约 v2（0.12.0）：verdict 头 + 块锚批注。无 verdict 头时 verdict 为
 * undefined（旧回复/模型未遵守），调用方按旧形态渲染——结构是增强不是门槛，
 * 与 parseAdvisorItems 同一纪律。
 * 契约 v3（0.13.0，options.explore）：dossier 段在前、verdict 段在后，
 * 解析只消费 verdict 段——dossier 里的 ### 头（含排除项的伪装复发）不落
 * 批注；stats 行解析为 {checked, confirmed, excluded}。
 */
function parseOutcomeRows(text) {
  const prefix = String(text).replace(/\r\n/g, '\n').split(/^## verdict:/m)[0]
  const rows = []
  const issues = []
  if (!/^## dossier[ \t]*$/m.test(prefix)) issues.push('缺少逐项调查结果')
  for (const line of prefix.split('\n')) {
    if (!/^-\s*result:/i.test(line)) continue
    const match = /^-\s*result:\s*(s\d+)\s*\|\s*outcome:\s*(defect|cleared|unchecked)\s*\|\s*evidence:\s*(.*)$/i.exec(line)
    if (!match) { issues.push('无法解析逐项结果'); continue }
    rows.push({ id: match[1].toLowerCase(), outcome: match[2].toLowerCase(), evidence: match[3].trim().slice(0, 400) })
  }
  return { rows, issues }
}

/** Recover visible investigator checkpoints, never tool output or reasoning.
 * Repeated identical checkpoints are OK across messages, not within one.
 * Any conflict/retraction/malformed selected row poisons that id: recovery
 * cannot silently revive an earlier conclusion the investigator questioned.
 * Citation shape is a recoverability check, not proof of semantic truth.
 */
function recoverCitedDossier(texts, selected) {
  const allowed = new Set(selected.map((s) => s.id))
  const byId = new Map()
  const invalid = new Set()
  for (const text of texts) {
    const prefix = String(text).replace(/\r\n/g, '\n').split(/^## verdict:/m)[0]
    if (!/^## dossier[ \t]*$/m.test(prefix)) continue
    const rows = parseOutcomeRows(prefix).rows
    const seen = new Set()
    for (const line of prefix.split('\n')) {
      const id = /^-\s*result:\s*(s\d+)\b/i.exec(line)?.[1].toLowerCase()
      if (!allowed.has(id)) continue
      if (!/^-\s*result:\s*s\d+\s*\|\s*outcome:\s*(defect|cleared|unchecked)\s*\|\s*evidence:\s*.*$/i.test(line)) invalid.add(id)
    }
    for (const row of rows) {
      if (!allowed.has(row.id)) continue
      if (seen.has(row.id)) invalid.add(row.id)
      seen.add(row.id)
      if (row.outcome === 'unchecked' || (!evidenceRefs(row.evidence).length && !/(?:[\w./-]+:\d+|\b(?:read|grep|glob|bash|web_fetch|web_search)\b)/i.test(row.evidence))) invalid.add(row.id)
      const previous = byId.get(row.id)
      if (previous && (previous.outcome !== row.outcome || previous.evidence !== row.evidence)) invalid.add(row.id)
      byId.set(row.id, row)
    }
  }
  return selected.map((s) => !invalid.has(s.id) && byId.has(s.id)
    ? byId.get(s.id) : { id: s.id, outcome: 'unchecked', evidence: '' })
}

/** Finite host-owned identity pool: neither self-reported counts nor extra ids expand it. */
function reconcileReviewLedger(text, annotations, selected, all, blocks, frozenRows) {
  const allowed = new Map(selected.map((s) => [s.id, s]))
  const parsedRows = parseOutcomeRows(text)
  // A recovery writer formats the investigator's findings; it cannot reopen
  // cleared issues, erase settled findings or invent newly verified outcomes.
  const rows = Array.isArray(frozenRows) ? frozenRows : parsedRows.rows
  const issues = Array.isArray(frozenRows) ? [] : parsedRows.issues
  const byId = new Map()
  const duplicate = new Set()
  const hasEvidence = (value) => typeof value === 'string' && value !== '' && !/^(?:none|n\/a|unchecked|未查|未核实|无|[-—])\s*[.。]?$/i.test(value)
  for (const row of rows) {
    if (!allowed.has(row.id)) { issues.push('忽略未选中的结果编号 ' + row.id); continue }
    if (byId.has(row.id)) { duplicate.add(row.id); issues.push('重复结果编号 ' + row.id); continue }
    byId.set(row.id, row)
  }
  for (const s of selected) {
    const row = byId.get(s.id)
    if (!row || duplicate.has(s.id) || (row.outcome !== 'unchecked' && !hasEvidence(row.evidence))) {
      byId.set(s.id, { id: s.id, outcome: 'unchecked', evidence: '' })
    }
  }
  let ignoredAnnotations = 0
  const kept = []
  for (const a of annotations) {
    const row = byId.get(a.suspect)
    const suspect = allowed.get(a.suspect)
    const block = suspect?.block && Array.isArray(blocks) ? blocks.find((b) => b.id === suspect.block) : undefined
    const wrongBlock = suspect?.block && a.block && a.block !== suspect.block
    const wrongAnchor = block && a.anchor && !anchorInDraft(a.anchor, block.text)
    if (!suspect || row?.outcome !== 'defect' || wrongBlock || wrongAnchor) {
      ignoredAnnotations += 1
      continue
    }
    // The ledger citation accompanies the annotation even if its author
    // forgot to repeat it. This verifies linkage/presence, not semantic truth.
    const { downgraded, ...rest } = a
    kept.push({ ...rest, severity: downgraded ? 'blocker' : a.severity, evidence: row.evidence, ...(suspect.block ? { block: suspect.block } : {}) })
  }
  if (ignoredAnnotations) issues.push('剔除 ' + ignoredAnnotations + ' 条未核实、已排除或越界批注')
  for (const [id, row] of byId) {
    if (row.outcome === 'defect' && !kept.some((a) => a.suspect === id)) {
      byId.set(id, { id, outcome: 'unchecked', evidence: '' })
      issues.push('缺陷结果没有对应有效批注 ' + id)
    }
  }
  const outcomes = all.map((s) => byId.get(s.id) || { id: s.id, outcome: 'unchecked', evidence: '' })
  const stats = {
    checked: outcomes.length,
    confirmed: outcomes.filter((r) => r.outcome === 'defect').length,
    excluded: outcomes.filter((r) => r.outcome === 'cleared').length,
    unchecked: outcomes.filter((r) => r.outcome === 'unchecked').length,
  }
  return { annotations: kept, outcomes, stats, ledgerIssues: [...new Set(issues)], ignoredAnnotations }
}

function parseCriticReview(text, draft, blocks, options) {
  text = String(text).replace(/\r\n/g, '\n')
  const strict = !!(options && (options.explore || options.strict))
  const heads = [...text.matchAll(/^## verdict:[ \t]*(pass|changes)[ \t]*$/gm)]
  const candidates = [...text.matchAll(/^##[ \t]+verdict\b.*$/gim)]
  const valid = heads.length === 1 && candidates.length === 1
  const verdictMatch = valid ? heads[0] : undefined
  // New reviews never parse a dossier as legacy annotations. Legacy loading
  // remains available to callers that explicitly omit strict/explore mode.
  const section = verdictMatch ? text.slice(verdictMatch.index) : strict ? '' : text
  const summaryMatch = /(?:^|\n)[ \t]*summary:[ \t]*(.*)/.exec(section)
  const statsMatch = /(?:^|\n)[ \t]*stats:[ \t]*(.*)/.exec(section)
  let stats = parseStatsLine(statsMatch ? statsMatch[1] : undefined)
  let annotations = parseAnnotations(section, draft, blocks, options)
  let ledger
  if (valid && Array.isArray(options?.selected)) {
    ledger = reconcileReviewLedger(text, annotations, options.selected, options.allSuspects || options.selected, blocks, options.frozenRows)
    annotations = ledger.annotations
    stats = ledger.stats
  }
  const verdict = verdictMatch ? (annotations.some((a) => a.severity === 'blocker') ? 'changes' : 'pass') : undefined
  return {
    valid,
    verdict,
    ...(verdictMatch && verdict !== verdictMatch[1] ? { verdictAdjusted: true } : {}),
    summary: summaryMatch ? summaryMatch[1].trim().slice(0, 300) : '',
    ...(stats === undefined ? {} : { stats }),
    ...(ledger ? { outcomes: ledger.outcomes, ledgerIssues: ledger.ledgerIssues, ignoredAnnotations: ledger.ignoredAnnotations } : {}),
    annotations,
  }
}

/** Only an explicit, well-formed empty list is a valid zero-suspect result. */
function parseSuspectResponse(text) {
  const lines = String(text).replace(/\r\n/g, '\n').trim().split('\n').filter((line) => line.trim() !== '')
  if (lines[0] !== '## suspects') return { ok: false, error: 'missing suspects header' }
  const body = lines.slice(1)
  if (body.length > 8 || body.some((line) => !/^- suspect:[ \t]*\S/.test(line))) {
    return { ok: false, error: 'invalid suspect list (expected at most 8 suspect lines)' }
  }
  const suspects = parseSuspectList(body.join('\n'))
  if (suspects.length !== body.length) return { ok: false, error: 'unparsed suspect lines' }
  return { ok: true, suspects }
}

/** Normalize coverage separately from severity; incomplete can never mean sound. */
function reviewCoverage(parsed, { explore, suspects, salvaged }) {
  if (!explore || suspects?.total === 0) return { coverage: 'not-verified', stats: parsed.stats }
  if (Array.isArray(parsed.outcomes)) {
    const issues = parsed.ledgerIssues || []
    return {
      coverage: salvaged || parsed.stats.unchecked > 0 || issues.length > 0 ? 'partial' : 'complete',
      stats: parsed.stats,
      ...(issues.length ? { coverageNote: issues.slice(0, 3).join('；') } : {}),
    }
  }
  const chosen = suspects?.triaged || 0
  const skipped = suspects?.skipped || 0
  const s = parsed.stats
  const nums = s ? [s.checked, s.confirmed, s.excluded, s.unchecked ?? 0] : []
  const valid = nums.length === 4 && nums.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100)
    && s.checked >= chosen && s.checked === s.confirmed + s.excluded + (s.unchecked || 0)
    && (s.confirmed === 0 || (parsed.annotations?.length || 0) > 0)
  const stats = valid
    ? { ...s, checked: s.checked + skipped, unchecked: (s.unchecked || 0) + skipped }
    : { checked: chosen + skipped, confirmed: 0, excluded: 0, unchecked: chosen + skipped }
  return {
    coverage: !valid || salvaged || stats.unchecked > 0 ? 'partial' : 'complete',
    stats,
    ...(!valid ? { coverageNote: '统计缺失或不一致，无法确认排查范围' } : {}),
  }
}

/** One deadline shared by every phase; a request cap is opt-in for the advisor only. */
function createReviewOperation({ timeoutMs = 180000, maxRequests, now = Date.now, timers = globalThis } = {}) {
  const controller = new AbortController()
  const deadline = now() + timeoutMs
  let reason = ''
  let requests = 0
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const cancel = (why = 'cancelled') => {
    if (controller.signal.aborted) return
    reason = why
    controller.abort(new Error(why))
  }
  const check = () => {
    if (now() >= deadline) cancel('review timeout')
    if (controller.signal.aborted) throw new Error(reason)
  }
  const timer = timers.setTimeout(() => cancel('review timeout'), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal, cancel, check, done,
    reason: () => reason,
    requests: () => requests,
    remainingMs: () => Math.max(0, deadline - now()),
    beforeRequest: () => {
      check()
      if (maxRequests !== undefined && requests >= maxRequests) { cancel('model request limit reached'); check() }
      requests += 1
    },
    dispose: () => { timers.clearTimeout(timer); finish() },
  }
}

function reviewKey(sessionId, messageId) { return JSON.stringify([String(sessionId), String(messageId)]) }

/** Synchronous reservation: concurrent starts cannot all see the same settled count. */
function createConsultationGate() {
  const entries = new WeakMap()
  return {
    reserve(parent, facts, limit) {
      if (!facts) throw new Error('advisor telemetry unavailable; refusing an unmetered consultation')
      let entry = entries.get(parent)
      if (entry?.active) throw new Error('advisor consultation already in flight for this session')
      if (!entry || entry.turnKey !== facts.turnKey) {
        entry = { turnKey: facts.turnKey, spent: facts.settledThisTurn, active: false }
        entries.set(parent, entry)
      }
      entry.spent = Math.max(entry.spent, facts.settledThisTurn)
      if (entry.spent >= limit) throw new Error('advisor budget for this planning phase is exhausted')
      entry.spent += 1
      entry.active = true
      return () => { entry.active = false }
    },
  }
}

/**
 * Parse the advisor's structured-Markdown reply into items. Sister of
 * parseAnnotations: tolerant by design — a missing field is an issue, never
 * a dropped item; zero heads means the reply predates or broke the contract
 * and the caller simply gets the raw text (structure is an enhancement,
 * never a gate — M3-②'s core discipline).
 */
/**
 * 0.12.0 ①块切分：把 markdown 草稿切成顶层块（b1..bN），供批评者输入的
 * 块地图与浏览器的 gutter 渲染共用同一序号空间。host 与 client 各内嵌一份
 * 相同实现（两端无共享打包通道），一致性由 test/blocks.fixtures.js 的共享
 * 夹具锁定——改一端不改另一端会红测试。
 *
 * 规则（行级扫描，宁简勿繁）：
 *   - 围栏代码（```/~~~，长围栏吞短围栏）自成一块；
 *   - ATX 标题、水平线自成一块；
 *   - 连续表格行 / 引用行（含懒惰续行）各成一块；
 *   - 列表含松散项（空行后仍是列表内容）仍为一块；
 *   - 其余非空行聚成段落块；空行只是边界，不进任何块。
 * 渲染 DOM 与切分序号的错位风险由消费方兜底（块定位失败退回旧 proximity）。
 */
function splitMarkdownBlocks(text) {
  const lines = String(text).split('\n')
  const blocks = []
  const isBlank = (l) => /^\s*$/.test(l)
  const isHeading = (l) => /^\s{0,3}#{1,6}\s/.test(l)
  const fenceMark = (l) => {
    const m = /^(\s*)(`{3,}|~{3,})/.exec(l)
    return m ? { ch: m[2][0], len: m[2].length } : null
  }
  const isTable = (l) => /^\s*\|/.test(l)
  const isQuote = (l) => /^\s*>/.test(l)
  const isListItem = (l) => /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(l)
  const isHr = (l) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)
  const push = (type, start, end) => {
    const body = lines.slice(start, end).join('\n')
    if (body.trim() === '') return
    blocks.push({ id: 'b' + (blocks.length + 1), type, text: body })
  }
  let i = 0
  while (i < lines.length) {
    if (isBlank(lines[i])) { i += 1; continue }
    const start = i
    const fence = fenceMark(lines[i])
    if (fence) {
      i += 1
      while (i < lines.length) {
        const m = fenceMark(lines[i])
        if (m && m.ch === fence.ch && m.len >= fence.len) { i += 1; break }
        i += 1
      }
      push('code', start, i)
      continue
    }
    if (isHeading(lines[i])) { push('heading', start, start + 1); i += 1; continue }
    if (isHr(lines[i])) { push('hr', start, start + 1); i += 1; continue }
    if (isTable(lines[i])) {
      i += 1
      while (i < lines.length && isTable(lines[i])) i += 1
      push('table', start, i)
      continue
    }
    if (isQuote(lines[i])) {
      i += 1
      while (i < lines.length && (isQuote(lines[i]) || (!isBlank(lines[i]) && !isHeading(lines[i]) && !fenceMark(lines[i])))) i += 1
      push('quote', start, i)
      continue
    }
    if (isListItem(lines[i])) {
      i += 1
      for (;;) {
        while (i < lines.length && !isBlank(lines[i]) && !isHeading(lines[i]) && !fenceMark(lines[i]) && !isTable(lines[i]) && !isHr(lines[i])) i += 1
        let j = i
        while (j < lines.length && isBlank(lines[j])) j += 1
        // 松散列表延续必须以严格前进为前提：j === i 意味着下一行就是边界
        // （缩进围栏/缩进标题等），i = j 会原地死循环——生产实例曾因此被
        // 事件循环卡死（真实教训，见 test 夹具）。
        if (j > i && j < lines.length && (isListItem(lines[j]) || /^\s{2,}\S/.test(lines[j]))) { i = j; continue }
        break
      }
      push('list', start, i)
      continue
    }
    i += 1
    while (i < lines.length && !isBlank(lines[i]) && !isHeading(lines[i]) && !fenceMark(lines[i]) && !isTable(lines[i]) && !isQuote(lines[i]) && !isListItem(lines[i]) && !isHr(lines[i])) i += 1
    push('paragraph', start, i)
  }
  return blocks
}

function parseAdvisorItems(text) {
  const heads = []
  const re = /^## \[(high|mid|low)\][ \t]*(.*)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    heads.push({ tier: m[1], title: (m[2] || '').trim(), at: m.index, end: re.lastIndex })
  }
  if (heads.length === 0) return { items: [], issues: [] }
  const issues = []
  if (heads.length > 6) issues.push('item count ' + heads.length + ' exceeds the 6-item cap')
  const FIELD_NAMES = ['framing', 'pitfalls', 'verification_target']
  const items = []
  for (let i = 0; i < heads.length; i += 1) {
    const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : text.length)
    const field = (name) => {
      const match = new RegExp(
        '(?:^|\\n)[ \\t]*' + name + '[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*(?:' + FIELD_NAMES.join('|') + ')[ \\t]*:|$)',
      ).exec(body)
      return match ? match[1].trim() : ''
    }
    const item = {
      tier: heads[i].tier,
      title: heads[i].title.slice(0, 120),
      framing: field('framing').slice(0, 1200),
      pitfalls: field('pitfalls').slice(0, 1200),
      verificationTarget: field('verification_target').slice(0, 600),
    }
    if (item.framing === '') issues.push('item ' + (i + 1) + ' ("' + item.title + '") lacks framing')
    if (item.verificationTarget === '') issues.push('item ' + (i + 1) + ' ("' + item.title + '") lacks verification_target')
    items.push(item)
  }
  return { items, issues }
}

/**
 * ③深化（0.9.0，advrub 原型 A/B 确认后静态化）：捞「当时的顾问输出」的
 * 验证目标清单。ask_advisor 的结构化 items 随 tool/result 事件的 data.meta
 * 落盘（presentationMeta 通道，{v:1, items}）。取清单的优先级：草案同轮的
 * 最近一次咨询 > 更早轮的最近一次咨询。A/B 实测（同消息双跑）：清单驱动批注
 * 锚定顾问事前指定的风险点、敢下事实语气；无清单基线靠现场猜。
 */
function advisorTargets(events, target) {
  events = toolEventView(events)
  const callIds = new Set()
  const withMeta = []
  for (const event of events) {
    if (!event || event.seq >= target.seq) break
    if (event.type === 'tool/call' && event.data && event.data.name === 'ask_advisor') {
      callIds.add(String(event.data.callId))
    } else if (event.type === 'tool/result' && event.data) {
      const meta = event.data.meta
      if (meta === null || typeof meta !== 'object' || meta.v !== 1 || !Array.isArray(meta.items)) continue
      const message = event.data.message || {}
      const block = Array.isArray(message.content) ? message.content[0] : undefined
      if (!callIds.has(String(block && block.toolCallId))) continue
      withMeta.push({ seq: event.seq, turn: event.data.turn, items: meta.items })
    }
  }
  if (withMeta.length === 0) return { items: [], from: 'none' }
  const targetTurn = target.data && target.data.turn
  const sameTurn = withMeta.filter((r) => r.turn === targetTurn)
  const chosen = sameTurn.length > 0 ? sameTurn[sameTurn.length - 1] : withMeta[withMeta.length - 1]
  const items = chosen.items.filter(
    (it) => it && typeof it === 'object' && typeof it.verificationTarget === 'string' && it.verificationTarget !== '',
  )
  return { items, from: (sameTurn.length > 0 ? 'same-turn' : 'earlier-turn') + ' seq ' + chosen.seq }
}

/** Extract the visible text of a user/message event. */
function userText(event) {
  const content = event.data && event.data.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Collect the verdict-level evidence of the turn that produced a draft: the
 * request text(s) plus one digest line per tool result. Never full tool
 * output, never reasoning — the critic judges the OUTPUT; the author's
 * process narrative stays invisible so the critique keeps its independence
 * (an omniscient critic converges with the author's framing and the
 * diversity the second model exists for evaporates). Slicing by seq range
 * stays correct even for event payloads that carry no turn field.
 *
 * 0.14.1 起按可复现性分级（「做没做」靠摘要存在性核对，「当时看到了什么」
 * 只有世界无法再生产同样字节的证据才值得全文引用）：read/grep/glob 保持
 * 摘要行（批评者自己就能拿到更新鲜的同一份）；bash/web_search/web_fetch
 * 的回显逐条全文引用（verbatim quote），单条 1600 字符、总量 8000 封顶，
 * 超出截断并落标记。
 */
const EPHEMERAL_EVIDENCE_TOOLS = new Set(['bash', 'web_search', 'web_fetch'])
const EVIDENCE_QUOTE_MAX = 1600
const EVIDENCE_QUOTES_BUDGET = 8000

function privateEvidenceReference(value) {
  if (typeof value !== 'string') return false
  const stateRoot = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (value.includes(stateRoot)) return true
  if (/(?:^|[\s/\\"'`])(?:\.env(?:[.\w-]*)?|(?:credentials?|secrets?|cookies?|auth-state|storageState)\.(?:json|ya?ml|txt|toml)|id_rsa|id_ed25519|[^\s/\\"'`]+\.(?:pem|p12|pfx|key))(?:[\s/\\"'`]|$)/i.test(value)) return true
  return /(?:^|[\s/\\"'`])(?:\.dsh|\.ssh|\.aws|\.session-repair|\.bashrc|\.zshrc|\.netrc|\.npmrc)(?:[\s/\\"'`]|$)|\$\{?DSH_HOME\b|\b(?:printenv|process\.env|os\.environ)\b/i.test(value)
}
function turnEvidence(events, target, { protectInputs = false } = {}) {
  events = toolEventView(events)
  const turn = target.data && target.data.turn
  let startSeq = 0
  for (const event of events) {
    if (event.seq >= target.seq) break
    if (event && event.type === 'turn/start' && event.data && event.data.turn === turn) {
      startSeq = event.seq
    }
  }
  const requests = []
  const calls = new Map()
  const results = []
  const quotes = []
  let quotesSpent = 0
  let withheld = false
  for (const event of events) {
    if (!event || event.seq < startSeq || event.seq >= target.seq) continue
    if (event.type === 'user/message') {
      const text = userText(event)
      if (text !== '' && !text.includes('[advisor:plan-reminder]')) requests.push(text)
    } else if (event.type === 'tool/call' && event.data) {
      calls.set(String(event.data.callId), {
        name: String(event.data.name || 'tool'),
        privateSource: protectInputs && privateEvidenceReference(event.data.arguments),
      })
    } else if (event.type === 'tool/result' && event.data) {
      const message = event.data.message || {}
      const block = Array.isArray(message.content) ? message.content[0] : undefined
      const callId = (block && block.toolCallId) || (message.source && message.source.callId)
      const call = calls.get(String(callId))
      const name = call?.name || 'tool'
      let snippet = ''
      let fullText = ''
      if (block && Array.isArray(block.content)) {
        const texts = block.content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text)
        fullText = texts.join('\n')
        if (fullText !== '') snippet = fullText.replace(/\s+/g, ' ').trim().slice(0, 240)
      }
      if (protectInputs && (call?.privateSource || !['read', 'grep', 'glob', 'write', 'edit', 'run_code', ...EPHEMERAL_EVIDENCE_TOOLS].includes(name) || detectSensitiveText(fullText) || privateEvidenceReference(fullText))) {
        withheld = true
        results.push('- tool result withheld for privacy; it cannot substantiate draft claims')
        continue
      }
      results.push('- ' + name + ': ' + ((block && block.isError) ? 'ERROR' : 'ok') + (protectInputs || snippet === '' ? '' : ' — "' + snippet + '"'))
      if (EPHEMERAL_EVIDENCE_TOOLS.has(name) && fullText !== '' && quotesSpent < EVIDENCE_QUOTES_BUDGET) {
        const room = Math.min(EVIDENCE_QUOTE_MAX, EVIDENCE_QUOTES_BUDGET - quotesSpent)
        const truncated = fullText.length > room
        const text = truncated ? fullText.slice(0, room) + '\n…[truncated]' : fullText
        quotesSpent += text.length
        quotes.push({ name, isError: !!(block && block.isError), text })
      }
    }
  }
  const MAX_TOOLS = 15
  return {
    request: requests.join('\n---\n').slice(0, 3000),
    tools: results.length === 0
      ? 'No tool results are included for this turn. This is a turn-local, incomplete view, NOT evidence that work or tests did not happen. Earlier turns and background work may be absent; leave unresolvable claims unchecked.'
      : results.slice(0, MAX_TOOLS).join('\n') + (results.length > MAX_TOOLS ? '\n… +' + (results.length - MAX_TOOLS) + ' more' : ''),
    quotes,
    ...(protectInputs ? { withheld, sensitiveInput: detectSensitiveText(requests.join('\n')) } : {}),
  }
}

/** New versioned records only. Legacy dsh-advisor JSONL is deliberately not read. */
function reviewsPath(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return undefined
  return join(recordRoot(), 'reviews', sessionId)
}
async function readReviews(sessionId) {
  if (!reviewsPath(sessionId)) return []
  const entries = await listRecords('reviews', sessionId)
  if (entries.some(entry => !entry || entry.sessionId !== sessionId || typeof entry.reviewId !== 'string')) throw new Error('Invalid review record identity')
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.reviewId.localeCompare(b.reviewId))
}
async function persistReview(sessionId, entry) {
  if (!reviewsPath(sessionId)) throw new Error('unusable session id for review storage')
  const { evidenceRecords = [], ...summary } = entry
  if (detectSensitiveText(JSON.stringify(entry))) throw new Error('评审结果含疑似敏感内容，未保存')
  const evidenceIds = evidenceRecords.map(record => record.id)
  // The summary is the commit marker. Orphaned evidence cannot be addressed
  // through the RPC because readEvidence first validates the committed review.
  await writeRecord('evidence', sessionId, entry.reviewId, { reviewId: entry.reviewId, records: evidenceRecords })
  await writeRecord('reviews', sessionId, entry.reviewId, { ...summary, schemaVersion: RECORD_SCHEMA_VERSION, sessionId, evidenceIds })
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
async function persistAdvice(sessionId, kind, id, text, usage) {
  if (detectSensitiveText(text)) throw new Error('顾问输出含疑似敏感内容，未保存')
  const callId = callRecordId(kind, id)
  const parsed = parseAdvisorItems(text)
  await writeRecord('advice', sessionId, callId, { sessionId, callId, kind, text, ...parsed, modelUsage: modelUsageSnapshot(usage), createdAt: Date.now() })
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
const feedbackWrites = new Map()
async function appendFeedback(sessionId, record) {
  const reviewId = record.triageBatch?.reviewId || record.triage?.reviewId || record.triageFilter?.reviewId
  if (!reviewId) return writeRecord('feedback', sessionId, 'keys:' + randomUUID(), record)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
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

/**
 * The advisorReview Remote service: one list + one start method, callable from
 * the browser card through the Typert gateway (strict descriptors registered
 * by apply below; the gateway resolves receiver contexts itself). The binding
 * comes from the TypertRemoteService base — the exact shape validateBinding
 * requires.
 */
class AdvisorReviewService extends TypertRemoteService {
  /**
   * @param ctx - host context (agents/subagents are read lazily per call).
   * @param liveCriticChildren - shared set for the effort pin listener.
   * @param getConfig - thunk returning the LATEST resolved settings (the
   *   settings scope resyncs after construction, so capture the thunk, never
   *   a snapshot).
   */
  constructor(ctx, liveCriticChildren, getConfig, activeOperations = new Set(), isolation = {}) {
    super(ctx, 'advisorReview')
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
    for (const method of ['readReview', 'readEvidence', 'readAdvice']) remoteMarker(Object.getPrototypeOf(this), method).call(this)
  }

  /** Register a Ciel-only provider; no unrestricted spawn fallback is permitted. */
  async ensureReviewBackend() {
    if (this.backendPromise) return this.backendPromise
    const pending = (async () => {
      const subagents = this.ownerCtx.get('subagents')
      if (!this.guardAvailable || typeof subagents?.registerProvider !== 'function') throw new Error('评审隔离运行环境不可用；没有启动评审')
      const provider = await this.createProvider({
        claimControl: (request) => {
          const control = this.pendingReviewControls.get(request.label)
          if (!control || control.parent !== request.parent || control.abort.signal !== request.signal) return null
          control.operation.check()
          this.pendingReviewControls.delete(request.label)
          return control
        },
        bindControl: (control, child) => {
          if (!this.guardAvailable || !child?.id) throw new Error('review guard unavailable')
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
      if (!this.guardAvailable) throw new Error('评审守卫不可用；没有启动评审')
      const dispose = subagents.registerProvider(provider)
      this.ownerCtx.effect(() => () => {
        dispose()
        this.backendPromise = null
        for (const op of this.inFlight.values()) op.cancel('plugin stopped')
      }, 'Ciel: restricted review provider')
      return provider.name
    })()
    this.backendPromise = pending
    try { return await pending } catch {
      if (this.backendPromise === pending) this.backendPromise = null
      throw new Error('评审隔离运行环境不可用；请检查 DSH 依赖，没有退回普通文件工具')
    }
  }

  async readReview(request) {
    try {
      const { sessionId, reviewId } = request || {}
      const review = await readRecord('reviews', sessionId, reviewId)
      if (!review || review.schemaVersion !== RECORD_SCHEMA_VERSION || review.sessionId !== sessionId || review.reviewId !== reviewId) return { ok: false, error: '评审记录不存在或不属于此会话' }
      const triage = (await readFeedbackTriage(sessionId, [reviewId])).get(reviewId)
      return { ok: true, review: { ...review, triage: triage ? { states: Object.fromEntries(triage.states), filter: triage.filter } : { states: {} } } }
    } catch (error) { return { ok: false, error: '评审记录不可用：' + (error.code || '读取失败') } }
  }
  async readEvidence(request) {
    try {
      const { sessionId, reviewId, evidenceId } = request || {}
      if (typeof evidenceId !== 'string' || !/^[ea][1-9][0-9]*$/.test(evidenceId)) return { ok: false, error: '无效证据标识' }
      const result = await this.readReview({ sessionId, reviewId })
      if (!result.ok || !result.review.evidenceIds?.includes(evidenceId)) return { ok: false, error: '证据不属于此评审或未被最终结果引用' }
      const archive = await readRecord('evidence', sessionId, reviewId)
      const found = archive?.reviewId === reviewId && archive.records?.filter(record => record.id === evidenceId)
      if (!found || found.length !== 1) return { ok: false, error: '历史证据片段不可用；不会改读当前文件' }
      const evidence = found[0]
      if (typeof evidence.content !== 'string' || createHash('sha256').update(evidence.content).digest('hex') !== evidence.contentSha256) return { ok: false, error: '历史证据内容与记录指纹不一致' }
      if (detectSensitiveText(evidence.content) || detectSensitiveText(JSON.stringify(evidence))) return { ok: false, error: '历史证据因隐私检查未提供' }
      return { ok: true, evidence }
    } catch (error) { return { ok: false, error: '历史证据不可用：' + (error.code || '读取失败') } }
  }
  async readAdvice(request) {
    try {
      const { sessionId, callId } = request || {}
      const advice = await readRecord('advice', sessionId, callId)
      if (!advice || advice.sessionId !== sessionId || advice.callId !== callId) return { ok: false, error: '顾问记录不存在或不属于此会话' }
      if (detectSensitiveText(advice.text)) return { ok: false, error: '顾问记录因隐私检查未提供' }
      return { ok: true, advice }
    } catch (error) { return { ok: false, error: '顾问记录不可用：' + (error.code || '读取失败') } }
  }

  async callModelUsage(request) {
    try {
      return { modelUsage: await readCallModelUsage(request?.sessionId, request?.kind, request?.id) }
    } catch {
      return { ok: false, error: 'model usage record unavailable' }
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
    operation.cancel('review cancelled by user')
    return { ok: true, cancelled: true }
  }

  /** The dedup ledger for one session, seeded from the WAL on first touch. */
  sentSet(sessionId) {
    const sid = String(sessionId || '')
    let pending = this.sentBySession.get(sid)
    if (pending === undefined) {
      pending = readFeedbackKeys(sid).catch((error) => { if (this.sentBySession.get(sid) === pending) this.sentBySession.delete(sid); throw error })
      this.sentBySession.set(sid, pending)
    }
    return pending
  }

  /** The triage ledger for one session, seeded from the WAL on first touch. */
  triageSet(sessionId) {
    const sid = String(sessionId || '')
    let pending = this.triageBySession.get(sid)
    if (pending === undefined) {
      pending = readFeedbackTriage(sid).catch((error) => { if (this.triageBySession.get(sid) === pending) this.triageBySession.delete(sid); throw error })
      this.triageBySession.set(sid, pending)
    }
    return pending
  }

  /** List every persisted review of one session (sidecar store — the session need not be live). */
  async list(request) {
    const sessionId = request?.sessionId
    const page = await listRecordsPage('reviews', sessionId, { cursor: request?.cursor, limit: request?.limit })
    const entries = page.values
    if (entries.some(entry => !entry || entry.sessionId !== sessionId || typeof entry.reviewId !== 'string')) throw new Error('Invalid review record identity')
    const triage = await readFeedbackTriage(sessionId, entries.map(entry => entry.reviewId))
    const triageOut = Object.fromEntries([...triage].map(([id, value]) => [id, { states: Object.fromEntries(value.states), ...(value.filter ? { filter: value.filter } : {}) }]))
    return { reviews: entries.map(entry => ({ ...entry, time: entry.createdAt })), sentKeys: [], triage: triageOut, nextCursor: page.nextCursor, limited: page.limited }
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
        const review = await readRecord('reviews', sessionId, reviewId)
        if (!review || review.sessionId !== sessionId || review.reviewId !== reviewId || !Array.isArray(review.annotations)) return { ok: false, error: 'stored review not found' }
        if (changes.some(change => !change || !Number.isInteger(change.index) || change.index < 0 || change.index >= review.annotations.length || !['accept', 'dismiss'].includes(change.state))) return { ok: false, error: 'annotation index or state is invalid' }
        await appendFeedback(sessionId, { triageBatch: { reviewId, changes, filter } })
        this.triageBySession.delete(sessionId)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '分诊保存失败：' + (error.code || error.message || 'unknown') }
      }
    })
    this.triageOperations.set(key, pending)
    return pending.finally(() => { if (this.triageOperations.get(key) === pending) this.triageOperations.delete(key) })
  }

  /** Run the critic over one assistant message and persist the review. */
  async start(request) {
    if (!request || typeof request.sessionId !== 'string' || typeof request.messageId !== 'string') return { ok: false, error: 'sessionId and messageId required' }
    const cfg = this.getConfig()
    const modelUsage = createModelUsage(cfg.criticProvider, cfg.criticModel)
    if (cfg.enabled === false) return { ok: false, error: 'Ciel disabled', modelUsage }
    if (!this.guardAvailable) return { ok: false, error: 'Ciel requires tools.guard() for bounded execution; update DSH before reviewing' }
    const sessionId = request.sessionId
    const messageId = request.messageId
    const key = reviewKey(sessionId, messageId)
    const agents = this.ctx.get('agents')
    const subagents = this.ctx.get('subagents')
    if (agents === undefined || subagents === undefined) {
      return { ok: false, error: 'agents/subagents service unavailable' }
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
    // Owned scalar telemetry survives child disposal; never persist queries,
    // file contents, reasoning or transient child sessions in an error record.
    const diagnostics = { phase: 0, toolCalls: 0, limitMode: 'time', timeoutMs }
    const reviewId = 'r-' + randomUUID()
    const receiptLedger = createEvidenceLedger({ roots: [
      { virtual: '/project', actual: agent.session?.header?.cwd },
      ...(cfg.criticAdditionalRoots || []).map((actual, i) => ({ virtual: '/external-' + (i + 1), actual })),
    ] })
    const fail = async (error) => {
      for (const control of stageControls.values()) captureModelUsage(modelUsage, control.run)
      this.ctx.logger?.warn('dsh-advisor: review.start failed: %s', String(error))
      const cancelled = operation.reason() === 'review cancelled by user' || operation.reason() === 'Ciel disabled' || operation.reason() === 'plugin stopped'
      const entry = { reviewId, messageId, anchorSeq: target.seq, status: cancelled ? 'cancelled' : 'error', error: String(error), annotations: [], modelRequests: operation.requests(), modelUsage: modelUsageSnapshot(modelUsage), limits, diagnostics: { ...diagnostics }, createdAt: Date.now() }
      try { await persistReview(sessionId, entry) } catch (e) { this.ctx.logger?.warn('dsh-advisor: review persist failed: %s', e && e.message) }
      return { ok: false, error: entry.error, review: entry }
    }
    try {
      let run
      // Hoisted out of the spawn-guard try: the review entry (outer scope)
      // reads targets.items.length for targetsProvided — a block-scoped const
      // inside the inner try threw ReferenceError at entry construction
      // (0.9.0 live bug: "targets is not defined").
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
        const providedText = (evidence.quotes || []).map(q => q.text).join('\n')
        const authorRef = receiptLedger.provided(providedText)
        if (authorRef) baseContext += 'Host evidence reference ' + authorRef + ' identifies the provided author tool quotes below (not independently rerun). Use it only for claims settled by those quotes.\n'
        if (evidence.sensitiveInput || detectSensitiveText(draft)) return await fail('本次输入含疑似凭据，未发送给评审；请先去除敏感内容')
        if (evidence.request !== '') {
          baseContext += 'Request being answered:\n"""\n' + evidence.request + '\n"""\n\n'
        }
        suspectContext = baseContext
        let draftContext = 'Draft block map:\n'
        for (const b of draftBlocks) draftContext += b.id + ': ' + b.type + '\n'
        draftContext += '\nDraft under review:\n"""\n' + draft + '\n"""'
        suspectContext += draftContext
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
        return await fail('evidence assembly failed: ' + String(evidenceError && evidenceError.message || evidenceError))
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
        } catch {
          operation.check()
          return await fail('无法安全准备评审资料区；请确认项目目录及隔离运行环境，没有启动模型或退回普通文件读取')
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
          return await fail('critic spawn failed: ' + String(spawnError && spawnError.message || spawnError))
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
          return await fail('suspect phase failed: ' + String(suspectError && suspectError.message || suspectError))
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
            return await fail('critic spawn failed: ' + String(spawnError && spawnError.message || spawnError))
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
      parsed.stats = coverage.stats
      const annotations = parsed.annotations
      const sound = coverage.coverage === 'complete' && parsed.verdict === 'pass' && annotations.length === 0
      // A free-form summary cannot certify withheld claims around the ledger.
      const summary = parsed.outcomes
        ? (parsed.stats.checked === 0 ? '未提出可证伪疑点；未进行独立核实。'
          : '复核记录：' + parsed.stats.checked + ' 项疑点，' + parsed.stats.confirmed + ' 项确认问题，' + parsed.stats.excluded + ' 项排除，' + parsed.stats.unchecked + ' 项未查。')
        : parsed.summary
      const entry = {
        schemaVersion: RECORD_SCHEMA_VERSION, sessionId, reviewId, messageId, workspaceRoot: agent.session?.header?.cwd,
        evidenceRecords: parsed.evidenceRecords, evidenceIds: parsed.evidenceRecords.map(record => record.id),
        status: coverage.coverage === 'partial' ? 'incomplete' : sound ? 'sound' : annotations.length ? 'completed' : 'unverified',
        coverage: coverage.coverage,
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
        await persistReview(sessionId, entry)
      } catch (persistError) {
        return await fail('review persistence failed: ' + String(persistError && persistError.message || persistError))
      }
      const { evidenceRecords: _privateEvidence, ...publicEntry } = entry
      return { ok: true, review: publicEntry }
    } catch (error) {
      return await fail('unexpected: ' + String(error && error.message || error))
    } finally {
      // All stage handles are awaited before the operation leaves the registry.
      for (const [id, c] of stageControls) {
        c.abort.abort()
        try { await c.run.dispose() } catch (error) { this.ctx.logger?.warn('Ciel child cleanup failed: %s', error.message) }
        operation.signal.removeEventListener('abort', c.onCancel)
        this.children.delete(id)
        this.liveCriticChildren.delete(id)
      }
      corpus?.dispose()
      receiptLedger.dispose()
      for (const [label, control] of this.pendingReviewControls) if (control.operation === operation) this.pendingReviewControls.delete(label)
      operation.dispose()
      this.activeOperations.delete(operation)
      this.inFlight.delete(key)
      this.activeSessions.delete(sessionId)
      this.progressByMessage.delete(key)
    }
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
      const stored = await readRecord('reviews', sessionId, reviewId)
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
  toolEventView,
  AdvisorReviewService,
  triageSuspects,
  appendFeedback,
  readFeedbackTriage,
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
    reviewService.beforeRequest(agent.id)
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
        invocations: [reviewInvocation('list'), reviewInvocation('start'), reviewInvocation('feedback'), reviewInvocation('prepareFeedback'), reviewInvocation('triage'), reviewInvocation('progress'), reviewInvocation('cancel'), reviewInvocation('callModelUsage'), reviewInvocation('readReview'), reviewInvocation('readEvidence'), reviewInvocation('readAdvice')],
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
      return reviewService.guard(exec)
    })
    reviewService.guardAvailable = true
    tctx.effect(() => () => {
      reviewService.guardAvailable = false
      for (const operation of reviewService.inFlight.values()) operation.cancel('tool guard unavailable')
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
        if (!reviewService.guardAvailable) throw new Error('Ciel requires tools.guard() before model calls')
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
          try { await persistAdvice(parent.id, 'tool', exec.callId, answer, modelUsage) }
          catch { ctx.logger?.warn('Ciel: advisor sidebar record could not be saved') }
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

  // ── /advise 人类命令（P3，advcmd 原型 pkg-16 双线确认后静态化）───────────
  // 双槽：此处 commands 注册 + client 的 conversation.chat.commandview 卡片。
  // 上下文自动装配（assembleAdviseContext）；四条门对人类显式触发放行
  // （HITL override，看板 M3-①）。成功结果除卡片外以 steer 回注主模型——
  // next-step 在每个 step 边界无条件全量认领；followup 的 next-turn 队列在
  // goal 轮次/composer 路径下会饿死（原型实测，inbox 挂 3 轮未认领）。
  // effort 钉与 ask_advisor 共用 liveAdvisorChildren 通道；错误结果不回注。
  ctx.inject(['commands', 'subagents'], (cctx) => {
    cctx.commands.register({
      name: 'advise',
      description: '向顾问模型发起咨询；上下文自动装配自本会话，结果渲染卡片并回注主模型',
      input: { hint: '咨询问题（开放设计空间 / 陌生领域 / 不可逆决策 / 困难诊断）' },
      async handler(invocation) {
        const cfg = current()
        const modelUsage = createModelUsage(cfg.provider, cfg.model)
        try {
        const question = String(invocation.rawInput || '').trim()
        if (question === '') {
          return { kind: 'error', text: '用法：/advise 你的问题 —— 上下文会从本会话最近对话自动装配' }
        }
        if (cfg.enabled === false) return { kind: 'error', text: 'Ciel disabled' }
        if (!reviewService.guardAvailable) return { kind: 'error', text: 'Ciel requires tools.guard() before model calls' }
        const assembled = assembleAdviseContext(invocation.agent)
        const consultation =
          'Established facts and constraints:\n' +
          '（以下上下文由 /advise 命令从本会话最近对话自动装配，可能不完整；如需补充请以对话说明为准）\n' +
          (assembled === '' ? '（本会话暂无可装配的对话内容）' : assembled) +
          '\n\nQuestion:\n' + question
        if (detectSensitiveText(consultation)) return { kind: 'error', text: '咨询输入含疑似凭据，未发送给顾问；请先去除敏感内容' }
        const owned = beginAdvisorCall(invocation.signal)
        let run
        try {
          owned.operation.check()
          run = await cctx.subagents.start('spawn', {
            label: 'advise',
            parent: invocation.agent,
            signal: owned.operation.signal,
            prompt: [{ type: 'text', text: consultation }],
            agentOptions: {
              provider: cfg.provider,
              model: cfg.model,
              maxTokens: cfg.maxTokens,
            },
            persona: ADVISOR_PERSONA,
            maxDepth: 1,
            toolFilter: { allow: [] },
          })
        } catch (spawnError) {
          owned.finish()
          return {
            kind: 'error',
            text: 'advisor spawn failed: ' + String((spawnError && spawnError.message) || spawnError),
          }
        }
        liveAdvisorChildren.set(run.id, owned.operation)
        try {
          const childTools = run.localAgent?.ctx?.get('tools')
          if (typeof childTools?.presentAs === 'function') childTools.presentAs('native')
          const result = await run.result
          owned.operation.check()
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            return {
              kind: 'error',
              text: '顾问咨询异常结束（' + String(result.stopReason) + '）' +
                (text === '' ? '' : '\n部分回答：\n' + text),
            }
          }
          const answer = text === '' ? '顾问返回了空回答。' : text
          // 注入失败不颠覆命令本身——卡片照常渲染，失败以附注形式透明可见。
          let note = ''
          try {
            invocation.agent.steer({
              id: 'advise-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
              role: 'user',
              content: [{
                type: 'text',
                text: '[advisor:advise-result] 用户通过 /advise 命令向顾问模型发起咨询，结果如下' +
                  '（用户已在卡片中看到同样的内容；请结合当前工作自行采纳或讨论，不必复述原文）：\n\n' +
                  '问题：' + question + '\n\n顾问回答：\n' + answer,
              }],
              source: { kind: 'user' },
            })
          } catch (injectError) {
            note = '\n\n（结果回注主模型失败：' + String((injectError && injectError.message) || injectError) + '）'
          }
          captureModelUsage(modelUsage, run)
          try { await persistAdvice(invocation.agent.id, 'command', invocation.commandId, answer, modelUsage) }
          catch { note += '\n\n（顾问侧栏记录保存失败，本次卡片内容仍可查看）' }
          return { kind: 'success', text: answer + note }
        } catch (runError) {
          return {
            kind: 'error',
            text: 'advisor run failed: ' + String((runError && runError.message) || runError),
          }
        } finally {
          captureModelUsage(modelUsage, run)
          liveAdvisorChildren.delete(run.id)
          try { await run.dispose() } finally { owned.finish() }
        }
        } finally {
          try { await persistCallModelUsage(invocation.agent?.id, 'command', invocation.commandId, modelUsage) }
          catch { ctx.logger?.warn('Ciel: command model usage record could not be saved') }
        }
      },
    })
  })
}
