// Annotation-review prototype — host half (pkg-12: unchanged from pkg-8 — google/gemini-3.7-flash critic with the effort-low pin; all changes are client-side.)

const CRITIC_PROVIDER = 'google'
const CRITIC_MODEL = 'gemini-3.7-flash'

function makeSignal() {
  if (typeof AbortController === 'function') return new AbortController().signal
  return {
    aborted: false,
    reason: undefined,
    addEventListener() {},
    removeEventListener() {},
    throwIfAborted() {},
  }
}

const CRITIC_PERSONA =
  'You are a convergent plan critic. You receive a DRAFT (a plan or answer a ' +
  'model is about to act on) and your only job is to find what is wrong, ' +
  'missing, or unverified in it — red-line annotations, never a rewrite, ' +
  'never an alternative plan of your own. You have NO tools and NO way to ' +
  'verify anything externally: never plan or attempt tool calls; judge the ' +
  'draft from its text and your own knowledge, and say so inside the comment ' +
  'when a claim cannot be verified. Your deliverable is your VISIBLE reply ' +
  'text — private reasoning without a visible answer is a failed review. ' +
  'For every issue output one annotation in EXACTLY this Markdown shape, ' +
  'with the fields on their own lines:\n\n' +
  '### [blocker] short title\n' +
  'anchor: a verbatim quote copied character-for-character from the draft\n' +
  'comment: what is wrong or missing, and why it matters\n\n' +
  'Severity: [blocker] means acting on the draft without fixing this is ' +
  'likely to fail or cause real damage; [nit] means worth fixing but not ' +
  'blocking. Rules: at most 8 annotations; every anchor MUST be an exact ' +
  'substring of the draft (copy it, never paraphrase, never translate); ' +
  'critique the draft itself, not the topic in general; no compliments, no ' +
  'summaries, no step-by-step fixes — name the problem and the reason, the ' +
  'author owns the remedy. If the draft is sound, output one line starting ' +
  'with "SOUND:" followed by a single sentence, plus at most 3 [nit] ' +
  'annotations for residual risks.'

const PROMPT_SUFFIX =
  '\n\nWrite the annotations now as your visible reply. You have no tools; ' +
  'judge from the text alone.'

function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function clip(text, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
}

function unwrapErrorMessage(message) {
  let text = String(message === undefined || message === null ? '' : message)
  for (let depth = 0; depth < 3; depth += 1) {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{')) break
    let parsed
    try { parsed = JSON.parse(trimmed) } catch { break }
    const inner = parsed && typeof parsed === 'object'
      ? (parsed.error && parsed.error.message !== undefined ? parsed.error.message : parsed.message)
      : undefined
    if (typeof inner !== 'string' || inner === text) break
    text = inner
  }
  return clip(text, 300)
}

function childErrorDetail(run) {
  const agent = run.localAgent
  if (agent === undefined) return ''
  let events
  try { events = agent.session.events } catch { return '' }
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.type !== 'turn/end') continue
    const reason = event.data && event.data.reason
    if (reason && reason.kind === 'error' && reason.error !== undefined) {
      const message = typeof reason.error === 'object' && reason.error !== null ? reason.error.message : reason.error
      return unwrapErrorMessage(message)
    }
    return ''
  }
  return ''
}

function draftText(event) {
  const content = event.data && event.data.message && event.data.message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function anchorInDraft(anchor, draft) {
  if (anchor === '') return false
  if (draft.includes(anchor)) return true
  const squash = (s) => s.replace(/\s+/g, ' ')
  return squash(draft).includes(squash(anchor))
}

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

return {
  apply(ctx) {
    const liveChildren = new Set()
    ctx.on('agent/request', async (payload, next) => {
      const agent = payload && payload.agent
      if (agent === undefined || !liveChildren.has(agent.id)) return next()
      if (CRITIC_PROVIDER !== 'google') return next()
      const resolved = await next()
      return { ...resolved, reasoningEffort: 'low' }
    })

    const inFlight = new Set()

    harness.handle('review.list', (args) => {
      const sessionId = args && args.sessionId
      const agents = ctx.get('agents')
      const agent = agents && agents.get(sessionId)
      const events = agent && agent.session && agent.session.events
      if (!Array.isArray(events)) return { reviews: [] }
      const reviews = []
      for (const event of events) {
        if (event && event.type === 'advisor/review' && event.data && typeof event.data === 'object') {
          reviews.push({ ...event.data, time: event.time })
        }
      }
      return { reviews }
    })

    harness.handle('review.start', async (args) => {
      const sessionId = args && args.sessionId
      const messageId = args && args.messageId
      if (typeof sessionId !== 'string' || typeof messageId !== 'string') {
        return { ok: false, error: 'sessionId and messageId are required' }
      }
      const agents = ctx.get('agents')
      const subagents = ctx.get('subagents')
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
      if (inFlight.has(messageId)) return { ok: false, error: 'review already in flight for this message' }
      inFlight.add(messageId)
      const reviewId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const fail = (error) => {
        console.error('review.start failed:', error)
        const entry = { reviewId, messageId, anchorSeq: target.seq, status: 'error', error: String(error), annotations: [], createdAt: Date.now() }
        try { agent.session.append('advisor/review', entry) } catch (e) { console.error('append failed', e && e.message) }
        return { ok: false, error: entry.error, review: entry }
      }
      try {
        let run
        try {
          run = await subagents.start('spawn', {
            label: 'critic',
            parent: agent,
            signal: makeSignal(),
            prompt: [{ type: 'text', text: 'Draft under review:\n"""\n' + draft + '\n"""' + PROMPT_SUFFIX }],
            agentOptions: { provider: CRITIC_PROVIDER, model: CRITIC_MODEL, maxTokens: 4096 },
            persona: CRITIC_PERSONA,
            maxDepth: 1,
            toolFilter: { allow: [] },
          })
        } catch (spawnError) {
          return fail('critic spawn failed: ' + String(spawnError && spawnError.message || spawnError))
        }
        liveChildren.add(run.id)
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
          liveChildren.delete(run.id)
          await run.dispose()
        }
        const annotations = parseAnnotations(text, draft)
        const sound = /^SOUND:/m.test(text)
        const entry = {
          reviewId, messageId, anchorSeq: target.seq,
          status: annotations.length > 0 ? 'completed' : sound ? 'sound' : 'completed-unparsed',
          sound,
          annotations,
          createdAt: Date.now(),
        }
        if (annotations.length === 0) entry.raw = text.slice(0, 2000)
        try {
          agent.session.append('advisor/review', entry)
        } catch (appendError) {
          return fail('session.append rejected advisor/review: ' + String(appendError && appendError.message || appendError))
        }
        return { ok: true, review: entry }
      } catch (error) {
        return fail('unexpected: ' + String(error && error.message || error))
      } finally {
        inFlight.delete(messageId)
      }
    })
  },
}
