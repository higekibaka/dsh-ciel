// Review input assembly, prompts and result parsing; no model calls or writes.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectSensitiveText } from './review-corpus.js'
import { projectReviewRequest } from './review-input.js'
import { evidenceRefs } from './review-evidence.js'

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

/** Synchronous reservation: concurrent starts cannot all see the same settled count. */
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
  const request = projectReviewRequest(events, target)
  const calls = new Map()
  const results = []
  const quotes = []
  let quotesSpent = 0
  let withheld = false
  for (const event of events) {
    if (!event || event.seq < startSeq || event.seq >= target.seq) continue
    if (event.type === 'tool/call' && event.data) {
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
    request: request.text,
    requestContext: request.context,
    tools: results.length === 0
      ? 'No tool results are included for this turn. This is a turn-local, incomplete view, NOT evidence that work or tests did not happen. Earlier turns and background work may be absent; leave unresolvable claims unchecked.'
      : results.slice(0, MAX_TOOLS).join('\n') + (results.length > MAX_TOOLS ? '\n… +' + (results.length - MAX_TOOLS) + ' more' : ''),
    quotes,
    ...(protectInputs ? { withheld, sensitiveInput: request.texts.some(text => detectSensitiveText(text)) } : {}),
  }
}


export { outputText, clip, unwrapErrorMessage, childErrorDetail, CRITIC_NO_TOOLS_CLAUSE, CRITIC_PERSONA, RUBRIC_ADDENDUM, CRITIC_PROMPT_SUFFIX, CRITIC_SUSPECT_PERSONA, CRITIC_SUSPECT_PROMPT_SUFFIX, VERIFICATION_LEDGER_CONTRACT, CRITIC_VERIFY_CONTRACT, CRITIC_VERIFY_PROMPT_SUFFIX, criticExploreToolsClause, criticExplorePersona, draftText, toolEventView, sessionEvents, REVIEW_SOURCE_TOOLS, REVIEW_TOOL_DENIAL, probeCriticAction, createReviewObserver, anchorInDraft, parseAnnotations, parseStatsLine, parseSuspectList, triageSuspects, parseOutcomeRows, recoverCitedDossier, reconcileReviewLedger, parseCriticReview, parseSuspectResponse, reviewCoverage, splitMarkdownBlocks, parseAdvisorItems, advisorTargets, EPHEMERAL_EVIDENCE_TOOLS, EVIDENCE_QUOTE_MAX, EVIDENCE_QUOTES_BUDGET, privateEvidenceReference, turnEvidence }
