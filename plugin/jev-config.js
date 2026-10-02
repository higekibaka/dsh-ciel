// Shared non-secret defaults and validation; safe to bundle into the client.
export const JEV_MODEL = 'jev-1.13.0'
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?![\s\S])/
export const JEV_KEY_PATTERN = /^[\x21-\x7e]{1,4096}(?![\s\S])/
export const JEV_ENDPOINT_PATTERN = /^https:\/\/[^\s\\@?#]+(?![\s\S])/

export function validJevEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || !JEV_ENDPOINT_PATTERN.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
export const validJevModel = value => typeof value === 'string' && JEV_MODEL_PATTERN.test(value)
export const validJevKey = value => typeof value === 'string' && JEV_KEY_PATTERN.test(value)

// The environment credential belongs to TypeSafe, never an arbitrary proxy.
// Unsetting the profile override re-inherits deployment config, then this fallback.
export function jevConnection(config = {}, envKey = process.env.TYPESAFE_API_KEY) {
  const endpoint = config.jevEndpoint ?? JEV_ENDPOINT
  return {
    endpoint, model: config.jevModel ?? JEV_MODEL,
    apiKey: config.jevApiKey?.trim() || (endpoint === JEV_ENDPOINT ? envKey : '') || '',
  }
}
