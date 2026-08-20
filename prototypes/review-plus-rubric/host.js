// M3-③深化原型 pkg-5：默认评审对象改为「上一个已完成轮次的最后一条正文消息」——
// pkg-4 实测：在途 step 的消息尚未落盘，无参调用会误评同轮的中间叙述文本。
// （已静态化进 bundle 0.9.0；此文件为动态插件源码存档，仅供回放/参考）

function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
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

function userText(event) {
  const content = event.data && event.data.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 与静态 turnEvidence 同构：该轮用户请求 + 工具裁决摘要（无全文、无思维链）。 */
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
 * 捞「当时的顾问输出」的验证目标清单。ask_advisor 的结构化 items 随
 * tool/result 事件的 data.meta 落盘（presentationMeta 通道，{v:1, items}）。
 * 取清单的优先级：草案同轮的最近一次咨询 > 更早轮的最近一次咨询。
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
  if (withMeta.length === 0) return { items: [], from: '无咨询记录' }
  const targetTurn = target.data && target.data.turn
  const sameTurn = withMeta.filter((r) => r.turn === targetTurn)
  const chosen = sameTurn.length > 0 ? sameTurn[sameTurn.length - 1] : withMeta[withMeta.length - 1]
  const items = chosen.items.filter(
    (it) => it && typeof it === 'object' && typeof it.verificationTarget === 'string' && it.verificationTarget !== '',
  )
  return { items, from: (sameTurn.length > 0 ? '同轮咨询' : '更早轮咨询') + ' seq ' + chosen.seq }
}

const CRITIC_PERSONA_BASE =
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

return {
  apply(ctx) {
    const liveChildren = new Set()
    ctx.on('agent/request', async (payload, next) => {
      const agent = payload && payload.agent
      if (agent === undefined || !liveChildren.has(agent.id)) return next()
      const resolved = await next()
      return { ...resolved, reasoningEffort: 'low' }
    })

    harness.registerTool(ctx, harness.defineTool({
      name: 'advisor_review_plus',
      description:
        '[原型·仅限评估] 对一条 assistant 回复做「带顾问验证清单」的批评者评审：' +
        '与静态「批注评审」按钮的差异仅在批评者输入多了当时的顾问验证目标清单。' +
        '默认评审上一个已完成轮次的最后一条正文消息（在途轮次的中间叙述不算）；传 messageId 可指定。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '要评审的 assistant 消息 id；省略 = 上一已完成轮次的最后一条正文消息' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            targetsProvided: { type: 'number', required: true },
            targetsFrom: { type: 'string', required: true },
            draftHead: { type: 'string', required: true },
          },
        },
        render: (_args, v) => [{
          type: 'text',
          text: '[advrub 原型] 验证清单 ' + v.targetsProvided + ' 条（' + v.targetsFrom + '）· 评审对象：' + v.draftHead + '\n\n' + v.text,
        }],
      },
      async execute(args, exec) {
        const agent = exec && exec.agent
        if (agent === undefined) throw new Error('advisor_review_plus requires exec.agent')
        const events = agent.session && agent.session.events
        if (!Array.isArray(events)) throw new Error('session events unreadable')

        let target
        if (typeof args.messageId === 'string' && args.messageId !== '') {
          for (const event of events) {
            if (event && event.type === 'assistant/message' && event.data && event.data.message && event.data.message.id === args.messageId) {
              target = event
            }
          }
          if (target === undefined) throw new Error('no assistant message with id ' + args.messageId)
        } else {
          // 当前在途轮次的起点：该轮的消息（含本条工具所属的 step）不参与默认选取——
          // pkg-4 实测：在途 step 的消息尚未落盘，会误评同轮中间叙述文本。
          let currentTurnStart = -1
          for (let i = events.length - 1; i >= 0; i -= 1) {
            if (events[i] && events[i].type === 'turn/start') { currentTurnStart = events[i].seq; break }
          }
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i]
            if (currentTurnStart >= 0 && event.seq >= currentTurnStart) continue
            if (event && event.type === 'assistant/message' && draftText(event) !== '') { target = event; break }
          }
          if (target === undefined) throw new Error('no completed-turn assistant message with text found')
        }
        const draft = draftText(target)
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

        const subagents = ctx.get('subagents')
        if (subagents === undefined) throw new Error('subagents service unavailable')
        const run = await subagents.start('spawn', {
          label: 'critic+',
          parent: agent,
          signal: exec.signal,
          prompt: [{ type: 'text', text: promptText }],
          agentOptions: { provider: 'google', model: 'gemini-3.7-flash', maxTokens: 4096 },
          persona: CRITIC_PERSONA_BASE + RUBRIC_ADDENDUM,
          maxDepth: 1,
          toolFilter: { allow: [] },
        })
        liveChildren.add(run.id)
        try {
          const result = await run.result
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            throw new Error('critic ended with "' + result.stopReason + '"' + (text === '' ? '' : '; partial:\n' + text))
          }
          if (text === '') throw new Error('critic returned an empty answer (reasoning only)')
          return {
            text,
            targetsProvided: targets.items.length,
            targetsFrom: targets.from,
            draftHead: draft.replace(/\s+/g, ' ').slice(0, 80),
          }
        } finally {
          liveChildren.delete(run.id)
          await run.dispose()
        }
      },
    }))
  },
}
