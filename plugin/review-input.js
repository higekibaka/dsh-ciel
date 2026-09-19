// Read-only request projection. A user-role model message is not necessarily
// human input: DSH uses it for runtime snapshots, goals and plugin notices too.
export function userText(event) {
  const content = event?.data?.content
  return Array.isArray(content) ? content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim() : ''
}

// Compatibility for the retired command's incorrectly user-attributed steer.
// Both its generated identity and exact wrapper are required; merely quoting
// the marker in a normal human message must not hide that human's request.
const LEGACY_ADVICE_PREFIX = '[advisor:advise-result] 用户通过 /advise 命令向顾问模型发起咨询，结果如下' +
  '（用户已在卡片中看到同样的内容；请结合当前工作自行采纳或讨论，不必复述原文）：\n\n问题：'
function legacyAdvice(event, text) {
  return /^advise-[a-z0-9]+$/.test(event.data?.id || '') && text.startsWith(LEGACY_ADVICE_PREFIX)
}

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * Track only request-bearing originals, not DSH's derived model messages.
 * A verified compaction preserves their identity; other replacements revoke
 * them. Replaying the target's prefix avoids reading today's live surface
 * when reviewing a historical draft. Missing markers retain legacy support.
 */
function requestSurface(events) {
  const nodes = [], visible = new Set(), removed = new Set()
  let invalid = false
  const starts = new Map()
  let previous
  for (const event of events) {
    if (event.type === 'compaction/start') starts.set(event.data?.compactionId, event)
    if (!SURFACE_TYPES.has(event.type)) { previous = event; continue }
    const source = event.type === 'user/message' ? event.data?.source : undefined
    const bearsRequest = event.type === 'user/message' && (source?.kind === 'user' || source?.kind === 'goal' || source?.kind === undefined)
    const roots = bearsRequest ? [event.seq] : []
    const op = event.surfaceOp
    // PTC adapters also expose log-only dispatch results as tool/result.
    // They carry no surface marker and must not expand a compacted range.
    if (op === undefined && event.type !== 'user/message' && event.type !== 'assistant/message') { previous = event; continue }
    if (op === undefined || op === 'append') {
      nodes.push({ seq: event.seq, roots })
    } else {
      const start = nodes.findIndex(node => node.seq === op?.startSeq)
      const end = nodes.findIndex(node => node.seq === op?.endSeq)
      if (op?.op !== 'replace' || start < 0 || end < start) {
        invalid = true
        previous = event
        continue
      }
      const shadowed = nodes.slice(start, end + 1)
      const cited = new Set(event.sourceEventSeqs)
      const summary = previous?.type === 'compaction/summary' ? previous : undefined
      const opening = starts.get(source?.compactionId)
      const compact = source?.kind === 'plugin' && source.plugin === 'compact'
        && typeof source.compactionId === 'string' && opening && summary
        && summary.data?.compactionId === source.compactionId
        && summary.data.shadowedRange?.start === op.startSeq && summary.data.shadowedRange?.end === op.endSeq
        && summary.data.shadowedSeqs?.length === shadowed.length
        && shadowed.every((node, i) => summary.data.shadowedSeqs[i] === node.seq && cited.has(node.seq))
        && cited.has(opening.seq) && cited.has(summary.seq)
      const inherited = shadowed.flatMap(node => node.roots)
      // Replacement copies (even with source.kind=user) are model-only;
      // neither arbitrary plugin output nor a copied role creates human input.
      nodes.splice(start, shadowed.length, { seq: event.seq, roots: compact ? inherited : [] })
      if (!compact) for (const seq of inherited) removed.add(seq)
    }
    previous = event
  }
  for (const node of nodes) for (const seq of node.roots) visible.add(seq)
  return { visible, removed, invalid }
}

/** Only facts before this exact draft can contribute to its request. */
export function projectReviewRequest(events, target) {
  const prefix = events.filter(event => event && event.seq < target.seq)
  let turnStart = 0
  for (const event of prefix) {
    if (event.type === 'turn/start' && event.data?.turn === target.data?.turn) turnStart = event.seq
  }
  const surface = requestSurface(prefix)
  let turn = -1, latestHumanTurn = -2, latestHumans = [], goal
  const current = [], bridges = [], commands = [], goalBridges = [], reasons = new Set()
  const unknownTurns = new Set()
  const isInputLimited = event => Array.isArray(event.data?.content) && event.data.content.some(block => block?.type !== 'text')
  const addReason = reason => reasons.add(reason)
  for (const event of prefix) {
    if (event.type === 'turn/start') turn = event.seq
    if (event.type === 'goal/change') {
      const data = event.data, next = data?.goal
      if (data?.kind !== 'goal/change' || data.version !== 1 || data.operation === 'clear'
        || !next || typeof next.id !== 'string' || !next.id || !Number.isSafeInteger(next.revision) || next.revision < 1
        || typeof next.objective !== 'string' || !next.objective.trim()) {
        goal = undefined
      } else if (data.operation === 'create' || goal?.id === next.id) {
        const changed = !goal || goal.id !== next.id || goal.objective !== next.objective
        const origin = changed
          ? latestHumans.filter(item => latestHumanTurn === turn && (!goal || item.seq > goal.changedAt))
          : goal.origin
        goal = { ...next, origin: origin.slice(), changedAt: changed ? event.seq : goal.changedAt,
          limited: changed ? !origin.length || unknownTurns.has(latestHumanTurn) : goal.limited }
      } else goal = undefined
    }
    if (event.type === 'command/run' && event.data?.name === 'advise' && event.data.source?.kind === 'user'
      && typeof event.data.commandId === 'string' && typeof event.data.args === 'string' && event.data.args.trim()) {
      commands.push({ seq: event.seq, text: event.data.args.trim(), origin: latestHumans.slice(), limited: unknownTurns.has(latestHumanTurn) })
    }
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (surface.removed.has(event.seq) && event.seq >= turnStart) addReason('replaced-input')
    if (!surface.visible.has(event.seq)) continue
    if (source?.kind === 'goal') {
      if (event.seq >= turnStart) {
        const matched = goal && goal.id === source.goalId && goal.revision === source.revision
          && goal.phase === 'active' && Number.isSafeInteger(source.round) && source.round > 0
        goalBridges.push(matched ? { origin: goal.origin.slice(), limited: goal.limited } : undefined)
      }
      continue
    }
    if (source?.kind !== 'user') {
      unknownTurns.add(turn)
      if (goal && goal.phase !== 'complete') goal.limited = true
      if (event.seq >= turnStart) addReason('unknown-source')
      continue
    }
    if (isInputLimited(event)) {
      unknownTurns.add(turn)
      if (goal && goal.phase !== 'complete') goal.limited = true
      if (event.seq >= turnStart) addReason('non-text-input')
    }
    const text = userText(event)
    if (!text) continue
    if (legacyAdvice(event, text)) {
      if (event.seq >= turnStart) {
        // The retired producer steered before command/done was persisted.
        bridges.push(commands.findLast(call => text.startsWith(LEGACY_ADVICE_PREFIX + call.text + '\n\n顾问回答：')))
      }
      continue
    }
    const request = { seq: event.seq, text }
    if (latestHumanTurn !== turn) { latestHumanTurn = turn; latestHumans = [] }
    latestHumans.push(request)
    if (event.seq >= turnStart) current.push(request)
    // Only a later native goal round may use these intervening human inputs.
    // A new human-led turn itself never borrows the active goal's old task.
    if (goal?.phase === 'active') {
      goal.origin.push(request)
      goal.limited ||= unknownTurns.has(turn)
    } else if (goal && goal.phase !== 'complete') {
      // Work while a goal is paused/blocked is not automatically its refinement.
      // Resuming may retain the known origin, but cannot claim full context.
      goal.limited = true
    }
  }

  let selected = current, mode = 'current-turn'
  if (goalBridges.length) {
    const bridge = goalBridges.at(-1)
    if (bridge) {
      selected = [...bridge.origin, ...current]
      mode = 'goal-continuation'
      if (bridge.limited) addReason('goal-origin-missing')
    } else addReason('goal-unmatched')
  } else if (!selected.length && bridges.length) {
    const bridge = bridges.at(-1)
    selected = bridge ? [...bridge.origin, { seq: bridge.seq, text: bridge.text }] : []
    mode = bridge ? 'legacy-command' : 'missing'
    if (!bridge || !bridge.origin.length || bridge.limited) addReason('legacy-unmatched')
  } else if (selected.length) {
    selected = [...selected, ...bridges.filter(call => call && call.seq >= current[0].seq)
      .map(call => ({ seq: call.seq, text: call.text }))]
  }
  if (bridges.some(call => !call)) addReason('legacy-unmatched')
  if (surface.invalid) { selected = []; addReason('invalid-history') }
  const seen = new Set()
  selected = selected.filter(item => { if (seen.has(item.seq)) return false; seen.add(item.seq); return true })
    .sort((a, b) => a.seq - b.seq)
  if (!selected.length) { mode = 'missing'; addReason('missing-input') }
  const bounded = selected.slice(-8), parts = []
  let budget = 3000
  if (bounded.length !== selected.length) addReason('truncated-input')
  for (let i = bounded.length - 1; i >= 0; i--) {
    const room = budget - (parts.length ? 5 : 0)
    if (room <= 0) { addReason('truncated-input'); break }
    const text = bounded[i].text.slice(0, room)
    if (text.length !== bounded[i].text.length) addReason('truncated-input')
    parts.unshift(text)
    budget = room - text.length
  }
  return {
    text: parts.join('\n---\n'),
    // Internal only: privacy checks inspect full input before clipping.
    texts: selected.map(item => item.text),
    context: { mode, limited: reasons.size > 0, ...(reasons.size ? { reasons: [...reasons].sort() } : {}) },
  }
}

/** Safe explanation shared by persisted coverage and the existing review UI. */
export function requestContextNote(context) {
  const labels = {
    'missing-input': '缺少可关联的真人请求',
    'unknown-source': '输入来源不明',
    'legacy-unmatched': '历史咨询关联不足',
    'goal-unmatched': '目标续跑与目标记录不匹配',
    'goal-origin-missing': '目标缺少可恢复的真人要求',
    'replaced-input': '请求被无法核对来源的消息替换',
    'invalid-history': '历史消息替换关系无法核对',
    'truncated-input': '请求超出长度或条数限制',
    'non-text-input': '图片或附件未纳入文本评审',
  }
  const details = (context.reasons || []).map(reason => labels[reason]).filter(Boolean)
  return '用户请求上下文' + (details.length ? '不足（' + details.join('；') + '）' : '缺失、关联不明或被截断')
    + '，不能确认完整满足任务；请补充明确请求后重新评审'
}
