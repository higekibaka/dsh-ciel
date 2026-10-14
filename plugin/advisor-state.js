// The consultation gate and planning reminder share one event classification.
import { sessionEvents } from './advisor-content.js'

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
    return consultationFacts(sessionEvents(parent?.session))
  } catch {
    return undefined
  }
}

/** Shared durable interpretation for both admission and planning reminders. */
function consultationFacts(events) {
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
        resultHeads.set(part.toolCallId, { head: text.slice(0, 160), isError: part.isError === true })
      }
    }
  }
  let settledThisTurn = 0
  let pendingThisTurn = 0
  let lastSettledAdvisor = -1
  thisTurn.forEach((event, index) => {
    if (!isAdvisorCall(event)) return
    const head = resultHeads.get(event.data.callId)
    if (head === undefined) { pendingThisTurn += 1; return }
    if (head.isError && GATE_REJECTION_HEAD.test(head.head)) return
    settledThisTurn += 1
    lastSettledAdvisor = index
  })
  return {
    turnKey: turnStart < 0 ? 'no-turn' : (events[turnStart].seq ?? events[turnStart].data?.turn ?? turnStart),
    settledThisTurn,
    pendingThisTurn,
    turnStart,
    explorationDone: events.some(isWorkCall),
    workSinceLast: lastSettledAdvisor < 0 || thisTurn.slice(lastSettledAdvisor + 1).some(isWorkCall),
  }
}

/** One-shot reminder rendered by the agent-scoped context when planning starts unconsulted. */
const PLAN_REMINDER_TEXT =
  "[advisor:plan-reminder] Planning has started in this turn and the advisor has not been consulted. If this task involves an open design space, an unfamiliar domain, an irreversible decision, or a difficult diagnosis—and the task is bigger than one consultation round-trip—call ask_advisor now with the facts you have gathered. Judge the decision space, not prompt length: a one-line request can hide a large open design. If the task is mechanical or fully specified, ignore this reminder."

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
    const facts = consultationFacts(events)
    if (!facts || facts.turnStart < 0 || facts.settledThisTurn > 0 || facts.pendingThisTurn > 0) return ''
    const turnStart = facts.turnStart
    let planning = false
    for (let index = turnStart; index < events.length; index += 1) {
      const event = events[index]
      if (!event) continue
      if (event.type === 'tool/call' && event.data) {
        if (event.data.name === 'todo_write' || event.data.name === 'exit_plan_mode') planning = true
      } else if (event.type === 'user/message') {
        const source = event.data?.source
        if (source?.kind !== 'runtime-context' && (source?.kind !== 'plugin' || source.plugin !== '@deepseek-ai/dsh-system-prompt')) continue
        if (Array.isArray(source.sections) && !source.sections.some(section => section?.name === 'advisor:plan-reminder')) continue
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

export { GATE_REJECTION_HEAD, gateFacts, consultationFacts, PLAN_REMINDER_TEXT, reminderTextFor, createConsultationGate }
