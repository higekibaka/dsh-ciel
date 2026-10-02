import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { main, migrateDocument } from '../migrate-dsh-017-settings.mjs'

test('host model selection and preset preferences reach the new editable fields', () => {
  const { parseDocument } = createRequire(join(process.env.DSH_CHECKOUT, 'packages/settings/settings/package.json'))('yaml')
  const document = parseDocument('agent-presets:\n  default: standard\nsubagent-model-selection:\n  enabled: true\n  allowedModels:\n    - provider: fixture\n      model: fixture\n')
  assert.equal(migrateDocument(document).length, 2)
  assert.deepEqual(document.toJSON(), {
    'agent-preset-registry': { selectedDefault: 'standard' },
    'subagent-model-selection-settings': { enabled: true, allowedModels: [{ provider: 'fixture', model: 'fixture' }] },
  })
  const existing = parseDocument('agent-presets:\n  default: standard\nagent-preset-registry:\n  selectedDefault: fixture-selected\nsubagent-model-selection:\n  enabled: true\nsubagent-model-selection-settings:\n  enabled: false\n')
  migrateDocument(existing)
  assert.equal(existing.getIn(['agent-preset-registry', 'selectedDefault']), 'fixture-selected')
  assert.equal(existing.getIn(['subagent-model-selection-settings', 'enabled']), false)
  assert.equal(migrateDocument(existing).length, 0)
})

test('migration previews, backs up, preserves canonical overrides and is idempotent', async () => {
  assert.ok(process.env.DSH_CHECKOUT, 'DSH_CHECKOUT must name a built checkout')
  const home = await mkdtemp(join(tmpdir(), 'settings-migration-'))
  const filename = join(home, 'settings.yaml')
  const source = '# Keep this comment\nciel:\n  enabled: false\n  provider: fixture-secret\nadvisor:\n  enabled: true\ndsh-theme-endfield-glass:\n  motion: static\nunrelated:\n  language: zh\n'
  const output = [], originalLog = console.log
  console.log = value => output.push(value)
  try {
    await writeFile(filename, source, { mode: 0o600 })
    assert.equal((await main(['--home', home])).changes.length, 2)
    assert.equal(await readFile(filename, 'utf8'), source)
    assert.deepEqual(await readdir(home), ['settings.yaml'])
    const result = await main(['--home', home, '--apply'])
    assert.equal(await readFile(result.backup, 'utf8'), source)
    assert.equal((await stat(result.backup)).mode & 0o777, 0o600)
    const changed = await readFile(filename, 'utf8')
    assert.match(changed, /# Keep this comment/)
    assert.match(changed, /enabled: true/)
    assert.match(changed, /provider: fixture-secret/)
    assert.match(changed, /endfield-glass:/)
    assert.match(changed, /unrelated:/)
    assert.doesNotMatch(changed, /^ciel:|^dsh-theme-endfield-glass:/m)
    assert.equal((await main(['--home', home, '--apply'])).changes.length, 0)
    assert.equal((await readdir(home)).length, 2)
    assert.ok(!output.join('').includes('fixture-secret'))
    await writeFile(filename, 'ciel: [invalid]\n')
    await assert.rejects(main(['--home', home, '--apply']), /Invalid settings mapping/)
    assert.equal(await readFile(filename, 'utf8'), 'ciel: [invalid]\n')
  } finally { console.log = originalLog; await rm(home, { recursive: true, force: true }) }
})
