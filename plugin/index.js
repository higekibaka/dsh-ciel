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

/** Cordis plugin name. */
export const name = 'dsh-advisor'

/** Advisor persona: the ideas-only output contract for the child agent. */
const ADVISOR_PERSONA =
  'You are a senior technical advisor consulted BEFORE planning begins. ' +
  'Offer: alternative problem framings, relevant domain knowledge and prior art, ' +
  'common pitfalls, cross-domain analogies, and the evaluation dimensions an ' +
  'expert would check. Output ideas and knowledge ONLY — never step-by-step ' +
  'plans, never code, never tool usage instructions. Keep each idea to one ' +
  'short paragraph, at most six items total.'

/** Guidance prompt section text: the consultation protocol for the caller. */
const GUIDANCE_TEXT =
  'You have an `ask_advisor` tool connected to a second model chosen for ' +
  'knowledge breadth. The advisor gives ideas, not plans; its value is ' +
  'diversity — directions your own priors would not sample first.\n\n' +
  'WHEN to consult (at most once per planning phase, and only for ' +
  'knowledge-heavy tasks): an open solution space (architecture, technology ' +
  'selection, data modeling — several fundamentally different routes exist); ' +
  'an unfamiliar domain where your training knowledge is thin; a highly ' +
  'irreversible decision (migrations, external contracts); or a difficult ' +
  'diagnosis where ordinary approaches have already failed twice.\n\n' +
  'Do NOT consult when the answer is inside the environment (inspect the ' +
  'code instead), for mechanical pattern-fixed tasks, or for small tasks ' +
  'where one consultation costs more than the task itself.\n\n' +
  'HOW to consult: (1) Explore first — gather concrete environment facts ' +
  '(code structure, versions, constraints) BEFORE calling; ungrounded ' +
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
  allowWebSearch: Schema.boolean().default(true)
    .description('允许顾问使用 web_search 查证资料；关闭则为纯参数知识'),
  guidanceEnabled: Schema.boolean().default(true)
    .description('向系统提示词注入顾问使用协议（触发判据与追问预算）'),
})

/** Shared string-output contract for the tool definition. */
const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
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
  // setting re-registers the section without a restart.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    let dispose = null
    resyncGuidance = () => {
      if (dispose !== null) {
        dispose()
        dispose = null
      }
      if (current().guidanceEnabled) {
        dispose = systemPrompt.section({
          name: 'advisor:guidance',
          order: 40,
          text: GUIDANCE_TEXT,
        })
      }
    }
    resyncGuidance()
    ctx.effect(
      () => () => {
        if (dispose !== null) dispose()
      },
      'dsh-advisor: guidance section',
    )
  }

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

  // ── the ask_advisor tool. Each call is a fresh one-shot child on the spawn
  // provider: the stateless follow-up channel the consultation protocol
  // requires. Settings are read per call, so panel edits hot-apply.
  ctx.inject(['tools', 'subagents'], (tctx) => {
    tctx.tools.register({
      name: 'ask_advisor',
      description:
        'Consult a second, knowledge-rich model BEFORE planning. Pass the goal, the ' +
        'facts already found in the environment, and the constraints; receive ' +
        'framings, prior art, pitfalls, and evaluation dimensions — ideas only, ' +
        'never steps. Follow-ups are separate calls: each must carry new facts ' +
        'and one specific question (never a draft plan).',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The goal plus the specific question for the advisor.',
          },
          context: {
            type: 'string',
            description: 'Environment facts and constraints already established (explore first).',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args, exec) {
        const parent = exec && exec.agent
        if (parent === undefined) {
          throw new Error('ask_advisor requires a calling agent (exec.agent was undefined)')
        }
        const cfg = current()
        const consultation =
          typeof args.context === 'string' && args.context.trim() !== ''
            ? `Established facts and constraints:\n${args.context}\n\nQuestion:\n${args.question}`
            : String(args.question)
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
          maxDepth: 0,
          toolFilter: cfg.allowWebSearch ? { allow: ['web_search'] } : { allow: [] },
        })
        try {
          const result = await run.result
          const text = outputText(result.output)
          if (result.stopReason !== 'completed') {
            throw new Error(
              `advisor consultation ended with "${result.stopReason}"` +
                (text === '' ? '' : `; partial answer:\n${text}`),
            )
          }
          return text === '' ? 'The advisor returned an empty answer.' : text
        } finally {
          await run.dispose()
        }
      },
    })
  })
}
