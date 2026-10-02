import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { packageReadme, checkReadme, checkClassification, checkLinks } from '../docs-contract.mjs'

const fields = { enabled: { meta: {} }, endpoint: { meta: {} }, roots: { meta: {} }, apiKey: { meta: { role: 'secret' } }, retired: { meta: { hidden: true } } }
const defaults = { enabled: false, endpoint: 'https://example.com/v1/check', roots: [] }
const doc = [
  '# dsh-ciel (Ciel)', '<!-- ciel-doc: current -->',
  'Current release: **[1.2.3](https://github.com/higekibaka/dsh-ciel/releases/tag/v1.2.3)**',
  '[npm](https://www.npmjs.com/package/dsh-ciel/v/1.2.3)',
  'dsh plugin --profile web add dsh-ciel@1.2.3', "## What's new in 1.2.3",
  '| `enabled` | `false` | toggle |', '| `endpoint` | `https://example.com/v1/check` | URL |',
  '| `roots` | `[]` | roots |', '| `apiKey` | unset | secret |', '',
].join('\n')
const check = text => checkReadme(text, '1.2.3', fields, defaults, 'en')

test('README contract accepts real types, undefined secret and retired hidden fields', () => {
  assert.deepEqual(check(doc), [])
  const chinese = doc.replace('Current release:', '当前版本：').replace("## What's new in 1.2.3", '## 1.2.3 更新').replace('| unset |', '| 未设置 |')
  assert.deepEqual(checkReadme(chinese, '1.2.3', fields, defaults, 'zh'), [])
})

test('version drift rejects stale current links, install command and highlights', () => {
  assert.ok(check(doc.replaceAll('1.2.3', '1.2.2')).length >= 4)
  assert.ok(check(doc.replace('dsh-ciel@1.2.3', 'dsh-ciel@latest')).includes('install command version mismatch'))
})

test('default, missing, duplicate and unknown config rows are rejected', () => {
  assert.ok(check(doc.replace('| `false` |', '| `true` |')).includes('configuration default mismatch: enabled'))
  assert.ok(check(doc.replace('| `apiKey` | unset | secret |', '')).includes('missing configuration row: apiKey'))
  assert.ok(check(doc + '| `enabled` | `false` | duplicate |').includes('duplicate configuration field row'))
  assert.ok(check(doc + '| `retired` | `1` | hidden |').includes('unknown or retired configuration row: retired'))
  assert.ok(checkReadme(doc, '1.2.3', { ...fields, newField: { meta: {} } }, defaults, 'en').includes('missing configuration row: newField'))
})

test('a secret placeholder cannot become a documented default credential', () => {
  assert.ok(check(doc.replace('| unset |', '| `redacted` |')).includes('configuration default mismatch: apiKey'))
})

test('npm README is a deterministic English body with repository links', () => {
  const english = '<p>banner</p>\n' + doc + '[Contract](docs/review-contract.md#核实结果) [Changes](CHANGELOG.md) [MIT](LICENSE)\n'
  const built = packageReadme(english)
  assert.ok(built.startsWith('<!-- Generated from README.en.md'))
  assert.ok(!built.includes('<p>banner'))
  assert.ok(built.includes('](https://github.com/higekibaka/dsh-ciel/blob/main/docs/review-contract.md#核实结果)'))
  assert.ok(built.includes('[MIT](LICENSE)'))
  assert.equal(packageReadme(english), built)
  assert.throws(() => packageReadme('missing heading'))
})

test('current docs cannot silently be unclassified or label shipped features unreleased', () => {
  assert.deepEqual(checkClassification(doc), [])
  assert.ok(checkClassification(doc.replace('<!-- ciel-doc: current -->', '')).length)
  assert.ok(checkClassification(doc + '\n## 开发版：Jev').length)
  assert.deepEqual(checkClassification('<!-- ciel-doc: historical -->\n## 开发版：旧设计'), [])
})

test('local links reject missing or private files and stale Chinese/English anchors', () => {
  const files = new Map([['docs/a.md', '# A\n## 已发布配置\n## API settings\n## API settings\n'], ['README.md', '# Home\n']])
  const tracked = new Set([...files.keys(), 'LICENSE'])
  assert.deepEqual(checkLinks('docs/a.md', '[x](#已发布配置) [y](#api-settings-1) [h](../README.md#home) [l](../LICENSE) [remote](https://example.com/)', files, tracked), [])
  assert.ok(checkLinks('docs/a.md', '[bad](#顾问建议检查开发版)', files, tracked).length)
  assert.ok(checkLinks('docs/a.md', '[private](../.local/report.md)', files, tracked).length)
})

test('checked-in generated README exactly matches its English source', async () => {
  const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
  assert.equal(await read('plugin/README.md'), packageReadme(await read('README.en.md')))
})
