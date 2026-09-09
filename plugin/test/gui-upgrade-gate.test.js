import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const probe = fileURLToPath(new URL('../../scripts/verify-running-gui.mjs', import.meta.url))
for (const [version, expectedMessage] of [
  ['0.1.5-alpha.1', 'Upgrade the requested DSH checkout before running the actual GUI probe'],
  ['0.1.5-alpha.2', 'A private startup log is required'],
]) {
  test('GUI verification refuses before browser launch without upgrade prerequisites: ' + version, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ciel-upgrade-gate-'))
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ version }))
      const result = spawnSync(process.execPath, [probe], {
        cwd: dir, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, DSH_CHECKOUT: dir, DSH_HOME: dir, CIEL_UPGRADE_ROOT: dir, CIEL_EXPECT_DSH_VERSION: '0.1.5-alpha.2' },
      })
      assert.equal(result.status, 1, result.stderr)
      assert.ok(result.stderr.includes(expectedMessage), result.stderr)
      assert.deepEqual(await readdir(dir), ['package.json'], 'no report, profile, or user-state write before prerequisites pass')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
for (const [label, envPatch, expectedMessage] of [
  ['an explicit DSH_CHECKOUT', { DSH_CHECKOUT: undefined }, 'DSH_CHECKOUT is required'],
  ['an explicit CIEL_UPGRADE_ROOT', { CIEL_UPGRADE_ROOT: undefined }, 'CIEL_UPGRADE_ROOT is required'],
]) {
  test('GUI verification requires ' + label + ' before any browser launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ciel-upgrade-env-'))
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '0.1.5-alpha.2' }))
      const env = { ...process.env, DSH_CHECKOUT: dir, DSH_HOME: dir, CIEL_UPGRADE_ROOT: dir, CIEL_EXPECT_DSH_VERSION: '0.1.5-alpha.2' }
      for (const [key, value] of Object.entries(envPatch)) { if (value === undefined) delete env[key]; else env[key] = value }
      const result = spawnSync(process.execPath, [probe], { cwd: dir, encoding: 'utf8', timeout: 10000, env })
      assert.equal(result.status, 1, result.stderr)
      assert.ok(result.stderr.includes(expectedMessage), result.stderr)
      assert.deepEqual(await readdir(dir), ['package.json'], 'no report, profile, or user-state write before prerequisites pass')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
