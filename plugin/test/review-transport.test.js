import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReviewTransport } from '../src/review-transport.js'
import { Context, getTraceable, symbols } from '@deepseek-ai/cordis'

// Real Cordis returns a fresh caller-bound facade for every service lookup.
// Unmounting a Remote aborts its outstanding RPCs; a progress query must not
// mistake facade churn for replacement and cancel a pending review.start.
test('Cordis facade churn does not remount or abort a pending start during progress reads', async (t) => {
  const ctx = new Context()
  let mounts = 0, disposals = 0, complete, current, startSignal, markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const remote = {
    [symbols.tracker]: { property: 'ctx' },
    ctx: null,
    async $mount() {
      assert.equal(this.ctx, ctx, 'mount keeps the caller-bound facade')
      mounts++
      current = new AbortController()
      const controller = current
      return () => { disposals++; controller.abort() }
    },
  }
  const getRemote = () => getTraceable(ctx, remote)
  assert.notEqual(getRemote(), getRemote(), 'regression requires distinct facades')
  const transport = createReviewTransport({
    getRemote,
    getApi: () => ({
      start: () => new Promise(resolve => {
        complete = () => resolve({ ok: true, value: { ok: true } })
        startSignal = current.signal
        startSignal.addEventListener('abort', () => resolve({ ok: false, error: {
          code: 'gateway/cancelled', message: 'client api: Remote invocation "advisorReview/start" was aborted',
        } }), { once: true })
        markStarted()
      }),
      progress: async () => ({ ok: true, value: { inFlight: true } }),
      list: async () => ({ ok: true, value: { reviews: [] } }),
    }),
  })
  t.after(() => transport.dispose())
  await transport.ready()
  const start = transport.call('start', {})
  await started
  await Promise.all([transport.call('progress', {}), transport.call('list', {})])
  await transport.call('progress', {})
  const observed = { mounts, disposals, aborted: startSignal.aborted }
  complete()
  const result = await start
  assert.deepEqual(observed, { mounts: 1, disposals: 0, aborted: false })
  assert.deepEqual(result, { ok: true })
  await transport.dispose()
  assert.equal(disposals, 1)
})

test('a failed mount can be retried, concurrent calls share readiness, successful mount is not repeated', async () => {
  let mounts = 0, disposals = 0
  const remote = { $mount: async () => { if (++mounts === 1) throw new Error('private path sentinel'); return () => { disposals++ } } }
  const transport = createReviewTransport({
    getRemote: () => remote,
    getApi: () => ({ list: async () => ({ ok: true, value: { reviews: [] } }) }), descriptor: {},
  })
  const first = await transport.call('list', {})
  assert.equal(first.code, 'CIEL_REMOTE_MOUNT_FAILED')
  assert.doesNotMatch(JSON.stringify(first), /sentinel/)
  const next = await Promise.all([transport.call('list', {}), transport.call('list', {})])
  assert.deepEqual(next, [{ reviews: [] }, { reviews: [] }])
  assert.equal(mounts, 2)
  await transport.dispose()
  assert.equal(disposals, 1)
  assert.equal((await transport.call('list', {})).code, 'CIEL_REMOTE_DISPOSED')
})

test('service readiness, interface mismatch, remote business errors and transport errors stay distinct', async () => {
  let remote, api
  const transport = createReviewTransport({ getRemote: () => remote, getApi: () => api, descriptor: {} })
  assert.equal((await transport.call('list', {})).code, 'CIEL_REMOTE_NOT_READY')
  remote = {}
  assert.equal((await transport.call('list', {})).code, 'CIEL_REMOTE_INTERFACE_MISMATCH')
  remote = { $mount: async () => {} }
  api = {}
  assert.equal((await transport.call('list', {})).code, 'CIEL_REMOTE_INTERFACE_MISMATCH')
  api.list = async () => ({ ok: false, error: { code: 'PERMISSION_DENIED', message: 'denied' } })
  assert.equal((await transport.call('list', {})).code, 'PERMISSION_DENIED')
  api.list = async () => ({ ok: true, value: { ok: false, code: 'record_corrupt', error: 'corrupt' } })
  assert.equal((await transport.call('list', {})).code, 'record_corrupt')
  api.list = async () => { throw new Error('private host sentinel') }
  const failed = await transport.call('list', {})
  assert.equal(failed.code, 'transport_error')
  assert.doesNotMatch(JSON.stringify(failed), /sentinel/)
  await transport.dispose()
})

test('unloading during mount releases a late registration exactly once and never calls its API', async () => {
  let release, disposed = 0, calls = 0
  const mounted = new Promise(resolve => { release = resolve })
  const transport = createReviewTransport({ getRemote: () => ({ $mount: () => mounted }), getApi: () => ({ list() { calls++ } }) })
  const pending = transport.call('list', {})
  const stopping = transport.dispose()
  release(() => { disposed++ })
  await stopping
  assert.equal((await pending).code, 'CIEL_REMOTE_DISPOSED')
  assert.equal(calls, 0)
  assert.equal(disposed, 1)
})

test('replacing the Remote service releases the old registration and mounts the new service', async () => {
  let released = 0, mounts = 0
  let remote = { $mount: async () => { mounts++; return () => { released++ } } }
  const transport = createReviewTransport({ getRemote: () => remote, getApi: () => ({ list: () => ({ reviews: [] }) }) })
  await transport.call('list', {})
  remote = { $mount: async () => { mounts++; return () => { released++ } } }
  await Promise.all([transport.call('list', {}), transport.call('list', {})])
  assert.equal(mounts, 2)
  assert.equal(released, 1)
  await transport.dispose()
  assert.equal(released, 2)
})
