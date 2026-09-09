#!/usr/bin/env node
// Exercise the real imperative card and Ciel stylesheet with JSDOM. Native
// Tag portal metadata uses fixtures here; verify-native-settings.mjs mounts
// the real native components. No server or model.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createRuntime } from '../plugin/test/review-ui.harness.js'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required (supplies JSDOM)')
const { JSDOM } = createRequire(join(checkout, 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
const doc = dom.window.document
const rt = await createRuntime({}, { document: doc })
try {
  const entry = { reviewId: 'collapse-fixture', messageId: 'collapse-message', status: 'incomplete', verdict: 'pass', coverage: 'partial', summary: '4 项疑点，4 项排除', annotations: [], stats: { checked: 4, confirmed: 0, excluded: 4, unchecked: 0 }, modelUsage: { used: [{ provider: 'fixture', model: 'fixed' }] }, privacy: { mode: 'restricted-snapshot' }, coverageNote: '资料读取受到范围或大小限制' }
  const panel = rt.runtime.buildPanel(doc, entry)
  doc.body.appendChild(panel)
  const button = panel.querySelector('.dsr-vtoggle'), details = panel.querySelector('.dsr-details')
  assert.ok(details.contains(panel.querySelector('.ciel-model-usage')))
  assert.match(details.textContent, /读取范围.*资料读取受到范围/s)
  assert.notEqual(dom.window.getComputedStyle(details).display, 'none')
  button.focus()
  assert.equal(doc.activeElement, button, 'native disclosure button is keyboard reachable')
  button.click()
  assert.equal(dom.window.getComputedStyle(details).display, 'none')
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  assert.notEqual(dom.window.getComputedStyle(panel.querySelector('.dsr-tail-head')).display, 'none')
  assert.match(button.textContent, /4 项疑点，4 项排除/)
  assert.ok(rt.runtime.renderPanelTags(panel).some(portal => portal.__portal.children.__element[2] === '◇ 部分核实'))
  const repaint = rt.runtime.buildPanel(doc, { ...entry })
  panel.replaceWith(repaint)
  assert.equal(dom.window.getComputedStyle(repaint.querySelector('.dsr-details')).display, 'none')
  repaint.querySelector('.dsr-vtoggle').click()
  assert.notEqual(dom.window.getComputedStyle(repaint.querySelector('.dsr-details')).display, 'none')
  assert.equal(repaint.querySelector('.dsr-vtoggle').getAttribute('aria-expanded'), 'true')
  console.log(JSON.stringify({ passed: true, zeroAnnotationsDetailsHidden: true, summaryRetained: true, repaintRetainsFold: true, keyboardReachable: true, reopened: true, modelCalls: 0 }))
} finally {
  await rt.dispose()
  dom.window.close()
}
