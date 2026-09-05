#!/usr/bin/env node
// Offline DOM verification: real React + Chromium, fixture RPC only, no server.
const { createRequire } = require('module')
const { join, dirname } = require('path')
const { readFileSync } = require('fs')
const assert = require('node:assert/strict')
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT required')
const webRequire = createRequire(join(checkout, 'apps/web/package.json'))
const { chromium } = webRequire('playwright')
const reactDir = dirname(webRequire.resolve('react'))
const domDir = dirname(webRequire.resolve('react-dom/client'))
const clientSource = readFileSync(join(__dirname, '../plugin/client.js'), 'utf8')
;(async () => {
  const browser = await chromium.launch(process.env.CIEL_AB_CHROME ? { executablePath: process.env.CIEL_AB_CHROME } : {})
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', (route) => route.abort())
    await page.setContent('<html><head></head><body><main id="chat"><section id="message"><p id="draft">alpha 0001，beta 0002，gamma 0003。这里是静态评审夹具正文，不会发送给任何模型。</p><div id="actions"></div></section></main></body></html>')
    await page.addScriptTag({ path: join(reactDir, 'umd/react.development.js') })
    await page.addScriptTag({ path: join(domDir, 'umd/react-dom.development.js') })
    await page.evaluate(() => { window.__ModuleLoader__ = { load: (module) => { window.fixtureModule = module } } })
    await page.addScriptTag({ content: clientSource })
    await page.evaluate(async () => {
      const plugin = window.fixtureModule.factory((name) => name === 'react' ? window.React : {})
      const state = { reviews: [], triage: {}, sentKeys: [], progress: { inFlight: false }, feedback: null, startResolve: null }
      const renderers = {}, cleanups = [], effects = []
      const wrap = (fn) => async (req) => ({ ok: true, value: await fn(req) })
      const api = {
        list: wrap(() => ({ reviews: state.reviews, triage: state.triage, sentKeys: state.sentKeys })),
        progress: wrap(() => state.progress),
        start: wrap(() => { if (state.startFailure) return { ok: false, error: state.startFailure }; state.progress = { inFlight: true, explore: true, phase: 1, toolCalls: 0, suspects: 0, budget: 5 }; return new Promise((resolve) => { state.startResolve = resolve }) }),
        cancel: wrap(() => {
          const entry = { reviewId: 'cancelled', messageId: 'message', status: 'cancelled', error: 'review cancelled by user', annotations: [], createdAt: Date.now() }
          state.reviews = [entry]; state.progress = { inFlight: false }
          if (state.startResolve) state.startResolve({ ok: false, review: entry, error: entry.error })
          return { ok: true, cancelled: true }
        }),
        triage: wrap((req) => {
          const current = state.triage[req.reviewId] ||= { states: {} }
          for (const c of req.changes || []) current.states[c.index] = c.state
          if (req.filter) current.filter = req.filter
          return { ok: true }
        }),
        feedback: wrap((req) => { state.feedback = req; return { ok: true, delivered: req.items.length, skipped: 0, skippedIndices: [] } }),
      }
      plugin.apply({
        settingsScope: { bind: () => ({ getSnapshot: () => ({ status: 'ready', value: { criticProvider: 'fixture', criticModel: 'fixed' } }) }) },
        slots: { inject: (_name, fn) => fn(), register: (desc, fn) => { renderers[desc.id || desc.key] = fn; return () => {} } },
        get: (name) => name === 'remote' ? { $mount: async () => async () => {} } : name === 'remote.advisorReview' ? api : undefined,
        on: () => () => {},
        effect: (fn) => { const p = Promise.resolve(fn()).then((cleanup) => { if (cleanup) cleanups.push(cleanup) }); effects.push(p); return () => {} },
      })
      await Promise.all(effects)
      const rt = plugin.__test.runtime
      let root
      const mount = () => { root = window.ReactDOM.createRoot(document.querySelector('#actions')); root.render(renderers['advisor-review']({ sessionId: 'session', messageId: 'message' })) }
      const setEntry = async (entry, triage = {}) => { state.reviews = [entry]; state.triage = triage; await rt.hydrate('session', { force: true }) }
      window.domFixture = { state, rt, mount, setEntry, unmount: () => root.unmount(), dispose: async () => { root.unmount(); for (const cleanup of cleanups.reverse()) await cleanup() } }
      await setEntry({ reviewId: 'partial', messageId: 'message', createdAt: 1, status: 'incomplete', coverage: 'partial', verdict: 'pass', summary: '仍有未查项目', annotations: [], stats: { checked: 1, confirmed: 0, excluded: 0, unchecked: 1 }, explore: { budget: 5, toolCalls: 0, salvaged: true } })
      mount()
    })
    await page.locator('.dsr-tail').waitFor()
    assert.equal(await page.locator('.dsr-vbadge-pass').count(), 0)
    assert.match(await page.locator('.dsr-tail').innerText(), /抢救产出/)
    await page.evaluate(() => { window.domFixture.state.startFailure = 'connection lost' })
    await page.locator('.dsr-btn').click()
    await page.locator('.dsr-start-error').waitFor()
    assert.equal(await page.locator('.dsr-tail').count(), 1)
    await page.evaluate(() => { window.domFixture.state.startFailure = null })
    await page.locator('.dsr-btn').click()
    await page.locator('.dsr-cancel').waitFor()
    await page.locator('.dsr-cancel').click()
    await page.waitForFunction(() => document.querySelector('.dsr-btn')?.textContent.includes('取消'))
    assert.equal(await page.locator('.dsr-cancel').count(), 0)
    await page.evaluate(async () => {
      const anns = ['alpha 0001', 'beta 0002', 'gamma 0003'].map((anchor, i) => ({ severity: i === 0 ? 'blocker' : 'nit', block: 'b1', anchor, title: '问题 ' + i, comment: '夹具意见 ' + i, evidence: 'fixture.txt:' + (i + 1), matched: true }))
      await window.domFixture.setEntry({ reviewId: 'annotations', messageId: 'message', createdAt: Date.now() + 1, status: 'completed', coverage: 'complete', verdict: 'changes', annotations: anns, blocks: [{ id: 'b1', type: 'paragraph' }] }, { annotations: { states: { 0: 'dismiss' } } })
    })
    await page.locator('.dsrf-box').nth(2).waitFor()
    assert.deepEqual(await page.locator('.dsrf-box').evaluateAll((boxes) => boxes.map((b) => b.checked)), [false, true, true])
    await page.locator('.dsrf-box').nth(1).uncheck()
    await page.waitForFunction(() => window.domFixture.state.triage.annotations.states[1] === 'dismiss')
    await page.evaluate(() => { window.domFixture.unmount(); window.domFixture.mount() })
    await page.locator('.dsrf-box').nth(2).waitFor()
    assert.deepEqual(await page.locator('.dsrf-box').evaluateAll((boxes) => boxes.map((b) => b.checked)), [false, false, true])
    await page.locator('.dsrf-send').click()
    await page.waitForFunction(() => !!window.domFixture.state.feedback)
    const feedback = await page.evaluate(() => window.domFixture.state.feedback)
    assert.equal(feedback.items.length, 1)
    assert.equal(feedback.items[0].evidence, 'fixture.txt:3')
    assert.equal(feedback.items[0].block, 'b1')
    assert.equal(feedback.messageId, 'message')
    await page.evaluate(() => window.domFixture.dispose())
    assert.equal(await page.locator('.dsr-tail').count(), 0)
    assert.equal(await page.locator('.dsr-mark').count(), 0)
    assert.deepEqual(errors, [])
    console.log('DOM PASS: incomplete badge, visible salvage, stop, selection remount, evidence feedback, cleanup; network/model calls = 0')
  } finally { await browser.close() }
})().catch((error) => { console.error(error); process.exitCode = 1 })
