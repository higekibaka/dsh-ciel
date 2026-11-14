import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOST_PACKAGES,
  HostDependencyError,
  describeHostModule,
  hostAnchors,
  hostCandidates,
  hostSchemastery,
  hostTypertProtocol,
  loadHostModule,
  resetHostModuleCache,
} from '../runtime.js'

const ENV_KEYS = ['DSH_CIEL_HOST_MODULES', 'DSH_CHECKOUT', 'DSH_INSTALL_DIR']
const SCHEMASTERY = '@deepseek-ai/schemastery'
const TYPERT = '@deepseek-ai/dsh-typert-protocol'

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

/** Write a package with both build flavours at an exact directory. */
async function writePackage(root, { name, marker, asyncModule = false }) {
  await mkdir(join(root, 'lib'), { recursive: true })
  const manifest = {
    name,
    version: '0.0.0-fixture',
    type: 'module',
    exports: { '.': { import: './lib/index.mjs', require: './lib/index.cjs' } },
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const head = asyncModule ? "await Promise.resolve()\n" : ''
  await writeFile(join(root, 'lib', 'index.mjs'), head + 'export default { marker: ' + JSON.stringify(marker + '-esm') + ' }\n')
  await writeFile(join(root, 'lib', 'index.cjs'), 'module.exports = { marker: ' + JSON.stringify(marker + '-cjs') + ' }\n')
}

/** Write a fixture package into <root>/node_modules, as an installed dependency. */
function writeInstalled(root, options) {
  return writePackage(join(root, 'node_modules', ...options.name.split('/')), options)
}

async function withFixture(name, body) {
  const root = await mkdtemp(join(tmpdir(), 'ciel-runtime-' + name + '-'))
  const saved = snapshotEnv()
  try {
    return await body(root)
  } finally {
    restoreEnv(saved)
    resetHostModuleCache()
    await rm(root, { recursive: true, force: true })
  }
}

test('host module resolution covers exactly the two shared packages', () => {
  assert.deepEqual([...HOST_PACKAGES], [SCHEMASTERY, TYPERT])
  assert.ok(Object.isFrozen(HOST_PACKAGES))
})

test('anchors run from the explicit override to the plugin itself', async () => {
  await withFixture('anchors', async () => {
    clearEnv()
    const bare = hostAnchors().map((anchor) => anchor.source)
    assert.equal(bare.at(-1), 'plugin', 'the plugin copy is always the last resort')
    assert.equal(bare.includes('DSH_CIEL_HOST_MODULES'), false)

    process.env.DSH_CIEL_HOST_MODULES = 'C:\\host-modules'
    process.env.DSH_CHECKOUT = 'C:\\checkout'
    process.env.DSH_INSTALL_DIR = 'C:\\install'
    const sources = hostAnchors().map((anchor) => anchor.source)
    assert.equal(sources[0], 'DSH_CIEL_HOST_MODULES')
    const checkout = sources.filter((source) => source.startsWith('DSH_CHECKOUT:'))
    assert.equal(checkout[0], 'DSH_CHECKOUT:packages/core/tools')
    assert.ok(checkout.includes('DSH_CHECKOUT:apps/cli'), 'a checkout may be resolved through its CLI app')
    assert.ok(checkout.at(-1) === 'DSH_CHECKOUT:.')
    const workspace = sources.indexOf('DSH_CHECKOUT')
    assert.ok(workspace > 0, 'the checkout workshop stage exists')
    assert.ok(sources.indexOf('DSH_CHECKOUT:.') < workspace, 'source-mode workspace packages come after resolvable ones')
    assert.equal(hostAnchors()[workspace].workspace, true)
    const install = sources.filter((source) => source.startsWith('DSH_INSTALL_DIR:'))
    assert.equal(install[0], 'DSH_INSTALL_DIR:.')
    assert.ok(workspace < sources.indexOf('DSH_INSTALL_DIR:.'), 'the whole checkout stage stays before the install stage')
    assert.ok(sources.indexOf('DSH_CHECKOUT:packages/core/tools') < sources.indexOf('DSH_INSTALL_DIR:.'))
    assert.ok(sources.indexOf(install.at(-1)) < sources.indexOf('plugin'))
  })
})

test('an explicit host module root wins and the ES module build is the loaded instance', async () => {
  await withFixture('host-modules', async (root) => {
    clearEnv()
    await writeInstalled(root, { name: SCHEMASTERY, marker: 'host' })
    process.env.DSH_CIEL_HOST_MODULES = root
    resetHostModuleCache()
    const record = loadHostModule(SCHEMASTERY)
    assert.equal(record.source, 'DSH_CIEL_HOST_MODULES')
    assert.match(record.file, /index\.mjs$/, 'the host imports the ES module build, so the plugin must too')
    assert.equal(record.module.default.marker, 'host-esm')
    assert.deepEqual(describeHostModule(SCHEMASTERY), { source: 'DSH_CIEL_HOST_MODULES', file: record.file })
  })
})

test('a built checkout resolves through its monorepo workspace packages', async () => {
  await withFixture('checkout-monorepo', async (root) => {
    clearEnv()
    process.env.DSH_CHECKOUT = root
    await writeInstalled(join(root, 'packages', 'core', 'tools'), { name: TYPERT, marker: 'checkout' })
    resetHostModuleCache()
    const record = loadHostModule(TYPERT)
    assert.equal(record.source, 'DSH_CHECKOUT:packages/core/tools')
    assert.equal(record.module.default.marker, 'checkout-esm')
  })
})

test('a built checkout may expose the shared package only under its CLI app', async () => {
  await withFixture('checkout-cli', async (root) => {
    clearEnv()
    process.env.DSH_CHECKOUT = root
    await writeInstalled(join(root, 'apps', 'cli'), { name: TYPERT, marker: 'cli' })
    resetHostModuleCache()
    const record = loadHostModule(TYPERT)
    assert.equal(record.source, 'DSH_CHECKOUT:apps/cli')
    assert.equal(record.module.default.marker, 'cli-esm')
  })
})

test('an explicit host override outranks a checkout source workspace', async () => {
  await withFixture('precedence', async (root) => {
    clearEnv()
    const hostModules = join(root, 'host-modules')
    const checkout = join(root, 'checkout')
    await writeInstalled(hostModules, { name: SCHEMASTERY, marker: 'explicit-host' })
    await writePackage(join(checkout, 'vendor', 'schemastery'), { name: SCHEMASTERY, marker: 'checkout-workspace' })
    process.env.DSH_CIEL_HOST_MODULES = hostModules
    process.env.DSH_CHECKOUT = checkout
    resetHostModuleCache()
    const record = loadHostModule(SCHEMASTERY)
    assert.equal(record.source, 'DSH_CIEL_HOST_MODULES', 'the explicit override wins even when a checkout resolves')
    assert.equal(record.module.default.marker, 'explicit-host-esm')
    const order = hostCandidates(SCHEMASTERY).candidates.map((candidate) => candidate.source)
    assert.ok(order.indexOf('DSH_CIEL_HOST_MODULES') < order.findIndex((source) => source.endsWith(':vendor/schemastery')), 'candidate order keeps the override first')
    delete process.env.DSH_CIEL_HOST_MODULES
    resetHostModuleCache()
    const fallback = loadHostModule(SCHEMASTERY)
    assert.equal(fallback.source, 'DSH_CHECKOUT:vendor/schemastery', 'the workspace copy still serves the checkout without the override')
    assert.equal(fallback.module.default.marker, 'checkout-workspace-esm')
  })
})

test('an explicit anchor list is never preempted by the checkout in the environment', async () => {
  await withFixture('explicit-anchors', async (root) => {
    clearEnv()
    const checkout = join(root, 'checkout')
    const empty = join(root, 'empty')
    await mkdir(empty, { recursive: true })
    await writePackage(join(checkout, 'vendor', 'schemastery'), { name: SCHEMASTERY, marker: 'checkout-workspace' })
    process.env.DSH_CHECKOUT = checkout
    const explicit = [{ source: 'explicit-only', base: empty }]
    const { attempts, candidates } = hostCandidates(SCHEMASTERY, explicit)
    assert.deepEqual(candidates, [], 'the environment checkout contributes no candidate to an explicit anchor list')
    assert.ok(attempts.length > 0)
    assert.ok(attempts.every((attempt) => attempt.startsWith('explicit-only')), 'attempts name only the explicit anchor')
    await assert.rejects(
      async () => loadHostModule(SCHEMASTERY, explicit),
      (error) => error.code === 'CIEL_HOST_DEPENDENCY_UNAVAILABLE',
    )
  })
})

test('a built checkout may ship the shared package as a source workspace', async () => {
  await withFixture('checkout-workspace', async (root) => {
    clearEnv()
    process.env.DSH_CHECKOUT = root
    await writePackage(join(root, 'vendor', 'schemastery'), { name: SCHEMASTERY, marker: 'vendor' })
    resetHostModuleCache()
    const record = loadHostModule(SCHEMASTERY)
    assert.equal(record.source, 'DSH_CHECKOUT:vendor/schemastery')
    assert.equal(record.module.default.marker, 'vendor-esm')
  })
})

test('the plugin keeps working from its own development dependency when nothing overrides it', async () => {
  await withFixture('local', async () => {
    clearEnv()
    resetHostModuleCache()
    const schema = hostSchemastery()
    assert.equal(typeof schema, 'function')
    assert.equal(typeof schema.boolean, 'function')
    // Under the test runner `process.argv[1]` is a test file inside this same
    // plugin workspace, so both local anchors name the identical installed copy.
    assert.ok(['plugin', 'process.argv[1]'].includes(describeHostModule(SCHEMASTERY).source))
    const protocol = hostTypertProtocol()
    assert.equal(typeof protocol.TypertRemoteService, 'function')
    assert.equal(typeof protocol.Remote, 'function')
  })
})

test('loads are memoised until resetHostModuleCache re-runs resolution', async () => {
  await withFixture('cache', async (root) => {
    clearEnv()
    const first = join(root, 'first')
    const second = join(root, 'second')
    await writeInstalled(first, { name: SCHEMASTERY, marker: 'first' })
    await writeInstalled(second, { name: SCHEMASTERY, marker: 'second' })
    process.env.DSH_CIEL_HOST_MODULES = first
    resetHostModuleCache()
    assert.equal(loadHostModule(SCHEMASTERY).module.default.marker, 'first-esm')
    process.env.DSH_CIEL_HOST_MODULES = second
    assert.equal(loadHostModule(SCHEMASTERY).module.default.marker, 'first-esm', 'a repeated load stays cached')
    resetHostModuleCache()
    assert.equal(loadHostModule(SCHEMASTERY).module.default.marker, 'second-esm')
  })
})

test('a missing host dependency raises HostDependencyError naming every anchor', async () => {
  await withFixture('missing', async (root) => {
    clearEnv()
    await assert.rejects(
      async () => loadHostModule(SCHEMASTERY, [{ source: 'empty-anchor', base: root }]),
      (error) => {
        assert.ok(error instanceof HostDependencyError)
        assert.equal(error.name, 'HostDependencyError')
        assert.equal(error.code, 'CIEL_HOST_DEPENDENCY_UNAVAILABLE')
        assert.equal(error.packageName, SCHEMASTERY)
        assert.ok(error.attempts.some((attempt) => attempt.includes('empty-anchor')), 'the failing anchor is reported')
        assert.match(error.message, /DSH_CIEL_HOST_MODULES/)
        assert.match(error.message, /DSH_CHECKOUT/)
        return true
      },
    )
    assert.equal(describeHostModule(SCHEMASTERY), undefined, 'a failed load caches nothing')
  })
})

test('an ES module entry with top-level await falls back to the synchronous build', async () => {
  await withFixture('async-fallback', async (root) => {
    clearEnv()
    await writeInstalled(root, { name: SCHEMASTERY, marker: 'await', asyncModule: true })
    process.env.DSH_CIEL_HOST_MODULES = root
    resetHostModuleCache()
    const candidates = hostCandidates(SCHEMASTERY, [{ source: 'fixture', base: root }]).candidates
    assert.ok(candidates.length >= 2, 'both the ES module and the CommonJS build are offered')
    const record = loadHostModule(SCHEMASTERY)
    assert.match(record.file, /index\.cjs$/, 'the unloadable ES module build is skipped, never fatal')
    assert.equal(record.module.marker, 'await-cjs')
  })
})

test('Desktop Electron process.resourcesPath resolves app.asar/dsh with zero environment variables', async () => {
  await withFixture('electron-resources', async (root) => {
    clearEnv()
    const prevDesc = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    try {
      await writeInstalled(join(root, 'app.asar', 'dsh'), { name: SCHEMASTERY, marker: 'desktop-asar' })
      Object.defineProperty(process, 'resourcesPath', { value: root, configurable: true, writable: true })
      resetHostModuleCache()
      const record = loadHostModule(SCHEMASTERY)
      assert.equal(record.source, 'process.resourcesPath:app.asar/dsh')
      assert.equal(record.module.default.marker, 'desktop-asar-esm')
    } finally {
      if (prevDesc) Object.defineProperty(process, 'resourcesPath', prevDesc)
      else delete process.resourcesPath
    }
  })
})
