#!/usr/bin/env node
// Independent native-Chromium acceptance for the current-session 夏尔收件箱.
//
// The GENERATED production plugin/client.js is injected verbatim and bundled
// next to the isolated checkout's REAL client services: SlotTestRuntime (real
// Cordis Context + SlotRegistry + UI renderer), the real ui-sidebar global
// panel shell (sidebar.panellist + sidebar.main), ui-sidebar-right, resources,
// locale, dockkit, native primitives, React 18, and the real Lexical
// SessionInputShell. Only the Host data RPC (inboxList/inboxSetIntent and the
// pre-existing advisorReview surface), the layout panel-selection face, the
// settings scope, and the composer sink are fixtures.
//
// This is FIXTURE acceptance, never a claim about the live GUI: no server, no
// DSH_HOME, no model call, no external network request (every request is
// aborted and counted). scripts/verify-inbox-live.mjs is the separate,
// read-only live probe.
//
// Run:
//   DSH_CHECKOUT=/path/to/deepseek-harness node scripts/verify-inbox-browser.mjs
//   DSH_CHECKOUT=... node scripts/verify-inbox-browser.mjs --probe   # structure dump only
// Env:
//   DSH_CHECKOUT              isolated built checkout (required, no default)
//   CIEL_REPORT_DIR           artifact dir (default <ciel repo>/.artifacts)
//   CIEL_EXPECT_DSH_VERSION   assert the checkout version (optional)
//   CIEL_ALLOW_STALE=1        downgrade a stale generated client.js to a warning
//   CIEL_CHROME_PATH / CIEL_WINDOWS_CHROME  browser selection (via browser-launch)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchOwnedBrowser } from './browser-launch.mjs'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must explicitly name the isolated verification target')
if (!existsSync(join(checkout, 'package.json'))) throw new Error('DSH_CHECKOUT is not a built checkout: ' + checkout)
const cielRoot = fileURLToPath(new URL('..', import.meta.url))
const reportDir = process.env.CIEL_REPORT_DIR || join(cielRoot, '.artifacts')
mkdirSync(reportDir, { recursive: true })
const targetVersion = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version
if (process.env.CIEL_EXPECT_DSH_VERSION !== undefined) {
  assert.equal(targetVersion, process.env.CIEL_EXPECT_DSH_VERSION, 'DSH_CHECKOUT version does not match CIEL_EXPECT_DSH_VERSION')
}
const probeOnly = process.argv.includes('--probe')
const buildOnly = process.argv.includes('--build-only')
const allowStale = process.env.CIEL_ALLOW_STALE === '1'

// ── JSONC: strip comments/trailing commas without touching string bodies ─────
function stripJsonComments(text) {
  let out = '', index = 0, inString = false, inLine = false, inBlock = false
  while (index < text.length) {
    const char = text[index], next = text[index + 1]
    if (inLine) { if (char === '\n') { inLine = false; out += char } index += 1; continue }
    if (inBlock) { if (char === '*' && next === '/') { inBlock = false; index += 2 } else index += 1; continue }
    if (inString) { out += char; if (char === '\\') { out += next; index += 2; continue } if (char === '"') inString = false; index += 1; continue }
    if (char === '"') { inString = true; out += char; index += 1; continue }
    if (char === '/' && next === '/') { inLine = true; index += 2; continue }
    if (char === '/' && next === '*') { inBlock = true; index += 2; continue }
    out += char; index += 1
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
function loadTsPaths() {
  const config = JSON.parse(stripJsonComments(readFileSync(join(checkout, 'tsconfig.base.json'), 'utf8')))
  const paths = config?.compilerOptions?.paths || {}
  return Object.entries(paths).map(([key, targets]) => ({ key, target: targets[0] }))
}
function resolveTarget(target) {
  const absolute = resolve(checkout, target)
  try {
    if (statSync(absolute).isDirectory()) {
      for (const candidate of ['index.ts', 'index.tsx', 'index.js']) {
        if (existsSync(join(absolute, candidate))) return join(absolute, candidate)
      }
    }
  } catch { /* fall through to the raw path */ }
  return absolute
}
function tsPathsPlugin(entries) {
  const ordered = [...entries].sort((a, b) => b.key.replace('*', '').length - a.key.replace('*', '').length)
  return {
    name: 'ciel-tsconfig-paths',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
        for (const entry of ordered) {
          if (!entry.key.includes('*')) {
            if (args.path === entry.key) return { path: resolveTarget(entry.target) }
            continue
          }
          const [prefix, suffix] = entry.key.split('*')
          if (!args.path.startsWith(prefix) || !args.path.endsWith(suffix)) continue
          const matched = args.path.slice(prefix.length, suffix.length === 0 ? undefined : args.path.length - suffix.length)
          return { path: resolveTarget(entry.target.replace('*', matched)) }
        }
        return undefined
      })
    },
  }
}

const FIXTURES = {
  '@fixture/test-runtime': 'packages/test-support/client-runtime/src/index.ts',
  '@fixture/resources': 'packages/client/resources/src/client/index.ts',
  '@fixture/sidebar-right': 'packages/client/ui-sidebar-right/src/client/index.ts',
  '@fixture/ui-sidebar': 'packages/client/ui-sidebar/src/client/index.ts',
  '@fixture/locale': 'packages/client/locale/src/client/index.ts',
  '@fixture/common-locale': 'packages/client/locale/src/locales/index.ts',
  '@fixture/tag': 'packages/client/ui-primitives/src/Tag.tsx',
  '@fixture/button': 'packages/client/ui-primitives/src/Button.tsx',
  '@fixture/switch': 'packages/client/ui-primitives/src/Switch.tsx',
  '@fixture/input-shell': 'packages/client/ui-conversation/src/client/input/facade.ts',
  '@fixture/dockkit': 'packages/client/ui-dockkit/src/index.ts',
  '@fixture/document-definition': 'packages/client/ui-sidebar-documentpreview/src/client/definition.ts',
}
async function bundleFixture() {
  const alias = {}
  for (const [key, relative] of Object.entries(FIXTURES)) alias[key] = join(checkout, relative)
  alias['vitest'] = join(cielRoot, 'scripts/fixtures/vitest-shim.js')
  const result = await build({
    absWorkingDir: checkout,
    entryPoints: [join(cielRoot, 'scripts/fixtures/inbox-browser-entry.js')],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    outdir: join(reportDir, 'fixture-build'),
    charset: 'utf8', jsx: 'automatic', jsxImportSource: 'react', legalComments: 'none', minify: false,
    // The real ui-sidebar SidebarRoot reads process.env.DSH_CLIENT_* for its
    // brand row; a browser realm has no process, so the fixture bundle must
    // erase those reads (NODE_ENV keeps React's development build).
    define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.DSH_CLIENT_VERSION': 'undefined',
      'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined',
      'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined',
      global: 'globalThis',
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.gif': 'dataurl' },
    alias,
    nodePaths: [join(checkout, 'node_modules'), join(checkout, 'apps/web/node_modules')],
    plugins: [
      tsPathsPlugin(loadTsPaths()),
      {
        name: 'ciel-real-css',
        setup(build) {
          build.onLoad({ filter: /\.module\.css$/ }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'local-css' }))
          build.onLoad({ filter: /\.css$/ }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'css' }))
        },
      },
    ],
  })
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))
  const css = result.outputFiles.filter((file) => file.path.endsWith('.css')).map((file) => file.text).join('\n')
  if (js === undefined) throw new Error('fixture bundle produced no JS output')
  return { js: js.text, css }
}
/** Rebuild plugin/src/client.js in memory and compare with the generated artifact. */
async function generatedClientFreshness() {
  const result = await build({
    absWorkingDir: cielRoot,
    entryPoints: ['plugin/src/client.js'],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false,
    charset: 'utf8', loader: { '.css': 'text' }, legalComments: 'none', minify: false,
  })
  const expected = result.outputFiles[0].text
  const actual = readFileSync(join(cielRoot, 'plugin/client.js'), 'utf8')
  const withoutHeader = actual.slice(actual.indexOf('\n') + 1)
  return { fresh: withoutHeader === expected, sourceBytes: Buffer.byteLength(expected), generatedBytes: Buffer.byteLength(actual) }
}

const results = []
const record = (name, detail) => { results.push({ name, ...(detail === undefined ? {} : { detail }) }); console.log('  ok -', name, detail === undefined ? '' : JSON.stringify(detail)) }
const screenshots = []
async function screenshot(page, name) {
  const path = join(reportDir, 'inbox-browser-' + name + '.png')
  await page.screenshot({ path, fullPage: false })
  screenshots.push(path)
  return path
}

// Candidate labels are deliberately bilingual and are the ONE adaptation point
// if the shipped copy differs; the RPC contract is asserted independently.
// Only the shell-independent fallback remains: every UI assertion below uses the
// exact producer-side data hooks from plugin/src/inbox.js (see SEL).
const LABELS = { panel: ['夏尔收件箱', '收件箱'] }
// Exact producer-side contract from plugin/src/inbox.js (classes + data hooks).
const SEL = {
  root: '[data-ciel-inbox]',
  title: '[data-ciel-inbox-title]',
  session: '[data-ciel-inbox-session]',
  refresh: '[data-ciel-inbox-refresh]',
  next: '[data-ciel-inbox-next]',
  prev: '[data-ciel-inbox-prev]',
  page: '[data-ciel-inbox-page]',
  pageinfo: '[data-ciel-inbox-pageinfo]',
  filter: (id) => '[data-ciel-inbox-filter="' + id + '"]',
  error: '[data-ciel-inbox-error]',
  list: '[data-ciel-inbox-list]',
  review: (id) => '[data-ciel-inbox-review="' + id + '"]',
  reviewId: '[data-ciel-inbox-review-id]',
  summary: '[data-ciel-inbox-summary]',
  annotation: (reviewId, index) => '[data-ciel-inbox-review="' + reviewId + '"] [data-ciel-inbox-annotation="' + index + '"]',
  intent: (intent) => 'button[data-ciel-intent="' + intent + '"]',
  writeErrorConflict: '[data-ciel-inbox-write-error="conflict"]',
  writeErrorAny: '[data-ciel-inbox-write-error]',
  evidence: (id) => '[data-ciel-inbox-evidence="' + id + '"]',
  locate: (id) => '[data-ciel-inbox-locate="' + id + '"]',
  locateOk: '[data-ciel-inbox-locate-ok]',
  locateErr: '[data-ciel-inbox-locate-error]',
  icon: '[data-ciel-inbox-icon]',
  noAnnotations: '[data-ciel-inbox-no-annotations]',
}

async function main() {
  console.log('DSH checkout:', checkout, targetVersion, '| report dir:', reportDir)
  const fixtureBundle = await bundleFixture()
  const clientSource = readFileSync(join(cielRoot, 'plugin/client.js'), 'utf8')
  const themeCss = ['packages/client/ui-theme/src/styles/design-platform.css', 'packages/client/web/src/base.css']
    .map((relative) => readFileSync(join(checkout, relative), 'utf8')).join('\n')
  const externalCss = [...fixtureBundle.css.matchAll(/url\(\s*['"]?(https?:)?\/\//g)].length
  if (process.env.CIEL_FIXTURE_OUT) {
    // Reuse the exact bundle outside Chromium (e.g. a JSDOM smoke); never written unless asked.
    const out = resolve(process.env.CIEL_FIXTURE_OUT)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'inbox-fixture.js'), fixtureBundle.js)
    writeFileSync(join(out, 'inbox-fixture.css'), fixtureBundle.css)
  }
  console.log('fixture js bytes:', Buffer.byteLength(fixtureBundle.js), 'fixture css bytes:', Buffer.byteLength(fixtureBundle.css), 'client.js bytes:', Buffer.byteLength(clientSource), 'external css urls:', externalCss)
  assert.equal(externalCss, 0, 'bundled native CSS must not reference external URLs')
  const freshness = await generatedClientFreshness()
  console.log('generated client.js fresh:', freshness.fresh)
  if (buildOnly) {
    const report = {
      passed: true, mode: 'build-only', targetVersion, generatedClientFresh: freshness.fresh,
      fixtureJsBytes: Buffer.byteLength(fixtureBundle.js), fixtureCssBytes: Buffer.byteLength(fixtureBundle.css),
      clientBytes: Buffer.byteLength(clientSource), externalCssUrls: externalCss,
      browserLaunched: false, checks: [{ name: 'fixture-bundle-built', status: 'passed' }, { name: 'generated-client-fresh', status: freshness.fresh ? 'passed' : 'stale' }],
      boundaries: ['build-only: no browser was launched and no runtime assertion ran; run without --build-only for the native-browser acceptance.'],
    }
    writeFileSync(join(reportDir, 'inbox-browser-verify.json'), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(reportDir, 'inbox-browser-verify.log'), 'build-only ' + (freshness.fresh ? 'fresh' : 'stale') + '\n')
    console.log(JSON.stringify({ mode: 'build-only', generatedClientFresh: freshness.fresh, fixtureJsBytes: report.fixtureJsBytes }))
    return
  }

  let owner
  try {
    owner = await launchOwnedBrowser(checkout)
  } catch (error) {
    const message = String(error && error.message || error)
    const report = {
      passed: false, mode: 'browser-unavailable', targetVersion,
      generatedClientFresh: freshness.fresh, error: message, browserLaunched: false,
      boundaries: ['No isolated Chromium was available; the runner did not install one, change the sandbox, or attach to a user profile. Run scripts/verify-inbox-live.mjs or provision a browser through the owning agent.'],
    }
    writeFileSync(join(reportDir, 'inbox-browser-verify.json'), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(reportDir, 'inbox-browser-verify.log'), 'browser-unavailable ' + message + '\n')
    console.error(JSON.stringify(report))
    process.exitCode = 1
    return
  }
  const { browser, kind } = owner
  let networkRequests = 0
  const pageErrors = []
  const consoleErrors = []
  const actWarnings = []
  const failures = []
  const checks = []
  let page
  let probe
  let report = { passed: false, targetVersion, browser: kind, status: 'running' }
  writeFileSync(join(reportDir, 'inbox-browser-verify.json'), JSON.stringify(report, null, 2))

  const step = async (name, fn, requires = []) => {
    if (requires.some((required) => failures.some((failure) => failure.name === required))) {
      checks.push({ name, status: 'skipped', reason: 'prerequisite failed' })
      console.log('  skip -', name)
      return undefined
    }
    try {
      const detail = await fn()
      checks.push({ name, status: 'passed', ...(detail === undefined ? {} : { detail }) })
      if (probeOnly === false) console.log('  ok -', name, detail === undefined ? '' : JSON.stringify(detail))
      return detail
    } catch (error) {
      const message = String(error && error.message || error)
      failures.push({ name, error: message })
      checks.push({ name, status: 'failed', error: message })
      console.error('  FAIL -', name, message)
      // Every failure captures its own diagnostic screenshot; a screenshot
      // failure must never mask the recorded failure.
      try {
        if (page !== undefined) {
          const safe = String(name).replace(/[^a-z0-9-]+/gi, '_').slice(0, 60)
          const path = join(reportDir, 'inbox-browser-fail-' + checks.length + '-' + safe + '.png')
          await page.screenshot({ path, fullPage: false })
          screenshots.push(path)
        }
      } catch { /* diagnostic only */ }
      return undefined
    }
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN' })
    await context.route('**/*', (route) => { networkRequests += 1; return route.abort() })
    page = await context.newPage()
    page.on('pageerror', (error) => { pageErrors.push(error.message); console.error('pageerror:', error.message) })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      // Real pointer/keyboard events run outside React act; those warnings are
      // harness noise, not business errors.
      if (/not wrapped in act\(/.test(text)) { actWarnings.push(text); return }
      consoleErrors.push(text); console.error('console.error:', text)
    })
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>Ciel inbox browser verification</title><style>html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style></head><body><div id="ciel-chat-shell"><div id="ciel-chat-scroll" style="height:220px;overflow:auto"><div style="height:1400px"></div><div data-fixture-chat-root=""><div data-fixture-turn=""><div data-fixture-message-body="" data-ciel-session-id="s-a" data-ciel-message-id="m-a"><p data-fixture-block="b1">草稿声称 42 行，但实际文件只有 3 行；这里补足足够长的正文文本，让原文定位有可命中的锚点。</p><p data-fixture-block="b2">第二段正文用于让候选块与块地图按类型对齐。</p></div><div data-fixture-message-actions="" id="ciel-button-host"></div><span data-ciel-session-id="s-b" data-ciel-message-id="m-b"></span></div></div><div style="height:1400px"></div></div></div></body></html>`)
    await page.addStyleTag({ content: themeCss })
    await page.addStyleTag({ content: fixtureBundle.css })
    await page.addScriptTag({ content: fixtureBundle.js })
    await page.addScriptTag({ content: clientSource })
    await page.waitForFunction(() => window.__cielReady === true, null, { timeout: 20000 })

    const call = (id, method, args) => page.evaluate(([handle, name, payload]) => window.__cielInbox.call(handle, name, payload), [id, method, args === undefined ? {} : args])
    const waitFor = async (fn, timeout = 8000, message = 'condition') => {
      const deadline = Date.now() + timeout
      for (;;) {
        try { if (await fn()) return true } catch { /* keep polling */ }
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + message)
        await page.waitForTimeout(60)
      }
    }

    const boot = await page.evaluate(() => window.__cielInbox.boot({ sessions: ['s-a', 's-b', 's-page'] }))
    const handle = boot.id
    // The controller keeps the page-local filter across sessions and remounts,
    // so a step that needs the whole page restores it explicitly.
    const ensureAllFilter = async () => {
      if ((await call(handle, 'has', { selector: SEL.root })) === false) return
      if ((await call(handle, 'count', { selector: SEL.filter('all') + '.is-active' })) === 0) {
        await call(handle, 'click', { selector: SEL.filter('all') })
        await page.waitForTimeout(120)
      }
    }
    // Gestures may deliberately return to the conversation (evidence/review open,
    // locate); re-open the inbox panel whenever a step needs it.
    const ensureInbox = async () => {
      if ((await call(handle, 'has', { selector: SEL.root })) === false) await call(handle, 'clickPanel', { label: LABELS.panel[0] })
      await waitFor(async () => await call(handle, 'has', { selector: SEL.root }), 8000, 'inbox panel mounted')
      await ensureAllFilter()
    }
    console.log('boot:', JSON.stringify({ panelEntries: boot.panelEntries, mainEntries: boot.mainEntries, remoteMethods: boot.remoteMethods }))

    if (probeOnly) {
      probe = await call(handle, 'probe')
      writeFileSync(join(reportDir, 'inbox-browser-probe.json'), JSON.stringify({ boot, probe }, null, 2))
      await screenshot(page, '00-probe')
      report = { passed: true, mode: 'probe', targetVersion, browser: kind, boot, networkRequests, pageErrors, consoleErrors, screenshots, generatedClientFresh: freshness.fresh }
      return
    }

    let inboxId
    await step('generated-client-fresh', async () => {
      if (!freshness.fresh && !allowStale) throw new Error('plugin/client.js is stale relative to plugin/src/client.js; rebuild (pnpm build:client) or set CIEL_ALLOW_STALE=1')
      return freshness
    })
    await step('remote-declares-inbox-methods', async () => {
      assert.ok(boot.remoteMethods.includes('inboxList'), 'advisorReview does not declare inboxList: ' + JSON.stringify(boot.remoteMethods))
      assert.ok(boot.remoteMethods.includes('inboxSetIntent'), 'advisorReview does not declare inboxSetIntent: ' + JSON.stringify(boot.remoteMethods))
      return boot.remoteMethods.length
    })
    await step('sidebar-panellist-and-main-share-the-inbox-id', async () => {
      const entries = await call(handle, 'panelEntries')
      const entry = entries.find((item) => item.label !== null && LABELS.panel.some((label) => String(item.label).includes(label)))
        || entries.find((item) => item.id !== null && String(item.id).toLowerCase().includes('inbox'))
      assert.ok(entry, 'no sidebar.panellist entry labelled 夏尔收件箱 (entries: ' + JSON.stringify(entries) + ')')
      assert.equal(entry.id, 'dsh-ciel/inbox', 'INBOX_PANEL_ID drifted: ' + String(entry.id))
      assert.equal(entry.order, 40, 'INBOX_PANEL_ORDER drifted: ' + String(entry.order))
      const mains = await call(handle, 'mainEntries')
      assert.ok(mains.includes(entry.id), 'main keyed keys do not include the panellist id ' + entry.id + ': ' + JSON.stringify(mains))
      inboxId = entry.id
      return { id: inboxId, label: entry.label, order: entry.order, mains }
    }, ['remote-declares-inbox-methods'])
    await step('entry-opens-current-session-inbox', async () => {
      const opened = await call(handle, 'clickPanel', { label: LABELS.panel[0] })
      assert.equal(opened.active, inboxId, 'selecting the panel row did not activate ' + inboxId)
      await waitFor(async () => await call(handle, 'attr', { selector: SEL.root, attr: 'data-ciel-inbox-state' }) === 'ready', 8000, 's-a inbox page ready')
      assert.equal(await call(handle, 'textOf', { selector: SEL.title }), '夏尔收件箱')
      const ids = await call(handle, 'texts', { selector: SEL.reviewId })
      assert.deepEqual(ids, ['r-a1', 'r-a2', 'r-a3', 'r-a4'], 'the current session page must list every review: ' + JSON.stringify(ids))
      assert.equal(await call(handle, 'textOf', { selector: SEL.pageinfo }), '本页 4 条 · 批注 4 条')
      assert.equal(await call(handle, 'count', { selector: SEL.icon }), 1, 'the sidebar entry must render its glyph')
      const calls = await call(handle, 'rpcCalls', { method: 'inboxList' })
      assert.ok(calls.some((entry) => entry.request && entry.request.sessionId === 's-a' && entry.request.limit === 25), 'inboxList was not called with the current session and the 25 page size: ' + JSON.stringify(calls))
      return { ids, label: '夏尔收件箱' }
    }, ['sidebar-panellist-and-main-share-the-inbox-id'])
    await step('current-session-filter', async () => {
      await call(handle, 'setCurrent', { sessionId: 's-b' })
      await waitFor(async () => await call(handle, 'attr', { selector: SEL.root, attr: 'data-ciel-inbox-state' }) === 'ready', 8000, 's-b inbox page')
      const ids = await call(handle, 'texts', { selector: SEL.reviewId })
      assert.deepEqual(ids, ['r-b1'], 'switching to s-b must re-scope the page: ' + JSON.stringify(ids))
      const calls = await call(handle, 'rpcCalls', { method: 'inboxList' })
      assert.ok(calls.some((entry) => entry.request && entry.request.sessionId === 's-b' && entry.request.cursor === undefined), 'no first-page read for s-b')
      await call(handle, 'setCurrent', { sessionId: 's-a' })
      await waitFor(async () => (await call(handle, 'texts', { selector: SEL.reviewId })).includes('r-a1'), 8000, 's-a re-scope')
      return { sB: ids }
    }, ['entry-opens-current-session-inbox'])
    await step('page-local-filter-and-count', async () => {
      // Real filter semantics (plugin/src/inbox.js filterReviews): an intent
      // filter keeps every non-complete group (incomplete/failed/cancelled), so
      // only the completed r-a1 drops out. A failure restores "all" in finally so
      // one bad assertion cannot cascade into the later pagination/intent steps.
      try {
        await call(handle, 'click', { selector: SEL.filter('planned') })
        await waitFor(async () => await call(handle, 'count', { selector: SEL.review('r-a1') }) === 0, 4000, 'planned filter drops the completed review')
        const ids = await call(handle, 'texts', { selector: SEL.reviewId })
        assert.deepEqual(ids, ['r-a2', 'r-a3', 'r-a4'], 'incomplete/failed/cancelled groups must survive every intent filter: ' + JSON.stringify(ids))
        assert.equal(await call(handle, 'count', { selector: SEL.review('r-a3') + ' ' + SEL.noAnnotations }), 1, 'the failed zero-annotation group stays visible')
        assert.equal(await call(handle, 'count', { selector: SEL.review('r-a4') + ' ' + SEL.noAnnotations }), 1, 'the cancelled zero-annotation group stays visible')
        assert.equal(await call(handle, 'attr', { selector: SEL.filter('planned'), attr: 'aria-pressed' }), 'true')
        assert.equal(await call(handle, 'textOf', { selector: SEL.filter('planned') }), '准备处理 3', 'the filter button carries its own retained-page count')
        assert.equal(await call(handle, 'textOf', { selector: SEL.pageinfo }), '本页 4 条 · 批注 4 条', 'pageinfo counts the loaded page, not the filtered view')
        return { ids, plannedCount: '准备处理 3' }
      } finally {
        try {
          await ensureAllFilter()
          await waitFor(async () => await call(handle, 'count', { selector: SEL.review('r-a1') }) === 1, 8000, 'all filter restored')
        } catch (restoreError) {
          console.error('  warn - filter restore failed:', String(restoreError && restoreError.message || restoreError))
        }
      }
    }, ['current-session-filter'])
    await step('pagination-cursor-and-page-index', async () => {
      await call(handle, 'setCurrent', { sessionId: 's-page' })
      await ensureInbox()
      await waitFor(async () => await call(handle, 'attr', { selector: SEL.root, attr: 'data-ciel-inbox-state' }) === 'ready' && await call(handle, 'count', { selector: SEL.list + ' > li' }) === 25, 8000, 's-page first page (25)')
      assert.equal(await call(handle, 'textOf', { selector: SEL.page }), '第 1 页')
      assert.equal(await call(handle, 'attr', { selector: SEL.next, attr: 'disabled' }), null, 'next must stay enabled while a cursor remains')
      await call(handle, 'click', { selector: SEL.next })
      await waitFor(async () => await call(handle, 'textOf', { selector: SEL.page }) === '第 2 页', 8000, 'second page')
      const secondIds = await call(handle, 'texts', { selector: SEL.reviewId })
      assert.deepEqual(secondIds, ['r-p26', 'r-p27'], 'the second page must hold the remaining two reviews: ' + JSON.stringify(secondIds))
      assert.equal(await call(handle, 'attr', { selector: SEL.next, attr: 'disabled' }), '', 'next must be disabled on the last page')
      const pageCalls = (await call(handle, 'rpcCalls', { method: 'inboxList' })).filter((entry) => entry.request && entry.request.sessionId === 's-page')
      assert.ok(pageCalls.some((entry) => entry.request.cursor === 'page:25'), 'the follow-up read did not echo the returned cursor: ' + JSON.stringify(pageCalls.map((c) => c.request)))
      await call(handle, 'click', { selector: SEL.prev })
      await waitFor(async () => await call(handle, 'textOf', { selector: SEL.page }) === '第 1 页', 8000, 'back to the first page')
      assert.equal(await call(handle, 'count', { selector: SEL.list + ' > li' }), 25)
      return { pageCalls: pageCalls.map((entry) => entry.request) }
    }, ['entry-opens-current-session-inbox'])
    await step('failure-retains-previous-page', async () => {
      // A session switch resets the controller page, so the retention contract
      // is exercised on a NON-reset read: a failed next-page load keeps page 1.
      await call(handle, 'setCurrent', { sessionId: 's-page' })
      await waitFor(async () => await call(handle, 'textOf', { selector: SEL.page }) === '第 1 页' && await call(handle, 'count', { selector: SEL.list + ' > li' }) === 25, 8000, 's-page first page')
      await call(handle, 'fixture', { state: { listFail: true } })
      await call(handle, 'click', { selector: SEL.next })
      await waitFor(async () => await call(handle, 'has', { selector: SEL.error }), 8000, 'inbox failure banner')
      const banner = await call(handle, 'textOf', { selector: SEL.error })
      assert.match(banner, /本页读取失败/)
      assert.match(banner, /store_error/)
      assert.equal(await call(handle, 'count', { selector: SEL.list + ' > li' }), 25, 'a failed next-page read must retain the previous page')
      assert.equal(await call(handle, 'count', { selector: SEL.review('r-p01') }), 1, 'page 1 rows must survive the failed load')
      await call(handle, 'fixture', { state: { listFail: false } })
      await call(handle, 'click', { selector: SEL.refresh })
      await waitFor(async () => await call(handle, 'count', { selector: SEL.list + ' > li' }) === 25 && !(await call(handle, 'has', { selector: SEL.error })), 8000, 'refresh recovery')
      // An explicit reset refresh surfaces the failure and recovers next time.
      await call(handle, 'fixture', { state: { listFail: true } })
      await call(handle, 'click', { selector: SEL.refresh })
      await waitFor(async () => await call(handle, 'has', { selector: SEL.error }), 8000, 'refresh failure banner')
      const refreshBanner = await call(handle, 'textOf', { selector: SEL.error })
      assert.match(refreshBanner, /store_error/)
      await call(handle, 'fixture', { state: { listFail: false } })
      await call(handle, 'click', { selector: SEL.refresh })
      await waitFor(async () => await call(handle, 'count', { selector: SEL.list + ' > li' }) === 25, 8000, 'post-failure recovery')
      return { retainedRows: 25, banner, refreshBanner }
    }, ['pagination-cursor-and-page-index'])
    await step('intent-write-and-revision-conflict', async () => {
      await call(handle, 'fixture', { state: { listFail: false, intentConflict: false, writeFail: false } })
      await call(handle, 'setCurrent', { sessionId: 's-a' })
      await ensureInbox()
      await waitFor(async () => await call(handle, 'attr', { selector: SEL.root, attr: 'data-ciel-inbox-state' }) === 'ready' && await call(handle, 'count', { selector: SEL.review('r-a1') }) === 1, 8000, 's-a inbox page')
      assert.equal(await call(handle, 'count', { selector: SEL.root + ' [data-ciel-select]' }), 0, 'the inbox must not reuse the legacy checkbox control')
      await call(handle, 'clearRpcCalls')
      const cell = SEL.annotation('r-a1', '0')
      await call(handle, 'click', { selector: cell + ' ' + SEL.intent('planned') })
      await waitFor(async () => (await call(handle, 'rpcCalls', { method: 'inboxSetIntent' })).length === 1, 4000, 'intent write')
      const writes = await call(handle, 'rpcCalls', { method: 'inboxSetIntent' })
      const request = writes[0].request
      assert.equal(request.sessionId, 's-a')
      assert.equal(request.reviewId, 'r-a1')
      assert.match(String(request.reviewFingerprint), /^[0-9a-f]{64}$/)
      assert.equal(request.expectedRevision, 0)
      assert.equal(request.index, 0)
      assert.equal(request.intent, 'planned')
      assert.deepEqual(Object.keys(request).sort(), ['expectedRevision', 'index', 'intent', 'reviewFingerprint', 'reviewId', 'sessionId'], 'intent writes must not carry the legacy checkbox payload')
      await waitFor(async () => await call(handle, 'attr', { selector: cell + ' ' + SEL.intent('planned'), attr: 'aria-pressed' }) === 'true', 4000, 'planned adopted from the server response')
      assert.equal(await call(handle, 'count', { selector: cell + ' .is-active' }), 1, 'exactly one intent may be active')
      await call(handle, 'fixture', { state: { intentConflict: true } })
      await call(handle, 'click', { selector: cell + ' ' + SEL.intent('rejected') })
      await waitFor(async () => await call(handle, 'has', { selector: SEL.writeErrorConflict }), 8000, 'revision-conflict notice')
      const conflictText = await call(handle, 'textOf', { selector: SEL.writeErrorConflict })
      assert.match(conflictText, /状态冲突/)
      assert.equal(await call(handle, 'attr', { selector: cell + ' ' + SEL.intent('planned'), attr: 'aria-pressed' }), 'true', 'a rejected write must not move the displayed intent')
      const afterConflict = await call(handle, 'rpcCalls', { method: 'inboxSetIntent' })
      assert.equal(afterConflict.length, 2, 'the conflict attempt is exactly the second write')
      assert.equal(afterConflict[1].request.expectedRevision, 1, 'the second write must fence on the revision returned by the first')
      assert.equal(afterConflict[1].request.intent, 'rejected')
      await call(handle, 'click', { selector: cell + ' ' + SEL.intent('pending') })
      await page.waitForTimeout(200)
      assert.equal((await call(handle, 'rpcCalls', { method: 'inboxSetIntent' })).length, 2, 'a conflicted cell must not issue further writes before refresh')
      await call(handle, 'fixture', { state: { intentConflict: false } })
      await call(handle, 'click', { selector: SEL.refresh })
      await waitFor(async () => !(await call(handle, 'has', { selector: SEL.writeErrorAny })), 8000, 'refresh clears the conflict')
      return { write: request, second: afterConflict[1].request, conflictText }
    }, ['entry-opens-current-session-inbox'])
    await step('locate-reveals-the-conversation-and-scrolls-the-real-anchor', async () => {
      await call(handle, 'fixture', { state: { listFail: false, intentConflict: false } })
      await call(handle, 'setCurrent', { sessionId: 's-a' })
      await ensureInbox()
      await waitFor(async () => await call(handle, 'count', { selector: SEL.review('r-a1') }) === 1, 8000, 's-a page')
      assert.equal(await call(handle, 'textOf', { selector: SEL.review('r-a1') + ' ' + SEL.summary }), 'A1 摘要：两处疑点待确认')
      await call(handle, 'setDraft', { text: '原稿保留-不动' })
      const scrollBefore = await call(handle, 'docScrollTop', { selector: '#ciel-chat-scroll' })
      await call(handle, 'click', { selector: SEL.locate('r-a1') })
      await waitFor(async () => (await call(handle, 'activePanel')) !== inboxId, 8000, 'locate reveals the conversation')
      assert.equal(await call(handle, 'docCount', { selector: '[data-ciel-session-id="s-a"][data-ciel-message-id="m-a"]' }), 1, 'the conversation must carry the exact Ciel anchor for the located message')
      // Real plugin scrolling: client.js does not inject scrollToAnchor, so this
      // observes inbox.js's own element.scrollIntoView fallback in a real browser.
      await waitFor(async () => (await call(handle, 'docScrollTop', { selector: '#ciel-chat-scroll' })) > scrollBefore, 8000, 'locate scrolls the conversation to the anchor')
      assert.equal(await call(handle, 'draft'), '原稿保留-不动', 'locate must never mutate the composer draft')
      await ensureInbox()
      return { scrollBefore, scrollAfter: await call(handle, 'docScrollTop', { selector: '#ciel-chat-scroll' }) }
    }, ['entry-opens-current-session-inbox'])
    await step('locate-failure-copy-survives-the-panel-remount', async () => {
      await ensureInbox()
      const removed = await call(handle, 'removeChatAnchor', { selector: '[data-ciel-session-id="s-a"][data-ciel-message-id="m-a"]' })
      assert.equal(removed.remaining, 0, 'the fixture anchor must be gone before the failure attempt')
      await call(handle, 'click', { selector: SEL.locate('r-a1') })
      await waitFor(async () => await call(handle, 'has', { selector: SEL.locateErr }), 15000, 'locate failure copy after the panel returns')
      const failure = await call(handle, 'textOf', { selector: SEL.locateErr })
      assert.match(String(failure), /未找到|无法定位/, 'the locate failure must name the miss: ' + String(failure))
      return { failure }
    }, ['locate-reveals-the-conversation-and-scrolls-the-real-anchor'])
    await step('right-column-evidence-and-review-open-without-draft-mutation', async () => {
      await ensureInbox()
      await call(handle, 'setDraft', { text: '原稿保留-不动' })
      // The evidence gesture returns to the conversation and opens the real right column.
      await call(handle, 'click', { selector: SEL.evidence('e1') })
      await waitFor(async () => (await call(handle, 'has', { selector: '[data-ciel-inbox-open-error]' })) || (await call(handle, 'text')).includes('line eleven'), 15000, 'evidence open attempt')
      const openError = await call(handle, 'textOf', { selector: '[data-ciel-inbox-open-error]' })
      assert.equal(openError, null, 'the inbox evidence button must open the native right column through the real sidebarRight service; got: ' + String(openError))
      assert.equal((await call(handle, 'text')).includes('line eleven'), true, 'the evidence body must render in the native right column')
      // 回到会话查看评审 opens the native review tab the same way.
      await ensureInbox()
      await call(handle, 'click', { selector: '[data-ciel-inbox-view-review="r-a1"]' })
      await waitFor(async () => (await call(handle, 'has', { selector: '[data-ciel-inbox-open-error]' })) || (await call(handle, 'text')).includes('行数不符'), 15000, 'review open attempt')
      assert.equal(await call(handle, 'textOf', { selector: '[data-ciel-inbox-open-error]' }), null, '回到会话查看评审 must open the native review tab')
      assert.equal(await call(handle, 'draft'), '原稿保留-不动', 'an inbox action must never mutate the composer draft')
      const methods = (await call(handle, 'rpcCalls')).map((entry) => entry.method)
      assert.equal(methods.includes('start'), false, 'the inbox must not start a model run')
      assert.equal(methods.includes('feedback'), false, 'the inbox must not write the legacy feedback WAL')
      assert.equal(methods.includes('prepareFeedback'), false, 'the inbox must not stage legacy feedback')
      await ensureInbox()
      return { evidence: true, review: true, methods: [...new Set(methods)] }
    }, ['locate-failure-copy-survives-the-panel-remount'])
    await step('narrow-viewport-no-horizontal-overflow', async () => {
      await ensureInbox()
      // Mirror the real frame on a global panel at a phone width: the left
      // sidebar collapses to its real 56px rail and the right column is gone
      // (RightbarRoot renders nothing for a global panel).
      await call(handle, 'setFrame', { sidebarWidth: 56, sidebarCollapsed: true, showRight: false })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(450)
      const box = await call(handle, 'bodyScrollWidthOf', { selector: SEL.root })
      assert.ok(box !== null, 'the inbox panel must exist')
      assert.ok(box.clientWidth >= 240, 'the fixture frame must hand the inbox a realistic phone column (rail sidebar, no right column): ' + JSON.stringify(box))
      assert.ok(box.scrollWidth <= box.clientWidth + 1, 'narrow inbox panel overflows horizontally: ' + JSON.stringify(box))
      await screenshot(page, '04-narrow-main')
      await call(handle, 'setFrame', { sidebarWidth: 300, sidebarCollapsed: false, showRight: true })
      await page.setViewportSize({ width: 1200, height: 900 })
      await page.waitForTimeout(450)
      return box
    }, ['entry-opens-current-session-inbox'])
    await step('keyboard-opens-the-panel', async () => {
      await call(handle, 'selectPanel', { id: null })
      // Leave React act for real browser keyboard events, then restore it.
      await page.evaluate(() => { window.IS_REACT_ACT_ENVIRONMENT = false })
      const row = page.getByRole('button', { name: LABELS.panel[0], exact: true }).first()
      await row.focus()
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      const active = await call(handle, 'activePanel')
      await page.evaluate(() => { window.IS_REACT_ACT_ENVIRONMENT = true })
      assert.equal(active, inboxId, 'Enter on the focused sidebar row did not open the inbox panel')
      return { active }
    }, ['entry-opens-current-session-inbox'])

    await step('zero-model-calls-and-zero-network', async () => {
      const state = await call(handle, 'fixture', {})
      assert.equal(state.modelCalls, 0, 'a model call was attempted')
      assert.equal(networkRequests, 0, 'a network request was attempted')
      assert.deepEqual(pageErrors, [], 'page errors must be zero')
      return { modelCalls: state.modelCalls, networkRequests, intentWrites: state.intentWrites }
    })
    await step('record-final-screenshot', async () => {
      await call(handle, 'setCurrent', { sessionId: 's-a' })
      await call(handle, 'selectPanel', { id: inboxId })
      await ensureInbox()
      await waitFor(async () => await call(handle, 'count', { selector: SEL.review('r-a1') }) === 1, 8000, 'final inbox page')
      await screenshot(page, '05-inbox-final')
      return screenshots.length
    })

    report = {
      passed: failures.length === 0,
      mode: 'strict',
      targetVersion,
      browser: kind,
      generatedClientFresh: freshness.fresh,
      fixtureJsBytes: Buffer.byteLength(fixtureBundle.js),
      fixtureCssBytes: Buffer.byteLength(fixtureBundle.css),
      clientBytes: Buffer.byteLength(clientSource),
      networkRequests,
      modelCalls: 0,
      pageErrors,
      consoleErrors,
      actWarnings,
      screenshots,
      checks,
      failures,
      results,
      realVsFixture: {
        real: [
          'generated plugin/client.js (the artifact under acceptance)',
          'ui-sidebar SidebarRoot shell + sidebar.panellist list and keyed main seat: the panel row, its aria-label/aria-current and the keyed body swap',
          'the production inbox module (plugin/src/inbox.js): controller, page-local filters/counts, cursor pagination, intent CAS UI, locate',
          'ui-sidebar-right and the right-column evidence tab, resources, dockkit, React 18, native primitives, the real Lexical SessionInputShell',
        ],
        fixture: [
          'Host data RPC: inboxList/inboxSetIntent and the pre-existing advisorReview methods (mirrors plugin/inbox-service.js with an opaque fake 64-hex fingerprint)',
          'ctx.layout panel selection (selectPanel/toggleSidebar/openRightbar/closeRightbar) is a stub that only writes panelInfo',
          'uiWorkspace.startSession, the settings scope, the composer sink',
          'the chat shell that carries the Ciel anchor attributes (marked data-fixture-*)',
        ],
      },
      boundaries: [
        'FIXTURE acceptance, not the live GUI. The inbox UI, the native shell and the slot contract are the real implementations; the Host RPC, layout selection face, settings scope, composer sink and chat shell are fixtures.',
        'ctx.layout.selectPanel is a stub: the panel row, its aria-label/aria-current rendering and the keyed main swap are real, but the production layout service is NOT exercised here.',
        'The inbox RPC fixture mirrors plugin/inbox-service.js (25-item pages, opaque cursor, content fingerprint, revision CAS, underscore error codes) but uses an opaque fake 64-hex fingerprint; it proves the UI echoes fingerprint and revision back, not the host hash algorithm.',
        'Failure retention is asserted on a non-reset next-page failure (the path that keeps the previous page); an explicit reset refresh surfaces the error code and recovers on the next read.',
        'Intent writes must carry exactly {sessionId, reviewId, reviewFingerprint, expectedRevision, index, intent} - no legacy checkbox payload - and the inbox panel renders no [data-ciel-select] control.',
        'The sidebar entry renders a static glyph; the page count is asserted from [data-ciel-inbox-pageinfo] and the filter buttons, not from a badge.',
        'Gestures that return to the conversation (locate, and evidence/review open after the planned fix) are re-entered by re-opening the inbox panel; the script never treats the layout stub as a real navigation service.',
        'No real DSH_HOME, no server, no model call, and no external network request was made (every request is aborted and counted; modelCalls 0).',
        'If generatedClientFresh is false the tested artifact is stale relative to plugin/src/client.js; that is independently reported and (unless CIEL_ALLOW_STALE=1) fails the run.',
      ],
    }
  } catch (error) {
    failures.push({ name: 'fatal', error: String(error && error.message || error) })
    report = { passed: false, targetVersion, browser: kind, fatal: String(error && error.message || error), checks, failures, networkRequests, pageErrors, consoleErrors, actWarnings, screenshots }
    console.error('fatal:', error)
  } finally {
    await owner.close()
  }
  writeFileSync(join(reportDir, 'inbox-browser-verify.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(reportDir, 'inbox-browser-verify.log'), checks.map((entry) => entry.name + ' ' + entry.status + (entry.error === undefined ? '' : ' ' + entry.error)).join('\n') + '\n')
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, failures: failures.map((failure) => failure.name), screenshots, networkRequests, pageErrors: pageErrors.length }, null, 1))
  if (report.passed !== true) process.exitCode = 1
}

await main()
