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
//   3. the `ciel` settings namespace — edited from Settings → Plugins →
//      dsh-ciel, hot-applied to every later consultation without restart;
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
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
    .description('允许 Ciel 发起模型调用（顾问、/advise、评审及回传）；关闭会取消本插件在途调用，不改变模型配置'),
  advisorTimeoutSeconds: Schema.number().step(1).min(10).max(600).default(180)
    .description('一次顾问咨询（含 /advise）的总时限，秒；取消或超时不会自动重试'),
  criticTimeoutSeconds: Schema.number().step(1).min(10).max(600).default(180)
    .description('一次完整评审的总时限（秒，含存疑、核实和抢救）；超时停止，不自动重试'),
  criticMaxRequests: Schema.number().step(1).min(2).max(32).default(16)
    .description('一次评审全部阶段的模型步骤请求上限；提供方内部重试由 DSH 管理，不是金额上限，达到后不再抢救'),
  criticMaxTokens: Schema.number().step(1).min(256).max(32768).default(16384)
    .description('批评者每次模型请求的输出上限；存疑最多 4096、抢救最多 8192；不是整轮 token 总额'),
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
    .description('探索型批评者（0.13.0）：评审时对可证伪疑点做只读定点核实（read/grep/glob 白名单，世界可碰、过程不许碰）；关闭后退回纯草稿裁决'),
  criticExploreBudget: Schema.number().step(1).min(0).max(10).default(5)
    .description('单次评审允许执行的只读工具次数；执行前拦截超额调用。0 关闭探索但仍调用模型；不是金额上限'),
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
    },
    required: ['text', 'items', 'issues'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
  presentationMeta: (_args, value) => ({ v: 1, items: value.items, issues: value.issues }),
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
const GATE_REJECTION_HEAD = /^(?:Error: )?(?:context is required:|explore first:|follow-ups must be driven by NEW facts:|advisor budget for this planning phase is exhausted|advisor consultation already in flight|advisor telemetry unavailable|Ciel disabled|Ciel requires tools\.guard)/

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
      return name !== undefined && name !== 'ask_advisor'
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
  'text, or which tool result showed what). When the draft asserts ' +
  'something the provided evidence cannot confirm — including a turn with ' +
  'NO tool activity matching a claimed verification — flag it ONLY if the ' +
  'claim is load-bearing (the draft\'s conclusion or the user\'s next ' +
  'action collapses if it is false): at most 2 such annotations, each ' +
  'phrased as a conditional risk ("if X does not hold, … — verify before ' +
  'acting"), never asserted as fact. Product facts about this environment ' +
  'you may rely on — never second-guess them: the chat UI supports image ' +
  'attachments (users can paste screenshots); replies render in a web UI ' +
  'whose action area can carry plugin-registered buttons and cards, and ' +
  'plugins can add inline marks (underlines, badges) to rendered text; ' +
  'session history persists across restarts; static host-bundle plugins ' +
  'take effect only after a DSH restart while dynamic Cordis packages ' +
  'hot-swap without one. If the draft is sound, use the pass verdict ' +
  'header and a one-sentence summary in the draft\'s language, ' +
  'plus at most 3 [nit] annotations for residual risks.'

/**
 * ③深化 persona 增补（0.9.0）：清单驱动批注免于 ≤2 条配给（grounding 来自
 * 事前指定的清单，不是现场猜测）。两种形态——「声称已验证但无对应工具动作」
 * 可事实语气；「依赖建议结论但未见验证动作」保持条件句式。证据摘要只覆盖草案
 * 同轮：引用更早轮次验证的断言按条件风险处理（advrub 原型实测教训——跨轮引用
 * 在本摘要中天然不可见，误升事实级会制造错报）。自带 when-present 门，无清单时
 * 不改变基线行为。
 */
const RUBRIC_ADDENDUM =
  '\n\nADVISOR VERIFICATION LIST: when one is provided after the tool ' +
  'activity section, it is the checklist the consulted advisor PRE-DECLARED ' +
  '— what the author should verify against the environment before relying ' +
  'on each suggestion. Cross-check every listed target against the tool ' +
  'activity digest. Two annotation forms, both EXEMPT from the 2-item ' +
  'unverifiable-claim ration because their grounding is the pre-declared ' +
  'list, not your own guessing: (1) the draft asserts or implies a listed ' +
  'verification was performed but NO tool activity corresponds — phrase as ' +
  'fact, citing which digest line should have existed; (2) the draft relies ' +
  'on a listed suggestion\'s conclusion yet no verification-shaped tool ' +
  'activity appears — keep conditional phrasing ("若未验证…先核实"). When ' +
  'the digest shows a matching verification action, do NOT annotate that ' +
  'target. Never annotate a listed target the draft neither claims nor ' +
  'relies on — a pending verification is normal, not an error. The digest ' +
  'covers ONLY the draft\'s own turn: a draft claim that cites verification ' +
  'performed in an EARLIER turn (e.g. "早些时候已验证") cannot match this ' +
  'digest by construction — treat such claims as conditional risks (form 2), ' +
  'never as form-1 facts.'

const CRITIC_PROMPT_SUFFIX =
  '\n\nWrite the verdict header and annotations now as your visible reply. ' +
  'You have no tools; judge from the draft and the provided request/tool ' +
  'evidence.'

/**
 * 契约 v4（0.15.0）两阶段显式化：阶段 1「存疑」独立成无工具 spawn，只交
 * 结构化疑点清单——阶段边界由编排强制（根治单回合步骤塌缩），清单随后
 * 经 host 机械分诊（bearing 排序 + 预算截取），stats 的 M/Z 由此诚实。
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
  '- result: s1 | outcome: cleared | evidence: <finding with file:line, tool quote, or provided evidence>\n' +
  '- result: s2 | outcome: defect | evidence: <finding that proves the draft WRONG>\n' +
  '- result: s3 | outcome: unchecked | evidence: none\n\n' +
  '## verdict: pass|changes\n' +
  'summary: <one sentence>\n\n' +
  '### [blocker] title\n' +
  'suspect: s2\n' +
  'block: b2\n' +
  'evidence: <the concrete finding for s2>\n' +
  'anchor: <verbatim quote from that suspect\'s draft block>\n' +
  'comment: <the defect and why it matters>\n\n' +
  'Only defect results may have annotations (blocker or nit), and every ' +
  'defect must have an annotation. A TRUE draft claim is cleared, NOT a ' +
  'defect. Unchecked means evidence did not settle the suspicion; it ' +
  'MUST NOT become a conditional risk, warning, suggestion or nit. ' +
  'Never relabel an unchecked/withheld claim with another suspect id. ' +
  'Settled outcomes require a nonempty evidence citation. Severity and ' +
  'evidence are separate: every annotation includes its proof. Output ' +
  'the two sections even when no issues survive; never a SOUND-only reply.'

const CRITIC_VERIFY_CONTRACT =
  '\n\nVERIFY CONTRACT: verify ONLY the ordered selected suspects, cheapest ' +
  'first, within the read-only tool budget. A provided verbatim tool quote ' +
  'may settle a suspicion without another read; cite its decisive line. ' +
  'NEVER investigate your own instructions or this review contract. ' +
  'When no tool calls remain, write the final reply (writing is NOT a tool ' +
  'call). Do not start an investigation that cannot fit the remaining ' +
  'budget; leave that suspect unchecked. Earlier allowances for conditional ' +
  'unverified-claim annotations do NOT apply in this verification mode.' +
  VERIFICATION_LEDGER_CONTRACT

const CRITIC_VERIFY_PROMPT_SUFFIX =
  '\n\nVerify the suspects in order with your read-only tools within ' +
  'budget, then emit the dossier and verdict sections as your visible ' +
  'reply.'

function criticExploreToolsClause(budget) {
  return 'You have READ-ONLY exploration tools (read, grep, glob — no ' +
    'writes, no shell, no session history) and a HARD BUDGET of ' + budget +
    ' tool calls for this review; exceeding it aborts the review.'
}

function criticExplorePersona(budget) {
  return CRITIC_PERSONA.replace(CRITIC_NO_TOOLS_CLAUSE, criticExploreToolsClause(budget)) + RUBRIC_ADDENDUM + CRITIC_VERIFY_CONTRACT
}

/**
 * 熔断抢救书写员（仅一次）：探索者被预算熔断杀死后，拿着它的部分卷宗
 * （子会话死前最后可见文本）出最终 dossier+verdict——未了结的疑点一律
 * 进「未查 Z」，不得以任何形式落批注。
 */
const CRITIC_SALVAGE_PERSONA =
  'You are the verdict writer for an ABORTED review: the exploring critic ' +
  'was cut off by the budget breaker before writing its verdict. You ' +
  'receive the DRAFT, its block map, the suspect list the critic worked ' +
  'from, and the critic\'s PARTIAL dossier text (possibly empty, partial, ' +
  'or mid-sentence). You have NO tools. Produce the final two sections, ' +
  'dossier FIRST, verdict SECOND, in the same format: suspects the ' +
  'partial dossier already settled keep their outcome (defect or ' +
  'cleared, WITH the evidence the partial text cites); every other ' +
  'suspect is UNCHECKED — it must NOT appear as an annotation in any ' +
  'form (not even as a nit or a suggestion), it only counts toward 未查. ' +
  'A purported finding without cited evidence remains unchecked, never ' +
  'an annotation. Do not use the author context to investigate new issues. ' +
  'verdict: changes only when at least one blocker survives.' + VERIFICATION_LEDGER_CONTRACT

const CRITIC_SALVAGE_PROMPT_SUFFIX =
  '\n\nWrite the final dossier and verdict sections now from the partial ' +
  'findings — nothing else.'

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
function sessionEvents(session) {
  if (!session) return undefined
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  const events = session.events
  return Array.isArray(events) ? events : undefined
}

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
 * Progress sampler and terminal backstop. The authoritative execution cap is
 * AdvisorReviewService.guard(); polling observes attempted calls, not executed
 * bodies, and cannot enforce a precise limit. stop() also checks the final
 * sample so fast completion cannot hide an over-budget attempt.
 * @returns {{ stop(): number, calls(): number, breached(): boolean, action(): object }}
 */
function createBudgetWatchdog(options) {
  const agents = options.agents
  const runId = options.runId
  const budget = options.budget
  const intervalMs = options.intervalMs || 400
  const onBreach = options.onBreach
  let calls = 0
  let breached = false
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
        if (e.type === 'tool/call') { n += 1; lastTool = e; lastCall = e }
        else if (e.type === 'tool/result') lastTool = e
      }
      calls = n
      action = probeCriticAction(lastTool, lastCall)
    } catch { /* 看门狗尽力而为；spawn signal 仍是运行边界 */ }
  }
  const check = () => {
    sample()
    if (!breached && calls > budget) {
      breached = true
      onBreach()
    }
  }
  const timer = setInterval(check, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop: () => { clearInterval(timer); check(); return calls },
    calls: () => calls,
    breached: () => breached,
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
 * 机械分诊（契约 v4，host 侧）：bearing 高优先稳定排序，按预算截取，
 * 其余计未查——清单在送审前定型，模型不再掌握「查几个」的决定权。
 */
function triageSuspects(suspects, budget) {
  const high = suspects.filter((s) => s.bearing === 'high')
  const low = suspects.filter((s) => s.bearing !== 'high')
  const ordered = [...high, ...low]
  const cap = Math.max(1, budget)
  return { chosen: ordered.slice(0, cap), skipped: ordered.slice(cap) }
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

/** One cancellable lifetime shared by every phase (budget abort stays phase-local). */
function createReviewOperation({ timeoutMs = 180000, maxRequests = 16, now = Date.now, timers = globalThis } = {}) {
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
    beforeRequest: () => {
      check()
      if (requests >= maxRequests) { cancel('model request limit reached'); check() }
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

function turnEvidence(events, target) {
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
  for (const event of events) {
    if (!event || event.seq < startSeq || event.seq >= target.seq) continue
    if (event.type === 'user/message') {
      const text = userText(event)
      if (text !== '' && !text.includes('[advisor:plan-reminder]')) requests.push(text)
    } else if (event.type === 'tool/call' && event.data) {
      calls.set(String(event.data.callId), String(event.data.name || 'tool'))
    } else if (event.type === 'tool/result' && event.data) {
      const message = event.data.message || {}
      const block = Array.isArray(message.content) ? message.content[0] : undefined
      const callId = (block && block.toolCallId) || (message.source && message.source.callId)
      const name = calls.get(String(callId)) || 'tool'
      let snippet = ''
      let fullText = ''
      if (block && Array.isArray(block.content)) {
        const texts = block.content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text)
        fullText = texts.join('\n')
        if (fullText !== '') snippet = fullText.replace(/\s+/g, ' ').trim().slice(0, 240)
      }
      results.push('- ' + name + ': ' + ((block && block.isError) ? 'ERROR' : 'ok') + (snippet === '' ? '' : ' — "' + snippet + '"'))
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
      ? 'NONE — any draft claim of having run, tested, written, or verified something is unsupported by this turn\'s tool activity'
      : results.slice(0, MAX_TOOLS).join('\n') + (results.length > MAX_TOOLS ? '\n… +' + (results.length - MAX_TOOLS) + ' more' : ''),
    quotes,
  }
}

/**
 * Review persistence: a per-session sidecar JSONL store under the harness
 * home. Why not an `advisor/review` session event (the 0.3.x design):
 * `Session.append()` cannot set the envelope `ignorable` flag, and the
 * harness load path refuses any event type outside its build-time generated
 * catalog unless the event is ignorable — every out-of-repo `advisor/review`
 * event bricked its session log with SessionFormatUnsupportedError (observed
 * live: five sessions locked out, each needing surgical log repair). The
 * sidecar writes NOTHING into the log, so no harness build can ever refuse
 * the session; hydration reads this store instead of scanning session events.
 */
function reviewsDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-advisor', 'reviews')
}

/** The sidecar path for one session id, or undefined for an unusable id. */
function reviewsPath(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined
  return join(reviewsDir(), sessionId + '.jsonl')
}

/** Read every stored review of one session; a missing file means none. */
async function readReviews(sessionId) {
  const path = reviewsPath(sessionId)
  if (path === undefined) return []
  let text
  try { text = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const reviews = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry === 'object' && typeof entry.reviewId === 'string') reviews.push(entry)
    } catch { /* a torn trailing line recovers like a torn log tail: skipped */ }
  }
  return reviews
}

/** Append one review entry to the session's sidecar log. */
async function persistReview(sessionId, entry) {
  const path = reviewsPath(sessionId)
  if (path === undefined) throw new Error('unusable session id for review storage: ' + String(sessionId))
  await mkdir(reviewsDir(), { recursive: true })
  await appendFile(path, JSON.stringify(entry) + '\n')
}

// ═══════════════ 回传（review feedback）持久化 ═══════════════
// Which annotations the user endorsed for the author model — a per-session
// WAL sibling of the reviews store. This is the static host bundle, so
// direct node:fs applies; the dynamic prototype's fs-sandbox dance (its fs
// service resolved against the host cwd, not the session workspace) is gone.

/** The feedback WAL directory under the harness home. */
function feedbackDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-advisor', 'feedback')
}

/** The feedback WAL path for one session id, or undefined for an unusable id. */
function feedbackPath(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined
  return join(feedbackDir(), sessionId + '.jsonl')
}

/** Read every dedup key recorded for one session; a missing file means none. */
async function readFeedbackKeys(sessionId) {
  const keys = new Set()
  const path = feedbackPath(sessionId)
  if (path === undefined) return keys
  let text
  try { text = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return keys; throw error }
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const record = JSON.parse(line)
      if (record && Array.isArray(record.keys)) {
        for (const key of record.keys) if (typeof key === 'string') keys.add(key)
      }
    } catch { /* a torn trailing line recovers like a torn log tail: skipped */ }
  }
  return keys
}

/**
 * 0.12.0 ④分诊持久化：同一 WAL 里的两类新记录——
 *   { triage: { reviewId, index, state } }        state: 'accept' | 'dismiss'
 *   { triageFilter: { reviewId, filter } }        filter: 'all' | 'blocker'
 * 逐 (reviewId,index) 与逐 reviewId 后写胜出；撕裂尾行按惯例跳过。
 */
async function readFeedbackTriage(sessionId) {
  const triage = new Map()
  const path = feedbackPath(sessionId)
  if (path === undefined) return triage
  let text
  try { text = await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return triage; throw error }
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    const t = record && record.triage
    if (t && typeof t.reviewId === 'string' && Number.isInteger(t.index) && (t.state === 'accept' || t.state === 'dismiss')) {
      if (!triage.has(t.reviewId)) triage.set(t.reviewId, { states: new Map(), filter: undefined })
      triage.get(t.reviewId).states.set(t.index, t.state)
      continue
    }
    const f = record && record.triageFilter
    if (f && typeof f.reviewId === 'string' && (f.filter === 'all' || f.filter === 'blocker')) {
      if (!triage.has(f.reviewId)) triage.set(f.reviewId, { states: new Map(), filter: undefined })
      triage.get(f.reviewId).filter = f.filter
    }
  }
  return triage
}

/** Append one feedback record to the session's WAL. */
async function appendFeedback(sessionId, record) {
  const path = feedbackPath(sessionId)
  if (path === undefined) throw new Error('unusable session id for feedback storage: ' + String(sessionId))
  await mkdir(feedbackDir(), { recursive: true })
  await appendFile(path, JSON.stringify(record) + '\n')
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
  constructor(ctx, liveCriticChildren, getConfig, activeOperations = new Set()) {
    super(ctx, 'advisorReview')
    this.liveCriticChildren = liveCriticChildren
    this.getConfig = getConfig
    this.activeOperations = activeOperations
    this.inFlight = new Map()
    this.activeSessions = new Set()
    this.children = new Map()
    this.guardAvailable = false
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
    remoteMarker(Object.getPrototypeOf(this), 'triage').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'progress').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'cancel').call(this)
  }

  /** Runs synchronously before a tracked child's actual tool body. */
  guard(exec) {
    const c = this.children.get(exec.agent?.id)
    if (!c) return undefined
    try { c.operation.check() } catch (error) { return error.message }
    if (!c.allowTools || !['read', 'grep', 'glob'].includes(exec.name)) {
      c.operation.cancel('unexpected tool in review: ' + exec.name)
      return 'this review phase cannot execute that tool'
    }
    if (c.used >= c.budget) {
      c.breached = true
      c.abort.abort()
      return 'review tool budget exceeded'
    }
    c.used += 1
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
    const entries = await readReviews(request && request.sessionId)
    // The dedup keys ride along so the client can grey out already-returned
    // annotations after a reload, not just within one page lifetime.
    const sent = await this.sentSet(request && request.sessionId)
    // 分诊状态随行：采纳/忽略逐条 + 过滤器，客户端水合后恢复（0.12.0 ④）。
    const triage = await this.triageSet(request && request.sessionId)
    const triageOut = {}
    for (const [reviewId, t] of triage) {
      triageOut[reviewId] = {
        states: Object.fromEntries(t.states),
        ...(t.filter === undefined ? {} : { filter: t.filter }),
      }
    }
    return { reviews: entries.map((entry) => ({ ...entry, time: entry.createdAt })), sentKeys: Array.from(sent), triage: triageOut }
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
    return {
      inFlight: true,
      explore: p.explore,
      budget: p.budget,
      ...(p.phase === undefined ? {} : { phase: p.phase }),
      ...(p.suspects === undefined ? {} : { suspects: p.suspects }),
      toolCalls: p.toolCalls(),
      action: typeof p.action === 'function' ? p.action() : { kind: 'thinking' },
      elapsedMs: Date.now() - p.startedAt,
    }
  }

  /**
   * Persist one triage batch from the card (0.12.0 ④): per-annotation
   * accept/dismiss and/or the review's filter, appended to the same feedback
   * WAL as the dedup keys. Last write wins by construction (read side is
   * last-wins), so replays and repaints stay idempotent in effect.
   */
  async triage(request) {
    const sessionId = request && request.sessionId
    const reviewId = request && request.reviewId
    if (typeof reviewId !== 'string' || reviewId === '') return { ok: false, error: 'reviewId required' }
    const changes = Array.isArray(request.changes) ? request.changes : []
    const filter = request.filter
    try {
      for (const change of changes) {
        if (!change || !Number.isInteger(change.index) || (change.state !== 'accept' && change.state !== 'dismiss')) continue
        await appendFeedback(sessionId, { triage: { reviewId, index: change.index, state: change.state } })
        const ledger = await this.triageSet(sessionId)
        if (!ledger.has(reviewId)) ledger.set(reviewId, { states: new Map(), filter: undefined })
        ledger.get(reviewId).states.set(change.index, change.state)
      }
      if (filter === 'all' || filter === 'blocker') {
        await appendFeedback(sessionId, { triageFilter: { reviewId, filter } })
        const ledger = await this.triageSet(sessionId)
        if (!ledger.has(reviewId)) ledger.set(reviewId, { states: new Map(), filter: undefined })
        ledger.get(reviewId).filter = filter
      }
      return { ok: true }
    } catch (error) {
      this.ctx.logger?.warn('dsh-advisor: triage WAL append failed: %s', error && error.message)
      return { ok: false, error: String(error && error.message || error) }
    }
  }

  /** Run the critic over one assistant message and persist the review. */
  async start(request) {
    if (!request || typeof request.sessionId !== 'string' || typeof request.messageId !== 'string') return { ok: false, error: 'sessionId and messageId required' }
    const cfg = this.getConfig()
    if (cfg.enabled === false) return { ok: false, error: 'Ciel disabled' }
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
    const operation = createReviewOperation({ timeoutMs: (cfg.criticTimeoutSeconds ?? 180) * 1000, maxRequests: cfg.criticMaxRequests ?? 16 })
    this.inFlight.set(key, operation)
    this.activeSessions.add(sessionId)
    this.activeOperations.add(operation)
    const stageControls = new Map()
    const reviewId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const fail = async (error) => {
      this.ctx.logger?.warn('dsh-advisor: review.start failed: %s', String(error))
      const cancelled = operation.reason() === 'review cancelled by user' || operation.reason() === 'Ciel disabled' || operation.reason() === 'plugin stopped'
      const entry = { reviewId, messageId, anchorSeq: target.seq, status: cancelled ? 'cancelled' : 'error', error: String(error), annotations: [], modelRequests: operation.requests(), createdAt: Date.now() }
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
      const explore = cfg.criticExploreEnabled !== false && (cfg.criticExploreBudget === undefined ? 5 : cfg.criticExploreBudget) > 0
      const budget = explore ? cfg.criticExploreBudget || 5 : 0
      // 共享上下文（请求/摘要/引用/顾问清单/块地图/草稿）——v2 单段与 v4
      // 两阶段的每个 spawn 都以此为底。
      let baseContext = ''
      let suspectContext = ''
      try {
        const evidence = turnEvidence(events, target)
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
          baseContext += 'Full outputs of this turn\'s NON-REPRODUCIBLE tool calls (verbatim quotes — the world cannot re-produce these byte-for-byte, so cross-check draft claims against them directly before spending your own budget):\n'
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
      const releaseRun = async (run) => {
        const control = stageControls.get(run.id)
        try { await run.dispose() } finally {
          if (control) operation.signal.removeEventListener('abort', control.onCancel)
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
        try {
          run = await subagents.start('spawn', {
            label: spec.label, parent: agent, signal: abort.signal,
            prompt: [{ type: 'text', text: spec.prompt }],
            agentOptions: { ...spec.agentOptions, maxTokens: Math.min(spec.agentOptions.maxTokens, cfg.criticMaxTokens ?? 16384) },
            persona: spec.persona, maxDepth: 1, toolFilter: spec.toolFilter,
          })
          const control = { run, operation, abort, onCancel, used: 0, budget, allowTools: spec.toolFilter.allow.length > 0, breached: false }
          stageControls.set(run.id, control)
          this.children.set(run.id, control)
          this.liveCriticChildren.add(run.id)
          // A native local presentation keeps no-tool phases tool-free even
          // when the parent uses PTC's reserved run_code transport.
          const tools = run.localAgent?.ctx?.get('tools')
          if (typeof tools?.presentAs === 'function') tools.presentAs('native')
          operation.check()
          return run
        } catch (error) {
          operation.signal.removeEventListener('abort', onCancel)
          if (run) await releaseRun(run)
          throw error
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
      let salvageRows
      let salvaged = false
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
        this.progressByMessage.set(key, { explore, budget, startedAt: Date.now(), toolCalls: () => 0, action: () => ({ kind: 'thinking' }) })
        const { result, text: out, detail } = await awaitRun(run)
        if (result.stopReason !== 'completed') {
          return await fail('critic ended with "' + result.stopReason + '"' + (detail === '' ? '' : ': ' + detail))
        }
        if (out === '') return await fail('critic returned an empty answer (reasoning only, no visible text)')
        text = out
      } else {
        // ── 契约 v4 两阶段 ──
        const progress = { explore, budget, phase: 1, suspects: 0, startedAt: Date.now(), toolCalls: () => 0, action: () => ({ kind: 'thinking' }) }
        this.progressByMessage.set(key, progress)
        // 阶段 1：存疑（无工具、便宜，产出结构化疑点清单）
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
        // host 机械分诊：bearing 排序 + 预算截取，清单定型。
        const triage = triageSuspects(suspects, budget)
        selectedSuspects = triage.chosen
        suspectsMeta = { total: suspects.length, triaged: triage.chosen.length, skipped: triage.skipped.length }
        if (triage.chosen.length > 0) {
          let listText = 'Ordered suspect list (' + triage.chosen.length + ' suspects given to you). ' + triage.skipped.length +
            ' other suspects were withheld: do NOT verify, annotate, or count those in your stats; the pipeline adds them separately.\n'
          triage.chosen.forEach((s, i) => {
            listText += s.id + '. ' + (s.block ? '[' + s.block + '] ' : '') + s.suspect + ' — falsify: ' + (s.falsify || '（未给出）') + '\n'
          })
          progress.phase = 2
          progress.suspects = triage.chosen.length
          // 阶段 2：核实（只读白名单 + 预算看门狗）
          let budgetAborted = false
          let needSalvage = false
          let salvageReason = ''
          let partialText = ''
          let run2
          const phase2Abort = new AbortController()
          try {
            run2 = await spawnOnce({
              label: 'critic',
              prompt: baseContext + '\n\n' + listText + CRITIC_VERIFY_PROMPT_SUFFIX,
              agentOptions: { provider: cfg.criticProvider, model: cfg.criticModel, maxTokens: 16384 },
              persona: criticExplorePersona(budget),
              toolFilter: { allow: ['read', 'grep', 'glob'] },
              abort: phase2Abort,
            })
          } catch (spawnError) {
            return await fail('critic spawn failed: ' + String(spawnError && spawnError.message || spawnError))
          }
          const watchdog = createBudgetWatchdog({
            agents, runId: run2.id, budget,
            onBreach: () => { budgetAborted = true; phase2Abort.abort() },
          })
          const phaseControl = stageControls.get(run2.id)
          progress.toolCalls = () => phaseControl?.used ?? watchdog.calls()
          progress.action = () => watchdog.action()
          this.liveCriticChildren.add(run2.id)
          try {
            const result = await run2.result
            const observedCalls = watchdog.stop()
            const control = stageControls.get(run2.id)
            toolCalls = control?.used ?? observedCalls
            budgetAborted = budgetAborted || !!control?.breached || observedCalls > budget
            operation.check()
            text = outputText(result.output)
            if (!budgetAborted && result.stopReason !== 'completed') {
              return await fail('critic ended with "' + result.stopReason + '": ' + childErrorDetail(run2))
            }
            if (!budgetAborted && text === '') return await fail('critic returned an empty answer')
            if (budgetAborted) {
              // 抓死前部分卷宗（dispose 前子会话仍可读）。
              try {
                const child = agents.get(run2.id)
                const evs = child && sessionEvents(child.session)
                if (Array.isArray(evs)) {
                  for (let i = evs.length - 1; i >= 0; i -= 1) {
                    if (evs[i] && evs[i].type === 'assistant/message') {
                      const t = draftText(evs[i])
                      if (t !== '') { partialText = t; break }
                    }
                  }
                }
              } catch { /* 部分卷宗尽力而为 */ }
              if (partialText === '') partialText = text
              // Do not pay another model to turn an empty investigation into
              // a verdict. Require an explicit dossier with a cited finding.
              const recovered = parseOutcomeRows(partialText).rows
              salvageRows = selectedSuspects.map((s) => {
                const candidates = recovered.filter((row) => row.id === s.id)
                const row = candidates.length === 1 ? candidates[0] : undefined
                return row && row.outcome !== 'unchecked' && /(?:[\w./-]+:\d+|\b(?:read|grep|glob|bash|web_fetch|web_search)\b)/i.test(row.evidence)
                  ? row : { id: s.id, outcome: 'unchecked', evidence: '' }
              })
              needSalvage = salvageRows.some((row) => row.outcome !== 'unchecked')
              salvageReason = 'budget exceeded'
              if (!needSalvage) return await fail('budget exceeded; no recoverable cited dossier, salvage skipped')
            }
          } finally {
            watchdog.stop()
            await releaseRun(run2)
          }
          if (needSalvage) {
            operation.check()
            if (operation.requests() >= (cfg.criticMaxRequests ?? 16)) return await fail('model request limit reached; salvage skipped')
            progress.phase = 3
            progress.action = () => ({ kind: 'thinking' })
            // 熔断抢救（仅一次）：无工具书写员拿部分卷宗出最终裁决。
            this.ctx.logger?.warn('dsh-advisor: phase 2 aborted (%s); running one-shot salvage writer', salvageReason)
            const salvagePrompt = suspectContext + '\n\n' + listText +
              '\n\nFROZEN investigator findings (already checked BEFORE the abort; your lack of tools does NOT undo these findings):\n' +
              salvageRows.map((row) => '- result: ' + row.id + ' | outcome: ' + row.outcome + ' | evidence: ' + (row.evidence || 'none')).join('\n') +
              '\n\nCopy these outcomes unchanged. Only write annotations for frozen defect ids; do not reassess the world or the author tool activity.' + CRITIC_SALVAGE_PROMPT_SUFFIX
            try {
              const run3 = await spawnOnce({
                label: 'critic-salvage',
                prompt: salvagePrompt,
                agentOptions: { provider: cfg.criticProvider, model: cfg.criticModel, maxTokens: 8192 },
                persona: CRITIC_SALVAGE_PERSONA,
                toolFilter: { allow: [] },
              })
              const r3 = await awaitRun(run3)
              if (r3.result.stopReason !== 'completed' || r3.text === '') {
                return await fail('phase 2 aborted (' + salvageReason + ') and the salvage writer also failed (stopReason ' + r3.result.stopReason + ')')
              }
              text = r3.text
              salvaged = true
            } catch (salvageError) {
              return await fail('phase 2 aborted (' + salvageReason + '); salvage spawn failed: ' + String(salvageError && salvageError.message || salvageError))
            }
          }
        }
      }
      if (explore && suspectsMeta?.triaged === 0 && text === '') {
        text = '## verdict: pass\nsummary: 存疑阶段未提出疑点；未进行独立核实。\nstats: 排查 0 · 证伪 0 · 排除 0 · 未查 0'
      }
      operation.check()
      const parsed = parseCriticReview(text, draft, draftBlocks, { explore, strict: true, ...(explore ? { selected: selectedSuspects, allSuspects, frozenRows: salvaged ? salvageRows : undefined } : {}) })
      if (!parsed.valid) return await fail('critic format error: exactly one valid verdict section is required')
      const coverage = reviewCoverage(parsed, { explore, suspects: suspectsMeta, salvaged })
      parsed.stats = coverage.stats
      const annotations = parsed.annotations
      const sound = coverage.coverage === 'complete' && parsed.verdict === 'pass' && annotations.length === 0
      // A free-form summary cannot certify withheld claims around the ledger.
      const summary = parsed.outcomes
        ? (parsed.stats.checked === 0 ? '未提出可证伪疑点；未进行独立核实。'
          : '复核记录：' + parsed.stats.checked + ' 项疑点，' + parsed.stats.confirmed + ' 项确认问题，' + parsed.stats.excluded + ' 项排除，' + parsed.stats.unchecked + ' 项未查。')
        : parsed.summary
      const entry = {
        reviewId, messageId, anchorSeq: target.seq,
        status: coverage.coverage === 'partial' ? 'incomplete' : sound ? 'sound' : annotations.length ? 'completed' : 'unverified',
        coverage: coverage.coverage,
        ...(coverage.coverageNote ? { coverageNote: coverage.coverageNote } : {}),
        ...(parsed.verdictAdjusted ? { verdictAdjusted: true } : {}),
        ...(parsed.outcomes ? { outcomes: parsed.outcomes, ignoredAnnotations: parsed.ignoredAnnotations } : {}),
        modelRequests: operation.requests(),
        sound,
        ...(parsed.verdict === undefined ? {} : { verdict: parsed.verdict }),
        ...(summary === '' ? {} : { summary }),
        // New exploratory stats are counted from the host-owned identity
        // ledger. Tool counts are a distinct resource metric, never progress
        // through the suspect pool or a monetary budget.
        ...(parsed.stats === undefined ? {} : { stats: parsed.stats }),
        ...(explore ? { explore: { budget, toolCalls, ...(salvaged ? { salvaged: true } : {}) } } : {}),
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
      return { ok: true, review: entry }
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
      operation.dispose()
      this.activeOperations.delete(operation)
      this.inFlight.delete(key)
      this.activeSessions.delete(sessionId)
      this.progressByMessage.delete(key)
    }
  }

  /**
   * Send the user-endorsed annotations of one review back to the author model
   * as a followup user message (next-turn semantics: never interrupts a
   * running turn — it becomes the sole ordinary message of its own turn once
   * the agent goes idle). Idempotent per reviewId#index: the WAL-seeded
   * ledger skips repeats, so a double click or a repainted panel re-send
   * costs nothing. Ported from the annfbk dynamic prototype after live
   * confirmation (delivery/wake, readable payload, dedup skip).
   */
  async feedback(request) {
    try {
      if (this.getConfig().enabled === false) return { ok: false, error: 'Ciel disabled; feedback would start a model turn' }
      const sessionId = request && request.sessionId
      const agents = this.ctx.get('agents')
      if (agents === undefined) return { ok: false, error: 'agents service unavailable' }
      const agent = agents.get(sessionId)
      if (agent === undefined) return { ok: false, error: 'session is not live: ' + sessionId }
      const reviewId = typeof request.reviewId === 'string' ? request.reviewId : ''
      const stored = (await readReviews(sessionId)).find((entry) => entry.reviewId === reviewId)
      if (!stored || !Array.isArray(stored.annotations)) return { ok: false, error: 'stored review not found' }
      if (request.messageId && request.messageId !== stored.messageId) return { ok: false, error: 'review/message mismatch' }
      const indices = new Set((Array.isArray(request.items) ? request.items : []).map((item) => item?.index))
      const items = [...indices].filter((i) => Number.isInteger(i) && i >= 0 && i < stored.annotations.length)
        .map((index) => ({ ...stored.annotations[index], index }))
      if (items.length === 0) return { ok: false, error: 'no annotations selected' }
      const keyOf = (item) => (reviewId !== '' ? reviewId : 't:' + String(item.title)) + '#' + String(item.index)
      const sent = await this.sentSet(sessionId)
      const fresh = items.filter((item) => !sent.has(keyOf(item)))
      const skippedIndices = items.filter((item) => sent.has(keyOf(item))).map((item) => item.index)
      if (fresh.length === 0) return { ok: true, delivered: 0, skipped: items.length, skippedIndices }
      const lines = [
        '[advisor:review-feedback] 用户逐条确认了批评者对你此前回复的以下批注，请按 author-owns-the-remedy 自行修复对应问题（不必逐条回复，修复后在产物中体现）：',
        '原消息: ' + stored.messageId + ' · 评审: ' + reviewId,
        '证据是批评者引用的发现，仍需核对与当前工作是否相符；不要因批注存在就盲目修改。',
      ]
      for (const item of fresh) {
        lines.push('')
        lines.push('### [' + (item.severity === 'blocker' ? 'blocker' : 'nit') + '] ' + String(item.title || '（无标题）'))
        if (item.block) lines.push('block: ' + String(item.block))
        if (item.anchor) lines.push('anchor: ' + String(item.anchor))
        if (item.evidence) lines.push('evidence: ' + String(item.evidence))
        if (item.comment) lines.push('comment: ' + String(item.comment))
      }
      agent.followup({
        id: 'mfb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: 'user' },
      })
      for (const item of fresh) sent.add(keyOf(item))
      let warn
      try {
        await appendFeedback(sessionId, {
          reviewId,
          messageId: typeof request.messageId === 'string' ? request.messageId : '',
          keys: fresh.map(keyOf),
          indices: fresh.map((item) => item.index),
          time: Date.now(),
        })
      } catch (error) {
        // Dedup already holds in memory; the WAL only matters across restarts.
        warn = '反馈日志未落盘（去重不受影响，重启后该条可能重复）: ' + String(error && error.message || error)
        this.ctx.logger?.warn('dsh-advisor: feedback WAL append failed: %s', error && error.message)
      }
      return { ok: true, delivered: fresh.length, skipped: skippedIndices.length, skippedIndices, ...(warn ? { warn } : {}) }
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
  createBudgetWatchdog,
  turnEvidence,
  parseSuspectList,
  parseSuspectResponse,
  parseOutcomeRows,
  reconcileReviewLedger,
  reviewCoverage,
  createReviewOperation,
  createConsultationGate,
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
        invocations: [reviewInvocation('list'), reviewInvocation('start'), reviewInvocation('feedback'), reviewInvocation('triage'), reviewInvocation('progress'), reviewInvocation('cancel')],
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
          return { text: answer, items: parsed.items, issues: parsed.issues }
        } finally {
          try {
            if (run) { liveAdvisorChildren.delete(run.id); await run.dispose() }
          } finally { owned.finish(); release() }
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
        const question = String(invocation.rawInput || '').trim()
        if (question === '') {
          return { kind: 'error', text: '用法：/advise 你的问题 —— 上下文会从本会话最近对话自动装配' }
        }
        const cfg = current()
        if (cfg.enabled === false) return { kind: 'error', text: 'Ciel disabled' }
        if (!reviewService.guardAvailable) return { kind: 'error', text: 'Ciel requires tools.guard() before model calls' }
        const assembled = assembleAdviseContext(invocation.agent)
        const consultation =
          'Established facts and constraints:\n' +
          '（以下上下文由 /advise 命令从本会话最近对话自动装配，可能不完整；如需补充请以对话说明为准）\n' +
          (assembled === '' ? '（本会话暂无可装配的对话内容）' : assembled) +
          '\n\nQuestion:\n' + question
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
          return { kind: 'success', text: answer + note }
        } catch (runError) {
          return {
            kind: 'error',
            text: 'advisor run failed: ' + String((runError && runError.message) || runError),
          }
        } finally {
          liveAdvisorChildren.delete(run.id)
          try { await run.dispose() } finally { owned.finish() }
        }
      },
    })
  })
}
