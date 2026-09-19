/**
 * Ciel's native right-Sidebar half: the review, evidence, and advice resources
 * and the tab bodies that show them.
 *
 * Three `dsh-resource://` protocols, one tab type each, one body each. The
 * module is pure ESM with no imports: React, the native `Tag`, and the
 * Workspace-path helper arrive as factory parameters, and the Host RPC arrives
 * as the `call` dependency of `install`. The parent plugin owns the Remote
 * method declarations and the chat-entry wiring; this module owns the native
 * registration and the display.
 *
 * Contract with the Host `call(method, request)` (the business object, NOT a
 * RemoteResult envelope):
 *   readReview({ sessionId, reviewId })               -> { ok: true, review } | { ok: false, error }
 *   readEvidence({ sessionId, reviewId, evidenceId }) -> { ok: true, evidence } | { ok: false, error }
 *   readAdvice({ sessionId, callId })                 -> { ok: true, advice } | { ok: false, error }
 *
 * Address grammar (every segment component-encoded; strict parse):
 *   dsh-resource://ciel-review/session/<sessionId>/<reviewId>
 *   dsh-resource://ciel-evidence/session/<sessionId>/<reviewId>/<evidenceId>
 *   dsh-resource://ciel-advice/session/<sessionId>/<callId>
 *
 * Resource values are `{ sessionId, reviewId, review }`,
 * `{ sessionId, reviewId, evidenceId, evidence }`, and
 * `{ sessionId, callId, advice }`. An evidence record may carry
 * `origin: 'author-tool'` (or `kind: 'reported'`): its content was not
 * separately stored, so the body explains that it is a report, not this
 * plugin's independent read. Only the Host-resolved `evidence.currentPath`
 * may open the live file; the recorded `path` is display-only and never a
 * fallback. A provider reads once and ends its stream:
 * no watch, no reload, no model call, and no session switch cancels a model.
 * A body never falls back to the last successful value while the resource
 * reports `failed`.
 *
 * Wiring the parent still owns:
 *   - the Host methods and their Remote descriptors (`readReview`,
 *     `readEvidence`, `readAdvice`);
 *   - `install(ctx, { call, onPrepareFeedback, onTriage })` from the client
 *     plugin's apply, with `call` bound to those methods;
 *   - `onPrepareFeedback({ sessionId, reviewId, messageId, items })` carrying
 *     the existing input-box protection (this module only asks; it never
 *     sends);
 *   - `onTriage({ sessionId, reviewId, changes, indices })` bound to
 *     `reviewCall('triage', request)`; a failure is shown in the body and a
 *     checked box never means "verified";
 *   - chat-entry buttons calling `openReview` / `openEvidence` /
 *     `openAdvice`;
 *   - `fileAddressFor(sessionId, path)` bound to the Session's workspace root;
 *   - the platform `Button` primitive (optional; a plain `<button>` is the
 *     mock/test fallback) and the text of `plugin/src/sidebar.css` appended to
 *     the client's existing style element — this module imports no CSS itself.
 */

/** The review resource protocol and tab kind. */
export const CIEL_REVIEW = 'ciel-review'
/** The evidence resource protocol and tab kind. */
export const CIEL_EVIDENCE = 'ciel-evidence'
/** The advice resource protocol and tab kind. */
export const CIEL_ADVICE = 'ciel-advice'

/** Every protocol this module serves, in registration order. */
const PROTOCOLS = [CIEL_REVIEW, CIEL_EVIDENCE, CIEL_ADVICE]

/** The slot body key of each type: the tab definition's own `id`. */
const TAB_IDS = {
  [CIEL_REVIEW]: 'dsh-ciel/sidebar-review',
  [CIEL_EVIDENCE]: 'dsh-ciel/sidebar-evidence',
  [CIEL_ADVICE]: 'dsh-ciel/sidebar-advice',
}

/** The resource-address scheme and the one scope this module builds. */
const RESOURCE_SCHEME = 'dsh-resource:'
const ADDRESS_PREFIX = 'dsh-resource://'
const SCOPE = 'session'

/** The slot a tab body registers into. */
const TAB_SLOT = 'sidebar.right.pane.tab'

/** Failure codes this module's providers report; they are not Host codes. */
const CODE_UNSUPPORTED = 'ciel-sidebar/unsupported-address'
const CODE_READ_FAILED = 'ciel-sidebar/read-failed'

// ── addresses ────────────────────────────────────────────────────────────

/** Component-encode one address segment. */
function encodeSegment(value) {
  return encodeURIComponent(String(value))
}

/** Build one address from its parts; `extraId` is the evidence segment. */
function buildAddress(protocol, sessionId, recordId, extraId) {
  const base = ADDRESS_PREFIX + protocol + '/' + SCOPE + '/' + encodeSegment(sessionId) + '/' + encodeSegment(recordId)
  return extraId === undefined ? base : base + '/' + encodeSegment(extraId)
}

/**
 * The address of one stored review.
 * @param sessionId - the Session the review belongs to.
 * @param reviewId - the review's id.
 * @returns the `dsh-resource://ciel-review/…` address.
 */
export function reviewAddress(sessionId, reviewId) {
  return buildAddress(CIEL_REVIEW, sessionId, reviewId)
}

/**
 * The address of one stored evidence record.
 * @param sessionId - the Session the review belongs to.
 * @param reviewId - the review's id.
 * @param evidenceId - the evidence id cited by an annotation.
 * @returns the `dsh-resource://ciel-evidence/…` address.
 */
export function evidenceAddress(sessionId, reviewId, evidenceId) {
  return buildAddress(CIEL_EVIDENCE, sessionId, reviewId, evidenceId)
}

/**
 * The address of one stored advisor call.
 * @param sessionId - the Session the call belongs to.
 * @param callId - the advisor call's id.
 * @returns the `dsh-resource://ciel-advice/…` address.
 */
export function adviceAddress(sessionId, callId) {
  return buildAddress(CIEL_ADVICE, sessionId, callId)
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
  if (!PROTOCOLS.includes(protocol)) return undefined
  const raw = url.pathname.split('/')
  if (raw[0] !== '' || raw[1] !== SCOPE) return undefined
  const segments = raw.slice(2)
  const expected = protocol === CIEL_EVIDENCE ? 3 : 2
  if (segments.length !== expected) return undefined
  const decoded = []
  for (const segment of segments) {
    const value = decodeSegment(segment)
    if (value === undefined) return undefined
    decoded.push(value)
  }
  if (protocol === CIEL_EVIDENCE) {
    return { protocol, sessionId: decoded[0], recordId: decoded[1], evidenceId: decoded[2] }
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
  if (protocol === CIEL_REVIEW) return '评审 ' + shortId(parsed.recordId)
  if (protocol === CIEL_EVIDENCE) return '证据 ' + shortId(parsed.evidenceId)
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

/** A positive integer line number, or `undefined`. */
function lineNumber(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
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

/** The display tone of a status Tag. */
function reviewTone(entry) {
  switch (entry.status) {
    case 'sound': return 'success'
    case 'completed': return 'danger'
    case 'incomplete': return 'warning'
    default: return 'neutral'
  }
}

/** The display text of a review's status. */
function reviewStatusText(entry) {
  switch (entry.status) {
    case 'sound': return '整体成立'
    case 'completed': return '发现问题'
    case 'incomplete': return '部分核实'
    case 'unverified': return '未核实'
    case 'cancelled': return '已取消'
    case 'error': return '评审失败'
    default: break
  }
  if (entry.verdict === 'pass') return '通过'
  if (entry.verdict === 'changes') return '需修改'
  return '评审记录'
}

/** The display label of one evidence kind. */
function evidenceKindText(kind) {
  switch (kind) {
    case 'source': return '源码'
    case 'search': return '检索'
    case 'listing': return '目录'
    case 'reported': return '作者报告'
    default: return typeof kind === 'string' && kind !== '' ? kind : '证据'
  }
}

/** The display label of one evidence status. */
function evidenceStatusText(status) {
  switch (status) {
    case 'available': return '可用'
    case 'withheld': return '未提供'
    case 'limited': return '受限'
    case 'unknown': return '状态未知'
    default: return typeof status === 'string' && status !== '' ? status : '未知'
  }
}

/** The tone of one evidence status. */
function evidenceTone(status) {
  switch (status) {
    case 'available': return 'neutral'
    case 'withheld': return 'warning'
    case 'limited': return 'warning'
    case 'unknown': return 'warning'
    default: return 'neutral'
  }
}

/** The tone of one advisor idea tier. */
function tierTone(tier) {
  switch (tier) {
    case 'high': return 'danger'
    case 'mid': return 'warning'
    default: return 'neutral'
  }
}

/** One snippet's lines, numbered from its captured start line when known. */
function splitLines(content, startLine) {
  if (typeof content !== 'string' || content === '') return []
  const text = content.endsWith('\n') ? content.slice(0, -1) : content
  return text.split('\n').map((line, index) => ({
    number: startLine === undefined ? undefined : startLine + index,
    text: line,
  }))
}

/**
 * The checked set a Host triage record initializes a review with: every index
 * whose state is `accept`. `dismiss` and absent indices start unchecked, so a
 * restored box means "the user accepted this earlier", never "this is true".
 * @param states - `review.triage.states`, keyed by annotation index.
 * @returns the indices to check.
 */
function triageSelection(states) {
  const selected = new Set()
  if (states === null || states === undefined || typeof states !== 'object') return selected
  for (const [key, state] of Object.entries(states)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0) continue
    if (state === 'accept') selected.add(index)
  }
  return selected
}

/** A compact model-route summary from the review/advice `modelUsage` shape. */
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

// ── the factory ──────────────────────────────────────────────────────────

/**
 * Build one Ciel sidebar instance.
 *
 * The returned API is a singleton: `install` may run once (idempotently on the
 * same context), the `open*` entry points are safe before install (they report
 * an error rather than throwing), and `dispose` is idempotent.
 * @param dependencies - `{ React, Tag, Button, fileAddressFor }`; React is
 *   required, `Tag` falls back to a plain span, `Button` falls back to a
 *   plain `<button>`, and `fileAddressFor(sessionId, path)` is required and
 *   must be bound to the Session's workspace root.
 * @returns the sidebar API: `install`, `dispose`, the three `open*` entry
 *   points, `openCurrentFile`, and the address helpers.
 */
export function createCielSidebar(dependencies) {
  const deps = dependencies === undefined || dependencies === null ? {} : dependencies
  const React = deps.React
  const Tag = deps.Tag
  const Button = deps.Button
  const fileAddressFor = deps.fileAddressFor
  if (React === null || typeof React !== 'object' || typeof React.createElement !== 'function') {
    throw new TypeError('createCielSidebar: React with createElement is required')
  }
  if (typeof fileAddressFor !== 'function') {
    throw new TypeError('createCielSidebar: fileAddressFor(sessionId, path) is required')
  }
  const h = React.createElement
  const nativeTag = typeof Tag === 'function' || (Tag !== null && typeof Tag === 'object')
  const nativeButton = typeof Button === 'function' || (Button !== null && typeof Button === 'object')

  /** One native status chip, or a plain span when the platform Tag is absent. */
  function chip(tone, text, key) {
    return nativeTag
      ? h(Tag, { key, tone }, text)
      : h('span', { key, 'data-ciel-chip': tone }, text)
  }

  /**
   * Local triage state, keyed by `sessionId + reviewId`: the pinned review
   * resource keeps its first frame, so a remounting body would otherwise read a
   * stale `review.triage`. One entry carries the choice, the last failure
   * line, and the identity of the record it was made against — a record whose
   * version/creation/message differs never borrows another's choice. The cache
   * lives as long as the install and is dropped with it.
   */
  const selections = new Map()
  const SELECTION_LIMIT = 100

  /** The cache key of one review: the address's own session, not the mounted one. */
  function selectionKey(sessionId, reviewId) {
    return String(sessionId) + '\u0000' + String(reviewId)
  }

  /**
   * The identity of one stored record, from whatever it carries: a changed
   * version, creation stamp, or reviewed message means a different record.
   */
  function recordIdentity(review) {
    if (review === null || review === undefined || typeof review !== 'object') return ''
    const parts = []
    for (const field of ['version', 'createdAt', 'messageId']) {
      const value = review[field]
      if (typeof value === 'string' && value !== '') parts.push(field + '=' + value)
      else if (typeof value === 'number' && Number.isFinite(value)) parts.push(field + '=' + value)
    }
    return parts.join('|')
  }

  /** One cached entry, only when it belongs to the record in hand. */
  function cachedEntry(key, identity) {
    const entry = selections.get(key)
    return entry === undefined || entry.identity !== identity ? undefined : entry
  }

  /** Remember one local choice (and its last failure line), evicting past the cap. */
  function rememberSelection(key, identity, indices, failed) {
    selections.delete(key)
    selections.set(key, {
      identity,
      indices: [...indices].sort((left, right) => left - right),
      failed: typeof failed === 'string' ? failed : '',
    })
    while (selections.size > SELECTION_LIMIT) selections.delete(selections.keys().next().value)
  }

  /**
   * One action button: the platform primitive when supplied (its own styling
   * owns the look), otherwise a plain `<button>` for mocks and tests. The
   * native-only `variant`/`size` props are dropped in the fallback so React
   * never sees unknown attributes.
   */
  function actionButton(props, children) {
    const actionProps = { size: 'md', 'data-ciel-action': '', ...props }
    // data-ciel-native-button marks ONLY the native primitive path (never the
    // <button> fallback), so the stylesheet can scope native sizing/focus.
    if (nativeButton) return h(Button, { 'data-ciel-native-button': '', ...actionProps }, children)
    const rest = { ...actionProps }
    delete rest.variant
    delete rest.size
    delete rest.icon
    return h('button', { type: 'button', ...rest }, children)
  }

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

  // ── bodies ─────────────────────────────────────────────────────────────

  /**
   * The review body: the stored entry, its annotations, their evidence refs,
   * and the one gesture this type owns — asking the parent to stage selected
   * annotations into the input box.
   */
  function ReviewBody(props) {
    const useTabInfo = props.useTabInfo
    const useResource = props.useResource
    const prepareFeedback = props.prepareFeedback
    const onTriage = props.onTriage
    const openEvidence = props.openEvidence
    const info = useTabInfo()
    const tab = info.tab
    const parsed = parseCielAddress(tab.contentId)
    const snapshot = useResource(tab.contentId)
    const navigation = tab.navigation === undefined || tab.navigation === null ? {} : tab.navigation
    const params = navigation.params !== null && typeof navigation.params === 'object' ? navigation.params : {}
    const revision = Number.isInteger(navigation.revision) ? navigation.revision : 0
    const focusIndex = Number.isInteger(params.annotationIndex) ? params.annotationIndex : undefined
    const liveReview = snapshot.status === 'live' && snapshot.value !== null && typeof snapshot.value === 'object'
      && snapshot.value.review !== null && typeof snapshot.value.review === 'object' ? snapshot.value.review : undefined
    // The review's own identity, independent of the mounted session; also the
    // guard that keeps a pending triage settlement off another review.
    const key = parsed === undefined ? undefined : selectionKey(parsed.sessionId, parsed.recordId)
    const identity = recordIdentity(liveReview)
    const keyRef = React.useRef(key)
    keyRef.current = key
    const identityRef = React.useRef(identity)
    identityRef.current = identity
    // null means "still following the Host's triage record"; any user toggle
    // replaces it, so a late resource frame cannot clobber a live choice.
    const [picked, setPicked] = React.useState(null)
    // The latest selection, readable synchronously: two clicks in one React
    // batch must both land, and a late Host triage frame must not undo either.
    const pickedRef = React.useRef(null)
    const [phase, setPhase] = React.useState('idle')
    const [note, setNote] = React.useState('')
    const [triageNote, setTriageNote] = React.useState('')
    const focusRef = React.useRef(null)
    React.useEffect(() => {
      const node = focusRef.current
      if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    }, [revision, focusIndex])
    if (parsed === undefined) return statePanel('malformed', undefined, ['无法解析的资源地址：' + String(tab.contentId)])
    if (snapshot.status === 'failed') return failurePanel(snapshot.failure)
    if (snapshot.status === 'none') return statePanel('none', undefined, ['资源协议 ' + CIEL_REVIEW + ' 未注册。'])
    if (snapshot.status !== 'live' || snapshot.value === null || snapshot.value === undefined) return statePanel('loading', undefined, ['正在读取评审…'])
    const review = snapshot.value.review
    if (review === null || review === undefined || typeof review !== 'object') return statePanel('malformed', undefined, ['评审记录为空。'])
    const annotations = Array.isArray(review.annotations) ? review.annotations : []
    const triage = review.triage !== null && typeof review.triage === 'object' ? review.triage : undefined
    const cached = cachedEntry(key, identity)
    const selected = pickedRef.current !== null
      ? pickedRef.current
      : picked !== null
        ? picked
        : cached !== undefined
          ? new Set(cached.indices)
          : triageSelection(triage === undefined ? undefined : triage.states)
    // A failure line outlives this body too, for the same record only.
    const noteText = triageNote !== '' ? triageNote : cached === undefined ? '' : cached.failed
    const toggle = (index, checked) => {
      // Read the ref, not the render closure: two clicks in one batch must both land.
      const next = new Set(pickedRef.current !== null ? pickedRef.current : selected)
      if (checked) next.add(index)
      else next.delete(index)
      pickedRef.current = next
      setPicked(next)
      // The local choice outlives this body: a remount restores it even while
      // the pinned resource still carries the first frame's triage.
      rememberSelection(key, identity, next, '')
      setTriageNote('')
      if (typeof onTriage !== 'function') return
      const request = {
        sessionId: parsed.sessionId,
        reviewId: parsed.recordId,
        changes: [{ index, state: checked ? 'accept' : 'dismiss' }],
        indices: [...next].sort((left, right) => left - right),
      }
      const requestKey = key
      const requestIdentity = identity
      Promise.resolve().then(() => onTriage(request)).then((result) => {
        // A settlement only speaks for the record it was issued for.
        if (keyRef.current !== requestKey || identityRef.current !== requestIdentity) return
        if (result !== null && typeof result === 'object' && result.ok === false) {
          const failure = errorText(result)
          setTriageNote(failure)
          rememberSelection(requestKey, requestIdentity, pickedRef.current ?? next, failure)
          return
        }
        setTriageNote('')
        rememberSelection(requestKey, requestIdentity, pickedRef.current ?? next, '')
      }, (error) => {
        if (keyRef.current !== requestKey || identityRef.current !== requestIdentity) return
        const failure = errorText(error)
        setTriageNote(failure)
        rememberSelection(requestKey, requestIdentity, pickedRef.current ?? next, failure)
      })
    }
    const submit = () => {
      const items = [...selected].sort((left, right) => left - right).map((index) => ({ index }))
      if (items.length === 0) return undefined
      if (typeof prepareFeedback !== 'function') {
        setPhase('error')
        setNote('输入框回传未接线。')
        return undefined
      }
      setPhase('sending')
      setNote('')
      const request = {
        sessionId: parsed.sessionId,
        reviewId: parsed.recordId,
        ...(typeof review.messageId === 'string' && review.messageId !== '' ? { messageId: review.messageId } : {}),
        items,
      }
      return Promise.resolve().then(() => prepareFeedback(request)).then((result) => {
        if (result !== null && typeof result === 'object' && result.ok === false) {
          setPhase('error')
          setNote(errorText(result))
          return
        }
        setPhase('sent')
        setNote('已填入输入框；请核对后手动发送。')
      }, (error) => {
        setPhase('error')
        setNote(errorText(error))
      })
    }
    const openRef = (evidenceId) => {
      if (typeof openEvidence === 'function') openEvidence(parsed.sessionId, parsed.recordId, evidenceId)
    }

    const stats = review.stats !== null && typeof review.stats === 'object' ? review.stats : undefined
    const explore = review.explore !== null && typeof review.explore === 'object' ? review.explore : undefined
    const privacy = review.privacy !== null && typeof review.privacy === 'object' ? review.privacy : undefined
    const usage = modelUsageText(review.modelUsage)
    const head = [
      h('div', { key: 'status', 'data-ciel-review-status': reviewStatusText(review) },
        chip(reviewTone(review), reviewStatusText(review), 'status'),
        typeof review.verdict === 'string' && review.verdict !== '' ? h('span', { key: 'verdict' }, ' · 裁决 ' + review.verdict) : null,
        review.sound === true ? h('span', { key: 'sound' }, ' · 宿主判定无阻断') : null),
      review.summary === undefined ? null : h('p', { key: 'summary', 'data-ciel-review-summary': '' }, String(review.summary)),
      h('p', { key: 'meta', 'data-ciel-review-meta': '' },
        '评审 ' + parsed.recordId + ' · 消息 ' + String(review.messageId === undefined ? '—' : review.messageId) +
        (formatTime(review.createdAt) === '' ? '' : ' · ' + formatTime(review.createdAt))),
      h('p', { key: 'coverage', 'data-ciel-review-coverage': String(review.coverage === undefined ? '' : review.coverage) },
        '覆盖：' + String(review.coverage === undefined ? '未标注' : review.coverage) +
        (typeof review.coverageNote === 'string' && review.coverageNote !== '' ? ' · ' + review.coverageNote : '')),
      stats === undefined ? null : h('p', { key: 'stats', 'data-ciel-review-stats': '' },
        '排查 ' + String(stats.checked === undefined ? '—' : stats.checked) +
        ' · 证伪 ' + String(stats.confirmed === undefined ? '—' : stats.confirmed) +
        ' · 排除 ' + String(stats.excluded === undefined ? '—' : stats.excluded) +
        ' · 未查 ' + String(stats.unchecked === undefined ? '—' : stats.unchecked)),
      explore === undefined ? null : h('p', { key: 'explore', 'data-ciel-review-explore': '' },
        '已查询 ' + String(explore.toolCalls === undefined ? '—' : explore.toolCalls) +
        (Number.isFinite(explore.budget) ? '/' + explore.budget : ' 次') +
        (explore.limitMode === 'time' && Number.isFinite(explore.timeoutSeconds) ? ' · 总时限 ' + explore.timeoutSeconds + ' 秒' : '') +
        (explore.salvaged === true ? ' · 熔断后抢救产出' : '')),
      usage === '' ? null : h('p', { key: 'usage', 'data-ciel-review-usage': '' }, '模型：' + usage),
      privacy === undefined || (privacy.dataLimited !== true && privacy.evidenceWithheld !== true)
        ? null
        : h('p', { key: 'privacy', 'data-ciel-review-privacy': '' },
          [privacy.dataLimited === true ? '资料读取受范围或大小限制' : '', privacy.evidenceWithheld === true ? '部分作者工具输出未提供' : ''].filter(Boolean).join('；')),
    ].filter((node) => node !== null)

    const rows = annotations.map((annotation, index) => {
      const item = annotation !== null && typeof annotation === 'object' ? annotation : {}
      const refs = Array.isArray(item.evidenceRefs) ? [...new Set(item.evidenceRefs.filter((id) => typeof id === 'string' && id !== ''))] : []
      const severity = item.severity === 'blocker' ? 'blocker' : 'nit'
      const focused = focusIndex === index
      return h('div', {
        key: 'a' + index,
        'data-ciel-annotation': String(index),
        'data-ciel-severity': severity,
        ...(focused ? { 'data-ciel-focus': '', ref: focusRef } : {}),
      },
        h('label', { key: 'pick', 'data-ciel-pick': String(index) },
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: selected.has(index),
            'data-ciel-select': String(index),
            'aria-label': '选择批注 ' + (index + 1),
            onChange: (event) => { toggle(index, event.target.checked === true) },
          }),
          chip(severity === 'blocker' ? 'danger' : 'warning', severity === 'blocker' ? 'blocker' : 'nit', 'sev'),
          h('span', { key: 'title', 'data-ciel-annotation-title': '' }, String(item.title === undefined || item.title === '' ? '（无标题）' : item.title))),
        item.anchor === undefined || item.anchor === '' ? null : h('blockquote', { key: 'anchor', 'data-ciel-annotation-anchor': '' }, String(item.anchor)),
        item.comment === undefined || item.comment === '' ? null : h('p', { key: 'comment', 'data-ciel-annotation-comment': '' }, String(item.comment)),
        item.evidence === undefined || item.evidence === '' ? null : h('p', { key: 'evidence', 'data-ciel-annotation-evidence-text': '' }, '证据引用：' + String(item.evidence)),
        refs.length === 0 ? null : h('p', { key: 'refs', 'data-ciel-annotation-refs': '' },
          '证据：',
          refs.map((id) => actionButton({
            key: id,
            variant: 'toolbar',
            icon: h('span', { 'aria-hidden': true }, '→'),
            'data-ciel-evidence-ref': id,
            onClick: () => { openRef(id) },
          }, '查看证据 ' + shortId(id)))))
    })

    return h('div', {
      'data-ciel-review': parsed.recordId,
      'data-ciel-revision': String(revision),
      ...(focusIndex === undefined ? {} : { 'data-ciel-focus-index': String(focusIndex) }),
    },
      h('div', { key: 'head', 'data-ciel-review-head': '' }, ...head),
      h('p', { key: 'hint', 'data-ciel-review-hint': '' }, '证据引用只是宿主记录的历史读取；内容需点开证据查看，不能替代当前文件核对。'),
      rows.length === 0
        ? h('p', { key: 'empty', 'data-ciel-review-empty': '' }, '本评审没有批注。')
        : h('div', { key: 'rows', 'data-ciel-review-annotations': '' }, ...rows),
      h('div', { key: 'actions', 'data-ciel-review-actions': '' },
        h('span', { key: 'count', 'data-ciel-selected-count': String(selected.size) }, '已选 ' + selected.size + ' 条'),
        actionButton({
          key: 'submit',
          variant: 'primary',
          'data-ciel-submit': '',
          disabled: selected.size === 0 || phase === 'sending' || typeof prepareFeedback !== 'function',
          onClick: () => submit(),
        }, phase === 'sending' ? '正在准备…' : '填入输入框'),
        note === '' ? null : h('span', { key: 'note', 'data-ciel-note': phase }, note),
        noteText === '' ? null : h('span', { key: 'triage-note', 'data-ciel-triage-note': 'error' }, '分诊保存失败：' + noteText),
        h('span', { key: 'triage-hint', 'data-ciel-triage-hint': '' }, '勾选只用于回传，不代表问题成立。'),
        typeof prepareFeedback === 'function' ? null : h('span', { key: 'unwired', 'data-ciel-unwired': '' }, '输入框回传未接线')))
  }

  /**
   * The evidence body: one historical, read-only snippet. The current file is
   * never read here; the one control opens it explicitly through the native
   * sidebar at the snippet's first line.
   */
  function EvidenceBody(props) {
    const useTabInfo = props.useTabInfo
    const useResource = props.useResource
    const splitPane = props.splitPane
    const info = useTabInfo()
    const tab = info.tab
    const panel = info.panel
    const parsed = parseCielAddress(tab.contentId)
    const snapshot = useResource(tab.contentId)
    const navigation = tab.navigation === undefined || tab.navigation === null ? {} : tab.navigation
    const params = navigation.params !== null && typeof navigation.params === 'object' ? navigation.params : {}
    const revision = Number.isInteger(navigation.revision) ? navigation.revision : 0
    const targetLine = lineNumber(params.line)
    const [note, setNote] = React.useState('')
    const targetRef = React.useRef(null)
    React.useEffect(() => {
      const node = targetRef.current
      if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
    }, [revision, targetLine])

    if (parsed === undefined) return statePanel('malformed', undefined, ['无法解析的资源地址：' + String(tab.contentId)])
    if (snapshot.status === 'failed') return failurePanel(snapshot.failure)
    if (snapshot.status === 'none') return statePanel('none', undefined, ['资源协议 ' + CIEL_EVIDENCE + ' 未注册。'])
    if (snapshot.status !== 'live' || snapshot.value === null || snapshot.value === undefined) return statePanel('loading', undefined, ['正在读取证据…'])
    const evidence = snapshot.value.evidence
    if (evidence === null || evidence === undefined || typeof evidence !== 'object') return statePanel('malformed', undefined, ['证据记录为空。'])
    // Fail closed: an unrecognized status never renders content as if it were
    // a clean snippet. Only the two known content-bearing statuses show it.
    const rawStatus = typeof evidence.status === 'string' && evidence.status !== '' ? evidence.status : 'available'
    const status = rawStatus === 'available' || rawStatus === 'withheld' || rawStatus === 'limited' ? rawStatus : 'unknown'
    const showContent = status === 'available' || status === 'limited'
    const startLine = lineNumber(evidence.startLine)
    const endLine = lineNumber(evidence.endLine)
    const range = startLine === undefined ? '' : (endLine === undefined ? String(startLine) : String(startLine) + '–' + String(endLine))
    // `path` is the recorded (possibly virtual or author-reported) path and is
    // display-only. Only the Host-resolved `currentPath` may address the live
    // file; there is no fallback, so a virtual path can never be opened.
    const path = typeof evidence.path === 'string' && evidence.path !== '' ? evidence.path : undefined
    const currentPath = typeof evidence.currentPath === 'string' && evidence.currentPath !== '' ? evidence.currentPath : undefined
    const origin = typeof evidence.origin === 'string' && evidence.origin !== '' ? evidence.origin : undefined
    // Author-tool output is a report, not a read this plugin performed; it says
    // so wherever it appears and never stands in for independent verification.
    const reported = evidence.kind === 'reported' || origin === 'author-tool'
    const lines = showContent ? splitLines(evidence.content, startLine) : []
    // The explicit gesture: build the live-file address, ask the native sidebar
    // to split the pane this tab is in, and land the file beside it. No split
    // (full, narrow, or no face) falls back to one column — the file opens as a
    // tab in the current pane. The tab's own actions are used, so a
    // cross-session record never grabs another session's surface.
    const openFile = (compare) => {
      if (currentPath === undefined) return
      if (tab.actions === undefined || tab.actions === null || typeof tab.actions.openResource !== 'function') {
        setNote('侧栏不可用')
        return
      }
      let address
      try {
        address = fileAddressFor(parsed.sessionId, currentPath)
      } catch (error) {
        setNote(errorText(error))
        return
      }
      if (typeof address !== 'string' || address === '') {
        setNote('无法生成当前文件地址')
        return
      }
      const params = startLine === undefined ? undefined : { line: startLine }
      const paneId = compare && typeof splitPane === 'function' ? splitPane(panel === undefined ? undefined : panel.id) : undefined
      const options = {
        // A split compare opens a second tab in the new pane even when the
        // file already sits in the other one; without a split the default
        // reveal keeps one tab per pane.
        ...(paneId === undefined ? {} : { paneId, revealIfOpened: false }),
        ...(params === undefined ? {} : { params }),
      }
      try {
        tab.actions.openResource(address, Object.keys(options).length === 0 ? undefined : options)
        setNote('')
      } catch (error) {
        setNote(errorText(error))
      }
    }
    const meta = [
      h('span', { key: 'kind', 'data-ciel-evidence-kind': String(evidence.kind === undefined ? '' : evidence.kind) }, evidenceKindText(evidence.kind)),
      chip(evidenceTone(status), evidenceStatusText(status), 'status'),
      path === undefined ? null : h('span', { key: 'path', 'data-ciel-evidence-path': path }, path),
      range === '' ? null : h('span', { key: 'range', 'data-ciel-evidence-range': range }, '行 ' + range),
      typeof evidence.tool === 'string' && evidence.tool !== '' ? h('span', { key: 'tool', 'data-ciel-evidence-tool': evidence.tool }, '工具 ' + evidence.tool) : null,
      origin === undefined ? null : h('span', { key: 'origin', 'data-ciel-evidence-origin': origin }, '来源 ' + origin),
      formatTime(evidence.capturedAt) === '' ? null : h('span', { key: 'time', 'data-ciel-evidence-time': '' }, formatTime(evidence.capturedAt)),
      typeof evidence.contentSha256 === 'string' && evidence.contentSha256 !== ''
        ? h('span', { key: 'sha', 'data-ciel-evidence-sha': evidence.contentSha256 }, 'sha256 ' + shortId(evidence.contentSha256))
        : null,
      evidence.truncated === true ? chip('warning', '已截断', 'truncated') : null,
    ].filter((node) => node !== null)
    const notices = []
    if (status === 'withheld') notices.push(h('p', { key: 'withheld', 'data-ciel-evidence-withheld': '' }, '该证据因隐私检查未提供内容；缺失不等于文件内容有误。'))
    if (status === 'limited') notices.push(h('p', { key: 'limited', 'data-ciel-evidence-limited': '' }, '内容受范围或大小限制，可能不完整。'))
    if (status === 'unknown') notices.push(h('p', { key: 'unknown', 'data-ciel-evidence-unknown': '' }, '证据状态为 ' + rawStatus + '，未显示内容。'))
    if (reported) notices.push(h('p', { key: 'reported', 'data-ciel-evidence-reported': origin === undefined ? 'reported' : origin }, '该证据来自作者工具输出' + (origin === undefined ? '' : '（' + origin + '）') + '；宿主未另行保存内容，这不是本插件的独立读取或核实。'))
    if (showContent && !reported && lines.length === 0) notices.push(h('p', { key: 'missing', 'data-ciel-evidence-missing': '' }, '证据没有保存内容片段。'))
    return h('div', { 'data-ciel-evidence': parsed.evidenceId },
      h('div', { key: 'head', 'data-ciel-evidence-head': '' }, ...meta),
      ...notices,
      h('p', { key: 'hint', 'data-ciel-evidence-hint': '' }, '历史证据为只读快照；当前文件可能已经变化。打开的是当前文件，不是这条历史证据。'),
      currentPath !== undefined && startLine !== undefined
        ? h('p', { key: 'line-hint', 'data-ciel-current-line-hint': '' }, '当前文件的源码行定位适用于代码或纯文本视图；Markdown 渲染视图请切换到代码或纯文本后定位。历史行号可能已不对应当前内容。')
        : null,
      h('div', { key: 'body', 'data-ciel-evidence-body': '' },
        ...lines.map((line) => {
          const target = targetLine !== undefined && line.number === targetLine
          return h('div', {
            key: String(line.number === undefined ? 'x' : line.number) + ':' + line.text.length,
            'data-ciel-line': line.number === undefined ? '' : String(line.number),
            ...(target ? { 'data-ciel-line-target': '', ref: targetRef } : {}),
          },
            line.number === undefined ? null : h('span', { key: 'n', 'data-ciel-line-number': String(line.number) }, String(line.number) + '  '),
            h('span', { key: 't', 'data-ciel-line-text': '' }, line.text))
        })),
      h('div', { key: 'current', 'data-ciel-evidence-current': '' },
        currentPath === undefined
          ? h('span', { key: 'none', 'data-ciel-current-none': '' }, '没有可打开的当前文件路径。')
          : [
            actionButton({
              key: 'compare',
              variant: 'primary',
              'data-ciel-compare-current': currentPath,
              onClick: () => { openFile(true) },
            }, '对照当前文件'),
            actionButton({
              key: 'open',
              variant: 'toolbar',
              icon: h('span', { 'aria-hidden': true }, '→'),
              'data-ciel-open-current': currentPath,
              onClick: () => { openFile(false) },
            }, '打开当前文件' + (startLine === undefined ? '' : '（第 ' + startLine + ' 行）')),
          ],
        note === '' ? null : h('span', { key: 'note', 'data-ciel-note': 'error' }, note)))
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

  /**
   * Register the three providers, the three tab types, and the three bodies.
   * @param ctx - the client root context (needs `effect`, `resources`,
   *   `sidebarRightTabs`, and `slots`).
   * @param options - `{ call, onPrepareFeedback, onTriage }`.
   * @returns an idempotent uninstall function; also reachable as `dispose`.
   */
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
    const onPrepareFeedback = typeof depsIn.onPrepareFeedback === 'function' ? depsIn.onPrepareFeedback : undefined
    const onTriage = typeof depsIn.onTriage === 'function' ? depsIn.onTriage : undefined

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
      // Local triage choices belong to this install; unload drops them.
      selections.clear()
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
    /**
     * Re-read one saved review for its triage only. The pinned resource keeps
     * its first frame, so a remounting body restores from the Host's saved
     * record here instead of trusting that frame. Never throws.
     * @param sessionId - the Session the review belongs to.
     * @param reviewId - the review id.
     * @returns the saved `triage.states`, or `undefined` when there is none.
     */
    const loaders = {
      [CIEL_REVIEW]: (parsed) => read('readReview', { sessionId: parsed.sessionId, reviewId: parsed.recordId }, 'review', { sessionId: parsed.sessionId, reviewId: parsed.recordId }),
      [CIEL_EVIDENCE]: (parsed) => read('readEvidence', { sessionId: parsed.sessionId, reviewId: parsed.recordId, evidenceId: parsed.evidenceId }, 'evidence', { sessionId: parsed.sessionId, reviewId: parsed.recordId, evidenceId: parsed.evidenceId }),
      [CIEL_ADVICE]: (parsed) => read('readAdvice', { sessionId: parsed.sessionId, callId: parsed.recordId }, 'advice', { sessionId: parsed.sessionId, callId: parsed.recordId }),
    }
    const definitions = [
      {
        id: TAB_IDS[CIEL_REVIEW],
        kind: CIEL_REVIEW,
        patterns: ['dsh-resource://' + CIEL_REVIEW + '/**'],
        priority: 'extension',
        canOpen: (address) => isProtocol(address, CIEL_REVIEW),
        title: (address) => titleOf(address, CIEL_REVIEW),
      },
      {
        id: TAB_IDS[CIEL_EVIDENCE],
        kind: CIEL_EVIDENCE,
        patterns: ['dsh-resource://' + CIEL_EVIDENCE + '/**'],
        priority: 'extension',
        canOpen: (address) => isProtocol(address, CIEL_EVIDENCE),
        title: (address) => titleOf(address, CIEL_EVIDENCE),
      },
      {
        id: TAB_IDS[CIEL_ADVICE],
        kind: CIEL_ADVICE,
        patterns: ['dsh-resource://' + CIEL_ADVICE + '/**'],
        priority: 'extension',
        canOpen: (address) => isProtocol(address, CIEL_ADVICE),
        title: (address) => titleOf(address, CIEL_ADVICE),
      },
    ]
    const face = {
      ...(onPrepareFeedback === undefined ? {} : { prepareFeedback: onPrepareFeedback }),
      ...(onTriage === undefined ? {} : { onTriage }),
      splitPane,
      openReview,
      openEvidence,
      openAdvice,
      openCurrentFile,
    }
    const bodies = [
      [TAB_IDS[CIEL_REVIEW], ReviewBody],
      [TAB_IDS[CIEL_EVIDENCE], EvidenceBody],
      [TAB_IDS[CIEL_ADVICE], AdviceBody],
    ]
    try {
      for (const protocol of PROTOCOLS) {
        own('dsh-ciel: ' + protocol + ' resource provider', () => resources.register(createStaticProvider(protocol, loaders[protocol])))
      }
      for (const definition of definitions) {
        own('dsh-ciel: ' + definition.kind + ' tab type', () => tabRegistry.register(definition))
      }
      for (const [key, Body] of bodies) {
        own('dsh-ciel: ' + key + ' body', () => slots.inject(TAB_SLOT, () => slots.register({
          name: TAB_SLOT,
          key,
          inject: () => face,
        }, Body)))
      }
    } catch (error) {
      // A registration clash must not leave half a module installed: unwind
      // everything this call already registered, then report the wiring fault.
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
   * Open a stored review in the native sidebar (chat entry).
   * @param sessionId - the Session the review belongs to.
   * @param reviewId - the review id.
   * @param options - `{ annotationIndex?, evidenceId? }`.
   * @returns `{ ok: true, address }` or `{ ok: false, error }`.
   */
  function openReview(sessionId, reviewId, options) {
    const source = options === undefined || options === null ? {} : options
    return open(reviewAddress(sessionId, reviewId), CIEL_REVIEW, paramsOf([
      ['annotationIndex', Number.isInteger(source.annotationIndex) ? source.annotationIndex : undefined],
      ['evidenceId', typeof source.evidenceId === 'string' && source.evidenceId !== '' ? source.evidenceId : undefined],
    ]))
  }

  /**
   * Open one stored evidence record in the native sidebar (chat entry).
   * @param sessionId - the Session the review belongs to.
   * @param reviewId - the review id.
   * @param evidenceId - the evidence id.
   * @param options - `{ line? }`.
   * @returns `{ ok: true, address }` or `{ ok: false, error }`.
   */
  function openEvidence(sessionId, reviewId, evidenceId, options) {
    const source = options === undefined || options === null ? {} : options
    return open(evidenceAddress(sessionId, reviewId, evidenceId), CIEL_EVIDENCE, paramsOf([
      ['line', lineNumber(source.line)],
    ]))
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
   * Split one docked pane through the native sidebar, for the evidence body's
   * explicit compare gesture. The native room rule and pane budget decide:
   * `undefined` means the column stays single. Never throws.
   * @param paneId - the pane to split; the tab's own panel.
   * @returns the new pane id, or `undefined` when nothing was split.
   */
  function splitPane(paneId) {
    if (disposed) return undefined
    const ctx = activeContext()
    if (ctx === undefined) return undefined
    const face = sidebarFace(ctx)
    if (face === null || face === undefined || typeof face.split !== 'function') return undefined
    try {
      return face.split(paneId)
    } catch {
      return undefined
    }
  }

  /**
   * Open the current file at a line through the native sidebar — the one
   * explicit gesture that bridges historical evidence to the live file. The
   * address comes from the injected `fileAddressFor`; the native registry
   * picks the viewer, and the native pane model decides docking or splitting.
   * @param sessionId - the Session whose workspace resolves the path.
   * @param path - the current file's path, as the evidence record carries it.
   * @param line - the 1-based line to reveal, when known.
   * @returns `{ ok: true, address }` or `{ ok: false, error }`.
   */
  function openCurrentFile(sessionId, path, line) {
    if (typeof path !== 'string' || path === '') return { ok: false, error: 'no current file path' }
    let address
    try {
      address = fileAddressFor(sessionId, path)
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
    if (typeof address !== 'string' || address === '') return { ok: false, error: 'fileAddressFor returned no address' }
    return open(address, undefined, paramsOf([['line', lineNumber(line)]]))
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

  return {
    install,
    dispose,
    openReview,
    openEvidence,
    openAdvice,
    openCurrentFile,
    reviewAddress,
    evidenceAddress,
    adviceAddress,
    parseAddress: parseCielAddress,
  }
}
