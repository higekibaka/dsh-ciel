import { resolvedConfig } from './config-fixture.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAdvisorItems, migrateLegacyAdvisorSettings, settingsUserSection } from '../index.js'

test('Config resolves schema defaults', () => {
  const value = resolvedConfig({})
  assert.equal(value.provider, 'kimi-coding')
  assert.equal(value.model, 'kimi-for-coding')
  assert.equal(value.maxTokens, 4096)
  assert.equal(value.maxCallsPerTurn, 3)
  assert.equal(value.requireExploration, true)
  assert.equal(value.reasoningEffort, 'provider')
})

test('Config admits every documented effort level on the advisor pipeline', () => {
  const levels = ['provider', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const level of levels) {
    const value = resolvedConfig({ reasoningEffort: level })
    assert.equal(value.reasoningEffort, level)
    }
})

test('Config rejects an unknown effort level', () => {
  assert.throws(() => resolvedConfig({ reasoningEffort: 'ludicrous' }))
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
