import { sessionEvents } from './review-content.js'

/** Owned per-call provenance. Requested settings are never treated as execution evidence. */
const MODEL_ROUTE_SCHEMA = {
  type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } },
  required: ['provider', 'model'], additionalProperties: false,
}
const MODEL_USAGE_SCHEMA = {
  type: 'object', properties: { requested: MODEL_ROUTE_SCHEMA, used: { type: 'array', items: MODEL_ROUTE_SCHEMA } },
  required: ['used'], additionalProperties: false,
}
function modelRoute(provider, model) {
  const valid = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
  return valid(provider) && valid(model) ? { provider: provider.trim(), model: model.trim() } : undefined
}
function createModelUsage(provider, model) {
  const requested = modelRoute(provider, model)
  return { ...(requested ? { requested } : {}), used: [] }
}
function modelUsageSnapshot(usage) {
  const requested = modelRoute(usage?.requested?.provider, usage?.requested?.model)
  const used = [], seen = new Set()
  for (const item of Array.isArray(usage?.used) ? usage.used : []) {
    const route = modelRoute(item?.provider, item?.model)
    if (!route) continue
    const key = route.provider + '\u0000' + route.model
    if (seen.has(key)) continue
    seen.add(key); used.push(route)
    if (used.length >= 32) break
  }
  return { ...(requested ? { requested } : {}), used }
}
function captureModelUsage(usage, run) {
  try {
    for (const event of sessionEvents(run?.localAgent?.session) || []) {
      if (event?.type !== 'assistant/message') continue
      const source = event.data?.message?.source
      if (source?.kind !== 'model') continue
      const route = modelRoute(source.provider, source.model)
      if (route && !usage.used.some((item) => item.provider === route.provider && item.model === route.model) && usage.used.length < 32) usage.used.push(route)
    }
  } catch { /* Unavailable execution evidence stays requested-only; never infer settings. */ }
  return modelUsageSnapshot(usage)
}


export { MODEL_ROUTE_SCHEMA, MODEL_USAGE_SCHEMA, modelRoute, createModelUsage, modelUsageSnapshot, captureModelUsage }
