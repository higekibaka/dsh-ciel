import { detectSensitiveText } from './review-corpus.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const seq = value => Number.isSafeInteger(value) && value >= 0
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value) && !detectSensitiveText(value)
const route = value => record(value) && name(value.provider) && name(value.model)
  ? { provider: value.provider, model: value.model } : undefined
const modes = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const policies = new Set(['ask', 'never'])

/** Allowlisted historical facts, never current settings or a raw request dump.
 * Session log provenance establishes what DSH recorded, not model weights,
 * network reachability, tool success, or permission to perform a new action. */
export function reviewHostFacts(events, target) {
  if (!Array.isArray(events) || !seq(target?.seq) || typeof target.data?.message?.id !== 'string' || !target.data.message.id) return []
  let last = -1, header, mode, policy, found = false
  for (const event of events) {
    if (!seq(event?.seq) || event.seq <= last) return []
    last = event.seq
    if (event.seq > target.seq) break
    if (event.seq === target.seq) {
      if (event.type !== 'assistant/message' || event.data?.message?.id !== target.data?.message?.id) return []
      found = true
      break
    }
    if (event.type === 'request/header') header = record(event.data?.header) ? event : undefined
    if (event.type === 'sandbox/mode') mode = modes.has(event.data?.mode) ? event : undefined
    if (event.type === 'approval/policy') policy = policies.has(event.data?.policy) ? event : undefined
  }
  if (!found) return []
  const facts = []
  const observedAt = Number.isFinite(target.time) ? target.time : undefined
  const add = (topic, sourceSeqs, value, limitations) => facts.push({
    topic, sourceSeqs, temporal: 'target-reply-history', ...(observedAt === undefined ? {} : { observedAt }),
    content: JSON.stringify({ topic, temporal: 'target-reply-history', ...(observedAt === undefined ? {} : { observedAt }), sourceSeqs, ...value, limitations }, null, 2),
  })
  const actual = target.data?.message?.source?.kind === 'model' ? route(target.data.message.source) : undefined
  const requested = route(header?.data.header.config)
  if (actual || requested) add('model-route', [...new Set([...(actual ? [target.seq] : []), ...(requested ? [header.seq] : [])])], {
    ...(actual ? { responseRoute: actual } : {}), ...(requested ? { requestedRoute: requested } : {}),
  }, 'DSH-recorded route/model identifiers for this reply; not proof of a server\'s physical model weights. A requested route without responseRoute does not establish actual execution.')
  if (mode || policy) add('session-policy', [mode?.seq, policy?.seq].filter(seq), {
    ...(mode ? { sandboxMode: mode.data.mode } : {}), ...(policy ? { approvalPolicy: policy.data.policy } : {}),
  }, 'Last explicitly logged policy values at or before the target reply. Missing fields are unknown: no current deployment defaults are substituted. This is not an approval decision or a grant to execute anything.')
  if (header && requested) {
    const tools = header.data.header.tools ?? []
    if (Array.isArray(tools) && tools.length <= 512 && tools.every(tool => record(tool) && name(tool.name))) {
      add('tool-declarations', [header.seq], { names: [...new Set(tools.map(tool => tool.name))].sort(), scope: 'model-direct-request-tools' },
        'Tools declared in the logged request header, not proof of credentials, network access or a successful call. In PTC mode run_code does not enumerate nested program tools; absence here cannot disprove availability through that transport.')
    }
  }
  return facts
}
