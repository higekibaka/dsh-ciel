import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from './review-ui.harness.js'

function documentStub() {
  return { createElement(tagName) {
    const handlers = new Map(), attrs = new Map()
    const node = { tagName, className: '', textContent: '', style: {}, children: [], hidden: false,
      setAttribute: (key, value) => attrs.set(key, String(value)), getAttribute: key => attrs.get(key),
      appendChild(child) { child.parentNode = this; this.children.push(child) },
      contains(child) { return this === child || this.children.some(n => n.contains(child)) },
      addEventListener(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]) },
      click() { let stopped = false; const event = { target: this, stopPropagation() { stopped = true } }; for (let n = this; n && !stopped; n = n.parentNode) for (const h of n.handlers.get('click') || []) h(event) },
      handlers,
    }
    node.classList = {
      contains: c => node.className.split(/\s+/).includes(c),
      add(...names) { for (const c of names) this.toggle(c, true) },
      toggle(c, force) { const names = new Set(node.className.split(/\s+/).filter(Boolean)); const on = force ?? !names.has(c); if (on) names.add(c); else names.delete(c); node.className = [...names].join(' '); return on },
    }
    return node
  } }
}
const all = n => [n, ...n.children.flatMap(all)]
const byClass = (n, c) => all(n).find(x => x.classList.contains(c))
const entry = { reviewId: 'review-zero', messageId: 'message-zero', status: 'incomplete', coverage: 'partial', verdict: 'pass', annotations: [], summary: '4 项疑点，4 项排除', stats: { checked: 4, confirmed: 0, excluded: 4, unchecked: 0 }, modelUsage: { used: [{ provider: 'fixture', model: 'fixed' }] }, privacy: { mode: 'restricted-snapshot' }, coverageNote: '资料读取受到范围或大小限制' }

test('zero-annotation review collapses model, scope and coverage notes, not only an empty list', async t => {
  const rt = await createRuntime(); t.after(() => rt.dispose())
  const panel = rt.runtime.buildPanel(documentStub(), entry)
  const button = byClass(panel, 'dsr-vtoggle'), details = byClass(panel, 'dsr-details')
  assert.equal(button.tagName, 'button')
  assert.equal(button.type, 'button')
  assert.equal(button.getAttribute('aria-controls'), details.id)
  assert.equal(button.getAttribute('aria-expanded'), 'true')
  assert.ok(details.contains(byClass(panel, 'ciel-model-usage')))
  assert.ok(all(details).some(n => n.textContent.includes('读取范围：')))
  assert.ok(all(details).some(n => n.textContent === entry.coverageNote))
  button.click()
  assert.equal(details.hidden, true)
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  assert.equal(button.getAttribute('aria-label'), '展开评审详情')
  assert.ok(panel.classList.contains('dsr-collapsed'))
  assert.ok(button.textContent !== '整体成立')
  button.click()
  assert.equal(details.hidden, false)
  assert.equal(button.getAttribute('aria-label'), '折叠评审详情')
})

test('fold choice survives repaint of the same review but not a different review', async t => {
  const rt = await createRuntime(); t.after(() => rt.dispose())
  const doc = documentStub()
  byClass(rt.runtime.buildPanel(doc, entry), 'dsr-vtoggle').click()
  const repainted = rt.runtime.buildPanel(doc, { ...entry, coverageNote: '重绘后的说明' })
  assert.equal(byClass(repainted, 'dsr-details').hidden, true)
  const other = rt.runtime.buildPanel(doc, { ...entry, reviewId: 'other-review' })
  assert.equal(byClass(other, 'dsr-details').hidden, false)
  byClass(repainted, 'dsr-vtoggle').click()
  assert.equal(byClass(rt.runtime.buildPanel(doc, entry), 'dsr-details').hidden, false)
})

test('draft preparation action is a separate button and never toggles collapse', async t => {
  const rt = await createRuntime(); t.after(() => rt.dispose())
  let staged = 0
  const fb = { sel: new Set([0]), sent: new Set(), note: '', sending: false, filter: 'all', onSend: () => staged++, onToggle() {}, onFilter() {}, onBlockers() {} }
  const annotated = { ...entry, reviewId: 'annotated', annotations: [{ severity: 'blocker', title: 'Finding', comment: 'Evidence-based finding', matched: true }] }
  const panel = rt.runtime.buildPanel(documentStub(), annotated, () => {}, fb)
  const toggle = byClass(panel, 'dsr-vtoggle'), send = byClass(panel, 'dsrf-send'), details = byClass(panel, 'dsr-details')
  assert.equal(toggle.contains(send), false, 'no nested interactive controls')
  send.click()
  assert.equal(staged, 1)
  assert.equal(details.hidden, false)
  toggle.click()
  send.click()
  assert.equal(staged, 2)
  assert.equal(details.hidden, true)
})
