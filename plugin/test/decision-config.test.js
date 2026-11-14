import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validDecisionEndpoint, decisionConnection, resolveDecisionConnection,
  DECISION_ENDPOINT, DECISION_MODEL,
} from '../decision-config.js'

test('validDecisionEndpoint accepts valid HTTPS URIs and rejects deviations', () => {
  const valid = [
    'https://example.com',
    'https://example.com/',
    'https://example.com/api',
    DECISION_ENDPOINT,
    'https://127.0.0.1:8443/v1',
    'https://[::1]:8443/v1'
  ]
  for (const uri of valid) assert.equal(validDecisionEndpoint(uri), true, `valid: ${uri}`)

  const invalid = [
    undefined, null, true, 123, {}, [], '',
    'http://example.com',
    'https:// example.com',
    'https://example.com/\\path',
    'https://user:pass@example.com',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'https://[invalid.'
  ]
  for (const uri of invalid) assert.equal(validDecisionEndpoint(uri), false, `invalid: ${uri}`)

  const edge2048 = 'https://example.com/' + 'a'.repeat(2048 - 20)
  assert.equal(validDecisionEndpoint(edge2048), true, '2048 chars')
  const edge2049 = edge2048 + 'a'
  assert.equal(validDecisionEndpoint(edge2049), false, '2049 chars')
})

test('decisionConnection keeps custom endpoints away from inherited credentials', () => {
  const emptyFallback = decisionConnection()
  assert.equal(emptyFallback.endpoint, DECISION_ENDPOINT)
  assert.equal(emptyFallback.model, DECISION_MODEL)
  assert.equal(emptyFallback.apiKey, '')

  assert.equal(decisionConnection({}, 'env-key').apiKey, 'env-key')
  assert.equal(decisionConnection({ decisionApiKey: ' saved ' }, 'env-key').apiKey, 'saved')
  assert.equal(decisionConnection({ decisionApiKey: '   ' }, 'env-key').apiKey, 'env-key')
  assert.equal(decisionConnection({ decisionApiKey: '' }, 'env-key').apiKey, 'env-key')

  assert.equal(decisionConnection({ decisionEndpoint: 'https://custom.test' }, 'env-key').apiKey, '')
  assert.equal(decisionConnection({ decisionEndpoint: 'https://custom.test', decisionApiKey: '   ' }, 'env-key').apiKey, '')
  assert.equal(decisionConnection({ decisionEndpoint: 'https://custom.test', decisionApiKey: 'custom-key' }, 'env-key').apiKey, 'custom-key')
})

test('resolveDecisionConnection walks settings, credentials, launch environment and env in order', async () => {
  const explicit = await resolveDecisionConnection({ decisionApiKey: ' saved ' }, {
    ctx: { get: () => ({ async resolve() { throw new Error('must not be read') } }) },
    env: { GEMINI_API_KEY: 'env-key' },
  })
  assert.equal(explicit.apiKey, 'saved')

  const calls = []
  const credentials = {
    async resolve(name) {
      calls.push(name)
      return name === 'GEMINI_API_KEY' ? { value: ' cred-gemini ' } : { value: 'cred-google' }
    },
  }
  const hostCredentials = await resolveDecisionConnection({}, {
    ctx: { get: name => name === 'credentials' ? credentials : undefined },
    env: { GOOGLE_API_KEY: 'env-google' },
  })
  assert.deepEqual(hostCredentials, { endpoint: DECISION_ENDPOINT, model: DECISION_MODEL, apiKey: 'cred-gemini' })
  assert.deepEqual(calls, ['GEMINI_API_KEY'])

  const googleOnly = await resolveDecisionConnection({}, {
    ctx: { get: name => name === 'credentials' ? { async resolve(key) { return key === 'GEMINI_API_KEY' ? { value: '  ' } : { value: ' cred-google ' } } } : undefined },
    env: {},
  })
  assert.equal(googleOnly.apiKey, 'cred-google')

  const launch = await resolveDecisionConnection({}, {
    ctx: { get: name => name === 'launchEnvironment' ? { get: key => key === 'GEMINI_API_KEY' ? { value: ' launch-key ' } : undefined } : undefined },
    env: { GEMINI_API_KEY: 'env-key' },
  })
  assert.equal(launch.apiKey, 'launch-key')

  const env = await resolveDecisionConnection({}, { env: { GOOGLE_API_KEY: 'env-google', GEMINI_API_KEY: ' env-gemini ' } })
  assert.equal(env.apiKey, 'env-gemini')

  const missing = await resolveDecisionConnection({ decisionApiKey: '   ', decisionEndpoint: 'https://custom.test' }, {
    ctx: { get: name => name === 'credentials' ? { async resolve() { return { value: 'cred' } } } : undefined },
    env: { GEMINI_API_KEY: 'env-key' },
  })
  assert.equal(missing.apiKey, '')
  assert.equal(missing.endpoint, 'https://custom.test')
})

test('resolveDecisionConnection never falls through to the environment when the store fails', async () => {
  const failing = {
    ctx: { get: name => name === 'credentials' ? { async resolve() { throw new Error('vault unavailable') } } : undefined },
    env: { GEMINI_API_KEY: 'env-key', GOOGLE_API_KEY: 'env-google' },
  }
  const result = await resolveDecisionConnection({}, failing)
  assert.equal(result.apiKey, '')
  assert.equal(result.endpoint, DECISION_ENDPOINT)
  assert.equal(result.model, DECISION_MODEL)
})
