import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validJevEndpoint, jevConnection, JEV_ENDPOINT, JEV_MODEL } from '../jev-config.js'

test('validJevEndpoint accepts valid HTTPS URIs and rejects deviations', () => {
  const valid = [
    'https://example.com',
    'https://example.com/',
    'https://example.com/api',
    'https://api.typesafe.ai/v1/systemone',
    'https://127.0.0.1:8443/v1',
    'https://[::1]:8443/v1'
  ]
  for (const uri of valid) assert.equal(validJevEndpoint(uri), true, `valid: ${uri}`)

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
  for (const uri of invalid) assert.equal(validJevEndpoint(uri), false, `invalid: ${uri}`)

  const edge2048 = 'https://example.com/' + 'a'.repeat(2048 - 20)
  assert.equal(validJevEndpoint(edge2048), true, '2048 chars')
  const edge2049 = edge2048 + 'a'
  assert.equal(validJevEndpoint(edge2049), false, '2049 chars')
})

test('jevConnection resolves default, precedence, spacing and env mapping', () => {
  const originalEnv = process.env.TYPESAFE_API_KEY
  try {
    delete process.env.TYPESAFE_API_KEY
    const emptyFallback = jevConnection()
    assert.equal(emptyFallback.endpoint, JEV_ENDPOINT)
    assert.equal(emptyFallback.model, JEV_MODEL)
    assert.equal(emptyFallback.apiKey, '')
  } finally {
    if (originalEnv !== undefined) process.env.TYPESAFE_API_KEY = originalEnv
  }

  const standardEnv = jevConnection({}, 'env-key')
  assert.equal(standardEnv.apiKey, 'env-key')
  assert.equal(standardEnv.endpoint, JEV_ENDPOINT)

  const savedKey = jevConnection({ jevApiKey: ' saved ' }, 'env-key')
  assert.equal(savedKey.apiKey, 'saved')

  const fallbackSavedKey = jevConnection({ jevApiKey: '   ' }, 'env-key')
  assert.equal(fallbackSavedKey.apiKey, 'env-key')

  const emptySavedKey = jevConnection({ jevApiKey: '' }, 'env-key')
  assert.equal(emptySavedKey.apiKey, 'env-key')

  const customEndpoint = jevConnection({ jevEndpoint: 'https://custom.test' }, 'env-key')
  assert.equal(customEndpoint.apiKey, '')
  assert.equal(customEndpoint.endpoint, 'https://custom.test')

  const customWithWhitespaceKey = jevConnection({ jevEndpoint: 'https://custom.test', jevApiKey: '   ' }, 'env-key')
  assert.equal(customWithWhitespaceKey.apiKey, '')
  assert.equal(customWithWhitespaceKey.endpoint, 'https://custom.test')

  const customWithEmptyKey = jevConnection({ jevEndpoint: 'https://custom.test', jevApiKey: '' }, 'env-key')
  assert.equal(customWithEmptyKey.apiKey, '')
  assert.equal(customWithEmptyKey.endpoint, 'https://custom.test')

  const customWithSaved = jevConnection({ jevEndpoint: 'https://custom.test', jevApiKey: 'custom-key' }, 'env-key')
  assert.equal(customWithSaved.apiKey, 'custom-key')
  assert.equal(customWithSaved.endpoint, 'https://custom.test')
})
