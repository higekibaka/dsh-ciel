// Browser fixture entry for scripts/verify-sidebar-browser.mjs.
//
// esbuild bundles this file with the target checkout's REAL client sources:
// the test-support SlotTestRuntime (real Cordis Context + SlotRegistry + UI
// renderer), the resources + sidebar-right plugins, the native primitives, the
// real Lexical SessionInputShell, and React 18. The production plugin/client.js
// is injected separately and registers its factory on window.__ModuleLoader__.
//
// Only the Host data RPC and the settings-scope/composer wiring are fixtures;
// every service under test (slots, resources, sidebarRightTabs, RightbarSeat,
// dockkit, primitives, React) is the real implementation.
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import { SlotTestRuntime } from '@fixture/test-runtime'
import * as resourcesPlugin from '@fixture/resources'
import * as sidebarRightPlugin from '@fixture/sidebar-right'
import { LocaleRuntime } from '@fixture/locale'
import { dockPaneIds } from '@fixture/dockkit'
import { Tag } from '@fixture/tag'
import { Button } from '@fixture/button'
import { Switch } from '@fixture/switch'
import { SessionInputShell } from '@fixture/input-shell'
import { textDefinition } from '@fixture/document-definition'

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

const address = (protocol, sessionId, recordId, extraId) =>
  'dsh-resource://' + protocol + '/session/' + sessionId + '/' + recordId + (extraId === undefined ? '' : '/' + extraId)

// Synthetic, already-stored Host records. No real session content is involved.
// Real Host readReview value shape: schemaVersion 1, owning sessionId, and
// evidenceIds in the actual e1/e2 receipt syntax (not display-only ids).
const REVIEW_A = {
  schemaVersion: 1, sessionId: 's-a',
  reviewId: 'r-a', messageId: 'm-a', status: 'completed', verdict: 'changes', coverage: 'complete',
  summary: 'A 会话的评审摘要：已核实三行与边界。', createdAt: 0, workspaceRoot: '/work',
  limits: { mode: 'time', timeoutSeconds: 180 },
  explore: { limitMode: 'time', toolCalls: 75, timeoutSeconds: 180 },
  stats: { checked: 2, confirmed: 1, excluded: 1, unchecked: 0 },
  privacy: { mode: 'restricted-snapshot' },
  evidenceIds: ['e1'],
  blocks: [{ id: 'b1', type: 'paragraph' }, { id: 'b2', type: 'paragraph' }],
  annotations: [
    { severity: 'blocker', title: 'A 批注：行数不符', block: 'b1', anchor: '42', comment: '草稿声称 42 行，证据显示不是。', evidenceRefs: ['e1'] },
    { severity: 'nit', title: 'A 批注：措辞', anchor: '草稿声称 42 行', comment: '建议改写。' },
  ],
}
const REVIEW_B = {
  schemaVersion: 1, sessionId: 's-b',
  reviewId: 'r-b', messageId: 'm-b', status: 'sound', verdict: 'pass', coverage: 'complete',
  summary: 'B 会话的评审摘要。', createdAt: 0, workspaceRoot: '/work-b', evidenceIds: [], annotations: [],
}
const EVIDENCE = {
  e1: { id: 'e1', kind: 'source', path: 'src/a.ts', startLine: 10, endLine: 12, content: 'line ten\nline eleven\nline twelve', contentSha256: 'abcdef0123456789', capturedAt: 0, tool: 'read', truncated: false, status: 'available', currentPath: '/work/src/a.ts' },
  e2: { id: 'e2', kind: 'source', path: 'src/long.ts', startLine: 1, endLine: 1, content: 'const value = ' + 'x'.repeat(400), contentSha256: 'deadbeef', capturedAt: 0, tool: 'read', truncated: false, status: 'available', currentPath: '/work/src/long.ts' },
  e4: { id: 'e4', kind: 'source', path: '/external-1/notes.md', workspaceRoot: '/work', startLine: 3, content: 'historical external note', status: 'available', currentPath: '/external/notes #?.md' },
  e5: { id: 'e5', kind: 'source', path: '/project/unknown.ts', startLine: 7, content: 'historical unknown-root note', status: 'available', currentPath: '/unknown/src/a.ts' },
  e3: { id: 'e3', kind: 'source', path: 'src/secret.ts', startLine: 1, endLine: 1, content: 'SECRET-SNIPPET', capturedAt: 0, tool: 'read', status: 'withheld' },
}
const ADVICE = {
  'c-a': { callId: 'c-a', kind: 'tool', text: '顾问原始文本', items: [{ tier: 'high', title: '方向一', framing: '框架', pitfalls: '陷阱', verificationTarget: '验证' }], issues: ['问题一'], modelUsage: { used: [{ provider: 'fixture', model: 'fixed' }] }, createdAt: 0 },
}

function createRpc() {
  const calls = []
  const api = {
    async readReview(request) {
      calls.push({ method: 'readReview', request })
      const review = request.sessionId === 's-b' ? (request.reviewId === 'r-b' ? REVIEW_B : undefined) : request.reviewId === 'r-a' ? REVIEW_A : undefined
      return review === undefined ? { ok: false, error: 'fixture review not found' } : { ok: true, value: { ok: true, review } }
    },
    async readEvidence(request) {
      calls.push({ method: 'readEvidence', request })
      const evidence = EVIDENCE[request.evidenceId]
      return evidence === undefined ? { ok: false, error: 'fixture evidence not found' } : { ok: true, value: { ok: true, evidence } }
    },
    async readAdvice(request) {
      calls.push({ method: 'readAdvice', request })
      const advice = ADVICE[request.callId]
      return advice === undefined ? { ok: false, error: 'fixture advice not found' } : { ok: true, value: { ok: true, advice } }
    },
    async list(request) { calls.push({ method: 'list', request }); return { ok: true, value: { reviews: [], sentKeys: [], triage: {} } } },
    async progress(request) { calls.push({ method: 'progress', request }); return { ok: true, value: { inFlight: false } } },
    async cancel(request) { calls.push({ method: 'cancel', request }); return { ok: true, value: { cancelled: false } } },
    async triage(request) { calls.push({ method: 'triage', request }); return { ok: true, value: { ok: true } } },
    async prepareFeedback(request) {
      calls.push({ method: 'prepareFeedback', request })
      return { ok: true, value: { ok: true, sessionId: request.sessionId, reviewId: request.reviewId, messageId: request.messageId, text: '[advisor:review-feedback] 请人工核对\n\n### 批注\n证据待确认。' } }
    },
  }
  return { api, calls }
}

const settingsStub = {
  getSnapshot: () => ({ status: 'ready', mode: 'host', writable: true, value: {}, user: {}, revision: 0 }),
  subscribe: () => () => {},
  mutate: async () => {},
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) }

const handles = new Map()
let serial = 0

async function boot(options = {}) {
  const sessions = options.sessions || ['s-a', 's-b']
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('layout', { openRightbar() {}, closeRightbar() {} })
  await runtime.mount({ inject: [...resourcesPlugin.inject], apply: resourcesPlugin.apply })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
    'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    'settings.section': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  })
  for (const id of sessions) await runtime.sessions.add({ id }, { current: false })
  await runtime.sessions.setCurrent(sessions[0])
  await runtime.mount({ inject: [...sidebarRightPlugin.inject], apply: sidebarRightPlugin.apply })

  // Real Lexical-backed composer; only the sink is a fixture.
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

  // A fixture file viewer (not a mocked native service): it proves the
  // current-file / compare gesture carries the trusted path and line.
  runtime.ctx.sidebarRightTabs.register({ ...textDefinition(), id: 'fixture/file', kind: 'file', priority: 'builtin' })
  function FileBody(props) {
    const info = props.useTabInfo()
    const params = info.tab.navigation.params
    return React.createElement('span', {
      'data-fixture-file': '',
      'data-address': info.tab.contentId,
      'data-line': params !== undefined && params !== null && params.line !== undefined ? String(params.line) : '',
    })
  }
  runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'fixture/file' }, FileBody)

  const width = options.width || 420
  const view = runtime.renderSlot('rightbar', { width, viewportWidth: options.viewportWidth || 1440, canShow: true })
  // The static page ships a fixture chat shell (clearly marked); the button
  // mounts into its actions row so the production gutter/panel DOM surgery runs.
  const buttonHost = document.getElementById('ciel-button-host') ?? (() => {
    const el = document.createElement('div')
    el.id = 'ciel-button-host'
    document.body.appendChild(el)
    return el
  })()
  const messageBody = document.querySelector('[data-fixture-message-body]')
  if (messageBody !== null) {
    messageBody.innerHTML = '<p data-fixture-block="b1">这是一条被评审的草稿正文。草稿声称 42 行，但实际文件只有 3 行；这里补足足够长的正文文本，让 gutter 徽章与 proximity 划线都能命中。</p><p data-fixture-block="b2">第二段正文用于让候选块与块地图按类型对齐。</p>'
  }
  const id = 'h' + (++serial)
  const handle = { id, runtime, module, exports, rpc, shell, view, buttonHost, buttonRoot: null, width }
  handles.set(id, handle)
  return {
    id,
    tabs: ['ciel-review', 'ciel-evidence', 'ciel-advice'].filter((kind) => runtime.ctx.sidebarRightTabs.get(kind) !== undefined),
    buttonEntries: runtime.slots.entries('conversation.chat.assistant-actions').map((entry) => entry?.options?.id ?? entry?.options?.key ?? null),
    remoteMethods: exports.__test.remoteMethodNames,
    panel: view.container.querySelector('[data-sidebar-right-panel]') !== null,
    slotSpecs: ['conversation.chat.assistant-actions', 'conversation.chat', 'settings.section', 'rightbar', 'rightbar.session', 'shell.overlay', 'tool.call.toolview']
      .map((key) => [key, runtime.slots._core?.specDynamic?.(key) !== undefined]),
  }
}

async function openResource(handle, kind, address) {
  await runtimeAct(handle, () => handle.runtime.ctx.sidebarRight.openResource(address, { kind }))
  await flush()
}
const runtimeAct = async (handle, fn) => { await React.act(async () => { fn() }) }

async function call(handleId, method, args = {}) {
  const handle = handles.get(handleId)
  if (!handle) throw new Error('unknown fixture handle ' + handleId)
  const { runtime, exports, view, rpc } = handle
  const container = view.container
  switch (method) {
    case 'reviewAddress': return address('ciel-review', args.sessionId, args.reviewId)
    case 'evidenceAddress': return address('ciel-evidence', args.sessionId, args.reviewId, args.evidenceId)
    case 'adviceAddress': return address('ciel-advice', args.sessionId, args.callId)
    case 'open': await openResource(handle, args.kind, args.address); return { ok: true }
    case 'text': return container.textContent
    case 'count': return container.querySelectorAll(args.selector).length
    case 'attr': {
      const node = container.querySelector(args.selector)
      return node === null ? null : node.getAttribute(args.attr)
    }
    case 'computed': {
      const node = container.querySelector(args.selector)
      return node === null ? null : getComputedStyle(node)[args.prop]
    }
    case 'click': {
      const node = container.querySelector(args.selector)
      if (node === null) throw new Error('no node for ' + args.selector)
      await React.act(async () => { node.click(); await flush() })
      return { ok: true }
    }
    case 'lineNumbers': return [...container.querySelectorAll('[data-ciel-line]')].map((node) => node.getAttribute('data-ciel-line'))
    case 'has': return container.querySelector(args.selector) !== null
    case 'buttonRegistered': return runtime.slots.entries('conversation.chat.assistant-actions').some((entry) => (entry?.options?.id ?? entry?.options?.key) === 'advisor-review')
    case 'renderButton': {
      if (handle.buttonRoot === null) handle.buttonRoot = createRoot(handle.buttonHost)
      exports.__test.runtime.absorb({
        schemaVersion: 1, sessionId: 's-a',
        reviewId: 'r-a', messageId: args.messageId, status: 'incomplete', verdict: 'pass', coverage: 'partial',
        createdAt: 1, summary: '2 项疑点，1 项排除',
        stats: { checked: 2, confirmed: 0, excluded: 1, unchecked: 1 },
        privacy: { mode: 'restricted-snapshot' },
        evidenceIds: ['e1'],
        blocks: [{ id: 'b1', type: 'paragraph' }, { id: 'b2', type: 'paragraph' }],
        annotations: [
          { severity: 'blocker', title: 'A 批注：行数不符', block: 'b1', anchor: '42', comment: '草稿声称 42 行，证据显示不是。', evidenceRefs: ['e1'] },
          { severity: 'nit', title: 'A 批注：措辞', anchor: '草稿声称 42 行', comment: '建议改写。' },
        ],
      })
      await React.act(async () => { handle.buttonRoot.render(React.createElement(exports.__test.runtime.ReviewButton, { sessionId: args.sessionId, messageId: args.messageId })) })
      await flush()
      await flush()
      return { ok: true }
    }
    case 'chatState': {
      const shell = document.getElementById('ciel-chat-shell')
      return {
        gutter: shell.querySelectorAll('.dsr-gutter').length,
        gmarks: shell.querySelectorAll('.dsr-gmark').length,
        marks: shell.querySelectorAll('.dsr-mark').length,
        badges: shell.querySelectorAll('.dsr-badge').length,
        panel: shell.querySelectorAll('.dsr-tail').length,
        lightweight: shell.querySelectorAll('.ciel-review-summary').length,
        legacyDetails: shell.querySelectorAll('.dsr-details').length,
        legacyBoxes: shell.querySelectorAll('.dsrf-box').length,
        tagMounts: shell.querySelectorAll('.ciel-native-tag-mount').length,
        nativeTags: shell.querySelectorAll('.ciel-native-tag-mount [data-tone]').length,
        summaryButtons: shell.querySelectorAll('.ciel-open-review').length,
        summaryButtonText: shell.querySelector('.ciel-open-review')?.textContent ?? '',
        panelText: shell.querySelector('.dsr-tail')?.textContent ?? '',
      }
    }
    case 'clickChat': {
      const node = document.querySelector(args.selector)
      if (node === null) throw new Error('no chat node for ' + args.selector)
      await React.act(async () => { node.click(); await flush() })
      await flush()
      return { ok: true }
    }
    case 'activeTab': {
      const tab = runtime.ctx.sidebarRight.active()
      return tab === undefined || tab === null ? null : { contentId: tab.contentId, params: tab.navigation?.params ?? null }
    }
    case 'focusIndex': return view.container.querySelector('[data-ciel-review]')?.getAttribute('data-ciel-focus-index') ?? null
    case 'focusedAnnotation': {
      const node = view.container.querySelector('[data-ciel-focus]')
      return node === null ? null : node.getAttribute('data-ciel-annotation')
    }
    case 'setTheme': {
      if (args.dark) document.body.setAttribute('data-ds-dark-theme', '')
      else document.body.removeAttribute('data-ds-dark-theme')
      await flush()
      return { ok: true }
    }
    case 'chatText': return document.getElementById('ciel-chat-shell').textContent
    case 'buttonText': return handle.buttonHost.textContent
    case 'buttonHtml': return handle.buttonHost.innerHTML
    case 'draft': return handle.shell.snapshot.draft
    case 'setDraft': handle.shell.setDraft(args.text); return { ok: true }
    case 'rpcCalls': return rpc.calls.filter((entry) => args.method === undefined || entry.method === args.method)
    case 'setCurrent': await runtime.sessions.setCurrent(args.sessionId); await flush(); return { ok: true }
    case 'setMainPanel':
      await React.act(async () => { runtime.panelInfo.set({ activePanelId: args.id ?? null }); await flush() })
      return { ok: true }
    case 'acceptsFileAddress': return textDefinition().canOpen(args.address)
    case 'resourceStatus': return runtime.ctx.resources.source(args.address).getSnapshot().status
    case 'resourceValue': return runtime.ctx.resources.source(args.address).getSnapshot().value === undefined ? null : 'present'
    case 'closeTab': {
      const layout = runtime.storeOf('rightbar.session', args.sessionId).getSnapshot().bySession[args.sessionId].layout
      const tab = Object.values(layout.tabs).find((entry) => entry.contentId === args.address)
      if (tab === undefined) return { closed: false }
      await React.act(async () => { runtime.ctx.sidebarRight.close(tab.id); await flush() })
      return { closed: true }
    }
    case 'openTabIds': {
      const layout = runtime.storeOf('rightbar.session', args.sessionId).getSnapshot().bySession[args.sessionId].layout
      return Object.values(layout.tabs).map((entry) => entry.contentId)
    }
    case 'paneCount': {
      const layout = runtime.storeOf('rightbar.session', args.sessionId).getSnapshot().bySession[args.sessionId].layout
      return dockPaneIds(layout).length
    }
    case 'fileTabs': return [...container.querySelectorAll('[data-fixture-file]')].map((node) => ({ address: node.getAttribute('data-address'), line: node.getAttribute('data-line') }))
    case 'bodyScrollWidth': return { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth }
    case 'bodyScrollWidthOf': {
      const node = container.querySelector(args.selector)
      return node === null ? null : { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
    }
    case 'dispose': {
      await React.act(async () => { await runtime.dispose(); await flush() })
      handles.delete(handleId)
      return { ok: true }
    }
    default: throw new Error('unknown fixture method ' + method)
  }
}

window.__cielBrowser = { boot, call, addresses: { reviewAddress: (s, r) => address('ciel-review', s, r) } }
window.__cielReady = true
