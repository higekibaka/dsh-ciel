// Retained credential screening regressions; the review corpus no longer exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectSensitiveText } from '../sensitive-text.js'

test('sensitivity heuristic catches common credentials but makes no arbitrary-secret guarantee', () => {
  for (const text of [
    '-----BEGIN ' + 'PRIVATE KEY-----\nFAKE',
    'const credential = "' + 'AKIA' + 'ABCDEFGHIJKLMNOP' + '"',
    'const url = "https://fake-user:fake-password@example.invalid/path"',
    'const url = "postgres://fake-user:fake-password@localhost/db"',
    'fetch("https://example.invalid?access_token=FAKE_TOKEN")',
    'Authorization: Bearer FAKE_LONG_BEARER_TOKEN',
    'const apiKey = "FAKE_API_KEY"',
    '{"client_secret":"FAKE_CLIENT_SECRET"}',
    'PASSWORD=FAKE_PASSWORD',
  ]) assert.equal(detectSensitiveText(text), true)
  assert.equal(detectSensitiveText('export const answer = 42'), false)
  assert.equal(detectSensitiveText('const value = "arbitrary-hidden-secret-with-no-marker"'), false)
  assert.equal(detectSensitiveText('const token = process.env.ACCESS_TOKEN'), false)
  assert.equal(typeof detectSensitiveText('const password = "fake"'), 'boolean')
})

test('placeholder credential values are not treated as secrets while real shapes still do', () => {
  for (const text of [
    'dsh web: http://127.0.0.1:3080/?token=…',
    'dsh web: http://127.0.0.1:3080/?token=...',
    'dsh web: http://127.0.0.1:3080/?token=<token>',
    'const apiKey = "YOUR_API_KEY"',
    'const token = "changeme"',
    'SECRET=[redacted]',
    'const token = "${ACCESS_TOKEN}"',
    'const apiKey = "example"',
    'const token = ""',
    // Markdown backticks, list punctuation, and prose wrappers must not turn a
    // placeholder into a credential value.
    '启动网址是 `http://127.0.0.1:3080/?token=…` 请替换',
    '（示例 ?token=…）',
    '规则写作 [?&]token=... 匹配',
    '| `?token=…`、`?token=...`、`?token=<token>` | 示例 |',
    'SECRET=changeme,',
  ]) assert.equal(detectSensitiveText(text), false)
  for (const text of [
    'dsh web: http://127.0.0.1:3080/?token=' + 'A'.repeat(43),
    'const apiKey = "FAKE_API_KEY"',
    '{"client_secret":"FAKE_CLIENT_SECRET"}',
    'PASSWORD=FAKE_PASSWORD',
  ]) assert.equal(detectSensitiveText(text), true)
})
