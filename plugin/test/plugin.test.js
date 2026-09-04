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
  splitMarkdownBlocks,
  parseCriticReview,
  criticExplorePersona,
  createBudgetWatchdog,
  appendFeedback,
  readFeedbackTriage,
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

// ── parseCriticReview（契约 v2） ─────────────────────────────────────────

const CRITIC_DRAFT = '## 方案\n正文第一段。\n```js\nconst a = 1\n```\n结尾段。'
const CRITIC_BLOCKS = splitMarkdownBlocks(CRITIC_DRAFT)

const V2_REPLY = [
  '## verdict: changes',
  'summary: 键盘路径存在阻断性问题，其余可放行。',
  '',
  '### [blocker] 焦点丢失',
  'block: b3',
  'anchor: const a = 1',
  'comment: 折叠卸载 DOM 时焦点掉到 body。',
  '',
  '### [nit] 摘要缺脏状态',
  'block: b2',
  'comment: 闭组看不到未保存修改。',
].join('\n')

test('parseCriticReview parses the v2 verdict header and block anchors', () => {
  const { verdict, summary, annotations } = parseCriticReview(V2_REPLY, CRITIC_DRAFT, CRITIC_BLOCKS)
  assert.equal(verdict, 'changes')
  assert.equal(summary, '键盘路径存在阻断性问题，其余可放行。')
  assert.equal(annotations.length, 2)
  assert.equal(annotations[0].block, 'b3')
  assert.equal(annotations[0].anchor, 'const a = 1')
  assert.equal(annotations[0].matched, true)
  assert.equal(annotations[1].block, 'b2')
  assert.equal(annotations[1].anchor, '')
})

test('parseCriticReview drops hallucinated block ids', () => {
  const text = V2_REPLY.replace('block: b3', 'block: b99')
  const { annotations } = parseCriticReview(text, CRITIC_DRAFT, CRITIC_BLOCKS)
  assert.equal(annotations[0].block, undefined)
  assert.equal(annotations[1].block, 'b2')
})

test('parseCriticReview degrades to legacy when the verdict header is absent', () => {
  const legacy = '### [nit] 只给意见不写头\ncomment: 旧形态。'
  const { verdict, summary, annotations } = parseCriticReview(legacy, CRITIC_DRAFT, CRITIC_BLOCKS)
  assert.equal(verdict, undefined)
  assert.equal(summary, '')
  assert.equal(annotations.length, 1)
  assert.equal(annotations[0].block, undefined)
})

test('parseCriticReview reads pass verdicts with zero annotations', () => {
  const { verdict, annotations } = parseCriticReview('## verdict: pass\nsummary: 没发现问题。', CRITIC_DRAFT, CRITIC_BLOCKS)
  assert.equal(verdict, 'pass')
  assert.equal(annotations.length, 0)
})

// ── parseCriticReview（契约 v3：dossier/verdict 分离 + stats + evidence） ──

const V3_REPLY = [
  '## dossier',
  '- suspect: b3 的代码有未处理越界 → confirmed: src/list.js:40 无长度校验',
  '- suspect: 摘要可能丢脏状态 → excluded: read 显示闭组仍渲染徽标',
  '### [blocker] 已排除疑点在卷宗里伪装复发',
  'comment: 这行属于 dossier 段，绝不应落进批注。',
  '',
  '## verdict: changes',
  'summary: 越界访问是阻断性问题。',
  'stats: 排查 2 · 证伪 1 · 排除 1',
  '',
  '### [blocker] 越界访问',
  'block: b3',
  'evidence: src/list.js:40 直接索引 items[i]，上方无长度校验',
  'anchor: const a = 1',
  'comment: i 可等于 items.length。',
  '',
  '### [blocker] 无证据的高危断言应降级',
  'block: b2',
  'comment: 没有任何工具取证支撑。',
].join('\n')

test('parseCriticReview v3 consumes only the verdict section (dossier leak-proof)', () => {
  const { verdict, summary, stats, annotations } = parseCriticReview(V3_REPLY, CRITIC_DRAFT, CRITIC_BLOCKS, { explore: true })
  assert.equal(verdict, 'changes')
  assert.equal(summary, '越界访问是阻断性问题。')
  assert.deepEqual(stats, { checked: 2, confirmed: 1, excluded: 1 })
  // dossier 里的伪装 ### 头不得落批注；只有 verdict 段的两条。
  assert.equal(annotations.length, 2)
  assert.equal(annotations[0].title, '越界访问')
  assert.equal(annotations[0].evidence, 'src/list.js:40 直接索引 items[i]，上方无长度校验')
  assert.equal(annotations[0].severity, 'blocker')
  assert.equal(annotations[0].block, 'b3')
})

test('parseCriticReview v3 downgrades evidence-less blockers to nit in explore mode', () => {
  const { annotations } = parseCriticReview(V3_REPLY, CRITIC_DRAFT, CRITIC_BLOCKS, { explore: true })
  assert.equal(annotations[1].severity, 'nit')
  assert.equal(annotations[1].downgraded, 'evidence-missing')
  assert.equal(annotations[1].evidence, undefined)
})

test('parseCriticReview v2 mode keeps evidence-less blockers as blocker', () => {
  const { annotations, stats } = parseCriticReview(V3_REPLY, CRITIC_DRAFT, CRITIC_BLOCKS)
  assert.equal(annotations[1].severity, 'blocker')
  assert.equal(annotations[1].downgraded, undefined)
  // stats 行与 evidence 字段在 v2 模式下同样解析（结构是增强不是门槛）。
  assert.deepEqual(stats, { checked: 2, confirmed: 1, excluded: 1 })
  assert.equal(annotations[0].evidence, 'src/list.js:40 直接索引 items[i]，上方无长度校验')
})

test('parseCriticReview stats line tolerates separator variants and omission', () => {
  const variant = '## verdict: pass\nsummary: ok\nstats: 排查 3，证伪 1，排除 2'
  assert.deepEqual(parseCriticReview(variant, CRITIC_DRAFT, CRITIC_BLOCKS).stats, { checked: 3, confirmed: 1, excluded: 2 })
  const bare = '## verdict: pass\nsummary: ok\nstats: 3 1 2'
  assert.deepEqual(parseCriticReview(bare, CRITIC_DRAFT, CRITIC_BLOCKS).stats, { checked: 3, confirmed: 1, excluded: 2 })
  const none = '## verdict: pass\nsummary: ok'
  assert.equal(parseCriticReview(none, CRITIC_DRAFT, CRITIC_BLOCKS).stats, undefined)
})

test('criticExplorePersona swaps the no-tools clause for a budgeted read-only clause', () => {
  const persona = criticExplorePersona(5)
  assert.equal(persona.includes('You have NO tools'), false)
  assert.equal(persona.includes('HARD BUDGET of 5'), true)
  assert.equal(persona.includes('## dossier'), true)
  assert.equal(persona.includes('read, grep, glob'), true)
})

// ── 预算看门狗（0.13.0 契约 v3 硬熔断） ─────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeChildAgents(evsRef) {
  return {
    get: () => ({ session: { snapshotEvents: () => evsRef.evs } }),
  }
}

test('createBudgetWatchdog stays silent at budget and breaches above it', async () => {
  const evsRef = { evs: [{ type: 'tool/call' }] }
  let breaches = 0
  const wd = createBudgetWatchdog({ agents: fakeChildAgents(evsRef), runId: 'child', budget: 1, intervalMs: 5, onBreach: () => { breaches += 1 } })
  await sleep(30)
  assert.equal(breaches, 0)
  assert.equal(wd.breached(), false)
  // 超限 → 熔断恰好一次（重复采样不重复触发）。
  evsRef.evs = [{ type: 'tool/call' }, { type: 'tool/call' }]
  await sleep(30)
  assert.equal(breaches, 1)
  assert.equal(wd.breached(), true)
  await sleep(20)
  assert.equal(breaches, 1)
  assert.equal(wd.stop(), 2)
})

test('createBudgetWatchdog tolerates missing child and non-tool events', async () => {
  const evsRef = { evs: [{ type: 'assistant/message' }, { type: 'turn/start' }] }
  let breaches = 0
  const wd = createBudgetWatchdog({ agents: { get: () => undefined }, runId: 'x', budget: 0, intervalMs: 5, onBreach: () => { breaches += 1 } })
  await sleep(15)
  assert.equal(breaches, 0)
  assert.equal(wd.stop(), 0)
  const wd2 = createBudgetWatchdog({ agents: fakeChildAgents(evsRef), runId: 'x', budget: 0, intervalMs: 5, onBreach: () => { breaches += 1 } })
  await sleep(15)
  assert.equal(breaches, 0)
  assert.equal(wd2.stop(), 0)
})

// ── 分诊 WAL（0.12.0 ④） ────────────────────────────────────────────────

test('triage WAL: last-write-wins per annotation and per filter', async () => {
  await appendFeedback('sess-triage', { triage: { reviewId: 'r1', index: 0, state: 'accept' } })
  await appendFeedback('sess-triage', { triage: { reviewId: 'r1', index: 1, state: 'dismiss' } })
  await appendFeedback('sess-triage', { triage: { reviewId: 'r1', index: 0, state: 'dismiss' } })
  await appendFeedback('sess-triage', { triageFilter: { reviewId: 'r1', filter: 'blocker' } })
  await appendFeedback('sess-triage', { triageFilter: { reviewId: 'r1', filter: 'all' } })
  await appendFeedback('sess-triage', { triage: { reviewId: 'r2', index: 3, state: 'accept' } })

  const triage = await readFeedbackTriage('sess-triage')
  assert.equal(triage.get('r1').states.get(0), 'dismiss')
  assert.equal(triage.get('r1').states.get(1), 'dismiss')
  assert.equal(triage.get('r1').filter, 'all')
  assert.equal(triage.get('r2').states.get(3), 'accept')
  assert.equal(triage.get('r2').filter, undefined)
  assert.equal((await readFeedbackTriage('sess-missing-triage')).size, 0)
})

process.on('exit', () => {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
})
