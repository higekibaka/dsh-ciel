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

/** Read-only adapter for V3/V4 native and PTC tool event vocabularies.
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
    if (event?.type === 'tool/result' && event.data?.message?.role === 'tool'
      && typeof event.data.message.toolCallId === 'string'
      && !event.data.message.content?.some(block => block.type === 'tool-result')) {
      const message = event.data.message
      return { ...event, data: { ...event.data, message: { ...message, content: [{
        type: 'tool-result', toolCallId: message.toolCallId, content: message.content, isError: message.isError,
      }] } } }
    }
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

export { outputText, childErrorDetail, toolEventView, sessionEvents, parseAdvisorItems }
