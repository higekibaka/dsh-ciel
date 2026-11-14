// Shared non-secret defaults and validation; safe to bundle into the client.
export const DECISION_MODEL = 'gemini-decision-1'
export const DECISION_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
export const DECISION_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?![\s\S])/
export const DECISION_KEY_PATTERN = /^[\x21-\x7e]{1,4096}(?![\s\S])/
export const DECISION_ENDPOINT_PATTERN = /^https:\/\/[^\s\\@?#]+(?![\s\S])/

export function validDecisionEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || !DECISION_ENDPOINT_PATTERN.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
export const validDecisionModel = value => typeof value === 'string' && DECISION_MODEL_PATTERN.test(value)
export const validDecisionKey = value => typeof value === 'string' && DECISION_KEY_PATTERN.test(value)

// Gemini Developer API keys belong to Google, never an arbitrary proxy. A
// custom endpoint must carry its own key; host and environment credentials are
// only ever sent to the official endpoint.
export function decisionConnection(config = {}, fallbackKey = '') {
  const endpoint = config.decisionEndpoint ?? DECISION_ENDPOINT
  const explicit = typeof config.decisionApiKey === 'string' ? config.decisionApiKey.trim() : ''
  const inherited = endpoint === DECISION_ENDPOINT && typeof fallbackKey === 'string' ? fallbackKey.trim() : ''
  return { endpoint, model: config.decisionModel ?? DECISION_MODEL, apiKey: explicit || inherited }
}

/**
 * Resolve the Gemini API key through the DSH host chain:
 * explicit setting → credentials service → launchEnvironment → process env.
 * Every layer is optional, so the plugin still runs in a plain Node process.
 * A credential-store failure returns no key instead of falling through to a
 * different principal's environment variable.
 */
export async function resolveDecisionConnection(config = {}, { ctx, env } = {}) {
  const endpoint = config.decisionEndpoint ?? DECISION_ENDPOINT
  const model = config.decisionModel ?? DECISION_MODEL
  const explicit = typeof config.decisionApiKey === 'string' ? config.decisionApiKey.trim() : ''
  if (explicit !== '') return { endpoint, model, apiKey: explicit }
  // A custom endpoint never inherits host or environment credentials.
  if (endpoint !== DECISION_ENDPOINT) return { endpoint, model, apiKey: '' }
  const credentials = ctx?.get?.('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
        const resolved = await credentials.resolve(name)
        const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
        if (value !== '') return { endpoint, model, apiKey: value }
      }
    } catch {
      return { endpoint, model, apiKey: '' }
    }
  }
  const launch = ctx?.get?.('launchEnvironment')
  if (launch && typeof launch.get === 'function') {
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
      const value = launch.get(name)?.value
      if (typeof value === 'string' && value.trim() !== '') return { endpoint, model, apiKey: value.trim() }
    }
  }
  const environment = env ?? globalThis.process?.env ?? {}
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const value = environment?.[name]
    if (typeof value === 'string' && value.trim() !== '') return { endpoint, model, apiKey: value.trim() }
  }
  return { endpoint, model, apiKey: '' }
}
