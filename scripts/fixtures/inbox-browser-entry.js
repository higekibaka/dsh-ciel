/**
 * Browser fixture entry for scripts/verify-inbox-browser.mjs.
 *
 * esbuild bundles this file with the isolated checkout's REAL client sources:
 * the test-support SlotTestRuntime (real Cordis Context + SlotRegistry + UI
 * renderer), the ui-sidebar global-panel shell, ui-sidebar-right, resources,
 * locale, dockkit, the native primitives, the real Lexical SessionInputShell,
 * and React 18. The GENERATED production plugin/client.js is injected
 * separately and registers its factory on window.__ModuleLoader__.
 *
 * Only the Host data RPC, the panel-selection layout face, the settings scope,
 * and the composer sink are fixtures. Everything the inbox UI is built on
 * (ctx.slots, sidebar.panellist/main seat, React, native primitives) is the
 * real target implementation. No server, no DSH_HOME, no model call, no
 * external network request.
 *
 * The Host RPC fixture mirrors plugin/inbox-service.js exactly:
 *   inboxList(request) -> { ok:true, sessionId, reviews, nextCursor, limited }
 *                      | { ok:false, code, error }
 *   inboxSetIntent(request) -> { ok:true, sessionId, reviewId, reviewFingerprint,
 *                                revision, intents } | { ok:false, code, error }
 * Each business value travels inside the real transport envelope
 * ({ ok:true, value }) because the production client unwraps it.
 */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SlotTestRuntime } from '@fixture/test-runtime'
import * as resourcesPlugin from '@fixture/resources'
import * as sidebarRightPlugin from '@fixture/sidebar-right'
import * as uiSidebarPlugin from '@fixture/ui-sidebar'
import { LocaleRuntime } from '@fixture/locale'
import { zh as commonZh, en as commonEn } from '@fixture/common-locale'
import { dockPaneIds } from '@fixture/dockkit'
import { Tag } from '@fixture/tag'
import { Button } from '@fixture/button'
import { Switch } from '@fixture/switch'
import { SessionInputShell } from '@fixture/input-shell'
import { textDefinition } from '@fixture/document-definition'

const h = React.createElement
window.IS_REACT_ACT_ENVIRONMENT = true

const captured = []
window.__ModuleLoader__ = {
  load(module) { captured.push(module); return module },
}
function clientModule() {
  const found = captured.find((entry) => entry.id === 'dsh-ciel')
  if (!found) throw new Error('production plugin/client.js did not register with __ModuleLoader__')
  return found
}
function clientRequire(name) {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tag, Button, Switch }
  throw new Error('unexpected production require: ' + name)
}

const MESSAGES = {
  invalid_session: '会话标识无效',
  invalid_limit: '分页大小必须是 1 到 25 之间的整数',
  invalid_cursor: '分页游标无效',
  invalid_review_id: '评审标识无效',
  invalid_fingerprint: '评审内容指纹无效',
  invalid_revision: '期望版本无效',
  invalid_index: '批注序号无效',
  invalid_intent: '意向取值无效',
  review_not_found: '评审记录不存在或不属于此会话',
  fingerprint_mismatch: '评审内容已变化，内容指纹不匹配；请刷新后重试',
  revision_conflict: '评审意向已被其他操作更新；请刷新后重试',
  record_corrupt: '收件箱或评审记录损坏、身份不符或状态失配；未作降级处理',
  write_failed: '收件箱写入失败；状态未更新',
  store_error: '记录存储不可用',
}

/** Stable 64-hex digest stand-in (opaque to the UI; it only echoes it back). */
function fakeFingerprint(seed) {
  let out = ''
  let acc = 2166136261
  for (let block = 0; out.length < 64; block++) {
    for (const ch of seed + '|' + block) {
      acc ^= ch.codePointAt(0)
      acc = Math.imul(acc, 16777619) >>> 0
    }
    out += acc.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

function annotation(severity, title, anchor, comment, evidenceRefs) {
  return { severity, title, anchor, comment, ...(evidenceRefs === undefined ? {} : { evidenceRefs }) }
}

const EVIDENCE = {
  e1: { id: 'e1', kind: 'source', path: 'src/a.ts', startLine: 10, endLine: 12, content: 'line ten\nline eleven\nline twelve', contentSha256: 'abcdef0123456789', capturedAt: 0, tool: 'read', truncated: false, status: 'available', currentPath: '/work/src/a.ts' },
  e2: { id: 'e2', kind: 'source', path: 'src/b.ts', startLine: 3, endLine: 3, content: 'const b = 2', contentSha256: 'deadbeef', capturedAt: 0, tool: 'read', truncated: false, status: 'available', currentPath: '/work/src/b.ts' },
}

function review(sessionId, reviewId, fields) {
  return {
    sessionId,
    reviewId,
    messageId: fields.messageId || ('m-' + reviewId),
    ...(fields.anchorSeq === undefined ? {} : { anchorSeq: fields.anchorSeq }),
    createdAt: fields.createdAt === undefined ? 0 : fields.createdAt,
    status: fields.status || 'completed',
    ...(fields.verdict === undefined ? {} : { verdict: fields.verdict }),
    ...(fields.summary === undefined ? {} : { summary: fields.summary }),
    ...(fields.coverage === undefined ? {} : { coverage: fields.coverage }),
    annotations: fields.annotations || [],
  }
}

function buildReviews() {
  const all = {}
  all['s-a'] = [
    // A completed review must carry the legal "complete" coverage: the host
    // classifies a partial coverage as incomplete, so completed+partial is not a
    // real combination.
    review('s-a', 'r-a1', {
      messageId: 'm-a', anchorSeq: 12, createdAt: 300, status: 'completed', verdict: 'changes', coverage: 'complete',
      summary: 'A1 摘要：两处疑点待确认',
      annotations: [
        annotation('blocker', '行数不符', '草稿声称 42 行', '草稿声称 42 行，证据显示不是。', ['e1']),
        annotation('nit', '措辞偏强', '草稿声称', '建议改成保守表述。'),
        annotation('blocker', '缺少证据', '证据缺失处', '缺少独立证据。', ['e2']),
      ],
    }),
    review('s-a', 'r-a2', {
      messageId: 'm-a2', createdAt: 200, status: 'incomplete', verdict: 'pass', coverage: 'partial',
      summary: 'A2 摘要：一项疑点',
      annotations: [annotation('nit', '标题偏长', '第二段正文', '标题可以更短。')],
    }),
    // Anomalous groups with no annotations must survive every intent filter.
    review('s-a', 'r-a3', {
      messageId: 'm-a3', createdAt: 150, status: 'failed', summary: 'A3 摘要：评审失败',
      annotations: [],
    }),
    review('s-a', 'r-a4', {
      messageId: 'm-a4', createdAt: 120, status: 'cancelled', summary: 'A4 摘要：评审已取消',
      annotations: [],
    }),
  ]
  all['s-b'] = [
    review('s-b', 'r-b1', {
      messageId: 'm-b', createdAt: 100, status: 'sound', verdict: 'pass', coverage: 'complete',
      summary: 'B1 摘要：会话 B 的声音',
      annotations: [annotation('nit', 'B 批注', 'B 会话锚点', 'B 会话评论。')],
    }),
  ]
  const page = []
  for (let i = 1; i <= 27; i++) {
    const id = 'r-p' + String(i).padStart(2, '0')
    page.push(review('s-page', id, {
      messageId: 'm-' + id, createdAt: 1000 - i, status: 'completed', verdict: 'pass', coverage: 'complete',
      summary: 'P' + String(i).padStart(2, '0') + ' 摘要',
      annotations: [annotation('nit', 'P 批注 ' + i, 'P 锚点 ' + i, 'P 评论 ' + i)],
    }))
  }
  all['s-page'] = page
  return all
}

// ── fixture inbox RPC (mirrors plugin/inbox-service.js semantics) ────────────
function createRpc() {
  const reviews = buildReviews()
  const store = new Map()
  const calls = []
  const state = { listFail: false, intentConflict: false, writeFail: false, modelCalls: 0, intentWrites: 0 }
  const key = (sessionId, reviewId) => String(sessionId) + '\\u0000' + String(reviewId)
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const fpOf = (value) => fakeFingerprint(value.sessionId + '/' + value.reviewId + '/' + JSON.stringify(value.annotations))
  const invalid = (code) => ({ ok: false, code, error: MESSAGES[code] || MESSAGES.store_error })

  function project(value) {
    const fingerprint = fpOf(value)
    const stored = store.get(key(value.sessionId, value.reviewId))
    let revision = 0
    let intents = {}
    if (stored !== undefined && stored.reviewFingerprint === fingerprint) {
      revision = stored.revision
      intents = { ...stored.intents }
    }
    return {
      sessionId: value.sessionId,
      reviewId: value.reviewId,
      messageId: value.messageId,
      ...(value.anchorSeq === undefined ? {} : { anchorSeq: value.anchorSeq }),
      createdAt: value.createdAt,
      status: value.status,
      ...(value.verdict === undefined ? {} : { verdict: value.verdict }),
      ...(value.summary === undefined || value.summary === '' ? {} : { summary: value.summary }),
      ...(value.coverage === undefined ? {} : { coverage: value.coverage }),
      reviewFingerprint: fingerprint,
      revision,
      annotations: value.annotations.map((item, index) => ({
        index,
        severity: item.severity === 'blocker' ? 'blocker' : 'nit',
        title: item.title || '',
        anchor: item.anchor || '',
        comment: item.comment || '',
        intent: intents[index] || 'pending',
        ...(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 ? { evidenceIds: item.evidenceRefs.slice(0, 16) } : {}),
      })),
    }
  }

  const api = {
    async inboxList(request) {
      calls.push({ method: 'inboxList', request: clone(request) })
      if (state.listFail) return { ok: true, value: invalid('store_error') }
      const sessionId = request?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return { ok: true, value: invalid('invalid_session') }
      let limit = request?.limit === undefined || request?.limit === null ? 25 : request.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) return { ok: true, value: invalid('invalid_limit') }
      const all = reviews[sessionId] || []
      let offset = 0
      if (request?.cursor !== undefined && request?.cursor !== null) {
        const matched = /^page:(\d+)$/.exec(String(request.cursor))
        if (matched === null) return { ok: true, value: invalid('invalid_cursor') }
        offset = Number(matched[1])
      }
      const page = all.slice(offset, offset + limit)
      const nextCursor = offset + limit < all.length ? 'page:' + (offset + limit) : null
      return { ok: true, value: { ok: true, sessionId, reviews: page.map(project), nextCursor, limited: false } }
    },
    async inboxSetIntent(request) {
      calls.push({ method: 'inboxSetIntent', request: clone(request) })
      const sessionId = request?.sessionId
      const reviewId = request?.reviewId
      if (typeof reviewId !== 'string' || reviewId === '') return { ok: true, value: invalid('invalid_review_id') }
      if (state.intentConflict) return { ok: true, value: invalid('revision_conflict') }
      if (state.writeFail) return { ok: true, value: invalid('write_failed') }
      const found = (reviews[sessionId] || []).find((item) => item.reviewId === reviewId)
      if (found === undefined) return { ok: true, value: invalid('review_not_found') }
      const fingerprint = fpOf(found)
      if (request?.reviewFingerprint !== fingerprint) return { ok: true, value: invalid('fingerprint_mismatch') }
      if (!Number.isInteger(request?.index) || request.index < 0 || request.index >= found.annotations.length) return { ok: true, value: invalid('invalid_index') }
      if (!['pending', 'planned', 'rejected'].includes(request?.intent)) return { ok: true, value: invalid('invalid_intent') }
      const stored = store.get(key(sessionId, reviewId))
      const baseRevision = stored !== undefined && stored.reviewFingerprint === fingerprint ? stored.revision : 0
      const baseIntents = stored !== undefined && stored.reviewFingerprint === fingerprint ? { ...stored.intents } : {}
      if (request?.expectedRevision !== baseRevision) return { ok: true, value: invalid('revision_conflict') }
      if (request.intent === 'pending') delete baseIntents[request.index]
      else baseIntents[request.index] = request.intent
      const revision = baseRevision + 1
      store.set(key(sessionId, reviewId), { reviewFingerprint: fingerprint, revision, intents: baseIntents })
      state.intentWrites += 1
      return { ok: true, value: { ok: true, sessionId, reviewId, reviewFingerprint: fingerprint, revision, intents: baseIntents } }
    },
    // ── pre-existing advisorReview surface the rest of the client expects ──
    async readReview(request) {
      calls.push({ method: 'readReview', request: clone(request) })
      const value = (reviews[request.sessionId] || []).find((item) => item.reviewId === request.reviewId)
      return value === undefined ? { ok: false, error: 'fixture review not found' } : { ok: true, value: { ok: true, review: value } }
    },
    async readEvidence(request) {
      calls.push({ method: 'readEvidence', request: clone(request) })
      const evidence = EVIDENCE[request.evidenceId]
      return evidence === undefined ? { ok: false, error: 'fixture evidence not found' } : { ok: true, value: { ok: true, evidence } }
    },
    async readAdvice(request) { calls.push({ method: 'readAdvice', request: clone(request) }); return { ok: false, error: 'fixture advice not found' } },
    async list(request) { calls.push({ method: 'list', request: clone(request) }); return { ok: true, value: { reviews: [], sentKeys: [], triage: {} } } },
    async progress(request) { calls.push({ method: 'progress', request: clone(request) }); return { ok: true, value: { inFlight: false } } },
    async cancel(request) { calls.push({ method: 'cancel', request: clone(request) }); return { ok: true, value: { cancelled: false } } },
    async triage(request) { calls.push({ method: 'triage', request: clone(request) }); return { ok: true, value: { ok: true } } },
    async prepareFeedback(request) { calls.push({ method: 'prepareFeedback', request: clone(request) }); return { ok: true, value: { ok: true, sessionId: request.sessionId, reviewId: request.reviewId, messageId: request.messageId, text: '[advisor:review-feedback] 请人工核对\n\n### 批注\n证据待确认。' } } },
  }
  return { api, calls, state }
}

const settingsStub = {
  getSnapshot: () => ({ status: 'ready', mode: 'host', writable: true, value: {}, user: {}, revision: 0 }),
  subscribe: () => () => {},
  mutate: async () => {},
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }
const flushMicro = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }

const handles = new Map()
let serial = 0

/**
 * Fixture-owned chrome sizing. It is a real external store (not a mutable plain
 * object) so the frame re-renders when the narrow-viewport step changes it, and
 * it mirrors what the real app frame does on a phone-width viewport: collapse
 * the left sidebar to its 56px rail and drop the right column for a global panel.
 */
const frameStore = {
  value: { sidebarWidth: 300, sidebarCollapsed: false, showRight: true },
  listeners: new Set(),
  get: () => frameStore.value,
  set: (patch) => { frameStore.value = { ...frameStore.value, ...patch }; for (const listener of [...frameStore.listeners]) listener() },
  subscribe: (listener) => { frameStore.listeners.add(listener); return () => { frameStore.listeners.delete(listener) } },
}

/** Root frame: the real sidebar shell beside the real keyed main panel. */
function inboxFrame(props) {
  const config = React.useSyncExternalStore(frameStore.subscribe, frameStore.get, frameStore.get)
  const activePanelId = props.usePanelInfo((info) => info.activePanelId)
  return h('div', { id: 'inbox-app', style: { display: 'flex', minHeight: '100vh', alignItems: 'stretch' } },
    h('aside', { id: 'inbox-sidebar', style: { flex: '0 0 auto' } },
      props.renderSlot('sidebar', { collapsed: config.sidebarCollapsed === true, width: config.sidebarWidth })),
    h('main', { id: 'inbox-main', style: { flex: '1 1 auto', minWidth: 0 } },
      props.renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })),
    config.showRight
      ? h('section', { id: 'inbox-right', style: { flex: '0 0 auto' } },
          props.renderSlot('rightbar', { width: 420, viewportWidth: 1440, canShow: true }))
      : null)
}

async function boot(options = {}) {
  const sessions = options.sessions || ['s-a', 's-b', 's-page']
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register('common', { zh: commonZh, en: commonEn }), 'inbox fixture: common locale')
  runtime.ctx.provide('layout', {
    beginNavigation: () => new AbortController().signal,
    toggleSidebar: () => {},
    selectPanel: (id) => { runtime.panelInfo.set({ activePanelId: id ?? null }) },
    openRightbar: () => {},
    closeRightbar: () => {},
  })
  runtime.ctx.provide('uiWorkspace', { startSession: () => {} })
  await runtime.mount({ inject: [...resourcesPlugin.inject], apply: resourcesPlugin.apply })
  await runtime.mount({ inject: [...sidebarRightPlugin.inject], apply: sidebarRightPlugin.apply })

  // Declare the root frame BEFORE ui-sidebar claims its children and the
  // production plugin registers its global panel + main body.
  await runtime.root.declare({
    sidebar: { kind: 'single', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
    'rightbar': { kind: 'single', scope: 'root' },
    'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    'settings.section': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  }, inboxFrame)
  await runtime.mount({ inject: [...uiSidebarPlugin.inject], apply: uiSidebarPlugin.apply })
  // Fallback main entry so an empty selection still renders a page.
  runtime.ctx.slots.inject('main', () => runtime.ctx.slots.register({ name: 'main', key: 'conversation' },
    () => h('div', { 'data-fixture-conversation': '' }, '会话正文（fixture 兜底）')))
  for (const id of sessions) await runtime.sessions.add({ id }, { current: false })
  await runtime.sessions.setCurrent(sessions[0])

  const shell = new SessionInputShell({
    actx: runtime.ctx,
    defaultSink: async () => { throw new Error('fixture composer: model sends are forbidden') },
    commandAttachments: { serialize: async () => [], release() {}, unsupportedNotice: () => 'unsupported' },
  })
  runtime.ctx.on('slash/input-insert-text', (request) => (shell.insertText(request.text, request.span) ? true : undefined))
  runtime.ctx.provide('conversation', { input: { for: () => shell } })

  const rpc = createRpc()
  runtime.ctx.provide('remote', {
    $mount: async () => { runtime.ctx.provide('remote.advisorReview', rpc.api); return () => {} },
    $on: () => () => {},
  })
  runtime.ctx.provide('remote.session', { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) })
  runtime.ctx.provide('settingsScope', { bind: () => settingsStub })

  const module = clientModule()
  const exports = module.factory(clientRequire)
  exports.apply(runtime.ctx)
  await flush()
  await flushMicro()

  const view = runtime.renderRoot()
  const id = 'h' + (++serial)
  const handle = { id, runtime, module, exports, rpc, shell, view, width: options.width || 300 }
  handles.set(id, handle)
  const optionsOf = (entry) => entry?.options ?? entry ?? {}
  const labelOf = (options) => {
    const label = options.label
    if (typeof label === 'function') { try { return String(label()) } catch { return '(label fn)' } }
    return label === undefined || label === null ? null : String(label)
  }
  return {
    id,
    panelEntries: runtime.ctx.slots.entriesOfSlot('sidebar.panellist').map((entry) => {
      const options = optionsOf(entry)
      return { id: options.id ?? null, order: options.order ?? 0, label: labelOf(options) }
    }),
    mainEntries: runtime.ctx.slots.entriesOfSlot('main').map((entry) => optionsOf(entry).key ?? null),
    remoteMethods: (exports.__test && exports.__test.remoteMethodNames) || [],
    sidebarButtons: [...view.container.querySelectorAll('nav button')].map((node) => ({ text: node.textContent, ariaLabel: node.getAttribute('aria-label'), current: node.getAttribute('aria-current') })),
  }
}

async function act(handle, fn) { await React.act(async () => { fn(); await flush() }) }

function nodeAttrs(node) {
  const data = {}
  for (const attr of node.attributes || []) if (attr.name.startsWith('data-')) data[attr.name] = attr.value
  return data
}
function describe(node) {
  return {
    tag: node.tagName.toLowerCase(),
    text: (node.textContent || '').trim().slice(0, 200),
    ariaLabel: node.getAttribute('aria-label'),
    title: node.getAttribute('title'),
    role: node.getAttribute('role'),
    disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
    data: nodeAttrs(node),
  }
}
function clickablesIn(root) {
  return [...root.querySelectorAll('button, [role="button"], a, input, select, textarea, label')].map(describe)
}

async function call(handleId, method, args = {}) {
  const handle = handles.get(handleId)
  if (!handle) throw new Error('unknown fixture handle ' + handleId)
  const { runtime, exports, view, rpc } = handle
  const container = view.container
  const main = () => container.querySelector('[data-slot="main"]') || container
  const pick = (selector) => {
    const node = container.querySelector(selector)
    if (node === null) throw new Error('no node for selector ' + JSON.stringify(selector))
    return node
  }
  switch (method) {
    case 'flush': await flushMicro(); return { ok: true }
    case 'panelEntries': {
      return runtime.ctx.slots.entriesOfSlot('sidebar.panellist').map((entry) => {
        const options = entry?.options ?? {}
        const label = typeof options.label === 'function' ? (() => { try { return String(options.label()) } catch { return null } })() : (options.label ?? null)
        return { id: options.id ?? null, order: options.order ?? 0, label: label === null || label === undefined ? null : String(label) }
      })
    }
    case 'mainEntries': return runtime.ctx.slots.entriesOfSlot('main').map((entry) => (entry?.options ?? {}).key ?? null)
    case 'remoteMethods': return (exports.__test && exports.__test.remoteMethodNames) || []
    case 'activePanel': return runtime.panelInfo.getSnapshot().activePanelId ?? null
    case 'text': return container.textContent
    case 'textOf': { const node = container.querySelector(args.selector); return node === null ? null : (node.textContent || '').trim() }
    case 'texts': return [...container.querySelectorAll(args.selector)].map((node) => (node.textContent || '').trim())
    case 'mainText': return main().textContent
    case 'html': return (main().innerHTML || '').slice(0, args.limit || 20000)
    case 'has': return container.querySelector(args.selector) !== null
    case 'count': return container.querySelectorAll(args.selector).length
    case 'attr': { const node = container.querySelector(args.selector); return node === null ? null : node.getAttribute(args.attr) }
    case 'attrs': { const node = container.querySelector(args.selector); return node === null ? null : describe(node) }
    case 'computed': { const node = container.querySelector(args.selector); return node === null ? null : getComputedStyle(node)[args.prop] }
    case 'queryAll': return [...container.querySelectorAll(args.selector)].map(describe)
    case 'clickables': return clickablesIn(container)
    case 'dataAttributes': {
      const names = new Set()
      for (const node of container.querySelectorAll('*')) for (const attr of node.attributes || []) if (attr.name.startsWith('data-')) names.add(attr.name)
      return [...names].sort()
    }
    case 'click':
      await act(handle, () => pick(args.selector).click())
      await flushMicro()
      return { ok: true }
    case 'clickIf':
      if (container.querySelector(args.selector) === null) return { ok: false }
      await act(handle, () => container.querySelector(args.selector).click())
      await flushMicro()
      return { ok: true }
    case 'clickText': {
      const wanted = String(args.text)
      const nodes = [...container.querySelectorAll(args.selector || 'button, [role="button"], a, label, input')]
      const node = nodes.find((item) => ((item.textContent || '') + ' ' + (item.getAttribute('aria-label') || '')).includes(wanted))
      if (node === undefined) throw new Error('no clickable containing text ' + JSON.stringify(wanted))
      await act(handle, () => node.click())
      await flushMicro()
      return { ok: true }
    }
    case 'clickFirstText': {
      const scope = args.scope === 'main' ? main() : container
      const labels = (args.labels || []).map(String)
      const nodes = [...scope.querySelectorAll(args.selector || 'button, [role="button"], a, input, label, [role="radio"], [role="tab"]')]
      for (const node of nodes) {
        const hay = ((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('title') || '')).trim()
        const hit = labels.find((label) => hay.includes(label))
        if (hit === undefined || node.disabled === true) continue
        await act(handle, () => node.click())
        await flushMicro()
        return { ok: true, matched: hit, node: describe(node) }
      }
      return { ok: false, tried: labels, available: nodes.map(describe).slice(0, 40) }
    }
    case 'mainHasText': return (main().textContent || '').includes(String(args.text))
    case 'clickPanel': {
      const wanted = String(args.label || '收件箱')
      const nodes = [...container.querySelectorAll('nav button')]
      const node = nodes.find((item) => ((item.textContent || '') + ' ' + (item.getAttribute('aria-label') || '')).includes(wanted))
      if (node === undefined) throw new Error('no global panel row for ' + JSON.stringify(wanted))
      await act(handle, () => node.click())
      await flushMicro()
      return { ok: true, active: runtime.panelInfo.getSnapshot().activePanelId ?? null }
    }
    case 'setCurrent': await runtime.sessions.setCurrent(args.sessionId); await flushMicro(); return { ok: true }
    case 'selectPanel': runtime.ctx.get('layout').selectPanel(args.id === undefined ? null : args.id); await flushMicro(); return { active: runtime.panelInfo.getSnapshot().activePanelId ?? null }
    case 'setFrame': {
      const patch = {}
      if (args.sidebarWidth !== undefined) patch.sidebarWidth = args.sidebarWidth
      if (args.sidebarCollapsed !== undefined) patch.sidebarCollapsed = args.sidebarCollapsed === true
      if (args.showRight !== undefined) patch.showRight = args.showRight === true
      await act(handle, () => { frameStore.set(patch) })
      await flushMicro()
      return { ...frameStore.value }
    }
    case 'rpcCalls': return rpc.calls.filter((entry) => args.method === undefined || entry.method === args.method)
    case 'clearRpcCalls': rpc.calls.length = 0; return { ok: true }
    case 'fixture': {
      if (args.state) Object.assign(rpc.state, args.state)
      return { ...rpc.state }
    }
    case 'setDraft': handle.shell.setDraft(String(args.text)); await flushMicro(); return { ok: true }
    case 'draft': return handle.shell.snapshot.draft
    case 'docCount': return document.querySelectorAll(args.selector).length
    case 'docAttr': { const node = document.querySelector(args.selector); return node === null ? null : node.getAttribute(args.attr) }
    case 'docScrollTop': { const node = document.querySelector(args.selector); return node === null ? null : node.scrollTop }
    case 'removeChatAnchor': {
      for (const node of document.querySelectorAll(args.selector)) node.remove()
      return { remaining: document.querySelectorAll(args.selector).length }
    }
    case 'bodyScrollWidth': return { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth }
    case 'bodyScrollWidthOf': { const node = container.querySelector(args.selector); return node === null ? null : { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth } }
    case 'rect': { const node = container.querySelector(args.selector); if (node === null) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    case 'probe': {
      const panelNav = container.querySelector('nav');
      return {
        panelEntries: runtime.ctx.slots.entriesOfSlot('sidebar.panellist').map((entry) => { const o = entry?.options ?? {}; return { id: o.id ?? null, order: o.order ?? 0, label: typeof o.label === 'function' ? (() => { try { return String(o.label()) } catch { return null } })() : (o.label ?? null) } }),
        mainEntries: runtime.ctx.slots.entriesOfSlot('main').map((entry) => (entry?.options ?? {}).key ?? null),
        remoteMethods: (exports.__test && exports.__test.remoteMethodNames) || [],
        activePanel: runtime.panelInfo.getSnapshot().activePanelId ?? null,
        sidebarNav: panelNav === null ? null : { ariaLabel: panelNav.getAttribute('aria-label'), buttons: [...panelNav.querySelectorAll('button')].map(describe) },
        mainHtml: (main().innerHTML || '').slice(0, 40000),
        dataAttributes: (() => { const names = new Set(); for (const node of container.querySelectorAll('*')) for (const attr of node.attributes || []) if (attr.name.startsWith('data-')) names.add(attr.name); return [...names].sort() })(),
        clickables: clickablesIn(main()),
      }
    }
    case 'dispose': {
      await React.act(async () => { await runtime.dispose(); await flush() })
      handles.delete(handleId)
      return { ok: true }
    }
    default: throw new Error('unknown fixture method ' + method)
  }
}

window.__cielInbox = { boot, call }
window.__cielReady = true
