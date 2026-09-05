import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime, flush } from './review-ui.harness.js'

test('a failed new request is visible without replacing an older durable review', async (t) => {
  const rt = await createRuntime({ start: { ok: false, error: { message: 'connection lost' } } })
  t.after(() => rt.dispose())
  const previous = { messageId: 'm', reviewId: 'r1', createdAt: 50, status: 'sound', coverage: 'complete', verdict: 'pass', annotations: [] }
  rt.runtime.absorb(previous)
  let tree = rt.runner.render(rt.ReviewButton, { sessionId: 's', messageId: 'm' })
  tree.__element[2].__element[1].onClick()
  await flush()
  tree = rt.runner.render(rt.ReviewButton, { sessionId: 's', messageId: 'm' })
  assert.equal(rt.runtime.store.byMessage.get('m').reviewId, 'r1')
  assert.equal(tree.__element[4].__element[1].className, 'dsr-start-error')
  assert.match(tree.__element[4].__element[1].title, /connection lost/)
  // A newly reconciled host result clears the warning by review identity,
  // without comparing the host clock to the client's failure timestamp.
  rt.runtime.absorb({ ...previous, reviewId: 'r2', createdAt: 100 })
  tree = rt.runner.render(rt.ReviewButton, { sessionId: 's', messageId: 'm' })
  assert.equal(tree.__element[4], null)
})
