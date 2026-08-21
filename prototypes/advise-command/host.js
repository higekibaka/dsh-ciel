// ═══════════════ /advise 命令 · host 半 ═══════════════
// P3 原型：人类触发的顾问咨询。设计三要点：
//  · 双槽之一（host 槽）：commands 注册表登记 'advise' 人类命令；
//  · 显式 inject：commands / subagents 是硬依赖，缺席即 waiting；
//  · 上下文自动装配：人只打「/advise 问题」，上下文由 handler 从
//    agent.session.events 倒序捞最近用户/助手可见文本拼成。
// 咨询执行路径与静态 dsh-advisor 的 ask_advisor 工具同文（spawn 一次性
// 子代理 + ADVISOR_PERSONA + maxDepth 1 + 禁工具），路由读 advisor 设置命名空间。

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

function clipText(text, max) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
}

// 上下文自动装配：倒序扫会话事件，取最近若干条用户/助手可见文本，
// 总量封顶 ~1800 字符（顾问的 grounding 预算与 ask_advisor 的 context 参数同级）。
function assembleContext(agent) {
  try {
    const session = agent && agent.session
    const events = session && session.events
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
      const content = ev.data.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text === '') continue
      const clipped = clipText(text, Math.min(400, budget))
      if (clipped === '') continue
      parts.unshift(role + '：' + clipped)
      budget -= clipped.length
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}

function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

return {
  inject: ['commands', 'subagents'],
  apply(ctx) {
    const settings = ctx.get('settings')
    const readConfig = () => {
      const fallback = { provider: 'kimi-coding', model: 'kimi-for-coding', maxTokens: 4096 }
      try {
        const ns = settings && typeof settings.get === 'function' ? settings.get('advisor') : undefined
        const o = ns !== null && typeof ns === 'object' ? ns : {}
        return {
          provider: typeof o.provider === 'string' && o.provider !== '' ? o.provider : fallback.provider,
          model: typeof o.model === 'string' && o.model !== '' ? o.model : fallback.model,
          maxTokens: typeof o.maxTokens === 'number' ? o.maxTokens : fallback.maxTokens,
        }
      } catch {
        return fallback
      }
    }

    // register 的 disposer 挂进 fiber effect：stop/update 即注销命令。
    ctx.effect(() => ctx.commands.register({
      name: 'advise',
      description: '向顾问模型发起一次人类触发的咨询；上下文自动装配自本会话最近对话',
      input: { hint: '咨询问题（开放设计空间 / 陌生领域 / 不可逆决策 / 困难诊断）' },
      async handler(invocation) {
        const question = String(invocation.rawInput || '').trim()
        if (question === '') {
          return { kind: 'error', text: '用法：/advise 你的问题 —— 上下文会从本会话最近对话自动装配' }
        }
        const cfg = readConfig()
        const assembled = assembleContext(invocation.agent)
        const consultation =
          'Established facts and constraints:\n' +
          '（以下上下文由 /advise 命令从本会话最近对话自动装配，可能不完整；如需补充请以对话说明为准）\n' +
          (assembled === '' ? '（本会话暂无可装配的对话内容）' : assembled) +
          '\n\nQuestion:\n' + question
        let run
        try {
          run = await ctx.subagents.start('spawn', {
            label: 'advise',
            parent: invocation.agent,
            signal: invocation.signal,
            prompt: [{ type: 'text', text: consultation }],
            agentOptions: {
              provider: cfg.provider,
              model: cfg.model,
              maxTokens: cfg.maxTokens,
            },
            persona: ADVISOR_PERSONA,
            // 与 ask_advisor 相同的绝对深度帽：准入 depth-1 顾问，禁其再派生。
            maxDepth: 1,
            // 顾问不碰工具：时效事实由调用方负责，grounding 单一所有者。
            toolFilter: { allow: [] },
          })
        } catch (spawnError) {
          return {
            kind: 'error',
            text: 'advisor spawn failed: ' + String((spawnError && spawnError.message) || spawnError),
          }
        }
        try {
          const result = await run.result
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            return {
              kind: 'error',
              text: '顾问咨询异常结束（' + String(result.stopReason) + '）' +
                (text === '' ? '' : '\n部分回答：\n' + text),
            }
          }
          return { kind: 'success', text: text === '' ? '顾问返回了空回答。' : text }
        } catch (runError) {
          return {
            kind: 'error',
            text: 'advisor run failed: ' + String((runError && runError.message) || runError),
          }
        } finally {
          try { await run.dispose() } catch { /* 忽略清理失败 */ }
        }
      },
    }), 'advcmd: /advise command')
  },
}
