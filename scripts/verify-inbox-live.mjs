#!/usr/bin/env node
// Read-only live probe for the current-session 夏尔收件箱 in the RUNNING GUI.
//
// The app is reached only through its NORMAL startup-token exchange: the URL is
// read from a private --startup-log file the operator supplies. This script
// never fabricates a cookie, never bypasses authentication, never reads
// credentials, and never prints or stores the token (every message is redacted).
//
// It performs READ-ONLY actions only: open the inbox panel, switch panels,
// view evidence, and reload. It does not submit prompts, does not write an
// intent, does not change real intent data, and does not touch the composer.
//
// Run (after the owning agent confirms a valid token is available):
//   DSH_CHECKOUT=/path/to/deepseek-harness \
//     node scripts/verify-inbox-live.mjs --startup-log /path/to/startup.log
// Env:
//   DSH_CHECKOUT             isolated built checkout (required, no default)
//   CIEL_EXPECT_ORIGIN       expected GUI origin (default http://127.0.0.1:3080)
//   CIEL_REPORT_DIR          artifact dir (default <ciel repo>/.artifacts)
//   CIEL_CHROME_PATH / CIEL_WINDOWS_CHROME  browser selection (via browser-launch)
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchOwnedBrowser } from './browser-launch.mjs'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required')
const cielRoot = fileURLToPath(new URL('..', import.meta.url))
const reportDir = process.env.CIEL_REPORT_DIR || join(cielRoot, '.artifacts')
mkdirSync(reportDir, { recursive: true })
const expectedOrigin = process.env.CIEL_EXPECT_ORIGIN || 'http://127.0.0.1:3080'
const version = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version

const logIndex = process.argv.indexOf('--startup-log')
if (logIndex === -1 || !process.argv[logIndex + 1]) throw new Error('A private --startup-log <path> is required (the normal token-exchange URL)')
const redact = (text) => String(text).replace(/[?&]token=[^\s&"'<>\\]+/g, '?token=[redacted]')
const urls = (readFileSync(process.argv[logIndex + 1], 'utf8').match(/https?:[/][/][^\s\x1b]+/g) || [])
const entry = urls.map((value) => { try { return new URL(value) } catch { return null } })
  .findLast((url) => url !== null && url.origin === expectedOrigin && url.pathname === '/' && url.searchParams.has('token'))
if (entry === undefined || entry === null) throw new Error('The normal GUI startup URL was not found for ' + expectedOrigin)

const passed = []
const skipped = []
const failed = []
const errors = []
const remoteErrors = []
const screenshots = []
const note = (name) => { passed.push(name); console.log('  ok -', name) }
// A skip is explicit and is never counted as a pass; a real trigger that fails is a failure.
const skip = (name, reason) => { skipped.push({ name, reason }); console.log('  skip -', name, '-', reason) }
const shot = async (page, name) => { const path = join(reportDir, 'inbox-live-' + name + '.png'); await page.screenshot({ path, fullPage: false }); screenshots.push(path) }
const finish = async (owner, report) => {
  await owner.close()
  const safe = JSON.parse(redact(JSON.stringify(report)))
  writeFileSync(join(reportDir, 'inbox-live-verify.json'), JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(safe))
  if (safe.ok !== true) process.exitCode = 1
}

const owner = await launchOwnedBrowser(checkout)
let allowedOriginRequests = 0
let blockedExternalRequests = 0
try {
  const context = await owner.browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === entry.origin || url.protocol === 'data:' || url.protocol === 'blob:') { allowedOriginRequests += 1; return route.continue() }
    blockedExternalRequests += 1
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(redact(error.message)))
  // Mount failures are caught by Ciel, so pageerror alone cannot detect them.
  page.on('console', (message) => {
    if (message.type() === 'error' && /dsh-advisor: review remote mount failed/.test(message.text())) {
      remoteErrors.push(redact(message.text()))
    }
  })
  // Capture the production client's test surface without changing app behavior.
  await page.addInitScript(() => {
    let loader
    const wrapped = new WeakSet()
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, get: () => loader, set(value) {
      let load = value.load
      Object.defineProperty(value, 'load', { configurable: true, set(fn) { load = fn }, get() { return registration => {
        if (registration.id === 'dsh-ciel' && !wrapped.has(registration.factory)) {
          const original = registration.factory
          const factory = require => { const exports = original(require); window.__CIEL_INBOX_SMOKE__ = exports.__test; return exports }
          wrapped.add(factory); registration = { ...registration, factory }
        }
        return load.call(value, registration)
      } } })
      loader = value
    } })
  })
  const response = await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
  assert.equal(response?.status(), 200, 'normal token exchange authenticated the index')
  assert.equal(new URL(page.url()).search, '', 'the authentication token was removed by redirect')
  await page.waitForFunction(() => window.__CIEL_INBOX_SMOKE__?.runtime?.reviewCall, null, { timeout: 60000 })
  note('authenticated-index-and-active-ciel')

  const methods = await page.evaluate(() => window.__CIEL_INBOX_SMOKE__.remoteMethodNames)
  assert.ok(methods.includes('inboxList'), 'advisorReview does not declare inboxList: ' + JSON.stringify(methods))
  note('live-remote-declares-inboxList')

  // Read-only contract probe against a non-existent session: no real data is read
  // and no write RPC is ever invoked.
  const empty = await page.evaluate(() => window.__CIEL_INBOX_SMOKE__.runtime.reviewCall('inboxList', { sessionId: 'ciel-inbox-live-smoke-missing', limit: 1 }))
  assert.equal(empty.ok, true, 'inboxList must answer for an unknown session: ' + JSON.stringify(empty))
  assert.deepEqual(empty.reviews, [], 'an unknown session must return an empty page')
  assert.equal(empty.nextCursor, null)
  assert.equal(empty.limited, false)
  note('live-readonly-inboxList-empty-session')

  /**
   * Dismiss the conditional first-run/credential onboarding. A credential-less
   * home replays it after every reload and its modal mask blocks the shell. The
   * helper is the normal UI path only: it never force-clicks, never edits the
   * DOM, and never fabricates credentials. A present button whose click fails is
   * a real failure and propagates.
   */
  const dismissOnboarding = async (suffix) => {
    const notice = page.getByRole('button', { name: '继续', exact: true })
    if (await notice.count() > 0 && await notice.first().isVisible().catch(() => false)) {
      await notice.first().click({ timeout: 10000 })
      await notice.first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
      note('first-run-notice-dismissed' + suffix)
    }
    const later = page.getByRole('button', { name: '稍后配置', exact: true })
    let credentialStep = false
    try {
      await later.first().waitFor({ state: 'visible', timeout: 8000 })
      credentialStep = true
    } catch { credentialStep = false }
    if (credentialStep) {
      await later.first().click({ timeout: 10000 })
      await later.first().waitFor({ state: 'hidden', timeout: 10000 })
      // The onboarding modal/mask must leave before the shell is interactive.
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(300)
      note('credential-onboarding-deferred' + suffix)
    }
  }

  /** Wait until the real overlay stack stops covering a sidebar row (no force click). */
  const waitForRowClickable = async (row) => {
    const label = await row.getAttribute('aria-label')
    if (label === null) return
    await page.waitForFunction((wanted) => {
      const el = [...document.querySelectorAll('nav button')].find((node) => node.getAttribute('aria-label') === wanted)
      if (el === undefined) return false
      const rect = el.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return top === el || el.contains(top)
    }, label, { timeout: 15000 })
  }

  await dismissOnboarding('')
  const row = page.getByRole('button', { name: /收件箱/ }).first()
  await row.waitFor({ state: 'visible', timeout: 30000 })
  await waitForRowClickable(row)
  await row.click({ timeout: 10000 })
  await page.waitForTimeout(500)
  assert.equal(await row.getAttribute('aria-current'), 'page', 'the inbox row must become the active global panel')
  const root = page.locator('[data-ciel-inbox]')
  await root.waitFor({ state: 'visible', timeout: 15000 })
  const panelState = await root.getAttribute('data-ciel-inbox-state')
  await shot(page, '01-panel')
  note('inbox-panel-opened')

  // The isolated home has no sessions: the panel must render its no-session state
  // instead of inventing a list. Any other phase is reported as observed.
  if (panelState === 'no-session') note('inbox-empty-home-no-session-state')
  else note('inbox-panel-state-' + String(panelState))

  // Panel switching is read-only navigation; skip cleanly when only one panel exists.
  const navButtons = page.locator('nav button')
  const navCount = await navButtons.count()
  if (navCount > 1) {
    await navButtons.nth(0).click({ timeout: 10000 })
    await page.waitForTimeout(200)
    await row.click({ timeout: 10000 })
    await page.waitForTimeout(300)
    assert.equal(await row.getAttribute('aria-current'), 'page')
    note('panel-switch-and-return')
  } else {
    skip('panel-switch-and-return', 'only one global panel is registered')
  }

  // Evidence: the ONLY valid trigger is the real evidence button, and it must
  // open the real right-column body. With no records this is an explicit skip.
  const evidenceButtons = page.locator('[data-ciel-inbox-evidence]')
  if (await evidenceButtons.count() === 0) {
    skip('inbox-evidence-right-column', 'the isolated home has no review/evidence records')
  } else {
    await evidenceButtons.first().click({ timeout: 10000 })
    const rightBody = page.locator('[data-slot="rightbar"] [data-ciel-line], [data-slot="rightbar"] [data-ciel-line-text], [data-ciel-evidence-body]')
    await rightBody.first().waitFor({ state: 'visible', timeout: 30000 })
    await shot(page, '02-evidence')
    note('inbox-evidence-right-column')
  }

  await shot(page, '03-final')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__CIEL_INBOX_SMOKE__?.runtime?.reviewCall, null, { timeout: 60000 })
  // A credential-less home replays the onboarding after the reload; dismiss it
  // again and wait for the row to be genuinely clickable before clicking.
  await dismissOnboarding('-after-reload')
  // The reload must re-open the inbox through the same panel row.
  const rowAfter = page.getByRole('button', { name: /收件箱/ }).first()
  await rowAfter.waitFor({ state: 'visible', timeout: 30000 })
  await waitForRowClickable(rowAfter)
  await rowAfter.click({ timeout: 10000 })
  await page.waitForTimeout(300)
  assert.equal(await rowAfter.getAttribute('aria-current'), 'page')
  note('refresh-reconnects-without-new-token')

  assert.deepEqual(errors, [], 'the live probe must not raise page errors')
  assert.deepEqual(remoteErrors, [], 'the review Remote must mount after boot and reload')
  await finish(owner, {
    ok: failed.length === 0, mode: 'live-readonly', url: entry.origin, checkoutVersion: version, browser: owner.kind,
    passed, skipped, failed, pageErrors: errors, remoteErrors, screenshots, readOnly: true,
    promptsSubmitted: 0, intentsWritten: 0, feedbackStaged: 0,
    allowedOriginRequests, blockedExternalRequests,
    boundaries: [
      'Read-only: no prompt submitted, no inboxSetIntent call, no intent or feedback data changed, no composer mutation.',
      'The isolated home has no sessions or reviews, so the live probe covers only the real-GUI entry, the read-only Remote contract and refresh; the full interaction chain is the offline fixture acceptance (scripts/verify-inbox-browser.mjs).',
      'Evidence is asserted only through the real [data-ciel-inbox-evidence] button and the real right-column body; with no records it is reported as skipped, never as passed.',
      'A skipped check is never a passed check; ok is true only when nothing failed.',
      'The app was reached only through the normal startup-token exchange read from the operator-supplied --startup-log; no cookie was fabricated and no credential was read. The token never appears in this report.',
      'Non-origin requests are aborted and counted, but the host server makes model calls from its own process, so this probe proves no user-triggered model turn (0 prompts), not that the server made none.',
    ],
  })
} catch (error) {
  const message = redact(String(error && error.message || error))
  failed.push({ name: 'fatal', error: message })
  await finish(owner, { ok: false, mode: 'live-readonly', url: entry.origin, checkoutVersion: version, passed, skipped, failed, error: message, pageErrors: errors, remoteErrors, screenshots, readOnly: true, promptsSubmitted: 0, intentsWritten: 0, blockedExternalRequests })
}
