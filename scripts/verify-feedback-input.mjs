#!/usr/bin/env node
// Real DSH SessionInputShell + Lexical and scoped Cordis event, in JSDOM.
// Run from DSH checkout with: DSH_CHECKOUT=/path node --import tsx/esm /path/to/this/script
// No server, real session, model, or network request is created.
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { loadClientFactory } from '../plugin/test/review-ui.harness.js'
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT is required')
const require = createRequire(join(checkout, 'package.json'))
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const saved = new Map()
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'DocumentFragment', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'Text', 'Event', 'KeyboardEvent', 'InputEvent']) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  const value = ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key]
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
// Node does not render CSS. Stub styles only; all editor/event code is real.
const styles = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
  return nextLoad(url, context)
} })
const originalFetch = globalThis.fetch
let networkRequests = 0, modelSends = 0, shell, ctx
try {
  globalThis.fetch = async () => { networkRequests++; throw new Error('Network forbidden') }
  const { SessionInputShell } = await import(pathToFileURL(join(checkout, 'packages/client/ui-conversation/src/client/input/facade.ts')).href)
  const { Context } = createRequire(join(checkout, 'packages/core/tools/package.json'))('@deepseek-ai/cordis')
  ctx = new Context()
  shell = new SessionInputShell({
    actx: ctx,
    defaultSink: async () => { modelSends++; throw new Error('Must not send') },
    commandAttachments: { serialize: async () => [], release() {}, unsupportedNotice: () => 'unsupported' },
  })
  ctx.on('slash/input-insert-text', req => shell.insertText(req.text, req.span) ? true : undefined)
  let current = 'fixture-session'
  const facade = { get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => ({ current }) }, scope: id => id === 'fixture-session' ? ctx : undefined }
    if (name === 'conversation') return { input: { for: () => shell } }
  } }
  const api = loadClientFactory().factory({ createElement() {} }).__test
  shell.setDraft('原稿\n@source')
  assert.equal(shell.insertReference({ source: 'fixture', ref: 'source', label: 'source', clipboardText: '@[source with spaces](fixture:source)' }, { start: 3, end: 10, draftRev: shell.snapshot.draftRev }), true)
  assert.equal(shell.addAttachments(['fixture-image']), true)
  const original = shell.snapshot.draft
  const occurrence = shell.snapshot.occurrences[0]
  const target = api.feedbackDraftTarget(facade, current)
  const text = '[advisor:review-feedback] 请人工核对\n\n### 批注\n证据待确认。'
  api.appendFeedbackDraft(facade, current, text, target)
  assert.equal(shell.snapshot.draft, original + '\n\n' + text)
  assert.equal(shell.snapshot.occurrences.length, 1)
  assert.equal(shell.snapshot.occurrences[0].occurrenceId, occurrence.occurrenceId)
  assert.equal(shell.snapshot.occurrences[0].ref, occurrence.ref)
  assert.deepEqual(shell.snapshot.attachmentIds, ['fixture-image'])
  assert.equal(api.appendFeedbackDraft(facade, current, text).duplicate, true)
  const stale = api.feedbackDraftTarget(facade, current)
  shell.setDraft('用户刚输入的新稿')
  assert.throws(() => api.appendFeedbackDraft(facade, current, text, stale), /输入内容已变化/)
  assert.equal(shell.snapshot.draft, '用户刚输入的新稿')
  current = 'different-session'
  assert.throws(() => api.appendFeedbackDraft(facade, 'fixture-session', text), /会话已切换/)
  current = 'fixture-session'
  shell.setDraft('')
  api.appendFeedbackDraft(facade, current, text)
  assert.equal(shell.snapshot.draft, text)
  assert.equal(modelSends, 0)
  assert.equal(networkRequests, 0)
  console.log(JSON.stringify({ passed: true, nativeChipAndAttachmentPreserved: true, duplicateSkipped: true, staleDraftRejected: true, wrongSessionRejected: true, clearAndReinsert: true, modelSends, networkRequests }))
} finally {
  shell?.dispose()
  await ctx?.fiber.dispose()
  globalThis.fetch = originalFetch
  styles.deregister()
  dom.window.close()
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
}
