#!/usr/bin/env node
// Real Chromium verification of the COMPLETE generated plugin/client.js.
//
// The production browser entry is injected verbatim (window.__ModuleLoader__
// factory), bundled next to the target checkout's REAL client services:
// SlotTestRuntime (Cordis Context + SlotRegistry + UI renderer), the resources
// and sidebar-right plugins, RightbarSeat/dockkit, React + native Tag/Button/
// Switch, and the real Lexical SessionInputShell. Only the Host data RPC, the
// settings-scope stub, and the composer sink are fixtures. No server, no model
// call, no external request, no real DSH_HOME.
//
// Run:
//   node scripts/verify-sidebar-browser.mjs
// Env: DSH_CHECKOUT, CIEL_CHROME_PATH (optional Linux Chromium),
//      CIEL_WINDOWS_CHROME (optional Windows chrome.exe for WSL/CDP).
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
const reportDir = process.env.CIEL_REPORT_DIR || join(cielRoot, '..', '.ciel-upgrade', 'reports')
mkdirSync(reportDir, { recursive: true })
const buildOnly = process.argv.includes('--build-only')
const targetVersion = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version

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
  '@fixture/locale': 'packages/client/locale/src/client/index.ts',
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
    entryPoints: [join(cielRoot, 'scripts/fixtures/sidebar-browser-entry.js')],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    // CSS imports need an output path even with write:false; the CSS lands in a
    // separate output file we inject as a real <style>.
    outdir: join(reportDir, 'fixture-build'),
    charset: 'utf8', jsx: 'automatic', jsxImportSource: 'react', legalComments: 'none', minify: false,
    // React's act() (used by the real SlotTestRuntime) requires the development
    // build; this is a test fixture bundle, never shipped.
    define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.gif': 'dataurl' },
    alias,
    nodePaths: [join(checkout, 'node_modules'), join(checkout, 'apps/web/node_modules')],
    plugins: [
      tsPathsPlugin(loadTsPaths()),
      {
        name: 'ciel-real-css',
        setup(build) {
          // Real CSS modules: local-css compiles the class-name mapping the
          // native components import; plain CSS is bundled as css. No stub and
          // no copied control styles.
          build.onLoad({ filter: /\.module\.css$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8'),
            loader: 'local-css',
          }))
          build.onLoad({ filter: /\.css$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8'),
            loader: 'css',
          }))
        },
      },
    ],
  })
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))
  const css = result.outputFiles.filter((file) => file.path.endsWith('.css')).map((file) => file.text).join('\n')
  if (js === undefined) throw new Error('fixture bundle produced no JS output')
  return { js: js.text, css }
}

// Browser ownership and profile cleanup are shared with the read-only GUI probe.

// ── scenario driver ──────────────────────────────────────────────────────────
const results = []
const record = (name, detail) => { results.push({ name, ...(detail === undefined ? {} : { detail }) }); console.log('  ok -', name, detail === undefined ? '' : JSON.stringify(detail)) }
const screenshot = async (page, name) => {
  const path = join(reportDir, 'sidebar-browser-' + name + '.png')
  await page.screenshot({ path, fullPage: false })
  return path
}

async function main() {
  const fixtureBundle = await bundleFixture()
  const clientSource = readFileSync(join(cielRoot, 'plugin/client.js'), 'utf8')
  const themeCss = ['packages/client/ui-theme/src/styles/design-platform.css', 'packages/client/web/src/base.css']
    .map((relative) => readFileSync(join(checkout, relative), 'utf8')).join('\n')
  const externalCss = [...fixtureBundle.css.matchAll(/url\(\s*['"]?(https?:)?\/\//g)].length
  console.log('fixture js bytes:', Buffer.byteLength(fixtureBundle.js), 'fixture css bytes:', Buffer.byteLength(fixtureBundle.css), 'theme css bytes:', Buffer.byteLength(themeCss), 'client.js bytes:', Buffer.byteLength(clientSource), 'external css urls:', externalCss)
  if (buildOnly) { console.log('build-only: fixture bundled successfully (real CSS modules)'); return }
  assert.equal(externalCss, 0, 'bundled native CSS must not reference external URLs')

  const owner = await launchOwnedBrowser(checkout)
  const { browser, kind } = owner
  let networkRequests = 0
  const pageErrors = []
  const consoleErrors = []
  const screenshots = []
  let report
  writeFileSync(join(reportDir, 'sidebar-browser-verify.json'), JSON.stringify({ passed: false, targetVersion, status: 'running' }))
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    await context.route('**/*', (route) => { networkRequests += 1; return route.abort() })
    const page = await context.newPage()
    page.on('pageerror', (error) => { pageErrors.push(error.message); console.error('pageerror:', error.message) })
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error') { consoleErrors.push(text); console.error('console.error:', text) }
    })
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><title>Ciel sidebar browser verification</title><style>html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style></head><body><div id="ciel-chat-shell"><div data-fixture-chat-root=""><div data-fixture-turn=""><div data-fixture-message-body=""></div><div data-fixture-message-actions="" id="ciel-button-host"></div></div></div></div></body></html>')
    await page.addStyleTag({ content: themeCss })
    await page.addStyleTag({ content: fixtureBundle.css })
    await page.addScriptTag({ content: fixtureBundle.js })
    await page.addScriptTag({ content: clientSource })
    await page.waitForFunction(() => window.__cielReady === true, null, { timeout: 15000 })

    const call = (id, method, args) => page.evaluate(([handle, name, payload]) => window.__cielBrowser.call(handle, name, payload), [id, method, args === undefined ? {} : args])

    // 1. production client.js apply(): sidebar + assistant-actions registration
    const boot = await page.evaluate(() => window.__cielBrowser.boot({ sessions: ['s-a', 's-b', 's-c'], width: 420 }))
    assert.deepEqual(boot.tabs, ['ciel-review', 'ciel-evidence', 'ciel-advice'], 'all three Ciel sidebar kinds installed')
    assert.ok(boot.buttonEntries.includes('advisor-review'), 'the production assistant-actions button registered')
    assert.ok(boot.panel, 'the real RightbarSeat rendered the panel')
    record('client.js factory apply installs sidebar + button', boot)
    const handle = boot.id

    // 2. review body through the real seat
    await call(handle, 'open', { kind: 'ciel-review', address: await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' }) })
    assert.match(await call(handle, 'text'), /A 会话的评审摘要/)
    assert.match(await call(handle, 'text'), /已查询 75 次 · 总时限 180 秒/)
    assert.match(await call(handle, 'text'), /A 批注：行数不符/)
    assert.equal(await call(handle, 'has', { selector: '[data-ciel-review="r-a"]' }), true)
    screenshots.push(await screenshot(page, '01-review'))
    record('review body renders through the real sidebar', { annotations: await call(handle, 'count', { selector: '[data-ciel-select]' }) })
    const evidenceAction = page.getByRole('button', { name: '查看证据 e1', exact: true })
    assert.equal(await evidenceAction.count(), 1, 'references say what clicking them will do')
    assert.ok((await evidenceAction.boundingBox()).height >= 36, 'sidebar evidence actions have a full-size hit area')
    assert.notEqual(await evidenceAction.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'evidence actions have a visible native fill')
    assert.equal(await page.locator('[data-ciel-submit]').isDisabled(), true, 'the emphasized input CTA still requires a selection')
    record('sidebar actions are filled and full-size; disabled semantics preserved')

    const rootReviewAddress = await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' })
    const beforeMainTabs = await call(handle, 'openTabIds', { sessionId: 's-a' })
    const beforeMainReads = (await call(handle, 'rpcCalls', { method: 'readReview' })).length
    await call(handle, 'setMainPanel', { id: 'fixture-global-panel' })
    assert.equal(await call(handle, 'has', { selector: '[data-sidebar-right-panel]' }), false)
    assert.equal(await call(handle, 'resourceStatus', { address: rootReviewAddress }), 'live')
    await call(handle, 'setMainPanel', { id: null })
    assert.equal(await call(handle, 'has', { selector: '[data-ciel-review="r-a"]' }), true)
    assert.deepEqual(await call(handle, 'openTabIds', { sessionId: 's-a' }), beforeMainTabs)
    assert.equal((await call(handle, 'rpcCalls', { method: 'readReview' })).length, beforeMainReads)
    record('global main panel hides Session content without losing pinned Ciel tabs')

    // 3. evidence snippet + current-file button
    await call(handle, 'open', { kind: 'ciel-evidence', address: await call(handle, 'evidenceAddress', { sessionId: 's-a', reviewId: 'r-a', evidenceId: 'e1' }) })
    assert.deepEqual(await call(handle, 'lineNumbers'), ['10', '11', '12'])
    assert.match(await call(handle, 'text'), /line eleven/)
    assert.equal(await call(handle, 'has', { selector: '[data-ciel-open-current]' }), true, 'trusted currentPath offers the current-file button')
    screenshots.push(await screenshot(page, '02-evidence'))
    record('evidence body: numbered snippet + current-file button')

    // 4. long line wraps in a narrow column (no horizontal overflow)
    await page.setViewportSize({ width: 480, height: 900 })
    await call(handle, 'open', { kind: 'ciel-evidence', address: await call(handle, 'evidenceAddress', { sessionId: 's-a', reviewId: 'r-a', evidenceId: 'e2' }) })
    assert.equal(await call(handle, 'computed', { selector: '[data-ciel-line-text]', prop: 'whiteSpace' }), 'pre-wrap')
    const overflow = await call(handle, 'bodyScrollWidthOf', { selector: '[data-ciel-line-text]' })
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, 'long line wraps instead of scrolling sideways: ' + JSON.stringify(overflow))
    screenshots.push(await screenshot(page, '03-evidence-narrow-long-line'))
    await page.setViewportSize({ width: 1200, height: 900 })
    record('narrow long-line wrap has no horizontal overflow', overflow)

    assert.equal(await call(handle, 'acceptsFileAddress', { address: 'dsh-resource://file/absolute/external/notes.md' }), false)
    for (const [name, sessionId, evidenceId, expectedAddress, line] of [
      ['external root', 's-a', 'e4', 'dsh-resource://file/session/s-a//external/notes%20%23%3F.md', '3'],
      ['unknown root and cross-session owner', 's-c', 'e5', 'dsh-resource://file/session/s-c//unknown/src/a.ts', '7'],
    ]) {
      await call(handle, 'open', { kind: 'ciel-evidence', address: await call(handle, 'evidenceAddress', { sessionId, reviewId: 'r-a', evidenceId }) })
      assert.equal(await call(handle, 'has', { selector: '[data-ciel-current-line-hint]' }), true)
      assert.match(await call(handle, 'text'), /Markdown 渲染视图请切换/)
      await call(handle, 'click', { selector: '[data-ciel-open-current]' })
      const files = await call(handle, 'fileTabs')
      assert.ok(files.some(tab => tab.address === expectedAddress && tab.line === line), 'prepared client preserves Session authority: ' + JSON.stringify(files))
      record('prepared bundle file navigation: ' + name, { address: expectedAddress, line })
    }

    // 4b. current-file / compare gesture carries the trusted path + line
    await call(handle, 'open', { kind: 'ciel-evidence', address: await call(handle, 'evidenceAddress', { sessionId: 's-a', reviewId: 'r-a', evidenceId: 'e1' }) })
    await call(handle, 'click', { selector: '[data-ciel-open-current]' })
    const fileTabs = await call(handle, 'fileTabs')
    assert.ok(fileTabs.some((tab) => tab.address === 'dsh-resource://file/session/s-a/src/a.ts' && tab.line === '10'), 'the current-file viewer opened the trusted workspace path at the snippet line: ' + JSON.stringify(fileTabs))
    await call(handle, 'open', { kind: 'ciel-evidence', address: await call(handle, 'evidenceAddress', { sessionId: 's-a', reviewId: 'r-a', evidenceId: 'e1' }) })
    assert.equal(await call(handle, 'has', { selector: '[data-ciel-compare-current]' }), true, 'the compare control renders')
    await call(handle, 'click', { selector: '[data-ciel-compare-current]' })
    const narrowPanes = await call(handle, 'paneCount', { sessionId: 's-a' })
    assert.equal(narrowPanes, 1, '420px does not fit two native tab strips; comparison stays single-column')
    assert.ok((await call(handle, 'fileTabs')).some(tab => tab.address === 'dsh-resource://file/session/s-a/src/a.ts' && tab.line === '10'))
    record('narrow compare falls back to a current-file tab', { panes: 1, line: 10 })
    await call(handle, 'open', { kind: 'ciel-evidence', address: await call(handle, 'evidenceAddress', { sessionId: 's-a', reviewId: 'r-a', evidenceId: 'e1' }) })
    await call(handle, 'click', { selector: '[data-sidebar-right-mode="fullscreen"]' })
    await page.waitForFunction(() => { const button = document.querySelector('[data-dockkit-split-button]'); return button && !button.disabled })
    await call(handle, 'click', { selector: '[data-ciel-compare-current]' })
    const panes = await call(handle, 'paneCount', { sessionId: 's-a' })
    assert.equal(panes, 2, 'fullscreen has real room for two native tab strips; panes=' + panes)
    screenshots.push(await screenshot(page, '06-evidence-compare'))
    record('evidence/current-file comparison opens the trusted path and splits', { panes: 2, line: 10 })
    await call(handle, 'click', { selector: '[data-sidebar-right-mode="push"]' })

    // 5. advisor body
    await call(handle, 'open', { kind: 'ciel-advice', address: await call(handle, 'adviceAddress', { sessionId: 's-a', callId: 'c-a' }) })
    assert.match(await call(handle, 'text'), /顾问原始文本/)
    assert.match(await call(handle, 'text'), /方向一/)
    assert.match(await call(handle, 'text'), /不是核实过的证据/)
    screenshots.push(await screenshot(page, '04-advice'))
    record('advisor body renders ideas with the not-verification disclaimer')

    // 6. checkbox -> prepareFeedback -> real Lexical draft staged and preserved
    await call(handle, 'open', { kind: 'ciel-review', address: await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' }) })
    await call(handle, 'setDraft', { text: '原稿保留' })
    await call(handle, 'click', { selector: '[data-ciel-select="0"]' })
    await call(handle, 'click', { selector: '[data-ciel-submit]' })
    const prepareCalls = await call(handle, 'rpcCalls', { method: 'prepareFeedback' })
    assert.equal(prepareCalls.length, 1, 'the injected prepareFeedback face reached the RPC')
    assert.deepEqual(prepareCalls[0].request.items, [{ index: 0 }])
    const draft = await call(handle, 'draft')
    assert.match(draft, /原稿保留/)
    assert.match(draft, /advisor:review-feedback/)
    screenshots.push(await screenshot(page, '05-feedback-draft'))
    record('checkbox回传 stages the real Lexical draft and keeps the original text', { draft })

    // 6b. fixture chat DOM shell: production gutter/panel surgery + the NEW
    // lightweight summary (requires entry.sessionId, aligned to Host schema)
    await call(handle, 'renderButton', { sessionId: 's-a', messageId: 'm-a' })
    const buttonText = await call(handle, 'buttonText')
    assert.match(buttonText, /部分核实/, 'the chat summary button rendered its status label: ' + buttonText)
    const chat = await call(handle, 'chatState')
    assert.ok(chat.gutter >= 1, 'a gutter was inserted into the reviewed block: ' + JSON.stringify(chat))
    assert.ok(chat.gmarks >= 1, 'a gutter mark was inserted: ' + JSON.stringify(chat))
    assert.ok(chat.marks >= 1, 'an inline proximity mark was inserted: ' + JSON.stringify(chat))
    assert.equal(chat.panel, 1, 'the in-chat panel was inserted: ' + JSON.stringify(chat))
    assert.equal(chat.lightweight, 1, 'the NEW lightweight summary card rendered: ' + JSON.stringify(chat))
    assert.equal(chat.legacyDetails, 0, 'no legacy .dsr-details panel: ' + JSON.stringify(chat))
    assert.equal(chat.legacyBoxes, 0, 'no legacy .dsrf-box checkbox: ' + JSON.stringify(chat))
    assert.equal(chat.summaryButtons, 1, 'the native 查看评审与证据 button rendered: ' + JSON.stringify(chat))
    assert.ok(chat.summaryButtonText.trim().endsWith('查看评审与证据'))
    const summaryAction = page.getByRole('button', { name: '查看评审与证据', exact: true })
    assert.equal(await summaryAction.count(), 1, 'the decorative arrow is excluded from the accessible label')
    const actionStyle = await summaryAction.evaluate(el => {
      let opacity = 1
      for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
      const style = getComputedStyle(el)
      return { opacity, height: el.getBoundingClientRect().height, color: style.color, fill: style.backgroundColor, cursor: style.cursor }
    })
    assert.equal(actionStyle.opacity, 1, 'no ancestor fades the card CTA')
    assert.ok(actionStyle.height >= 36)
    assert.equal(actionStyle.cursor, 'pointer')
    assert.notEqual(actionStyle.fill, 'rgba(0, 0, 0, 0)')
    // The fixture chat has no real shell column sizing. Collapse the real
    // sidebar normally before testing pointer interaction on the chat CTA.
    await call(handle, 'click', { selector: '[data-sidebar-right-toggle]' })
    await summaryAction.hover()
    assert.notEqual(await summaryAction.evaluate(el => getComputedStyle(el).backgroundColor), actionStyle.fill, 'native hover feedback remains visible')
    await summaryAction.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await summaryAction.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true)
    assert.equal(await summaryAction.evaluate(el => getComputedStyle(el).outlineWidth), '2px')
    record('card CTA has full contrast, native hover and a keyboard focus ring', actionStyle)
    assert.ok(chat.nativeTags >= 1, 'the summary rendered a native Tag: ' + JSON.stringify(chat))
    screenshots.push(await screenshot(page, '07-chat-light'))
    record('chat shell: lightweight summary + gutter/inline marks + native Tag/Button', chat)

    // 6b-ii. the native 查看评审与证据 button opens the sidebar review
    // Real browser keyboard events run outside Testing Library's act wrapper.
    // Return to act mode before driving the fixture API again.
    await page.evaluate(() => { window.IS_REACT_ACT_ENVIRONMENT = false })
    await summaryAction.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-ciel-review="r-a"]') !== null)
    await page.mouse.move(0, 0)
    await page.evaluate(() => { window.IS_REACT_ACT_ENVIRONMENT = true })
    const opened = await call(handle, 'activeTab')
    assert.equal(opened?.contentId, await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' }), 'the native summary button opened the review tab: ' + JSON.stringify(opened))
    record('native 查看评审与证据 opens the sidebar review', { contentId: opened.contentId })

    // 6b-iii. an original-text badge opens the sidebar at its annotationIndex
    await call(handle, 'clickChat', { selector: '.dsr-badge' })
    const focusIndex = await call(handle, 'focusIndex')
    assert.equal(focusIndex, '1', 'the inline badge focused annotation 1: ' + focusIndex)
    assert.equal(await call(handle, 'focusedAnnotation'), '1')
    screenshots.push(await screenshot(page, '07b-chat-badge-focus'))
    record('original-text badge opens sidebar at annotationIndex', { focusIndex })

    // 6c. theme + size matrix (real native CSS + latest Ciel CSS)
    await call(handle, 'open', { kind: 'ciel-review', address: await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' }) })
    await call(handle, 'setTheme', { dark: true })
    const darkAction = await summaryAction.evaluate(el => ({ color: getComputedStyle(el).color, fill: getComputedStyle(el).backgroundColor }))
    assert.notEqual(darkAction.fill, actionStyle.fill, 'primary fill follows the native dark theme')
    assert.notEqual(darkAction.color, actionStyle.color, 'foreground follows the matching dark-theme contrast token')
    screenshots.push(await screenshot(page, '08-review-dark'))
    await call(handle, 'click', { selector: '[data-sidebar-right-toggle]' })
    screenshots.push(await screenshot(page, '09-chat-dark'))
    await call(handle, 'open', { kind: 'ciel-review', address: await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' }) })
    await page.setViewportSize({ width: 480, height: 900 })
    screenshots.push(await screenshot(page, '10-review-dark-narrow'))
    const narrowActions = await page.locator('[data-ciel-review] [data-ciel-action]').evaluateAll(nodes => nodes.map(el => ({ width: el.getBoundingClientRect().width, available: el.parentElement.getBoundingClientRect().width, overflow: el.scrollWidth > el.clientWidth + 1 })))
    assert.ok(narrowActions.length > 0)
    assert.ok(narrowActions.every(action => action.width <= action.available + 1 && !action.overflow), 'full-size sidebar actions wrap without horizontal overflow')
    record('dark-theme actions stay legible and fit narrow panes', { darkAction, narrowActions })
    await page.setViewportSize({ width: 1200, height: 900 })
    await call(handle, 'setTheme', { dark: false })
    record('theme/size matrix screenshots (light+dark, desktop+480)', { shots: 4 })

    // 7. multi-session isolation: address session is authority
    await call(handle, 'setCurrent', { sessionId: 's-b' })
    await call(handle, 'open', { kind: 'ciel-review', address: await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' }) })
    assert.equal(await call(handle, 'has', { selector: '[data-ciel-review="r-a"]' }), true, "session A's review renders while current is B")
    const reads = await call(handle, 'rpcCalls', { method: 'readReview' })
    assert.ok(reads.some((entry) => entry.request.sessionId === 's-a' && entry.request.reviewId === 'r-a'))
    assert.equal(reads.some((entry) => entry.request.sessionId === 's-b' && entry.request.reviewId === 'r-a'), false, 'no cross-session read')
    record('multi-session isolation: address session is authority', { reads: reads.length })

    // 8. closing the last tab releases the pinned resource
    const reviewAddress = await call(handle, 'reviewAddress', { sessionId: 's-a', reviewId: 'r-a' })
    assert.equal(await call(handle, 'resourceStatus', { address: reviewAddress }), 'live')
    for (const sessionId of ['s-a', 's-b']) {
      await call(handle, 'setCurrent', { sessionId })
      for (let guard = 0; guard < 30; guard++) {
        const ids = await call(handle, 'openTabIds', { sessionId })
        if (!ids.includes(reviewAddress)) break
        await call(handle, 'closeTab', { sessionId, address: reviewAddress })
      }
    }
    assert.notEqual(await call(handle, 'resourceStatus', { address: reviewAddress }), 'live', 'the last close released the resource')
    record('close-tab releases the pinned resource', { status: await call(handle, 'resourceStatus', { address: reviewAddress }) })

    assert.equal(networkRequests, 0, 'no network request was attempted')
    record('zero network requests', { networkRequests })

    assert.deepEqual(pageErrors, [], 'page errors must be zero')
    const chatRootWarnings = consoleErrors.filter((text) => /chat root not found/.test(text))
    assert.deepEqual(chatRootWarnings, [], 'the fixture chat shell must prevent the chat-root warning')
    record('zero page errors and no chat-root warning', { pageErrors: pageErrors.length, consoleErrors: consoleErrors.length })

    const boundaries = [
      'Native component CSS is the real *.module.css compiled by esbuild local-css plus the real theme token stylesheet; no control style is copied. Plain CSS uses the css loader. The fixture chat shell is a marked fixture DOM (data-fixture-*), not the shipped ChatView, so real turn virtualization/markdown re-rendering is approximated.',
      'The chat summary button runs the production gutter/panel DOM surgery inside the fixture chat shell (gutter marks, inline marks, panel, native Tag portals asserted). It is not the shipped ChatView component tree.',
      'Host data RPC, the settings scope, and the composer sink are synthetic fixtures. slots/resources/sidebarRightTabs/SidebarRightController/RightbarSeat/dockkit/React/Tag/Button/Switch and the Lexical SessionInputShell are the real target implementations.',
      'Chromium is Windows Chrome over CDP (WSL localhost); no Linux Playwright browser binary is installed in this environment.',
      'No real DSH_HOME, no server, no model call, and no external network request was made (0 requests recorded); bundled CSS references 0 external URLs.',
    ]
    report = { passed: true, targetVersion, browser: kind, fixtureJsBytes: Buffer.byteLength(fixtureBundle.js), fixtureCssBytes: Buffer.byteLength(fixtureBundle.css), themeCssBytes: Buffer.byteLength(themeCss), clientBytes: Buffer.byteLength(clientSource), networkRequests, pageErrors, consoleErrors, screenshots, boundaries, results }

  } finally {
    await owner.close()
  }
  report.browserClosed = true
  writeFileSync(join(reportDir, 'sidebar-browser-verify.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(reportDir, 'sidebar-browser-verify.log'), results.map((entry) => entry.name + (entry.detail === undefined ? '' : ' ' + JSON.stringify(entry.detail))).join('\n') + '\n')
  console.log(JSON.stringify({ passed: true, browser: kind, checks: results.length, networkRequests, screenshots }, null, 1))
}

await main()
