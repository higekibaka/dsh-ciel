import { requestFixtures, resultFixtures } from './review-protocol.fixtures.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClientFactory } from './performance-review-ui.harness.js'

test('the generated client mounts factory codecs for all review and inbox methods', async (t) => {
  const plugin = loadClientFactory().factory({ createElement: () => ({}) })
  const effects = []
  let contribution
  const expected = { reviews: [], sentKeys: [], triage: {}, nextCursor: null, limited: false }
  const api = { list: async () => ({ ok: true, value: expected }) }
  plugin.apply({
    settingsScope: { bind: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, user: {}, writable: true }) }) },
    slots: { inject: () => () => {}, register: () => () => {} },
    on: () => () => {},
    get(key) {
      if (key === 'remote') return { async $mount(value) { contribution = value; return () => {} } }
      if (key === 'remote.advisorReview') return api
    },
    effect(fn) { effects.push(Promise.resolve(fn())); return () => {} },
  })
  t.after(async () => {
    for (const cleanup of (await Promise.all(effects)).reverse()) {
      if (typeof cleanup === 'function') await cleanup()
    }
  })
  await Promise.all(effects)
  assert.equal(contribution.package, 'dsh-advisor')
  assert.equal(contribution.descriptors.length, 13)
  for (const descriptor of contribution.descriptors) {
    for (const [codec, valid] of [[descriptor.parameters[0].codec, requestFixtures[descriptor.method]], [descriptor.result, resultFixtures[descriptor.method]]]) {
      assert.equal(codec.mode, 'strict')
      assert.equal(typeof codec.create, 'function', descriptor.method + ' supports alpha.2 codecs')
      const schema = codec.create()
      assert.equal(schema.parse(valid), valid)
      assert.equal(codec.schema.parse(valid), valid, 'older adapter enforces the same shape')
      for (const value of [null, [], true]) assert.throws(() => schema.parse(value), /review protocol/)
    }
  }
  assert.deepEqual(await plugin.__test.runtime.reviewCall('list', { sessionId: 'fixture' }), expected)
})
