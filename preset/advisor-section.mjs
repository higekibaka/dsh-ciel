/**
 * Advisor guidance: one static prompt section carrying the consultation
 * protocol for the `ask_advisor` tool.
 *
 * Registers a single prompt section at order 40 — after identity and persona
 * (orders -100/0), before the plan-mode policy (order 50) — so the protocol is
 * part of every system prompt assembled for this preset's agents. The text is
 * static, keeping the prompt prefix byte-stable across turns; prefix caching
 * is unaffected.
 *
 * The row publishes no service and writes only to this preset's own layer of
 * the prompt registry, so it sits loose in the composition like a tool row.
 * It resolves relative to the preset directory (the loader's `baseUrl`), which
 * is what lets an uninstalled plain file serve as a composition row.
 */

/** Cordis plugin name. */
export const name = 'advisor-guidance'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/**
 * Register the advisor protocol section in the mounting context's scope.
 * @param ctx - an agent scope context (preset standing mount).
 * @param config - `text`: the consultation protocol. Static; `{{variable}}`
 *   references would interpolate strictly, so plain prose must avoid `{{`.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'advisor:guidance',
    order: 40,
    text: config.text,
  }), 'advisor-guidance.section()')
}
