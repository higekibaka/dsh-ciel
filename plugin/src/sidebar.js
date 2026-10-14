/** Durable advisor records in the native resource/right-sidebar integration.
 * Reads never invoke a model; failures never display a stale successful value. */
import { advisorJevPanel } from './advisor-jev.js'

export const CIEL_ADVICE = 'ciel-advice'
const TAB_ID = 'dsh-ciel/sidebar-advice'
const RESOURCE_SCHEME = 'dsh-resource:'
const ADDRESS_PREFIX = 'dsh-resource://'
const SCOPE = 'session'
const TAB_SLOT = 'sidebar.right.pane.tab'
const CODE_UNSUPPORTED = 'ciel-sidebar/unsupported-address'
const CODE_READ_FAILED = 'ciel-sidebar/read-failed'

export function adviceAddress(sessionId, callId) {
  return ADDRESS_PREFIX + CIEL_ADVICE + '/' + SCOPE + '/' + encodeURIComponent(String(sessionId)) + '/' + encodeURIComponent(String(callId))
}

/**
 * Decode one segment, rejecting malformed escapes and empty ids.
 *
 * A percent-encoded separator (`%2F`) decodes to itself, so an id carrying
 * `/` round-trips: the raw pathname is split before decoding, which keeps the
 * segment boundary unambiguous. The decoded id is an opaque string handed back
 * to the Host, which owns its own id validation.
 */
function decodeSegment(segment) {
  if (segment === '') return undefined
  let value
  try {
    value = decodeURIComponent(segment)
  } catch {
    return undefined
  }
  return value === '' ? undefined : value
}

/**
 * Read one of this module's addresses back into its parts.
 *
 * Strict by design: the scheme, the session scope, the segment count, the
 * encoding, and the absence of userinfo/port/query/fragment are all checked.
 * The protocol is compared case-insensitively because the URL parser keeps a
 * non-special scheme's host case and the resource model lowercases it.
 * @param address - a candidate address.
 * @returns the parts, or `undefined` when the string is not one of ours.
 */
export function parseCielAddress(address) {
  if (typeof address !== 'string' || address === '') return undefined
  let url
  try {
    url = new URL(address)
  } catch {
    // The URL parser rejects strings without a scheme; nothing else throws here.
    return undefined
  }
  if (url.protocol !== RESOURCE_SCHEME) return undefined
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '') return undefined
  const protocol = url.hostname.toLowerCase()
  if (protocol !== CIEL_ADVICE) return undefined
  const raw = url.pathname.split('/')
  if (raw[0] !== '' || raw[1] !== SCOPE) return undefined
  const segments = raw.slice(2)
  if (segments.length !== 2) return undefined
  const decoded = []
  for (const segment of segments) {
    const value = decodeSegment(segment)
    if (value === undefined) return undefined
    decoded.push(value)
  }
  return { protocol, sessionId: decoded[0], recordId: decoded[1] }
}

/** Whether an address is one of this module's, under a named protocol. */
function isProtocol(address, protocol) {
  const parsed = parseCielAddress(address)
  return parsed !== undefined && parsed.protocol === protocol
}

/** A short, stable display id. */
function shortId(value) {
  const text = value === undefined || value === null ? '' : String(value)
  return text.length <= 12 ? text : text.slice(0, 12) + '…'
}

/** The tab chip's title for one address. */
function titleOf(address, protocol) {
  const parsed = parseCielAddress(address)
  if (parsed === undefined || parsed.protocol !== protocol) return address
  return '顾问 ' + shortId(parsed.recordId)
}

// ── shared value helpers ─────────────────────────────────────────────────

/** The human line for any failure-shaped value. */
function errorText(value) {
  if (value === undefined || value === null) return '读取失败'
  if (typeof value === 'string') return value === '' ? '读取失败' : value
  if (value instanceof Error) return value.message === '' ? String(value) : value.message
  if (typeof value === 'object') {
    if (typeof value.message === 'string' && value.message !== '') return value.message
    const nested = value.error
    if (typeof nested === 'string' && nested !== '') return nested
    if (nested !== null && typeof nested === 'object') {
      if (typeof nested.message === 'string' && nested.message !== '') return nested.message
      if (typeof nested.code === 'string' && nested.code !== '') return nested.code
    }
    if (typeof value.code === 'string' && value.code !== '') return value.code
    return '读取失败'
  }
  return String(value)
}

/** A resource failure frame that satisfies the RemoteError structural marker. */
function failureFrame(code, message, details) {
  const error = new Error(message)
  error.name = 'RemoteError'
  error.isDSHRemoteError = true
  error.code = code
  error.details = details === undefined ? {} : details
  return { ok: false, error }
}

/** A deterministic UTC display timestamp. */
function formatTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  try {
    return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } catch {
    return ''
  }
}

/** One issue entry as text, never throwing on odd shapes. */
function issueText(issue) {
  if (typeof issue === 'string') return issue
  if (issue !== null && typeof issue === 'object') {
    if (typeof issue.message === 'string') return issue.message
    if (typeof issue.title === 'string') return issue.title
    try {
      return JSON.stringify(issue)
    } catch {
      return '[object]'
    }
  }
  return String(issue)
}

/** The tone of one advisor idea tier. */
function tierTone(tier) {
  switch (tier) {
    case 'high': return 'danger'
    case 'mid': return 'warning'
    default: return 'neutral'
  }
}
/** A compact model-route summary from the advice `modelUsage` shape. */
function modelUsageText(usage) {
  if (usage === null || typeof usage !== 'object') return ''
  const routes = []
  if (Array.isArray(usage.used)) {
    for (const item of usage.used) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.provider === 'string' && typeof item.model === 'string') routes.push(item.provider + '/' + item.model)
    }
  }
  if (routes.length === 0 && usage.requested !== null && typeof usage.requested === 'object') {
    if (typeof usage.requested.provider === 'string' && typeof usage.requested.model === 'string') {
      routes.push(usage.requested.provider + '/' + usage.requested.model + '（请求）')
    }
  }
  return routes.join(' · ')
}

// ── resource providers ───────────────────────────────────────────────────

/**
 * One protocol's provider: read the address once, yield one frame, end.
 *
 * An in-flight read is shared by address, so two holders arriving during the
 * same Host call (a StrictMode remount, two tabs of one record) read once; the
 * entry is dropped on settle, so a later hold reads again. An abort before the
 * frame is yielded yields nothing, and every exit is idempotent.
 * @param protocol - the protocol this provider serves.
 * @param loader - performs the Host read for one parsed address.
 * @returns the provider to register into `ctx.resources`.
 */
function createStaticProvider(protocol, loader) {
  const inflight = new Map()
  const readOnce = (address, parsed) => {
    const held = inflight.get(address)
    if (held !== undefined) return held
    const pending = Promise.resolve().then(() => loader(parsed))
    inflight.set(address, pending)
    const settle = () => { if (inflight.get(address) === pending) inflight.delete(address) }
    pending.then(settle, settle)
    return pending
  }
  return {
    protocol,
    async *open(address, context) {
      const signal = context === undefined ? undefined : context.signal
      if (signal !== undefined && signal.aborted) return
      const parsed = parseCielAddress(address)
      if (parsed === undefined || parsed.protocol !== protocol) {
        yield failureFrame(CODE_UNSUPPORTED, 'not a ' + protocol + ' address: ' + String(address), { address })
        return
      }
      const result = await readOnce(address, parsed)
      if (signal !== undefined && signal.aborted) return
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        yield failureFrame(CODE_READ_FAILED, errorText(result), { address })
        return
      }
      yield { ok: true, value: result.value }
    },
  }
}

/**
 * Perform one Host read and normalize it to `{ ok, value }` or `{ ok, error }`.
 * Never throws: a rejected `call` is a failure, not a stream fault.
 */
function createReader(call) {
  return async (method, request, field, identity) => {
    let result
    try {
      result = await call(method, request)
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      return { ok: false, error: errorText(result) }
    }
    const value = result[field]
    if (value === null || typeof value !== 'object') {
      return { ok: false, error: method + ' returned no ' + field }
    }
    return { ok: true, value: Object.assign({}, identity, { [field]: value }) }
  }
}

export function createCielSidebar({ React, Tag }) {
  if (!React || typeof React.createElement !== 'function') throw new TypeError('React with createElement is required')
  const h = React.createElement
  const chip = (tone, text, key) => Tag ? h(Tag, { key, tone }, text) : h('span', { key, 'data-ciel-chip': tone }, text)

  /** A state panel (loading / failed / none / malformed) shared by the bodies. */
  function statePanel(state, code, lines) {
    return h('div', { 'data-ciel-state': state, ...(code === undefined ? {} : { 'data-ciel-code': code }) },
      ...lines.map((line, index) => h('p', { key: 'l' + index }, line)))
  }

  /** The failure panel; it never renders the stale value beneath it. */
  function failurePanel(failure) {
    return statePanel('failed', failure === null || failure === undefined ? undefined : failure.code, [
      '读取失败：' + errorText(failure),
      '此处不显示上一次成功读取的内容；关闭并重新打开此标签可重试。',
    ])
  }

  /** Resolve one service by `ctx.get`, falling back to property access. */
  function service(ctx, name) {
    if (ctx === null || ctx === undefined) return undefined
    if (typeof ctx.get === 'function') {
      const found = ctx.get(name)
      if (found !== null && found !== undefined) return found
    }
    try {
      return ctx[name]
    } catch {
      // A service the caller's fiber does not inject may refuse property access.
      return undefined
    }
  }

  /** Resolve the native sidebar face at call time; never cached across sessions. */
  function sidebarFace(ctx) {
    return service(ctx, 'sidebarRight')
  }
  /**
   * The advice body: one advisor call's visible reply and parsed ideas. The
   * banner is part of the contract: these are ideas, never verification.
   */
  function AdviceBody(props) {
    const useTabInfo = props.useTabInfo
    const useResource = props.useResource
    const info = useTabInfo()
    const tab = info.tab
    const parsed = parseCielAddress(tab.contentId)
    const snapshot = useResource(tab.contentId)
    const navigation = tab.navigation === undefined || tab.navigation === null ? {} : tab.navigation
    const params = navigation.params !== null && typeof navigation.params === 'object' ? navigation.params : {}
    const revision = Number.isInteger(navigation.revision) ? navigation.revision : 0
    const focusIndex = Number.isInteger(params.itemIndex) ? params.itemIndex : undefined
    const focusRef = React.useRef(null)
    React.useEffect(() => {
      const node = focusRef.current
      if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    }, [revision, focusIndex])

    if (parsed === undefined) return statePanel('malformed', undefined, ['无法解析的资源地址：' + String(tab.contentId)])
    if (snapshot.status === 'failed') return failurePanel(snapshot.failure)
    if (snapshot.status === 'none') return statePanel('none', undefined, ['资源协议 ' + CIEL_ADVICE + ' 未注册。'])
    if (snapshot.status !== 'live' || snapshot.value === null || snapshot.value === undefined) return statePanel('loading', undefined, ['正在读取顾问记录…'])
    const advice = snapshot.value.advice
    if (advice === null || advice === undefined || typeof advice !== 'object') return statePanel('malformed', undefined, ['顾问记录为空。'])
    const items = Array.isArray(advice.items) ? advice.items : []
    const issues = Array.isArray(advice.issues) ? advice.issues : []
    const usage = modelUsageText(advice.modelUsage)
    return h('div', { 'data-ciel-advice': parsed.recordId },
      h('div', { key: 'head', 'data-ciel-advice-head': '' },
        chip(advice.kind === 'command' ? 'info' : 'neutral', advice.kind === 'command' ? '命令' : '工具', 'kind'),
        h('span', { key: 'id', 'data-ciel-advice-id': '' }, parsed.recordId),
        formatTime(advice.createdAt) === '' ? null : h('span', { key: 'time', 'data-ciel-advice-time': '' }, formatTime(advice.createdAt)),
        usage === '' ? null : h('span', { key: 'usage', 'data-ciel-advice-usage': '' }, '模型：' + usage)),
      h('p', { key: 'disclaimer', 'data-ciel-advice-disclaimer': '' }, '以下是顾问的观点与方向，不是核实过的证据；采用前请自行验证。'),
      advisorJevPanel(h, advice.jev),
      // Structured ideas when the Host parsed them; the raw reply then lives
      // behind one collapsed disclosure instead of repeating the full text.
      items.length === 0
        ? (typeof advice.text === 'string' && advice.text !== '' ? h('pre', { key: 'text', 'data-ciel-advice-text': '' }, advice.text) : null)
        : h('div', { key: 'items', 'data-ciel-advice-items': '' },
        ...items.map((item, index) => {
          const idea = item !== null && typeof item === 'object' ? item : {}
          const focused = focusIndex === index
          return h('div', {
            key: 'i' + index,
            'data-ciel-advice-item': String(index),
            ...(focused ? { 'data-ciel-focus': '', ref: focusRef } : {}),
          },
            h('div', { key: 'head', 'data-ciel-advice-item-head': '' },
              chip(tierTone(idea.tier), String(idea.tier === undefined ? 'idea' : idea.tier), 'tier'),
              h('span', { key: 'title', 'data-ciel-advice-item-title': '' }, String(idea.title === undefined ? '' : idea.title))),
            idea.framing === undefined || idea.framing === '' ? null : h('p', { key: 'framing', 'data-ciel-advice-item-framing': '' }, String(idea.framing)),
            idea.pitfalls === undefined || idea.pitfalls === '' ? null : h('p', { key: 'pitfalls', 'data-ciel-advice-item-pitfalls': '' }, '陷阱：' + String(idea.pitfalls)),
            idea.verificationTarget === undefined || idea.verificationTarget === '' ? null : h('p', { key: 'verify', 'data-ciel-advice-item-verify': '' }, '验证：' + String(idea.verificationTarget)))
        })),
      items.length === 0 || typeof advice.text !== 'string' || advice.text === ''
        ? null
        : h('details', { key: 'raw', 'data-ciel-advice-raw': '' },
          h('summary', { key: 'summary' }, '原始文本'),
          h('pre', { key: 'text', 'data-ciel-advice-text': '' }, advice.text)),
      issues.length === 0 ? null : h('ul', { key: 'issues', 'data-ciel-advice-issues': '' },
        ...issues.map((issue, index) => h('li', { key: 's' + index }, issueText(issue)))))
  }

  // ── install / dispose ──────────────────────────────────────────────────

  let installed = null
  let disposed = false
  function install(ctx, options) {
    if (disposed) throw new Error('createCielSidebar: this instance is disposed')
    if (installed !== null) {
      if (installed.ctx === ctx) return installed.uninstall
      throw new Error('createCielSidebar: already installed on another context')
    }
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.effect !== 'function') {
      throw new TypeError('createCielSidebar: install requires a cordis context with effect()')
    }
    const resources = service(ctx, 'resources')
    if (resources === null || resources === undefined || typeof resources.register !== 'function') {
      throw new TypeError('createCielSidebar: install requires ctx.resources.register')
    }
    const tabRegistry = service(ctx, 'sidebarRightTabs')
    if (tabRegistry === null || tabRegistry === undefined || typeof tabRegistry.register !== 'function') {
      throw new TypeError('createCielSidebar: install requires ctx.sidebarRightTabs.register')
    }
    const slots = service(ctx, 'slots')
    if (slots === null || slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
      throw new TypeError('createCielSidebar: install requires ctx.slots')
    }
    const depsIn = options === undefined || options === null ? {} : options
    const call = depsIn.call
    if (typeof call !== 'function') throw new TypeError('createCielSidebar: install requires call(method, request)')
    const cleanups = []
    const record = { ctx, cleanups, uninstall: undefined }
    const uninstall = () => {
      if (installed !== record) return
      installed = null
      const pending = cleanups.splice(0)
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        try {
          pending[index]()
        } catch {
          // Teardown is best-effort: every disposer is idempotent on its own.
        }
      }
    }
    record.uninstall = uninstall
    installed = record

    /** Run one registration under a Cordis effect owned by this install. */
    const own = (label, setup) => {
      const handle = ctx.effect(() => {
        const cleanup = setup()
        return typeof cleanup === 'function' ? cleanup : () => {}
      }, label)
      cleanups.push(typeof handle === 'function' ? handle : () => {})
    }

    const read = createReader(call)

    try {
      own('Ciel: advice resource provider', () => resources.register(createStaticProvider(CIEL_ADVICE, parsed =>
        read('readAdvice', { sessionId: parsed.sessionId, callId: parsed.recordId }, 'advice', { sessionId: parsed.sessionId, callId: parsed.recordId }))))
      own('Ciel: advice tab type', () => tabRegistry.register({
        id: TAB_ID, kind: CIEL_ADVICE, patterns: ['dsh-resource://' + CIEL_ADVICE + '/**'], priority: 'extension',
        canOpen: address => isProtocol(address, CIEL_ADVICE), title: address => titleOf(address, CIEL_ADVICE),
      }))
      own('Ciel: advice body', () => slots.inject(TAB_SLOT, () => slots.register({ name: TAB_SLOT, key: TAB_ID }, AdviceBody)))
    } catch (error) {
      uninstall()
      throw error
    }
    return uninstall
  }

  /** The current install's context, or `undefined`. */
  function activeContext() {
    return installed === null ? undefined : installed.ctx
  }

  /** Open one address through the native sidebar face, never throwing. */
  function open(address, kind, params) {
    if (disposed) return { ok: false, error: 'dsh-ciel sidebar is disposed' }
    const ctx = activeContext()
    if (ctx === undefined) return { ok: false, error: 'dsh-ciel sidebar is not installed' }
    const face = sidebarFace(ctx)
    if (face === null || face === undefined || typeof face.openResource !== 'function') {
      return { ok: false, error: 'sidebarRight service is unavailable' }
    }
    const options = { kind }
    if (params !== undefined) options.params = params
    try {
      face.openResource(address, options)
      return { ok: true, address }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  /** The params bag for one open, dropping absent fields. */
  function paramsOf(entries) {
    const params = {}
    for (const [name, value] of entries) {
      if (value !== undefined) params[name] = value
    }
    return Object.keys(params).length === 0 ? undefined : params
  }
  /**
   * Open one stored advisor call in the native sidebar (chat entry).
   * @param sessionId - the Session the call belongs to.
   * @param callId - the advisor call id.
   * @param options - `{ itemIndex? }`.
   * @returns `{ ok: true, address }` or `{ ok: false, error }`.
   */
  function openAdvice(sessionId, callId, options) {
    const source = options === undefined || options === null ? {} : options
    return open(adviceAddress(sessionId, callId), CIEL_ADVICE, paramsOf([
      ['itemIndex', Number.isInteger(source.itemIndex) ? source.itemIndex : undefined],
    ]))
  }
  /**
   * Tear the module down. Idempotent: a second call is a no-op, and every
   * registration this install made is disposed exactly once, in reverse order.
   */
  function dispose() {
    if (disposed) return
    disposed = true
    if (installed !== null) installed.uninstall()
  }

  return { install, dispose, openAdvice, adviceAddress, parseAddress: parseCielAddress }
}
