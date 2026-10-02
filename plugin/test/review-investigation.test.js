import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewHarness, verdict } from './host-harness.js'
import { parseCriticReview, readReviews } from '../index.js'

const home = await mkdtemp(join(tmpdir(), 'ciel-independent-review-'))
process.env.DSH_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const suspects = count => '## suspects\n' + Array.from({ length: count }, (_, i) =>
  '- suspect: claim ' + (i + 1) + ' | block: b1 | bearing: high | falsify: read relevant source').join('\n')
const cleared = (id, ref) => verdict({ evidence: ref }).replace('result: s1', 'result: ' + id)
const unresolved = (id, reason) => '## dossier\n- result: ' + id + ' | outcome: unchecked | evidence: none | reason: ' + reason + '\n\n## verdict: pass\nsummary: not settled'
async function scenario(t, scripts) {
  const h = await reviewHarness(scripts)
  t.after(() => h.dispose())
  return h
}

test('every suspect gets an independent investigator before any sibling finishes', { timeout: 3000 }, async t => {
  let started = 0, release
  const allStarted = new Promise(resolve => { release = resolve })
  const scripts = Array.from({ length: 3 }, (_, index) => async ({ tool }, spec) => {
    if (++started === 3) release()
    await allStarted
    const id = 's' + (index + 1)
    assert.match(spec.prompt[0].text, new RegExp('\\n' + id + '\\. \\[b1\\] claim ' + (index + 1)))
    for (let other = 1; other <= 3; other++) if (other !== index + 1) assert.ok(!spec.prompt[0].text.includes('claim ' + other))
    assert.match(spec.prompt[0].text, /Scope manifest/)
    return cleared(id, tool('read', { file_path: '/project/source-' + id + '.js' }).evidence_refs[0])
  })
  const h = await scenario(t, [suspects(3), ...scripts])
  const result = await h.start()
  assert.equal(result.ok, true)
  assert.equal(result.review.status, 'sound')
  assert.deepEqual(result.review.stats, { checked: 3, confirmed: 0, excluded: 3, unchecked: 0 })
  assert.equal(result.review.modelRequests, 4)
  assert.equal(result.review.explore.toolCalls, 3)
  assert.equal(h.disposals.length, 4)
  assert.deepEqual(result.review.investigations.map(r => [r.id, r.status, r.toolCalls, r.modelRequests]), [
    ['s1', 'settled', 1, 1], ['s2', 'settled', 1, 1], ['s3', 'settled', 1, 1],
  ])
  assert.deepEqual((await readReviews(h.sid))[0].investigations, result.review.investigations)
})

test('unresolved and failed units cannot skip or erase a successful sibling', async t => {
  const reason = 'Checked the scope manifest; active runtime model is unavailable; need a host model-selection receipt.'
  const h = await scenario(t, [suspects(3),
    () => unresolved('s1', reason),
    () => ({ text: '', stopReason: 'error' }),
    ({ tool }) => cleared('s3', tool().evidence_refs[0]),
  ])
  const { review } = await h.start()
  assert.equal(review.status, 'incomplete')
  assert.equal(review.sound, false)
  assert.deepEqual(review.stats, { checked: 3, confirmed: 0, excluded: 1, unchecked: 2 })
  assert.equal(review.investigations[0].reason, reason)
  assert.equal(review.investigations[1].status, 'failed')
  assert.equal(review.investigations[2].status, 'settled')
  assert.equal(review.investigations[0].toolCalls, 0, 'scope-only investigation is not fabricated as a file query')
  assert.equal(h.requests.length, 4)
})

test('a worker cannot cite a sibling receipt that it never received', async t => {
  let share
  const receipt = new Promise(resolve => { share = resolve })
  const h = await scenario(t, [suspects(2),
    ({ tool }) => { const ref = tool().evidence_refs[0]; share(ref); return cleared('s1', ref) },
    async () => cleared('s2', await receipt),
  ])
  const { review } = await h.start()
  assert.equal(review.stats.excluded, 1)
  assert.equal(review.stats.unchecked, 1)
  assert.match(review.investigations[1].reason, /证据引用缺失/)
  assert.deepEqual(review.investigations[1].evidenceRefs, [])
})

test('shared cancellation drains every dispatched investigation and records each failure', { timeout: 3000 }, async t => {
  let count = 0, notify
  const started = new Promise(resolve => { notify = resolve })
  const work = async ({ signal }) => {
    if (++count === 3) notify()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return ''
  }
  const h = await scenario(t, [suspects(3), work, work, work])
  const pending = h.start()
  await started
  assert.equal((await h.cancel()).cancelled, true)
  const result = await pending
  assert.equal(result.review.status, 'cancelled')
  assert.equal(result.review.investigations.length, 3)
  assert.ok(result.review.investigations.every(row => row.status === 'failed' && /cancel/.test(row.reason)))
  assert.equal(h.service.coordinator.children.size, 0)
  assert.equal(h.disposals.length, 4)
})

test('legacy rows remain readable and reason is separate from citation', () => {
  const options = { explore: true, selected: [{ id: 's1' }], allSuspects: [{ id: 's1' }] }
  const parsed = parseCriticReview(unresolved('s1', 'No relevant source in snapshot.'), '', [], options)
  assert.equal(parsed.outcomes[0].reason, 'No relevant source in snapshot.')
  assert.equal(parsed.outcomes[0].evidence, 'none')
  const legacy = parseCriticReview(unresolved('s1', 'reason').replace(' | reason: reason', ''), '', [], options)
  assert.equal(legacy.outcomes[0].outcome, 'unchecked')
})
