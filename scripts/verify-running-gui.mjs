#!/usr/bin/env node
// Read-only verification of a running app. Uses its normal startup-token
// exchange; never changes authentication, fabricates cookies, or submits prompts.
// Run only AFTER the human updates and restarts the app; the early version gate
// defaults to alpha.2 and CIEL_EXPECT_DSH_VERSION selects another target.
// DSH_CHECKOUT and CIEL_UPGRADE_ROOT are REQUIRED: no developer-local defaults.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchOwnedBrowser } from './browser-launch.mjs'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required')
if (!process.env.CIEL_UPGRADE_ROOT) throw new Error('CIEL_UPGRADE_ROOT is required')
const root = resolve(process.env.CIEL_UPGRADE_ROOT)
const expectedVersion = process.env.CIEL_EXPECT_DSH_VERSION || '0.1.5-alpha.2'
const expectedOrigin = process.env.CIEL_EXPECT_ORIGIN || 'http://127.0.0.1:3080'
const reportName = process.env.CIEL_REPORT_NAME || 'live-gui-verification.json'
const shotName = process.env.CIEL_SHOT_NAME || 'live-ciel-settings.png'
const version = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')).version
assert.equal(version, expectedVersion, 'Upgrade the requested DSH checkout before running the actual GUI probe')
const log = process.argv[process.argv.indexOf('--startup-log') + 1]
if (!process.argv.includes('--startup-log') || !log) throw new Error('A private startup log is required')
const urls = (await readFile(log, 'utf8')).match(/https?:[/][/][^\s\x1b]+/g) || []
const entry = urls.map(value => { try { return new URL(value) } catch { return null } }).findLast(url => url?.origin === expectedOrigin && url.pathname === '/' && url.searchParams.has('token'))
if (!entry) throw new Error('The normal GUI startup URL was not found')
const owner = await launchOwnedBrowser(checkout)
const checks = [], errors = []
try {
  const context = await owner.browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  const page = await context.newPage()
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === entry.origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  page.on('pageerror', error => errors.push(error.message.replace(/[?]token=[^ ]+/g, '?token=[redacted]')))
  await page.addInitScript(() => {
    let loader
    const wrapped = new WeakSet()
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, get: () => loader, set(value) {
      let load = value.load
      Object.defineProperty(value, 'load', { configurable: true, set(fn) { load = fn }, get() { return registration => {
        if (registration.id === 'dsh-ciel' && !wrapped.has(registration.factory)) {
          const original = registration.factory
          const factory = require => { const exports = original(require); window.__CIEL_SMOKE__ = exports.__test; return exports }
          wrapped.add(factory); registration = { ...registration, factory }
        }
        return load.call(value, registration)
      } } })
      loader = value
    } })
  })
  const response = await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
  assert.equal(response?.status(), 200, 'normal token exchange authenticated the index')
  assert.equal(new URL(page.url()).search, '', 'authentication token was removed by redirect')
  await page.waitForFunction(() => window.__CIEL_SMOKE__?.runtime?.reviewCall, null, { timeout: 60000 })
  checks.push('authenticated-index-and-active-ciel')
  const rpc = await page.evaluate(async () => {
    const api = window.__CIEL_SMOKE__
    const list = await api.runtime.reviewCall('list', { sessionId: 'ciel-readonly-smoke-missing', limit: 1 })
    const missing = await api.runtime.reviewCall('readReview', { sessionId: 'ciel-readonly-smoke-missing', reviewId: 'missing' })
    return { methods: api.remoteMethodNames, list, missing }
  })
  assert.equal(rpc.methods.length, 11)
  assert.deepEqual(rpc.list.reviews, [])
  assert.equal(rpc.list.nextCursor, null)
  assert.equal(rpc.list.limited, false)
  assert.equal(rpc.missing.ok, false)
  checks.push('live-readonly-paged-rpc-and-missing-record-refusal')
  // A fresh Harness home shows the first-run beta notice; an acknowledged home
  // has no such button, so this is a no-op against an established profile.
  const notice = page.getByRole('button', { name: '继续', exact: true })
  if (await notice.count() > 0) {
    await notice.first().click({ timeout: 10000 })
    checks.push('first-run-notice-dismissed')
  }
  // A fresh home then offers the conditional API-key step. An established home
  // with credentials configured has no such step.
  const onboardingLater = page.getByRole('button', { name: '稍后配置', exact: true })
  try {
    await onboardingLater.first().waitFor({ state: 'visible', timeout: 8000 })
    await onboardingLater.first().click({ timeout: 10000 })
    checks.push('credential-onboarding-deferred')
  } catch { /* no credential step for this profile */ }
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click({ timeout: 30000 })
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '夏尔 Ciel', exact: true }) })
  await dialog.getByRole('button', { name: '夏尔 Ciel', exact: true }).click()
  await dialog.getByText('启用 Ciel', { exact: true }).waitFor()
  assert.ok(await dialog.getByRole('switch').count() > 0)
  checks.push('actual-settings-page-native-controls')
  await mkdir(join(root, 'reports'), { recursive: true })
  await dialog.screenshot({ path: join(root, 'reports', shotName) })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__CIEL_SMOKE__?.runtime?.reviewCall, null, { timeout: 60000 })
  checks.push('refresh-reconnects-without-new-token')
  assert.deepEqual(errors, [])
  assert.equal(JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')).version, expectedVersion, 'DSH version stayed fixed during verification')
  const report = { ok: true, url: entry.origin, version, browser: owner.kind, checks, pageErrors: errors, readOnly: true, promptsSubmitted: 0, finishedAt: new Date().toISOString() }
  await writeFile(join(root, 'reports', reportName), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report))
  await context.close()
} catch (error) {
  // Do not allow Playwright's error text to expose a query-token URL.
  const report = { ok: false, url: entry.origin, checks, error: String(error.message).replace(/[?]token=[^\s"']+/g, '?token=[redacted]'), pageErrors: errors }
  await writeFile(join(root, 'reports', reportName), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.error(JSON.stringify(report)); process.exitCode = 1
} finally { await owner.close() }
