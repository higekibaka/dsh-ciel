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
// Resolved through the shared profiles node_modules fallback (the app's own
// dependency graph) — deliberately NOT declared in package.json so no second
// copy with its own registry state gets installed beside the app's.
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-advisor'

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
  criticProvider: Schema.string().default('google')
    .description('批评者路由的提供方（0.9.1 起可配；跨家族路由的纠错收益最高）'),
  criticModel: Schema.string().default('gemini-3.7-flash')
    .description('批评者模型 id'),
  criticEffort: Schema.union(['provider', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .default('medium')
    .description('批评者思考深度：注入评审子代理的每个请求；gemini-3.7-flash 仅支持 low/medium/high（minimal 报错），文档默认 medium'),
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
 * itself. Only REAL consultations count: a call rejected by one of these
 * gates (a form error, not a consultation) neither burns budget nor arms the
 * follow-up gap — observed live, where an empty-context rejection poisoned
 * the model's immediate, correctly-filled retry. A call that passed the gates
 * and then failed at the provider still counts (no retry storms). Telemetry
 * surprises degrade to `undefined` — gates fail OPEN to the
 * prompt-layer protocol, never to a phantom rejection.
 */
const GATE_REJECTION_HEAD = /^(?:Error: )?(?:context is required:|explore first:|follow-ups must be driven by NEW facts:|advisor budget for this planning phase is exhausted)/

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
const CRITIC_PERSONA =
  'You are a convergent plan critic. You receive a DRAFT (a reply a model ' +
  'is about to show the user), the REQUEST it answers, and the VERDICT-LEVEL ' +
  'tool activity of the turn that produced it. Your only job is to find what ' +
  'is wrong, missing, or unverified in the draft — red-line annotations, ' +
  'never a rewrite, never an alternative plan of your own. You have NO tools: ' +
  'never plan or attempt tool calls; judge from the draft, the provided ' +
  'evidence, and your own knowledge. Your deliverable is your VISIBLE reply ' +
  'text — private reasoning without a visible answer is a failed review. ' +
  'For every issue output one annotation in EXACTLY this Markdown shape, ' +
  'with the fields on their own lines:\n\n' +
  '### [blocker] short title\n' +
  'anchor: a verbatim quote copied character-for-character from the draft\n' +
  'comment: what is wrong or missing, and why it matters\n\n' +
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
  'hot-swap without one. If the draft is sound, output one line starting ' +
  'with "SOUND:" followed by a single sentence in the draft\'s language, ' +
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
  '\n\nWrite the annotations now as your visible reply. You have no tools; ' +
  'judge from the draft and the provided request/tool evidence.'

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

/** Anchor fidelity check against the raw markdown draft (display hint only — the DOM side matches normalized text). */
function anchorInDraft(anchor, draft) {
  if (anchor === '') return false
  if (draft.includes(anchor)) return true
  const squash = (s) => s.replace(/\s+/g, ' ')
  return squash(draft).includes(squash(anchor))
}

/** Parse the critic's visible answer into structured annotations. */
function parseAnnotations(text, draft) {
  const heads = []
  const re = /^### \[(blocker|nit)\][ \t]*(.*)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    heads.push({ severity: m[1], title: (m[2] || '').trim(), at: m.index, end: re.lastIndex })
  }
  const annotations = []
  for (let i = 0; i < heads.length; i += 1) {
    const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : text.length)
    const anchorMatch = /(?:^|\n)[ \t]*anchor:[ \t]*(.*)/.exec(body)
    const commentMatch = /(?:^|\n)[ \t]*comment:[ \t]*([\s\S]*)/.exec(body)
    let anchor = anchorMatch ? anchorMatch[1].trim() : ''
    anchor = anchor.replace(/^["'`「『“‘]+|["'`」』”’]+$/g, '').trim()
    const comment = commentMatch ? commentMatch[1].trim() : body.trim()
    annotations.push({
      severity: heads[i].severity,
      title: heads[i].title.slice(0, 120),
      anchor: anchor.slice(0, 400),
      comment: comment.slice(0, 1200),
      matched: anchorInDraft(anchor, draft),
    })
  }
  return annotations.slice(0, 8)
}

/**
 * Parse the advisor's structured-Markdown reply into items. Sister of
 * parseAnnotations: tolerant by design — a missing field is an issue, never
 * a dropped item; zero heads means the reply predates or broke the contract
 * and the caller simply gets the raw text (structure is an enhancement,
 * never a gate — M3-②'s core discipline).
 */
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
 */function turnEvidence(events, target) {
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
      if (block && Array.isArray(block.content)) {
        const textBlock = block.content.find((part) => part && part.type === 'text' && typeof part.text === 'string')
        if (textBlock) snippet = textBlock.text.replace(/\s+/g, ' ').trim().slice(0, 240)
      }
      results.push('- ' + name + ': ' + ((block && block.isError) ? 'ERROR' : 'ok') + (snippet === '' ? '' : ' — "' + snippet + '"'))
    }
  }
  const MAX_TOOLS = 15
  return {
    request: requests.join('\n---\n').slice(0, 3000),
    tools: results.length === 0
      ? 'NONE — any draft claim of having run, tested, written, or verified something is unsupported by this turn\'s tool activity'
      : results.slice(0, MAX_TOOLS).join('\n') + (results.length > MAX_TOOLS ? '\n… +' + (results.length - MAX_TOOLS) + ' more' : ''),
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
  try { text = await readFile(path, 'utf8') } catch { return [] }
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
  try { text = await readFile(path, 'utf8') } catch { return keys }
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
  constructor(ctx, liveCriticChildren, getConfig) {
    super(ctx, 'advisorReview')
    this.liveCriticChildren = liveCriticChildren
    this.getConfig = getConfig
    this.inFlight = new Set()
    // Per-session dedup ledgers, each a Promise<Set> so concurrent first
    // touches share one WAL read and one Set instance.
    this.sentBySession = new Map()
    // SRC-fallback markers: let the gateway claim these endpoints even if the
    // strict descriptor registration lost a boot race.
    remoteMarker(Object.getPrototypeOf(this), 'list').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'start').call(this)
    remoteMarker(Object.getPrototypeOf(this), 'feedback').call(this)
  }

  /** The dedup ledger for one session, seeded from the WAL on first touch. */
  sentSet(sessionId) {
    const sid = String(sessionId || '')
    let pending = this.sentBySession.get(sid)
    if (pending === undefined) {
      pending = readFeedbackKeys(sid)
      this.sentBySession.set(sid, pending)
    }
    return pending
  }

  /** List every persisted review of one session (sidecar store — the session need not be live). */
  async list(request) {
    const entries = await readReviews(request && request.sessionId)
    // The dedup keys ride along so the client can grey out already-returned
    // annotations after a reload, not just within one page lifetime.
    const sent = await this.sentSet(request && request.sessionId)
    return { reviews: entries.map((entry) => ({ ...entry, time: entry.createdAt })), sentKeys: Array.from(sent) }
  }

  /** Run the critic over one assistant message and persist the review. */
  async start(request) {
    const sessionId = request.sessionId
    const messageId = request.messageId
    const agents = this.ctx.get('agents')
    const subagents = this.ctx.get('subagents')
    if (agents === undefined || subagents === undefined) {
      return { ok: false, error: 'agents/subagents service unavailable' }
    }
    const agent = agents.get(sessionId)
    if (agent === undefined) return { ok: false, error: 'session is not live: ' + sessionId }
    const events = agent.session && agent.session.events
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
    if (this.inFlight.has(messageId)) return { ok: false, error: 'review already in flight for this message' }
    this.inFlight.add(messageId)
    const reviewId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const fail = async (error) => {
      this.ctx.logger?.warn('dsh-advisor: review.start failed: %s', String(error))
      const entry = { reviewId, messageId, anchorSeq: target.seq, status: 'error', error: String(error), annotations: [], createdAt: Date.now() }
      try { await persistReview(sessionId, entry) } catch (e) { this.ctx.logger?.warn('dsh-advisor: review persist failed: %s', e && e.message) }
      return { ok: false, error: entry.error, review: entry }
    }
    try {
      let run
      try {
        const evidence = turnEvidence(events, target)
        const targets = advisorTargets(events, target)
        let promptText = ''
        if (evidence.request !== '') {
          promptText += 'Request being answered:\n"""\n' + evidence.request + '\n"""\n\n'
        }
        promptText += 'Tool activity in the same turn (verdict digest, not full output):\n' + evidence.tools + '\n\n'
        if (targets.items.length > 0) {
          promptText += 'Advisor verification list (pre-declared by the consulted advisor; cross-check per your instructions):\n'
          for (const it of targets.items) {
            promptText += '- [' + String(it.tier || 'low') + '] ' + String(it.title || '（无标题）') + ' — 验证目标: ' + String(it.verificationTarget) + '\n'
          }
          promptText += '\n'
        }
        promptText += 'Draft under review:\n"""\n' + draft + '\n"""' + CRITIC_PROMPT_SUFFIX
        run = await subagents.start('spawn', {
          label: 'critic',
          parent: agent,
          signal: new AbortController().signal,
          prompt: [{ type: 'text', text: promptText }],
          agentOptions: { provider: this.getConfig().criticProvider, model: this.getConfig().criticModel, maxTokens: 4096 },
          persona: CRITIC_PERSONA + RUBRIC_ADDENDUM,
          maxDepth: 1,
          toolFilter: { allow: [] },
        })
      } catch (spawnError) {
        return fail('critic spawn failed: ' + String(spawnError && spawnError.message || spawnError))
      }
      this.liveCriticChildren.add(run.id)
      let text = ''
      try {
        const result = await run.result
        text = outputText(result.output)
        if (result.stopReason !== 'completed') {
          const detail = result.stopReason === 'error' ? childErrorDetail(run) : ''
          return fail('critic ended with "' + result.stopReason + '"' + (detail === '' ? '' : ': ' + detail))
        }
        if (text === '') {
          return fail('critic returned an empty answer (reasoning only, no visible text)')
        }
      } finally {
        this.liveCriticChildren.delete(run.id)
        await run.dispose()
      }
      const annotations = parseAnnotations(text, draft)
      const sound = /^SOUND:/m.test(text)
      const entry = {
        reviewId, messageId, anchorSeq: target.seq,
        status: annotations.length > 0 ? 'completed' : sound ? 'sound' : 'completed-unparsed',
        sound,
        annotations,
        // ③深化：本次评审携带的顾问验证目标条数（0 = 无清单，基线行为）——
        // 评估回路的地面真值：回传数据可与清单有无交叉分析批注质量。
        targetsProvided: targets.items.length,
        createdAt: Date.now(),
      }
      if (annotations.length === 0) entry.raw = text.slice(0, 2000)
      try {
        await persistReview(sessionId, entry)
      } catch (persistError) {
        return fail('review persistence failed: ' + String(persistError && persistError.message || persistError))
      }
      return { ok: true, review: entry }
    } catch (error) {
      return fail('unexpected: ' + String(error && error.message || error))
    } finally {
      this.inFlight.delete(messageId)
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
      const sessionId = request && request.sessionId
      const agents = this.ctx.get('agents')
      if (agents === undefined) return { ok: false, error: 'agents service unavailable' }
      const agent = agents.get(sessionId)
      if (agent === undefined) return { ok: false, error: 'session is not live: ' + sessionId }
      const items = Array.isArray(request.items) ? request.items : []
      if (items.length === 0) return { ok: false, error: 'no annotations selected' }
      const reviewId = typeof request.reviewId === 'string' ? request.reviewId : ''
      const keyOf = (item) => (reviewId !== '' ? reviewId : 't:' + String(item.title)) + '#' + String(item.index)
      const sent = await this.sentSet(sessionId)
      const fresh = items.filter((item) => !sent.has(keyOf(item)))
      const skippedIndices = items.filter((item) => sent.has(keyOf(item))).map((item) => item.index)
      if (fresh.length === 0) return { ok: true, delivered: 0, skipped: items.length, skippedIndices }
      const lines = [
        '[advisor:review-feedback] 用户逐条确认了批评者对你此前回复的以下批注，请按 author-owns-the-remedy 自行修复对应问题（不必逐条回复，修复后在产物中体现）：',
      ]
      for (const item of fresh) {
        lines.push('')
        lines.push('### [' + (item.severity === 'blocker' ? 'blocker' : 'nit') + '] ' + String(item.title || '（无标题）'))
        if (item.anchor) lines.push('anchor: ' + String(item.anchor))
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
  // thinkingLevel; per the official thinking docs 3.7-flash supports only
  // low/medium/high and minimal returns an error, default On (medium)).
  // The `agent/request` waterfall reaches
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
        invocations: [reviewInvocation('list'), reviewInvocation('start'), reviewInvocation('feedback')],
      }),
      'dsh-advisor: review remote descriptors',
    )
  })
  new AdvisorReviewService(ctx, liveCriticChildren, () => current())

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
          const answer = text === '' ? 'The advisor returned an empty answer.' : text
          const parsed = parseAdvisorItems(answer)
          return { text: answer, items: parsed.items, issues: parsed.issues }
        } finally {
          liveAdvisorChildren.delete(run.id)
          await run.dispose()
        }
      },
    })
  })
}
