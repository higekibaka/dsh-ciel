#!/usr/bin/env node
// Real 0.1.7 Loader + ConfigEditor + Settings, temporary Home/Profile only.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required (built 0.1.7 checkout)')
const requireTarget = createRequire(join(checkout, 'packages/core/tools/package.json'))
const shared = Object.fromEntries(['@deepseek-ai/cordis', '@deepseek-ai/schemastery'].map(name => [name, requireTarget.resolve(name)]))
shared['@deepseek-ai/dsh-typert-protocol'] = join(checkout, 'packages/typert/protocol/lib/index.js')
const hooks = registerHooks({ resolve(specifier, context, next) {
  return shared[specifier] ? { url: pathToFileURL(shared[specifier]).href, shortCircuit: true } : next(specifier, context)
} })
const load = path => import(pathToFileURL(join(checkout, path, 'lib/index.js')).href)
const [{ boot, initProfile, readProfilePatches }, { default: ConfigEditor }, { default: Settings }, ciel] = await Promise.all([
  load('packages/boot/app-boot'), load('packages/boot/config-editor'), load('packages/settings/settings'), import('../plugin/index.js'),
])
const plugins = [['advisor', ciel, { jevEnabled: false, guidanceEnabled: false }, { advisorJevEnabled: true, jevEnabled: false, enabled: false, jevApiKey: 'settings-fixture-secret', jevEndpoint: 'https://proxy.invalid/systemone', jevModel: 'jev-test' }]]
if (process.env.GLASS_PLUGIN) {
  const glass = await import(pathToFileURL(resolve(process.env.GLASS_PLUGIN, 'lib/index.js')).href)
  plugins.push(['endfield-glass', glass, {}, { motion: 'static', frameRate: 60 }])
}
const home = await mkdtemp(join(tmpdir(), 'dsh-017-plugins-'))
const dir = join(home, 'profiles/test'), bundle = join(dir, 'node_modules/test-bundle')
const previousHome = process.env.DSH_HOME, previousFetch = globalThis.fetch
let ctx
try {
  process.env.DSH_HOME = home
  globalThis.fetch = async () => { throw new Error('Network forbidden in settings verification') }
  initProfile(dir, ['test-bundle'])
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"isolated-settings-test"}')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    ...plugins.map(([id, , config]) => ({ id, name: `cordis:${id}`, config })),
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), context => {
    context.provide('profileContext', profile)
    context.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    Object.assign(context.loader.builtins, { editor: ConfigEditor, settings: Settings, ...Object.fromEntries(plugins.map(([id, plugin]) => [id, plugin])) })
  })
  ctx = await start()
  for (const [id, , , updates] of plugins) {
    const entry = [...ctx.loader.entries()].find(row => row.options.id === id)
    assert.ok(entry?.fiber)
    const fiber = entry.fiber, refs = fiber.config
    let changed = 0
    fiber.ctx.on('loader/volatile-update', () => { changed++ })
    const form = ctx.settings.describe().find(row => row.ns === id)
    assert.ok(form, `${id}: editable form exists`)
    assert.equal(form.autoGenerate, false, `${id}: keeps its own settings page`)
    await ctx.settings.update(id, updates)
    assert.equal(entry.fiber, fiber, `${id}: no plugin restart`)
    assert.equal(fiber.config, refs, `${id}: stable references`)
    for (const [key, value] of Object.entries(updates)) assert.equal(refs[key].get(), value)
    assert.ok(changed > 0, `${id}: owner received volatile update`)
    if (id === 'advisor') {
      const wire = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === id)
      assert.equal(wire.value.jevApiKey, undefined)
      assert.equal(wire.user.jevApiKey, undefined)
      assert.equal(wire.secrets.find(row => row.path.join('.') === 'jevApiKey').set, true)
      assert.ok(!JSON.stringify(wire).includes('settings-fixture-secret'))
      await ctx.settings.update(id, { jevModel: 'jev-test' })
      assert.equal(refs.jevApiKey.get(), 'settings-fixture-secret', 'unrelated writes preserve the secret')
    }
    await assert.rejects(ctx.settings.update(id, { enabled: 'invalid' }))
  }
  const persisted = await readFile(profile.patchPath, 'utf8')
  assert.ok(persisted.includes('jevEnabled'))
  assert.ok(persisted.includes('advisorJevEnabled'))
  await ctx.fiber.dispose(); ctx = await start()
  for (const [id, , , updates] of plugins) {
    const value = ctx.settings.describe().find(row => row.ns === id).value
    for (const [key, expected] of Object.entries(updates)) assert.equal(value[key], expected, `${id}: restored ${key}`)
  }
  await ctx.settings.mutate('advisor', [{ op: 'unset', path: ['jevApiKey'] }])
  const cleared = ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'advisor')
  assert.equal(cleared.secrets.find(row => row.path.join('.') === 'jevApiKey').set, false)
  assert.ok(!(await readFile(profile.patchPath, 'utf8')).includes('settings-fixture-secret'))
  console.log(JSON.stringify({ passed: true, entries: plugins.map(([id]) => id), checks: ['volatile form discovery', 'custom-page policy', 'persistent live edits', 'same fiber and config references', 'owner notifications', 'invalid input rejection', 'restored after restart', 'secret wire redaction', 'unrelated edit preserves secret', 'explicit key removal'], modelCalls: 0, networkRequests: 0 }))
} finally {
  await ctx?.fiber.dispose()
  hooks.deregister()
  globalThis.fetch = previousFetch
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}
