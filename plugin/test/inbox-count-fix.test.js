// Ciel 收件箱计数修复 — 独立单元/组件回归（仅浏览器无关的 node 测试）。
//
// 固定方案（与实现 worker 独立编写，不引用其内部实现，仅断言可观察 DOM/纯函数语义）：
//   1. 保留 4 个意向 tab；失败/已取消/未检查完的异常评审在每个意向筛选下都必须可见。
//   2. “全部”tab 统计本页评审条数（N 项评审）；pending/planned/rejected
//      tab 统计本页真实批注条数（N 条批注），page-local。
//   3. 意向筛选在卡片内部过滤批注：只保留匹配意向的批注，原 index/key 不变。
//   4. 0 条真实批注保留“失败/取消/未检查完”的原文案；实际有批注但无匹配
//      必须说明“无该意向批注”，不能伪称“没有产生批注”。
//   5. 单列异常状态汇总 + 说明。
//   6. 数字用真实批注统计；失败评审自带的批注照常按其 intent 计入。
//
// 无网络、无模型请求、无 DOM 库、无副作用：只驱动纯 ESM 的
// plugin/src/inbox.js 与一个 mock React 渲染器。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INBOX_PANEL_ID,
  FILTER_LABELS,
  createCielInbox,
  filterReviews,
  pageCounts,
} from '../src/inbox.js'

const POINTER = 'b'.repeat(64)
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

// ── tiny React renderer（与 inbox-client.test.js 同一 fakeUI 风格） ─────────

function createRenderer() {
  let instance = null
  const same = (left, right) => {
    if (left === right) return true
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }
  const React = {
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { __el: true, type, props: { ...(props || {}), children: kids } }
    },
    useState(initial) {
      const index = instance.cursor++
      if (instance.state[index] === undefined) instance.state[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [instance.state[index].value, (next) => { instance.state[index].value = typeof next === 'function' ? next(instance.state[index].value) : next }]
    },
    useEffect(effect, deps) {
      instance.effects.push({ index: instance.cursor++, effect, deps })
    },
  }
  const textOf = (node) => {
    if (node === null || node === undefined) return ''
    if (node.text !== undefined) return node.text
    return (node.children || []).map(textOf).join('')
  }
  const build = (raw) => {
    const elements = []
    const convert = (node) => {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
      if (Array.isArray(node)) return { children: node.map(convert).filter((child) => child !== null) }
      if (!node.__el) return null
      if (typeof node.type === 'function') return convert(node.type(node.props))
      const element = { type: node.type, props: node.props, children: [] }
      elements.push(element)
      const child = convert(node.props.children)
      if (child !== null) element.children.push(child)
      return element
    }
    const root = convert(raw)
    return {
      root,
      elements,
      text: textOf(root),
      all: (predicate) => elements.filter(predicate),
      find: (predicate) => elements.find(predicate),
      textOf,
      click: (element) => (element && typeof element.props.onClick === 'function' ? element.props.onClick({}) : undefined),
    }
  }
  const render = () => {
    instance.cursor = 0
    instance.effects = []
    const tree = build(instance.component(instance.props))
    for (const entry of instance.effects) {
      const previous = instance.slots[entry.index]
      const shouldRun = entry.deps === undefined || previous === undefined || !same(previous.deps, entry.deps)
      if (!shouldRun) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = entry.effect()
      instance.slots[entry.index] = { deps: entry.deps === undefined ? undefined : [...entry.deps], cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    }
    return tree
  }
  return {
    React,
    mount(component, props) {
      instance = { component, props, cursor: 0, state: [], effects: [], slots: [] }
      return render()
    },
    rerender: () => render(),
    unmount() {
      for (const slot of instance.slots) if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
      instance = null
    },
  }
}

function FixtureTag(props) {
  return { __el: true, type: 'span', props: { 'data-tag': props.tone || 'neutral', children: props.children } }
}

function createMockContext() {
  const registrations = new Map()
  const slotKey = (registration) => registration.name + ':' + (registration.key === undefined ? registration.id : registration.key)
  const ctx = {
    slots: {
      inject(key, callback) {
        const cleanup = callback()
        return () => { if (typeof cleanup === 'function') cleanup() }
      },
      register(registration, component) {
        registrations.set(slotKey(registration), { registration, component })
        return () => { registrations.delete(slotKey(registration)) }
      },
    },
  }
  return { ctx, registrations }
}

function reviewOf(overrides) {
  return {
    sessionId: 's1',
    reviewId: 'r1',
    messageId: 'm1',
    createdAt: 100,
    status: 'sound',
    reviewFingerprint: POINTER,
    revision: 0,
    annotations: [{ index: 0, severity: 'nit', title: 't', anchor: 'a', comment: 'c', intent: 'pending' }],
    ...overrides,
  }
}

function annotation(index, intent, overrides) {
  return { index, severity: 'nit', title: 't' + index, anchor: 'a' + index, comment: 'c' + index, intent, ...(overrides || {}) }
}

function listResult(sessionId, reviews, nextCursor, limited) {
  return { ok: true, sessionId, reviews, nextCursor: nextCursor === undefined ? null : nextCursor, limited: limited === true }
}

function fakeSessions(initial) {
  const listeners = new Set()
  const state = { current: initial }
  return {
    list: {
      getSnapshot: () => ({ current: state.current }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    setCurrent(next) { state.current = next; for (const listener of [...listeners]) listener() },
  }
}

// ── tree helpers ──────────────────────────────────────────────────────────

/** All converted host elements inside a converted subtree (in document order). */
function descendants(node) {
  const out = []
  const visit = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) { for (const child of current) visit(child); return }
    if (typeof current !== 'object') return
    if (current.type !== undefined && current.props !== undefined) out.push(current)
    if (current.children !== undefined) visit(current.children)
  }
  visit(node)
  return out
}

const cardNode = (tree, reviewId) => tree.find((element) => element.props['data-ciel-inbox-review'] === reviewId)
const annotationsIn = (tree, reviewId) => {
  const card = cardNode(tree, reviewId)
  if (card === undefined) return []
  return descendants(card).filter((element) => element.props['data-ciel-inbox-annotation'] !== undefined)
}
const reviewIds = (tree) => tree.all((element) => element.props['data-ciel-inbox-review'] !== undefined).map((element) => element.props['data-ciel-inbox-review'])
const filterButton = (tree, id) => {
  const button = tree.find((element) => element.props['data-ciel-inbox-filter'] === id)
  assert.ok(button, 'filter button ' + id + ' must exist')
  return button
}
const filterText = (tree, id) => tree.textOf(filterButton(tree, id))
const pageInfo = (tree) => tree.textOf(tree.find((element) => element.props['data-ciel-inbox-pageinfo'] !== undefined))
const statusSummaryNodes = (tree) => tree.all((element) => element.props['data-ciel-inbox-status-summary'] !== undefined)
const filterNoteNodes = (tree) => tree.all((element) => element.props['data-ciel-inbox-filter-note'] !== undefined)
const filterNoteText = (tree) => filterNoteNodes(tree).map((element) => tree.textOf(element)).join(' ')
// The all tab counts page reviews; the three intent tabs count real annotations.
const TAB_UNIT = { all: '项评审', pending: '条批注', planned: '条批注', rejected: '条批注' }
const tabText = (filter, count) => FILTER_LABELS[filter] + ' ' + count + ' ' + TAB_UNIT[filter]

function clickFilter(tree, renderer, id) {
  tree.click(filterButton(tree, id))
  return renderer.rerender()
}

function matchingNote(tree, reviewId) {
  const card = cardNode(tree, reviewId)
  if (card === undefined) return undefined
  return descendants(card).find((element) => element.props['data-ciel-inbox-no-matching-annotations'] !== undefined)
}

async function mountPage(reviews, options) {
  const opts = options || {}
  const renderer = createRenderer()
  const { ctx, registrations } = createMockContext()
  const calls = []
  const inbox = createCielInbox({ React: renderer.React, Tag: FixtureTag })
  inbox.install(ctx, {
    call: async (method, request) => {
      calls.push({ method, request })
      if (typeof opts.call === 'function') return opts.call(method, request)
      return listResult(opts.sessionId || 's1', reviews)
    },
    getSessions: () => fakeSessions(opts.sessionId || 's1'),
    pageSize: opts.pageSize,
  })
  const controller = inbox.getController()
  controller.syncSession(opts.sessionId || 's1')
  await controller.ensureLoaded()
  const panel = registrations.get('main:' + INBOX_PANEL_ID)
  renderer.mount(panel.component, { ...panel.registration.inject() })
  await flush()
  const tree = renderer.rerender()
  return { renderer, tree, controller, calls }
}

// ── pure-helper regression: counts are annotation-based and page-local ─────

test('pageCounts counts every real annotation by intent, including annotated failed reviews', () => {
  const reviews = [
    { status: 'completed', annotations: [annotation(0, 'pending'), annotation(1, 'planned'), annotation(2, 'rejected')] },
    { status: 'error', annotations: [annotation(0, 'planned')] },
    { status: 'cancelled', annotations: [annotation(0, 'rejected')] },
    { status: 'incomplete', annotations: [] },
  ].map((raw, index) => ({ ...raw, key: 'k' + index, sessionId: 's1', reviewId: 'r' + index, messageId: 'm' + index, reviewFingerprint: POINTER, revision: 0, createdAt: 0 }))
  const counts = pageCounts(reviews)
  assert.equal(counts.reviews, 4)
  assert.equal(counts.annotations, 5)
  assert.equal(counts.pending, 1)
  assert.equal(counts.planned, 2, 'the failed review carries a planned annotation and must be counted')
  assert.equal(counts.rejected, 2, 'the cancelled review carries a rejected annotation and must be counted')
  assert.equal(counts.failed, 1)
  assert.equal(counts.cancelled, 1)
  assert.equal(counts.incomplete, 1)
})

test('filterReviews keeps every anomalous review under each intent filter', () => {
  const reviews = [
    { status: 'completed', annotations: [annotation(0, 'planned')] },
    { status: 'error', annotations: [] },
    { status: 'cancelled', annotations: [] },
  ].map((raw, index) => ({ ...raw, key: 'k' + index, sessionId: 's1', reviewId: 'r' + index, messageId: 'm' + index, reviewFingerprint: POINTER, revision: 0, createdAt: 0 }))
  assert.deepEqual(filterReviews(reviews, 'rejected').map((review) => review.reviewId), ['r1', 'r2'])
  assert.deepEqual(filterReviews(reviews, 'planned').map((review) => review.reviewId), ['r0', 'r1', 'r2'])
})

// ── scenario 1: 3 条 error、0 批注 ─────────────────────────────────────────

test('three failed zero-annotation reviews: every tab keeps all three, all three intents stay 0', async () => {
  const reviews = [1, 2, 3].map((n) => reviewOf({
    reviewId: 'err' + n, messageId: 'm' + n, status: 'error', error: 'boom' + n, annotations: [],
  }))
  const { renderer, tree } = await mountPage(reviews)

  assert.match(pageInfo(tree), /本页\s*3\s*条/)
  assert.match(pageInfo(tree), /批注\s*0\s*条/)

  // “全部”按项评审；三个意向按条批注（全是 0）。
  assert.equal(filterText(tree, 'all'), tabText('all', 3), 'the all tab must count reviews')
  for (const intent of ['pending', 'planned', 'rejected']) {
    assert.equal(filterText(tree, intent), tabText(intent, 0), intent + ' must count real annotations, not cards')
  }

  // 单列异常汇总 + 说明。
  const summaries = statusSummaryNodes(tree)
  assert.equal(summaries.length, 1, 'exactly one anomaly status summary column')
  const summaryText = tree.textOf(summaries[0])
  assert.match(summaryText, /失败\s*3/, 'the summary must report three failed reviews: ' + summaryText)
  // The explanation must exist, but it may live either in a dedicated
  // data-ciel-inbox-filter-note node or alongside the summary counts.
  const explanation = filterNoteNodes(tree).length > 0 ? filterNoteText(tree) : summaryText
  assert.match(explanation, /(异常|始终|保留|筛选)/, 'the page must explain that anomalous reviews stay visible: ' + explanation)

  // 每个意向筛选下仍看到三张失败卡，且不伪称为正常。
  let current = tree
  for (const intent of ['pending', 'planned', 'rejected']) {
    current = clickFilter(current, renderer, intent)
    const cards = current.all((element) => element.props['data-ciel-inbox-review'] !== undefined)
    assert.equal(cards.length, 3, 'filter ' + intent + ' must keep all three failed cards')
    assert.deepEqual(cards.map((card) => card.props['data-ciel-inbox-review']), ['err1', 'err2', 'err3'])
    for (const card of cards) {
      const text = current.textOf(card)
      assert.match(text, /本次评审失败，没有留下批注。/, 'zero-annotation failure copy must survive filter ' + intent)
      assert.match(text, /失败/, 'the failure status chip must stay visible under filter ' + intent)
      assert.doesNotMatch(text, /整体成立|正常|状态未知/, 'a failed review must never be shown as normal under filter ' + intent)
      assert.ok(descendants(card).some((element) => element.props['data-ciel-inbox-no-annotations'] !== undefined), 'the zero-annotation marker must stay')
    }
    assert.equal(annotationsIn(current, 'err1').length, 0)
    // 内部过滤不会反过来改变 page-local 计数。
    assert.equal(filterText(current, 'all'), tabText('all', 3))
    for (const other of ['pending', 'planned', 'rejected']) {
      assert.equal(filterText(current, other), tabText(other, 0))
    }
  }
})

// ── scenario 2: 混合正常 + 异常，多批注 / 混合意向 ─────────────────────────

function mixedReviews() {
  return [
    reviewOf({
      reviewId: 'ok3', messageId: 'm-ok3', status: 'completed', verdict: 'changes', coverage: 'complete',
      annotations: [annotation(0, 'pending'), annotation(1, 'planned'), annotation(2, 'rejected')],
    }),
    reviewOf({ reviewId: 'ok1', messageId: 'm-ok1', status: 'sound', annotations: [annotation(0, 'pending')] }),
    reviewOf({ reviewId: 'bad', messageId: 'm-bad', status: 'error', error: 'boom', annotations: [annotation(0, 'planned')] }),
    reviewOf({ reviewId: 'stop', messageId: 'm-stop', status: 'cancelled', annotations: [annotation(0, 'rejected')] }),
    reviewOf({ reviewId: 'part', messageId: 'm-part', status: 'incomplete', coverage: 'partial', annotations: [] }),
  ]
}

test('mixed page: numbers follow annotations not cards, anomaly cards stay, internal filter is exact', async () => {
  const { renderer, tree } = await mountPage(mixedReviews())

  // 5 项评审 / 6 条批注：pending 2、planned 2、rejected 2。
  assert.match(pageInfo(tree), /本页\s*5\s*条/)
  assert.match(pageInfo(tree), /批注\s*6\s*条/)
  assert.equal(filterText(tree, 'all'), tabText('all', 5), 'the all tab counts the page reviews')
  assert.equal(filterText(tree, 'pending'), tabText('pending', 2))
  assert.equal(filterText(tree, 'planned'), tabText('planned', 2))
  assert.equal(filterText(tree, 'rejected'), tabText('rejected', 2))

  const summaries = statusSummaryNodes(tree)
  assert.equal(summaries.length, 1)
  const summaryText = tree.textOf(summaries[0])
  assert.match(summaryText, /失败\s*1/, summaryText)
  assert.match(summaryText, /取消\s*1/, summaryText)
  assert.match(summaryText, /(?:未检查完|未完成)\s*1/, summaryText)

  // planned：只显示 ok3 的 index 1、bad 的 index 0；异常 stop/part 保留；ok1 隐藏。
  let planned = clickFilter(tree, renderer, 'planned')
  assert.deepEqual(reviewIds(planned), ['ok3', 'bad', 'stop', 'part'])
  assert.deepEqual(annotationsIn(planned, 'ok3').map((element) => element.props['data-ciel-inbox-annotation']), ['1'], 'the original annotation index must be preserved')
  assert.deepEqual(annotationsIn(planned, 'bad').map((element) => element.props['data-ciel-inbox-annotation']), ['0'])
  assert.equal(annotationsIn(planned, 'stop').length, 0, 'stop has a real annotation, just not a planned one')
  assert.match(planned.textOf(cardNode(planned, 'stop')), /(?:无|没有)该意向批注/, 'an annotated but non-matching card must say so explicitly')
  assert.doesNotMatch(planned.textOf(cardNode(planned, 'stop')), /没有留下批注|没有产生批注/)
  assert.match(planned.textOf(cardNode(planned, 'part')), /本次评审未检查完，没有留下批注。/, 'a truly zero-annotation card keeps the original copy')
  assert.doesNotMatch(planned.textOf(cardNode(planned, 'part')), /(?:无|没有)该意向批注/)
  // 数字仍按整页批注统计，不随可见卡片变化。
  assert.equal(filterText(planned, 'planned'), tabText('planned', 2), 'the tab keeps the page-local annotation count even when only 4 cards are visible')
  assert.equal(filterText(planned, 'all'), tabText('all', 5))

  // rejected：ok3 的 index 2、stop 的 index 0；bad/part 异常保留；ok1 隐藏。
  const rejected = clickFilter(planned, renderer, 'rejected')
  assert.deepEqual(reviewIds(rejected), ['ok3', 'bad', 'stop', 'part'])
  assert.deepEqual(annotationsIn(rejected, 'ok3').map((element) => element.props['data-ciel-inbox-annotation']), ['2'])
  assert.deepEqual(annotationsIn(rejected, 'stop').map((element) => element.props['data-ciel-inbox-annotation']), ['0'])
  assert.match(rejected.textOf(cardNode(rejected, 'bad')), /(?:无|没有)该意向批注/, 'bad holds a planned annotation only')
  assert.doesNotMatch(rejected.textOf(cardNode(rejected, 'bad')), /没有留下批注|没有产生批注/)
  assert.match(rejected.textOf(cardNode(rejected, 'part')), /本次评审未检查完，没有留下批注。/)

  // pending：ok3 index 0 + ok1 index 0 显示；异常 bad/stop/part 保留。
  const pending = clickFilter(rejected, renderer, 'pending')
  assert.deepEqual(reviewIds(pending), ['ok3', 'ok1', 'bad', 'stop', 'part'])
  assert.deepEqual(annotationsIn(pending, 'ok3').map((element) => element.props['data-ciel-inbox-annotation']), ['0'])
  assert.deepEqual(annotationsIn(pending, 'ok1').map((element) => element.props['data-ciel-inbox-annotation']), ['0'])
  assert.match(pending.textOf(cardNode(pending, 'bad')), /(?:无|没有)该意向批注/)
  assert.match(pending.textOf(cardNode(pending, 'stop')), /(?:无|没有)该意向批注/)
  assert.match(pending.textOf(cardNode(pending, 'part')), /本次评审未检查完，没有留下批注。/)
  for (const id of ['bad', 'stop', 'part']) {
    assert.equal(annotationsIn(pending, id).length, 0)
    const text = pending.textOf(cardNode(pending, id))
    assert.doesNotMatch(text, /整体成立|正常|状态未知/, id + ' is anomalous and must not look healthy')
  }
  assert.equal(filterText(pending, 'all'), tabText('all', 5))
})

// ── scenario 3: 意向切换后的计数/可见条目 & index 不串位 ───────────────────

test('switching an intent inside a filtered card updates page-local counts and never crosses indexes', async () => {
  const reviews = [
    reviewOf({
      reviewId: 'mix', messageId: 'm-mix', status: 'completed', coverage: 'complete',
      annotations: [annotation(0, 'planned'), annotation(1, 'rejected')],
    }),
    reviewOf({ reviewId: 'err', messageId: 'm-err', status: 'error', annotations: [annotation(0, 'rejected')] }),
  ]
  const writeResult = {
    ok: true, sessionId: 's1', reviewId: 'mix', reviewFingerprint: POINTER, revision: 1,
    intents: { 1: 'rejected' },
  }
  const { renderer, tree, calls } = await mountPage(reviews, {
    call: (method) => (method === 'inboxList' ? listResult('s1', reviews) : writeResult),
  })

  assert.equal(filterText(tree, 'planned'), tabText('planned', 1))
  assert.equal(filterText(tree, 'rejected'), tabText('rejected', 2))
  assert.equal(filterText(tree, 'pending'), tabText('pending', 0))

  const planned = clickFilter(tree, renderer, 'planned')
  assert.deepEqual(reviewIds(planned), ['mix', 'err'])
  const visible = annotationsIn(planned, 'mix')
  assert.deepEqual(visible.map((element) => element.props['data-ciel-inbox-annotation']), ['0'])

  // 在筛选后的卡片内把第 0 条从 planned 切到 pending；提交的 index 必须是真实 index 0。
  const pendingButton = descendants(visible[0]).find((element) => element.props['data-ciel-intent'] === 'pending')
  assert.ok(pendingButton, 'the filtered card must still expose its full three-way intent control')
  planned.click(pendingButton)
  await flush()
  const write = calls.find((entry) => entry.method === 'inboxSetIntent')
  assert.ok(write, 'the intent click must issue exactly one inboxSetIntent')
  assert.equal(write.request.index, 0, 'the write must carry the original annotation index')
  assert.equal(write.request.intent, 'pending')

  const after = renderer.rerender()
  // mix 已无 planned 批注且本身正常 => 从 planned 视图隐藏；异常 err 保留并说明无匹配。
  assert.deepEqual(reviewIds(after), ['err'])
  assert.match(after.textOf(cardNode(after, 'err')), /(?:无|没有)该意向批注/)
  assert.equal(filterText(after, 'planned'), tabText('planned', 0), 'the annotation count must drop after the real write')
  assert.equal(filterText(after, 'rejected'), tabText('rejected', 2), 'the untouched rejected annotation keeps its count')
  assert.equal(filterText(after, 'pending'), tabText('pending', 1), 'the moved annotation must be counted under its new intent')
  assert.equal(filterText(after, 'all'), tabText('all', 2))

  // rejected 视图：mix 仍显示它原来的 index 1，而不是被筛选压扁成 index 0。
  const rejected = clickFilter(after, renderer, 'rejected')
  assert.deepEqual(reviewIds(rejected), ['mix', 'err'])
  assert.deepEqual(annotationsIn(rejected, 'mix').map((element) => element.props['data-ciel-inbox-annotation']), ['1'])
  assert.deepEqual(annotationsIn(rejected, 'err').map((element) => element.props['data-ciel-inbox-annotation']), ['0'])

  // pending 视图：mix 的 index 0 只在这里出现，仍带原始 index。
  const pending = clickFilter(rejected, renderer, 'pending')
  assert.deepEqual(reviewIds(pending), ['mix', 'err'])
  assert.deepEqual(annotationsIn(pending, 'mix').map((element) => element.props['data-ciel-inbox-annotation']), ['0'])
  assert.equal(annotationsIn(pending, 'err').length, 0)
  assert.match(pending.textOf(cardNode(pending, 'err')), /(?:无|没有)该意向批注/)
})

// ── scenario 4: 空页 / 本页 / 翻页统计范围 ────────────────────────────────

test('empty page renders zero counts and the empty state, with no fabricated summary', async () => {
  const { tree } = await mountPage([])
  assert.match(pageInfo(tree), /本页\s*0\s*条/)
  assert.match(pageInfo(tree), /批注\s*0\s*条/)
  assert.equal(filterText(tree, 'all'), tabText('all', 0))
  for (const intent of ['pending', 'planned', 'rejected']) assert.equal(filterText(tree, intent), tabText(intent, 0))
  assert.equal(tree.all((element) => element.props['data-ciel-inbox-review'] !== undefined).length, 0)
  const summaries = statusSummaryNodes(tree)
  assert.ok(summaries.length <= 1, 'the anomaly summary must never be duplicated')
  if (summaries.length === 1) assert.doesNotMatch(tree.textOf(summaries[0]), /失败\s*[1-9]/, 'the empty page must not invent failures')
  assert.match(tree.text, /本页没有评审记录/)
})

test('counts are page-local: turning the page recomputes from the new page only', async () => {
  const pageOne = [
    reviewOf({ reviewId: 'p1', messageId: 'm-p1', annotations: [annotation(0, 'planned')] }),
    reviewOf({ reviewId: 'p2', messageId: 'm-p2', status: 'error', annotations: [] }),
  ]
  const pageTwo = [
    reviewOf({
      reviewId: 'p3', messageId: 'm-p3', status: 'completed',
      annotations: [annotation(0, 'rejected'), annotation(1, 'pending')],
    }),
  ]
  const { renderer, tree } = await mountPage([], {
    call: (method, request) => {
      if (method !== 'inboxList') throw new Error('unexpected method ' + method)
      if (request.cursor === undefined) return listResult('s1', pageOne, 'page:2')
      return listResult('s1', pageTwo, null)
    },
  })

  assert.equal(filterText(tree, 'all'), tabText('all', 2))
  assert.equal(filterText(tree, 'planned'), tabText('planned', 1))
  assert.equal(filterText(tree, 'rejected'), tabText('rejected', 0))
  assert.equal(statusSummaryNodes(tree).length, 1)
  assert.match(tree.textOf(statusSummaryNodes(tree)[0]), /失败\s*1/)

  const next = tree.find((element) => element.props['data-ciel-inbox-next'] !== undefined)
  assert.equal(next.props.disabled, false, 'page one must offer the next page')
  tree.click(next)
  await flush()
  const second = renderer.rerender()

  assert.equal(filterText(second, 'all'), tabText('all', 1), 'the all tab must count only the current page')
  assert.equal(filterText(second, 'rejected'), tabText('rejected', 1))
  assert.equal(filterText(second, 'pending'), tabText('pending', 1))
  assert.equal(filterText(second, 'planned'), tabText('planned', 0), 'page one planned count must not leak into page two')
  assert.deepEqual(reviewIds(second), ['p3'])
  assert.ok(statusSummaryNodes(second).length <= 1, 'the anomaly summary must never be duplicated')
  if (statusSummaryNodes(second).length === 1) assert.doesNotMatch(second.textOf(statusSummaryNodes(second)[0]), /失败\s*[1-9]/, 'page one\'s failure must not leak into page two')
  assert.match(pageInfo(second), /本页\s*1\s*条/)
  assert.match(pageInfo(second), /批注\s*2\s*条/)
})

// ── structural contract: hooks used by the browser verifier ───────────────

test('the count-fix surfaces the producer-side hooks the browser verifier selects', async () => {
  const { renderer, tree } = await mountPage(mixedReviews())
  // 单列异常汇总。
  assert.equal(statusSummaryNodes(tree).length, 1, 'data-ciel-inbox-status-summary must exist exactly once')
  // 筛选后有批注但无匹配的说明钩子。
  const planned = clickFilter(tree, renderer, 'planned')
  const stopCard = cardNode(planned, 'stop')
  assert.ok(matchingNote(planned, 'stop') !== undefined, 'a non-matching annotated card must carry data-ciel-inbox-no-matching-annotations')
  assert.match(planned.textOf(stopCard), /(?:无|没有)该意向批注/)
  // 0 批注仍用原有的 no-annotations 钩子。
  const partCard = cardNode(planned, 'part')
  assert.ok(descendants(partCard).some((element) => element.props['data-ciel-inbox-no-annotations'] !== undefined))
})
