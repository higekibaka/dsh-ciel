import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientFactory } from './review-ui.harness.js'

const api = loadClientFactory().factory({ createElement() {} }).__test
function composer(overrides = {}) {
  const state = { draft: '', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: ['keep-attachment'], ...overrides }
  let current = 's1', accept = true
  const events = []
  const input = { state: { getSnapshot: () => state }, setDraft() { throw new Error('must not overwrite') }, submit() { throw new Error('must not submit') } }
  const actx = { bail(subject, name, request) {
    assert.equal(subject, actx)
    assert.equal(name, 'slash/input-insert-text')
    events.push(request)
    if (!accept || request.span.draftRev !== state.draftRev) return undefined
    state.draft += request.text
    state.draftRev++
    return true
  } }
  const sessions = { list: { getSnapshot: () => ({ current }) }, scope: (id) => id === 's1' ? actx : undefined }
  const ctx = { get: (name) => name === 'sessions' ? sessions : name === 'conversation' ? { input: { for(scope) { assert.equal(scope, actx); return input } } } : undefined }
  return { ctx, state, events, switch: (id) => { current = id }, reject: () => { accept = false } }
}

test('draft staging appends without replacing text, attachments, or sending', () => {
  const c = composer({ draft: '我的原稿' })
  const target = api.feedbackDraftTarget(c.ctx, 's1')
  assert.deepEqual(api.appendFeedbackDraft(c.ctx, 's1', '批注内容', target), { duplicate: false })
  assert.equal(c.state.draft, '我的原稿\n\n批注内容')
  assert.deepEqual(c.state.attachmentIds, ['keep-attachment'])
  assert.deepEqual(c.events[0].span, { start: 4, end: 4, draftRev: 1 })
})

test('append uses atomic chip coordinates without flattening references', () => {
  const c = composer({ draft: '看 @src/index.js\n还有 @file', occurrences: [{ offset: 2, length: 13 }, { offset: 19, length: 5 }] })
  // Correct the fixture using literal coordinates; real chips stay outside the edit span.
  c.state.occurrences = [{ offset: 2, length: '@src/index.js'.length }, { offset: c.state.draft.indexOf('@file'), length: 5 }]
  const chips = c.state.occurrences
  api.appendFeedbackDraft(c.ctx, 's1', '批注')
  assert.equal(c.events[0].span.start, '看 \uFFFC\n还有 \uFFFC'.length)
  assert.equal(c.state.occurrences, chips)
  assert.equal(c.events[0].span.start, c.events[0].span.end)
})

test('exact draft duplicate is skipped, but clearing allows insertion again', () => {
  const c = composer()
  api.appendFeedbackDraft(c.ctx, 's1', '批注')
  assert.deepEqual(api.appendFeedbackDraft(c.ctx, 's1', '批注'), { duplicate: true })
  assert.equal(c.events.length, 1)
  c.state.draft = ''; c.state.draftRev++
  api.appendFeedbackDraft(c.ctx, 's1', '批注')
  assert.equal(c.events.length, 2)
  assert.equal(c.state.draft, '批注')
})

test('asynchronous preparation cannot clobber edits or follow a session switch', () => {
  const c = composer()
  const target = api.feedbackDraftTarget(c.ctx, 's1')
  c.state.draft = '新输入'; c.state.draftRev++
  assert.throws(() => api.appendFeedbackDraft(c.ctx, 's1', '批注', target), /输入内容已变化/)
  c.switch('s2')
  assert.throws(() => api.appendFeedbackDraft(c.ctx, 's1', '批注'), /会话已切换/)
  assert.equal(c.state.draft, '新输入')
  assert.equal(c.events.length, 0)
})

test('real staging action calls only prepareFeedback and fences asynchronous replies', async () => {
  const request = { sessionId: 's1', messageId: 'm1', reviewId: 'r1', items: [{ index: 0 }] }
  const response = { ok: true, ...request, text: '待确认批注' }
  const c = composer({ draft: '我的原稿' })
  const calls = []
  await api.stageFeedbackDraft(c.ctx, request, async (method, req) => { calls.push(method); assert.equal(req, request); return response })
  assert.deepEqual(calls, ['prepareFeedback'])
  assert.equal(c.state.draft, '我的原稿\n\n待确认批注')
  for (const mode of ['edited', 'switched', 'unmounted', 'mismatch', 'old-host']) {
    const c = composer()
    let resolve
    const pending = api.stageFeedbackDraft(c.ctx, request, (method) => {
      assert.equal(method, 'prepareFeedback')
      return new Promise((r) => { resolve = r })
    }, () => mode !== 'unmounted')
    if (mode === 'edited') { c.state.draft = '新稿'; c.state.draftRev++ }
    if (mode === 'switched') c.switch('s2')
    resolve(mode === 'mismatch' ? { ...response, sessionId: 'other' } : mode === 'old-host' ? { ok: false, error: 'unknown method' } : response)
    await assert.rejects(pending)
    assert.equal(c.events.length, 0, mode)
  }
})

for (const phase of ['claimed', 'submitting', 'adjudicating']) test('refuse composer phase ' + phase, () => {
  const c = composer({ phase })
  assert.throws(() => api.appendFeedbackDraft(c.ctx, 's1', '批注'), /处理命令或发送/)
  assert.equal(c.events.length, 0)
})

test('unclaimed slash input, invalid chips and rejected revision never fall back to sending', () => {
  const command = composer({ draft: '/help' })
  assert.throws(() => api.appendFeedbackDraft(command.ctx, 's1', '批注'), /处理命令或发送/)
  const invalid = composer({ draft: '@ref', occurrences: [{ offset: 0, length: 20 }] })
  assert.throws(() => api.appendFeedbackDraft(invalid.ctx, 's1', '批注'), /引用位置/)
  const rejected = composer(); rejected.reject()
  assert.throws(() => api.appendFeedbackDraft(rejected.ctx, 's1', '批注'), /未发送/)
  assert.equal(rejected.state.draft, '')
  assert.throws(() => api.appendFeedbackDraft({ get() {} }, 's1', '批注'), /未填入/)
})
