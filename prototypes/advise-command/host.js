// ═══════════════ /advise 命令 · host 半（pkg-6：结果双槽投递） ═══════════════
// P3 原型：人类触发的顾问咨询。设计三要点：
//  · 双槽之一（host 槽）：commands 注册表登记 'advise' 人类命令；
//  · 显式 inject：commands / subagents 是硬依赖，缺席即 waiting；
//  · 上下文自动装配：人只打「/advise 问题」，上下文由 handler 从
//    agent.session.events 倒序捞最近用户/助手可见文本拼成。
// 咨询执行路径与静态 dsh-advisor 的 ask_advisor 工具同文（spawn 一次性
// 子代理 + ADVISOR_PERSONA + maxDepth 1 + 禁工具），路由读 advisor 设置命名空间。
// pkg-6 兑现看板 ① 的 C 方案（用户实测后拍板）：成功的咨询结果除渲染卡片外，
// 自动回注主模型。pkg-7 把投递从 followup(next-turn) 改为 steer(next-step)：
// 实测 followup 消息在 inbox 挂 3 轮未被认领——wakeDriver 在 agent 忙时不闩锁
// 普通 wake（源码假设 live driver 会认领通用队列），但 goal 轮次/composer 的
// turn 不走 next-turn 认领 → 饿死。next-step 在每个 step 边界无条件全量认领
// （inbox.claim 实现），goal 轮次自身即走此路，从未饿死。失败不回注。

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
      description: '向顾问模型发起咨询；上下文自动装配自本会话，结果渲染卡片并回注主模型',
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
          const answer = text === '' ? '顾问返回了空回答。' : text
          // C 方案：成功结果以 steer 回注主模型——next-step 队列在每个 step
          // 边界被无条件全量认领（inbox.claim），无 followup 的饿死风险；
          // 空闲即开新 turn，在跑即并入当前 turn 的下一步（goal 轮次同路）。
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
          try { await run.dispose() } catch { /* 忽略清理失败 */ }
        }
      },
    }), 'advcmd: /advise command')
  },
}
