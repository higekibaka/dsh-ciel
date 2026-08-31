// dsh-ciel unit tests: the plugin's pure logic, run with `node --test`.
// No harness boot required — fakes stand in for the settings service, and
// the sidecar store is redirected into a temp dir through DSH_HOME.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-ciel-test-'))

const {
  Config,
  parseAdvisorItems,
  advisorTargets,
  userText,
  reviewsPath,
  readReviews,
  persistReview,
  migrateLegacyAdvisorSettings,
  settingsUserSection,
} = await import('../index.js')

// ── Config schema ────────────────────────────────────────────────────────

test('Config resolves schema defaults', () => {
  const value = Config({})
  assert.equal(value.provider, 'kimi-coding')
  assert.equal(value.model, 'kimi-for-coding')
  assert.equal(value.maxTokens, 4096)
  assert.equal(value.maxCallsPerTurn, 3)
  assert.equal(value.requireExploration, true)
  assert.equal(value.reasoningEffort, 'provider')
  assert.equal(value.criticProvider, 'google')
  assert.equal(value.criticModel, 'gemini-3.7-flash')
  assert.equal(value.criticEffort, 'medium')
})

test('Config admits every documented effort level on both pipelines', () => {
  const levels = ['provider', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const level of levels) {
    const value = Config({ reasoningEffort: level, criticEffort: level })
    assert.equal(value.reasoningEffort, level)
    assert.equal(value.criticEffort, level)
  }
})

test('Config rejects an unknown effort level', () => {
  assert.throws(() => Config({ criticEffort: 'ludicrous' }))
})

// ── parseAdvisorItems ────────────────────────────────────────────────────

const ADVISOR_DOC = [
  '前言：可以忽略。',
  '## [high] 先看锁的粒度',
  'framing: 把状态机而不是回调当成主结构',
  'pitfalls: 双检锁在 TS 里没有意义',
  'verification_target: 并发 100 次写入无丢更新',
  '',
  '## [low] 顺手统一命名',
  'framing: 词汇表先于代码',
].join('\n')

test('parseAdvisorItems parses tiered items with their fields', () => {
  const { items, issues } = parseAdvisorItems(ADVISOR_DOC)
  assert.equal(items.length, 2)
  assert.equal(items[0].tier, 'high')
  assert.equal(items[0].title, '先看锁的粒度')
  assert.equal(items[0].framing, '把状态机而不是回调当成主结构')
  assert.equal(items[0].pitfalls, '双检锁在 TS 里没有意义')
  assert.equal(items[0].verificationTarget, '并发 100 次写入无丢更新')
  assert.equal(items[1].pitfalls, '')
  // item 2 carries no verification_target — exactly the reported issue:
  assert.deepEqual(issues, ['item 2 ("顺手统一命名") lacks verification_target'])
})

test('parseAdvisorItems degrades to zero items on unstructured text', () => {
  const { items, issues } = parseAdvisorItems('just prose, no headings')
  assert.deepEqual(items, [])
  assert.deepEqual(issues, [])
})

test('parseAdvisorItems flags the 6-item cap', () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    `## [mid] item ${i}\nframing: f\nverification_target: v`).join('\n')
  const { items, issues } = parseAdvisorItems(many)
  assert.equal(items.length, 7)
  assert.ok(issues.some((issue) => issue.includes('exceeds the 6-item cap')))
})

// ── advisorTargets ───────────────────────────────────────────────────────

function toolEvents({ turn, callSeq, resultSeq, items }) {
  return [
    { seq: callSeq, type: 'tool/call', data: { name: 'ask_advisor', callId: 'c1', turn } },
    {
      seq: resultSeq,
      type: 'tool/result',
      data: {
        turn,
        meta: { v: 1, items },
        message: { content: [{ toolCallId: 'c1' }] },
      },
    },
  ]
}

test('advisorTargets prefers the same-turn consultation', () => {
  const earlier = toolEvents({
    turn: 1, callSeq: 1, resultSeq: 2,
    items: [{ verificationTarget: 'old' }],
  })
  const sameTurn = toolEvents({
    turn: 2, callSeq: 3, resultSeq: 4,
    items: [{ verificationTarget: 'new' }],
  })
  const target = { seq: 9, data: { turn: 2 } }
  const { items, from } = advisorTargets([...earlier, ...sameTurn], target)
  assert.equal(items[0].verificationTarget, 'new')
  assert.ok(from.startsWith('same-turn'))
})

test('advisorTargets falls back to the latest earlier-turn consultation', () => {
  const earlier = toolEvents({
    turn: 1, callSeq: 1, resultSeq: 2,
    items: [{ verificationTarget: 'old' }],
  })
  const target = { seq: 9, data: { turn: 2 } }
  const { items, from } = advisorTargets(earlier, target)
  assert.equal(items[0].verificationTarget, 'old')
  assert.ok(from.startsWith('earlier-turn'))
})

test('advisorTargets answers none without a consultation', () => {
  const { items, from } = advisorTargets([], { seq: 1, data: { turn: 1 } })
  assert.deepEqual(items, [])
  assert.equal(from, 'none')
})

// ── userText ─────────────────────────────────────────────────────────────

test('userText joins visible text blocks only', () => {
  const event = {
    data: {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', url: 'data:...' },
        { type: 'text', text: '第二段' },
      ],
    },
  }
  assert.equal(userText(event), '第一段\n第二段')
})

// ── sidecar review store ─────────────────────────────────────────────────

test('reviewsPath refuses unusable session ids', () => {
  assert.equal(reviewsPath('../escape'), undefined)
  assert.equal(reviewsPath(''), undefined)
  assert.equal(reviewsPath(42), undefined)
  assert.ok(reviewsPath('sess-1.ok').endsWith(join('dsh-advisor', 'reviews', 'sess-1.ok.jsonl')))
})

test('persistReview + readReviews round-trip, skipping torn lines', async () => {
  await persistReview('sess-test', { reviewId: 'r1', verdict: 'ok' })
  await persistReview('sess-test', { reviewId: 'r2', verdict: 'issues' })
  // tear the tail
  const path = reviewsPath('sess-test')
  const { appendFileSync } = await import('node:fs')
  appendFileSync(path, '{"reviewId": "r3"')
  const reviews = await readReviews('sess-test')
  assert.deepEqual(reviews.map((r) => r.reviewId), ['r1', 'r2'])
  assert.deepEqual(await readReviews('sess-missing'), [])
})

// ── legacy settings migration ────────────────────────────────────────────

function fakeSettings({ advisor, ciel }) {
  const stored = { advisor, ciel }
  return {
    registrations: new Map(),
    register(ns) {
      if (this.registrations.has(ns)) throw new Error('duplicate')
      this.registrations.set(ns, true)
    },
    describe() {
      return [...this.registrations.keys()].map((ns) => ({
        ns,
        ...(stored[ns] === undefined ? {} : { user: stored[ns] }),
      }))
    },
  }
}

function fakeScope() {
  const writes = []
  return { writes, update: async (patch) => { writes.push(patch) } }
}

test('migration copies legacy overrides into an untouched ciel namespace', async () => {
  const settings = fakeSettings({ advisor: { model: 'x', maxTokens: 8192 }, ciel: undefined })
  settings.register('ciel') // the live registration, as in apply()
  const scope = fakeScope()
  const moved = await migrateLegacyAdvisorSettings(settings, scope)
  assert.equal(moved, true)
  assert.deepEqual(scope.writes, [{ model: 'x', maxTokens: 8192 }])
})

test('migration never overwrites an existing ciel user section', async () => {
  const settings = fakeSettings({ advisor: { model: 'x' }, ciel: { model: 'y' } })
  settings.register('ciel')
  const scope = fakeScope()
  const moved = await migrateLegacyAdvisorSettings(settings, scope)
  assert.equal(moved, false)
  assert.deepEqual(scope.writes, [])
})

test('migration is a no-op without a legacy section or when the name is taken', async () => {
  const empty = fakeSettings({ advisor: undefined, ciel: undefined })
  empty.register('ciel')
  assert.equal(await migrateLegacyAdvisorSettings(empty, fakeScope()), false)

  const taken = fakeSettings({ advisor: { model: 'x' }, ciel: undefined })
  taken.register('ciel')
  taken.register('advisor') // omdsh-dev/dsh-advisor owns the name
  assert.equal(await migrateLegacyAdvisorSettings(taken, fakeScope()), false)
})

test('settingsUserSection tolerates namespaces missing from describe', () => {
  const settings = fakeSettings({ advisor: { a: 1 }, ciel: undefined })
  settings.register('ciel')
  assert.deepEqual(settingsUserSection(settings, 'advisor'), {})
})

process.on('exit', () => {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
})
