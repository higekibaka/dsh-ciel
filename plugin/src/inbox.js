/**
 * 夏尔收件箱 (Ciel inbox) — the browser half.
 *
 * One main-panel page plus its left-sidebar entry. The page reads ONE page of
 * the session's existing review records through the advisorReview Remote
 * (inboxList) and writes per-annotation intents through inboxSetIntent.
 * It never copies review bodies, evidence text, source code, prompts or model
 * output; the Host already bounds every projected string, and this module
 * additionally picks only the declared fields so an unknown field can never
 * ride along. It never calls a model, never touches the composer draft, and
 * never reuses the legacy accept/dismiss feedback WAL.
 *
 * The module is pure ESM with no imports so node tests can drive it directly:
 * React arrives as a factory parameter, the Host RPC arrives as a plain
 * call(method, request) business-level function, and the session service /
 * native right-sidebar / layout actions arrive through install options.
 *
 * Consistency model:
 *   - Every read carries a session id and a monotonically increasing
 *     generation. A later session switch or refresh bumps the generation, so
 *     an out-of-order response is dropped instead of overwriting the page.
 *   - Only the current page is retained, plus a bounded stack of previously
 *     seen cursors for "上一页". Switching sessions clears the page and its
 *     cursor chain.
 *   - A write presents the review's CURRENT reviewFingerprint and
 *     expectedRevision. Success is only reported from the server's returned
 *     { revision, intents } — never optimistically. A fingerprint/revision
 *     conflict marks the review stale and asks the user to refresh.
 *   - There is no polling and no MutationObserver. The page loads once on
 *     mount, on session switch, and on an explicit refresh; the anchor locate
 *     gesture performs a bounded rAF/timer wait and always re-checks the DOM.
 */

/** Main-panel key; the sidebar.panellist entry reuses it verbatim. */
export const INBOX_PANEL_ID = 'dsh-ciel/inbox'
/** Sidebar entry label. */
export const INBOX_LABEL = '夏尔收件箱'
/** Row order beside the shipped global panels. */
export const INBOX_PANEL_ORDER = 40

/** DSH 0.1.6 selection is the Session retained by the main view. */
export function currentSessionId(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  // Older DSH releases exposed selection directly on the list.
  if (Object.prototype.hasOwnProperty.call(snapshot, 'current')) {
    return typeof snapshot.current === 'string' && snapshot.current !== '' ? snapshot.current : undefined
  }
  const rows = snapshot.byId
  if (rows === null || typeof rows !== 'object') return undefined
  return Object.values(rows).find(row => (row?.retainedBy?.mainView ?? 0) > 0)?.id
}

/** Page sizing mirrors the Host: default and hard maximum are both 25. */
export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 25
/** Bounded cursor chain kept for "上一页" (never a page cache). */
export const MAX_CURSOR_STACK = 50
/** Bounded legacy-history paging when a record carries no anchorSeq. */
export const MAX_LOAD_OLDER_PAGES = 5
/** Bounded DOM waits: plain mount, and after a history load. */
export const ANCHOR_WAIT_FRAMES = 12
export const ANCHOR_WAIT_FRAMES_AFTER_LOAD = 60
/** Bounded wait for the rightbar session surface to mount after a panel switch. */
export const OPEN_WAIT_FRAMES = 60

/** The only legal per-annotation intents; pending is the implicit default. */
export const INBOX_INTENTS = Object.freeze(['pending', 'planned', 'rejected'])
export const INTENT_LABELS = Object.freeze({ pending: '待判断', planned: '准备处理', rejected: '暂不采纳' })
export const INBOX_FILTERS = Object.freeze(['all', 'pending', 'planned', 'rejected'])
export const FILTER_LABELS = Object.freeze({ all: '全部', pending: '待判断', planned: '准备处理', rejected: '暂不采纳' })

/** Client-side defensive caps; equal to the Host's own bounded projection. */
const LIMITS = Object.freeze({
  summary: 600,
  error: 500,
  title: 200,
  anchor: 400,
  comment: 1200,
  enum: 64,
  evidenceIds: 16,
  annotations: 64,
})

/** Host codes that mean "this page is out of date"; refresh is required. */
const CONFLICT_CODES = Object.freeze(new Set([
  'fingerprint_mismatch',
  'revision_conflict',
  'review_not_found',
  'review_identity',
  'record_corrupt',
]))

// ── pure helpers ─────────────────────────────────────────────────────────

/** Coerce a page limit to 1..25, defaulting to 25. */
export function normalizeLimit(limit) {
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_SIZE
  const value = Math.floor(limit)
  if (value < 1) return 1
  return Math.min(value, MAX_PAGE_SIZE)
}

/** One of the three legal intents; anything else is the pending default. */
export function normalizeIntent(value) {
  return value === 'planned' || value === 'rejected' ? value : 'pending'
}

/** Whether a server intent map is a sparse object of legal index keys and values. */
export function isValidIntentMap(intents, annotationCount) {
  if (intents === null || typeof intents !== 'object' || Array.isArray(intents)) return false
  for (const [key, value] of Object.entries(intents)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) return false
    const index = Number(key)
    if (!Number.isSafeInteger(index)) return false
    if (Number.isSafeInteger(annotationCount) && index >= annotationCount) return false
    if (value !== 'pending' && value !== 'planned' && value !== 'rejected') return false
  }
  return true
}

/** A bounded non-empty string, or undefined. */
function text(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed
}

/** The Host's maximum review id; longer is an explicit invalid response. */
const REVIEW_ID_MAX = 512

/**
 * A raw identity string (reviewId / messageId / evidence id). Identity is
 * NEVER trimmed, truncated, or stringified: the value projected by the Host
 * is what RPC and the DOM anchor must use verbatim. A non-string or empty
 * value is treated as absent (the Host already rejects those).
 */
function idText(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A bounded status/verdict/coverage token, or undefined. */
function enumText(value) {
  return text(value, LIMITS.enum)
}

/** The human line for any failure-shaped value; never throws. */
export function errorMessage(value) {
  if (value === undefined || value === null) return '未知错误'
  if (typeof value === 'string') return value === '' ? '未知错误' : value
  if (value instanceof Error) return value.message === '' ? String(value) : value.message
  if (typeof value === 'object') {
    if (typeof value.message === 'string' && value.message !== '') return value.message
    if (typeof value.error === 'string' && value.error !== '') return value.error
    if (value.error !== null && typeof value.error === 'object') {
      if (typeof value.error.message === 'string' && value.error.message !== '') return value.error.message
      if (typeof value.error.code === 'string' && value.error.code !== '') return value.error.code
    }
    if (typeof value.code === 'string' && value.code !== '') return value.code
  }
  return '未知错误'
}

/** Whether a business-level failure means the page must be refreshed. */
export function isConflictResult(result) {
  if (result === null || typeof result !== 'object') return false
  if (typeof result.code === 'string' && CONFLICT_CODES.has(result.code)) return true
  return false
}

/** One bounded annotation; unknown fields are deliberately dropped. */
export function normalizeAnnotation(raw, fallbackIndex) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const index = Number.isInteger(source.index) && source.index >= 0 ? source.index : (Number.isInteger(fallbackIndex) ? fallbackIndex : 0)
  const evidenceIds = Array.isArray(source.evidenceIds)
    ? source.evidenceIds.map((value) => idText(value)).filter((value) => value !== undefined).slice(0, LIMITS.evidenceIds)
    : []
  return {
    index,
    severity: source.severity === 'blocker' ? 'blocker' : 'nit',
    title: text(source.title, LIMITS.title) || '',
    anchor: text(source.anchor, LIMITS.anchor) || '',
    comment: text(source.comment, LIMITS.comment) || '',
    evidenceIds,
    intent: normalizeIntent(source.intent),
  }
}

/** One bounded review projection; unknown fields are deliberately dropped. */
export function normalizeReview(raw, fallbackIndex) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const reviewId = idText(raw.reviewId)
  const messageId = idText(raw.messageId)
  const sessionId = idText(raw.sessionId)
  const annotations = Array.isArray(raw.annotations)
    ? raw.annotations.slice(0, LIMITS.annotations).map((annotation, index) => normalizeAnnotation(annotation, index))
    : []
  const revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
  const anchorSeq = Number.isInteger(raw.anchorSeq) && raw.anchorSeq >= 0 ? raw.anchorSeq : undefined
  // An over-long review id is an explicit client-side invalid response; the
  // identity itself is preserved, never clipped into a different record.
  const identityInvalid = reviewId !== undefined && reviewId.length > REVIEW_ID_MAX
  const key = (reviewId === undefined ? (messageId === undefined ? 'entry' : 'm:' + messageId) : reviewId) + '#' + (Number.isInteger(fallbackIndex) ? fallbackIndex : 0)
  return {
    key,
    ...(identityInvalid ? { invalid: true } : {}),
    sessionId,
    reviewId: reviewId === undefined ? '' : reviewId,
    messageId: messageId === undefined ? '' : messageId,
    ...(anchorSeq === undefined ? {} : { anchorSeq }),
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined,
    status: enumText(raw.status) || 'unknown',
    verdict: enumText(raw.verdict),
    summary: text(raw.summary, LIMITS.summary),
    error: text(raw.error, LIMITS.error),
    coverage: enumText(raw.coverage),
    reviewFingerprint: typeof raw.reviewFingerprint === 'string' ? raw.reviewFingerprint : '',
    revision,
    annotations,
  }
}

/**
 * Validate the Host page envelope before any projection. Returns an error tag
 * or undefined. A malformed page is an explicit error, never a silent empty
 * list, and every review's identity must belong to the requested session.
 */
export function validateListPayload(result, sessionId) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return 'invalid'
  if (result.sessionId !== sessionId) return 'session'
  if (!Array.isArray(result.reviews)) return 'reviews'
  if (result.reviews.length > MAX_PAGE_SIZE) return 'reviews'
  if (result.nextCursor !== null && result.nextCursor !== undefined && typeof result.nextCursor !== 'string') return 'cursor'
  for (const raw of result.reviews) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'review'
    if (raw.sessionId !== sessionId) return 'review'
    if (typeof raw.reviewId !== 'string' || raw.reviewId === '' || raw.reviewId.length > REVIEW_ID_MAX) return 'review'
    if (typeof raw.messageId !== 'string' || raw.messageId === '') return 'review'
    if (typeof raw.reviewFingerprint !== 'string' || raw.reviewFingerprint === '') return 'review'
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) return 'review'
    if (!Array.isArray(raw.annotations) || raw.annotations.length > LIMITS.annotations) return 'review'
    for (let index = 0; index < raw.annotations.length; index += 1) {
      const annotation = raw.annotations[index]
      if (annotation === null || typeof annotation !== 'object' || Array.isArray(annotation)) return 'annotation'
      // The Host projects 0..n-1 in array order; a different index is a
      // different record, and a bad intent/severity is an explicit error
      // rather than a silent pending/nit downgrade.
      if (!Number.isSafeInteger(annotation.index) || annotation.index !== index) return 'annotation'
      if (annotation.intent !== undefined && annotation.intent !== 'pending' && annotation.intent !== 'planned' && annotation.intent !== 'rejected') return 'annotation'
      if (annotation.severity !== undefined && annotation.severity !== 'blocker' && annotation.severity !== 'nit') return 'annotation'
    }
  }
  return undefined
}

/** Whether a review group is failed / cancelled / unfinished / otherwise. */
export function reviewClassification(review) {
  const status = review !== null && typeof review === 'object' ? review.status : undefined
  if (status === 'error' || status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'canceled') return 'cancelled'
  if (status === 'incomplete' || status === 'unverified' || status === 'completed-unparsed' || status === 'running' || status === 'pending') return 'incomplete'
  return 'complete'
}

/** The status chip copy for one review. */
export function statusLabel(status) {
  switch (status) {
    case 'sound': return '整体成立'
    case 'completed': return '已完成'
    case 'error':
    case 'failed': return '失败'
    case 'cancelled':
    case 'canceled': return '已取消'
    case 'incomplete': return '未检查完'
    case 'unverified': return '未独立核实'
    case 'completed-unparsed': return '未解析完成'
    case 'running': return '进行中'
    default: return '状态未知'
  }
}

/** The coverage chip copy for one review. */
export function coverageLabel(coverage) {
  switch (coverage) {
    case 'complete': return '完整核实'
    case 'partial': return '部分核实'
    case 'not-verified': return '未核实'
    default: return undefined
  }
}

/** The verdict chip copy for one review. */
export function verdictLabel(verdict) {
  switch (verdict) {
    case 'pass': return '整体成立'
    case 'changes': return '建议修改'
    default: return undefined
  }
}

/** The annotation-free copy that still preserves a non-OK review group. */
export function emptyAnnotationsLabel(review) {
  switch (reviewClassification(review)) {
    case 'failed': return '本次评审失败，没有留下批注。'
    case 'cancelled': return '本次评审已取消，没有留下批注。'
    case 'incomplete': return '本次评审未检查完，没有留下批注。'
    default: return '本次评审没有批注。'
  }
}

/**
 * Page-local filtering. An intent filter keeps reviews carrying such an
 * annotation AND every anomalous group (failed / cancelled / unfinished), so a
 * filter can never make a broken review look like an untroubled one.
 */
export function filterReviews(reviews, filter) {
  const list = Array.isArray(reviews) ? reviews : []
  if (filter === 'pending' || filter === 'planned' || filter === 'rejected') {
    return list.filter((review) => reviewClassification(review) !== 'complete'
      || review.annotations.some((annotation) => annotation.intent === filter))
  }
  return list
}

/** Page-local counts; nothing here reflects records outside the loaded page. */
export function pageCounts(reviews) {
  const list = Array.isArray(reviews) ? reviews : []
  const counts = { reviews: list.length, annotations: 0, pending: 0, planned: 0, rejected: 0, failed: 0, cancelled: 0, incomplete: 0 }
  for (const review of list) {
    const classification = reviewClassification(review)
    if (Object.prototype.hasOwnProperty.call(counts, classification)) counts[classification] += 1
    for (const annotation of review.annotations) {
      counts.annotations += 1
      counts[annotation.intent] += 1
    }
  }
  return counts
}

// ── derived-value and element memoization ────────────────────────────────
//
// The controller keeps an immutable snapshot and shares unchanged references
// across emits: a write or a locate never rebuilds `reviews`, and a write only
// replaces the one `writes[key]` entry it touched. These caches build on that
// contract. Page counts and the filtered list are computed once per
// (reviews, filter) pair, and a review card element is reused while its own
// inputs are referentially unchanged — React skips a subtree when it receives
// the SAME element (same props object), so an unrelated emit no longer redraws
// every card on the page. All three are keyed by the `reviews` array, so a
// page replacement or session switch drops the previous page's entries.
const countsByReviews = new WeakMap()
const filteredByReviews = new WeakMap()
// Card elements are memoized per CONTROLLER, not per reviews array: a
// successful write replaces the reviews array (structural sharing), so an
// array-keyed cache would be dropped on every save and the untouched cards
// would rebuild. The controller is the stable owner; one entry set per page
// (getPageToken) is dropped on refresh/pagination/session switch, so no old
// review, element, or callback is retained across pages.
const cardsByController = new WeakMap()

/** Page-local counts, computed once per reviews array. */
export function cachedPageCounts(reviews) {
  const list = Array.isArray(reviews) ? reviews : []
  let counts = countsByReviews.get(list)
  if (counts === undefined) {
    counts = pageCounts(list)
    countsByReviews.set(list, counts)
  }
  return counts
}

/** The filtered list, computed once per (reviews, filter) pair. */
export function cachedFilteredReviews(reviews, filter) {
  const list = Array.isArray(reviews) ? reviews : []
  let byFilter = filteredByReviews.get(list)
  if (byFilter === undefined) {
    byFilter = new Map()
    filteredByReviews.set(list, byFilter)
  }
  if (!byFilter.has(filter)) byFilter.set(filter, filterReviews(list, filter))
  return byFilter.get(filter)
}

/**
 * Reuse the element for one review card whose inputs are referentially
 * unchanged. `inputs` carries exactly the values the card renders from
 * (`review`, `write`, `locate`, `filter`); `build` creates the element only
 * on a miss.
 *
 * The cache is owned by the CONTROLLER (stable identity, and never shared
 * across controllers) and scoped by its page token: a write keeps the token,
 * so an untouched card keeps its element; refresh/pagination/session switch
 * replaces the token, which drops the whole entry map (no retained review,
 * element, or old callback). A missing token or controller simply rebuilds.
 */
export function memoReviewCard(controller, pageToken, review, inputs, build) {
  if (controller === null || controller === undefined || typeof controller !== 'object' || pageToken === undefined || pageToken === null) {
    return build()
  }
  let holder = cardsByController.get(controller)
  if (holder === undefined || holder.pageToken !== pageToken) {
    holder = { pageToken, entries: new Map() }
    cardsByController.set(controller, holder)
  }
  const previous = holder.entries.get(review.key)
  if (previous !== undefined
    && previous.review === inputs.review
    && previous.write === inputs.write
    && previous.locate === inputs.locate
    && previous.filter === inputs.filter) {
    return previous.element
  }
  const element = build()
  holder.entries.set(review.key, {
    review: inputs.review,
    write: inputs.write,
    locate: inputs.locate,
    filter: inputs.filter,
    element,
  })
  return element
}

/** A deterministic UTC display timestamp. */
export function formatTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  try {
    return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } catch {
    return ''
  }
}

/** A short, stable display id. */
export function shortId(value, length) {
  const max = Number.isInteger(length) ? length : 10
  const string = value === undefined || value === null ? '' : String(value)
  return string.length <= max ? string : string.slice(0, max) + '…'
}

/** CSS attribute escaping that also works without a browser CSS.escape. */
export function escapeAttribute(value) {
  const string = String(value)
  const css = typeof globalThis.CSS === 'object' && globalThis.CSS !== null && typeof globalThis.CSS.escape === 'function' ? globalThis.CSS : undefined
  if (css !== undefined) return css.escape(string)
  return string.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** The selector of the existing Ciel-owned anchor for one message. */
export function anchorSelector(sessionId, messageId) {
  return '[data-ciel-session-id="' + escapeAttribute(sessionId) + '"][data-ciel-message-id="' + escapeAttribute(messageId) + '"]'
}

/** The default DOM lookup, used when install did not inject one. */
export function findAnchorInDocument(sessionId, messageId) {
  const doc = typeof document === 'undefined' ? undefined : document
  if (doc === undefined || doc === null || typeof doc.querySelector !== 'function') return undefined
  try {
    return doc.querySelector(anchorSelector(sessionId, messageId)) || undefined
  } catch {
    return undefined
  }
}

// ── controller ───────────────────────────────────────────────────────────

/**
 * Build the inbox store/controller. All async work is generation- and
 * session-fenced; the returned getSnapshot is a plain immutable value and
 * subscribe notifies on every change.
 *
 * @param options - { call, getSessions?, host?, now?, pageSize? }.
 * @returns the controller: snapshot access plus every page action.
 */
export function createInboxController(options) {
  const deps = options === null || options === undefined ? {} : options
  const call = deps.call
  if (typeof call !== 'function') throw new TypeError('createInboxController: call(method, request) is required')
  const getSessionsOption = typeof deps.getSessions === 'function' ? deps.getSessions : () => undefined
  const host = deps.host !== null && typeof deps.host === 'object' ? deps.host : {}
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const pageSize = normalizeLimit(deps.pageSize)

  let generation = 0
  // Stable identity of the currently loaded page. It changes only when the
  // page itself is replaced (refresh / pagination / session switch), never on
  // a write, so the card element memo can keep untouched cards across writes
  // while dropping every entry (and its refs) on a real page change.
  let pageToken = {}
  let disposed = false
  let sessionsService
  let sessionsUnsubscribe = null
  let writeSerial = 0
  let locateSerial = 0
  let openSerial = 0
  const writeTokens = new Map()
  const locateTokens = new Map()
  const listeners = new Set()

  function baseState(sessionId) {
    return {
      sessionId,
      phase: sessionId === undefined ? 'empty' : 'idle',
      reviews: [],
      nextCursor: null,
      limited: false,
      loadedAt: undefined,
      error: undefined,
      errorCode: undefined,
      attempted: false,
      cursor: undefined,
      cursorStack: [],
      pageIndex: 1,
      pageSize,
      filter: 'all',
      writes: {},
      locate: {},
      locateNotice: null,
      open: { status: 'idle', kind: undefined, reviewId: undefined, evidenceId: undefined, error: undefined },
    }
  }
  let state = baseState(undefined)

  /** The bound sessions service, or the lazily resolved option. */
  function getSessions() {
    return sessionsService !== undefined ? sessionsService : getSessionsOption()
  }

  function emit() {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a listener failure must not break the store */ }
    }
  }
  function set(patch) {
    state = { ...state, ...patch }
    emit()
  }
  function getSnapshot() { return state }
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function findReview(key) {
    for (const review of state.reviews) {
      if (review.key === key || (review.reviewId !== '' && review.reviewId === key)) return review
    }
    return null
  }

  function setWrite(key, patch) {
    const previous = state.writes[key] !== undefined ? state.writes[key] : {}
    state = { ...state, writes: { ...state.writes, [key]: { pending: false, pendingIndex: undefined, pendingIntent: undefined, error: undefined, conflict: false, ...previous, ...patch } } }
    emit()
  }
  function setLocate(key, patch) {
    const previous = state.locate[key] !== undefined ? state.locate[key] : {}
    state = { ...state, locate: { ...state.locate, [key]: { phase: 'idle', error: undefined, ...previous, ...patch } } }
    emit()
  }
  function setOpen(patch) {
    state = { ...state, open: { status: 'idle', kind: undefined, reviewId: undefined, evidenceId: undefined, error: undefined, ...state.open, ...patch } }
    emit()
  }
  /** A session-global notice so a locate failure survives a page reset. */
  function setLocateNotice(notice) {
    state = { ...state, locateNotice: notice }
    emit()
  }

  /** Replace the tracked session; a switch invalidates every in-flight request. */
  function syncSession(sessionId) {
    const next = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
    if (next === state.sessionId) return false
    generation += 1
    pageToken = {}
    writeTokens.clear()
    locateTokens.clear()
    state = { ...baseState(next), filter: state.filter }
    emit()
    return true
  }

  /**
   * Root-level sessions subscription: it stays bound for the install lifetime
   * so a session switch keeps invalidating in-flight reads even while the page
   * is unmounted. It clears the page on switch but never fetches.
   */
  function bindSessions(service) {
    const next = service === null ? undefined : service
    if (next === sessionsService) return
    if (sessionsUnsubscribe !== null) { sessionsUnsubscribe(); sessionsUnsubscribe = null }
    sessionsService = next
    if (next === undefined || next.list === null || next.list === undefined || typeof next.list.subscribe !== 'function') return
    const apply = () => {
      const snapshot = typeof next.list.getSnapshot === 'function' ? next.list.getSnapshot() : undefined
      syncSession(currentSessionId(snapshot))
    }
    apply()
    sessionsUnsubscribe = next.list.subscribe(apply)
  }

  /** Open gesture: sync the current session, then read one fresh first page. */
  function openPage() {
    const service = getSessions()
    const snapshot = service !== null && service !== undefined && service.list !== null && service.list !== undefined && typeof service.list.getSnapshot === 'function' ? service.list.getSnapshot() : undefined
    const current = currentSessionId(snapshot)
    syncSession(current)
    if (state.sessionId === undefined) return Promise.resolve({ ok: false, code: 'invalid_session', error: '没有可用的会话' })
    // Opening/mounting preserves a just-shown locate failure; the explicit
    // refresh button still clears it.
    return loadPage(state.sessionId, undefined, { reset: true, preserveLocate: true })
  }

  /**
   * Load one page. opts.cursorStack / opts.pageIndex describe the resulting
   * pagination position; opts.reset starts a fresh first page.
   */
  async function loadPage(sessionId, cursor, opts) {
    const optionsIn = opts === null || opts === undefined ? {} : opts
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { ok: false, code: 'invalid_session', error: '没有可用的会话' }
    }
    const requestGeneration = ++generation
    // Any page load (first, refresh, next, prev) is a new page identity; a
    // stale response is already fenced by the generation check below.
    pageToken = {}
    writeTokens.clear()
    locateTokens.clear()
    const reset = optionsIn.reset === true
    set({
      sessionId,
      phase: 'loading',
      attempted: true,
      error: undefined,
      errorCode: undefined,
      ...(reset ? { reviews: [], nextCursor: null, limited: false, cursor: undefined, cursorStack: [], pageIndex: 1, writes: {}, ...(optionsIn.preserveLocate === true ? {} : { locate: {} }) } : {}),
    })
    const request = { sessionId, limit: state.pageSize }
    if (cursor !== undefined && cursor !== null) request.cursor = cursor
    let result
    try {
      result = await call('inboxList', request)
    } catch (error) {
      result = { ok: false, code: 'store_error', error: errorMessage(error) }
    }
    if (disposed || generation !== requestGeneration || state.sessionId !== sessionId) {
      return { ok: false, stale: true, code: 'stale', error: '页面或会话已变化，本次读取结果未采用' }
    }
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      const code = result !== null && typeof result === 'object' && typeof result.code === 'string' ? result.code : undefined
      set({ phase: 'error', error: errorMessage(result), errorCode: code })
      return { ok: false, code, error: errorMessage(result) }
    }
    const payloadError = validateListPayload(result, sessionId)
    if (payloadError !== undefined) {
      const message = '收件箱返回的记录格式无效，本页未采用'
      set({ phase: 'error', error: message, errorCode: 'record_corrupt' })
      return { ok: false, code: 'record_corrupt', error: message }
    }
    const reviews = result.reviews.map((raw, index) => normalizeReview(raw, index))
    const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : null
    const cursorStack = optionsIn.cursorStack !== undefined ? optionsIn.cursorStack.slice(-MAX_CURSOR_STACK) : (reset ? [] : state.cursorStack)
    set({
      sessionId,
      phase: 'ready',
      reviews,
      nextCursor,
      limited: result.limited === true,
      loadedAt: now(),
      cursor,
      cursorStack,
      pageIndex: optionsIn.pageIndex !== undefined ? optionsIn.pageIndex : (reset ? 1 : state.pageIndex),
      error: undefined,
      errorCode: undefined,
      writes: {},
      ...(optionsIn.preserveLocate === true ? {} : { locate: {} }),
    })
    return { ok: true, reviews, nextCursor, limited: result.limited === true }
  }

  /** Fetch the first page once per session; never refetches a ready page. */
  function ensureLoaded() {
    if (state.sessionId === undefined) return Promise.resolve({ ok: false, code: 'invalid_session', error: '没有可用的会话' })
    if (state.phase === 'ready' || state.phase === 'loading' || state.attempted) return Promise.resolve({ ok: true, cached: true })
    return loadPage(state.sessionId, undefined, { reset: true })
  }

  /** Explicit refresh: always a fresh first page. */
  function refresh() {
    if (state.sessionId === undefined) return Promise.resolve({ ok: false, code: 'invalid_session', error: '没有可用的会话' })
    return loadPage(state.sessionId, undefined, { reset: true })
  }

  function nextPage() {
    if (state.sessionId === undefined) return Promise.resolve({ ok: false, code: 'invalid_session', error: '没有可用的会话' })
    if (state.nextCursor === null) return Promise.resolve({ ok: false, code: 'no_more_pages', error: '已经是最后一页' })
    const cursorStack = state.cursorStack.concat([state.cursor])
    return loadPage(state.sessionId, state.nextCursor, { cursorStack, pageIndex: state.pageIndex + 1 })
  }

  function prevPage() {
    if (state.sessionId === undefined) return Promise.resolve({ ok: false, code: 'invalid_session', error: '没有可用的会话' })
    if (state.cursorStack.length === 0) return Promise.resolve({ ok: false, code: 'first_page', error: '已经是第一页' })
    const cursorStack = state.cursorStack.slice(0, -1)
    const cursor = state.cursorStack[state.cursorStack.length - 1]
    return loadPage(state.sessionId, cursor, { cursorStack, pageIndex: Math.max(1, state.pageIndex - 1) })
  }

  function setFilter(filter) {
    const next = INBOX_FILTERS.includes(filter) ? filter : 'all'
    if (next === state.filter) return
    set({ filter: next })
  }

  function intentAt(intents, index) {
    if (intents === null || typeof intents !== 'object') return 'pending'
    const key = String(index)
    return normalizeIntent(Object.prototype.hasOwnProperty.call(intents, key) ? intents[key] : undefined)
  }

  /** Adopt the server's authoritative revision/fingerprint/intents. */
  function applyServerIntents(key, result) {
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) return false
    if (typeof result.reviewFingerprint !== 'string' || result.reviewFingerprint === '') return false
    const intents = result.intents !== null && typeof result.intents === 'object' ? result.intents : {}
    let changed = false
    const reviews = state.reviews.map((review) => {
      if (review.key !== key) return review
      // Structural sharing: only an annotation whose intent actually changed
      // gets a new object, and a review whose contents are unchanged keeps its
      // identity, so the per-card element memo can reuse the untouched cards.
      let annotationsChanged = false
      const annotations = review.annotations.map((annotation) => {
        const intent = intentAt(intents, annotation.index)
        if (intent === annotation.intent) return annotation
        annotationsChanged = true
        return { ...annotation, intent }
      })
      if (!annotationsChanged && review.revision === result.revision && review.reviewFingerprint === result.reviewFingerprint) return review
      changed = true
      return {
        ...review,
        revision: result.revision,
        reviewFingerprint: result.reviewFingerprint,
        annotations: annotationsChanged ? annotations : review.annotations,
      }
    })
    if (!changed) return true
    state = { ...state, reviews }
    emit()
    return true
  }

  /**
   * Compare-and-swap one annotation intent. Never marks the choice locally —
   * only the server's returned state is adopted.
   */
  async function setIntent(key, index, intent) {
    const review = findReview(key)
    if (state.sessionId === undefined) return { ok: false, code: 'invalid_session', error: '没有可用的会话' }
    if (review === null) return { ok: false, code: 'review_not_found', error: '该评审不在当前页' }
    if (review.invalid === true || review.reviewId === '') return { ok: false, code: 'invalid_review_id', error: '该评审标识无效，无法写入' }
    if (review.sessionId !== state.sessionId) return { ok: false, code: 'review_identity', error: '会话已切换，未保存' }
    if (!Number.isInteger(index) || index < 0) return { ok: false, code: 'invalid_index', error: '批注序号无效' }
    const currentWrite = state.writes[review.key]
    if (currentWrite !== undefined && currentWrite.conflict === true) return { ok: false, code: 'stale', error: '状态已过期，请先刷新本页' }
    // One write per review at a time: two same-review clicks would otherwise
    // share one expectedRevision and settle out of order.
    if (currentWrite !== undefined && currentWrite.pending === true) return { ok: false, code: 'write_busy', error: '该评审有正在保存的意向，请稍候' }
    const normalized = normalizeIntent(intent)
    const requestGeneration = generation
    const requestSession = state.sessionId
    const requestRevision = review.revision
    const requestFingerprint = review.reviewFingerprint
    const token = ++writeSerial
    writeTokens.set(review.key, token)
    setWrite(review.key, { pending: true, pendingIndex: index, pendingIntent: normalized, error: undefined, conflict: false })
    let result
    try {
      result = await call('inboxSetIntent', {
        sessionId: requestSession,
        reviewId: review.reviewId,
        reviewFingerprint: requestFingerprint,
        expectedRevision: requestRevision,
        index,
        intent: normalized,
      })
    } catch (error) {
      result = { ok: false, code: 'store_error', error: errorMessage(error) }
    }
    const settled = () => {
      if (writeTokens.get(review.key) !== token) return false
      writeTokens.delete(review.key)
      return true
    }
    if (disposed || generation !== requestGeneration || state.sessionId !== requestSession || writeTokens.get(review.key) !== token) {
      if (writeTokens.get(review.key) === token) writeTokens.delete(review.key)
      return { ok: false, stale: true, code: 'stale', error: '会话或页面已变化，本次写入结果未采用' }
    }
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      settled()
      const conflict = isConflictResult(result)
      setWrite(review.key, { pending: false, pendingIndex: undefined, pendingIntent: undefined, error: errorMessage(result), conflict })
      return { ok: false, code: result !== null && typeof result === 'object' && typeof result.code === 'string' ? result.code : undefined, error: errorMessage(result), conflict }
    }
    // Strict success: identity, the fingerprint we sent, exactly one revision
    // step, and a legal sparse intent map. A malformed success is NOT treated
    // as "everything pending".
    if (result.sessionId !== requestSession || result.reviewId !== review.reviewId
      || result.reviewFingerprint !== requestFingerprint
      || !Number.isSafeInteger(result.revision)
      || result.revision !== requestRevision + 1
      || !isValidIntentMap(result.intents, review.annotations.length)) {
      settled()
      setWrite(review.key, { pending: false, pendingIndex: undefined, pendingIntent: undefined, error: '服务返回的写入结果无效，未采用', conflict: true })
      return { ok: false, code: 'record_corrupt', error: '服务返回的写入结果无效，未采用', conflict: true }
    }
    settled()
    if (!applyServerIntents(review.key, result)) {
      setWrite(review.key, { pending: false, pendingIndex: undefined, pendingIntent: undefined, error: '服务未返回当前评审版本，未采用', conflict: true })
      return { ok: false, code: 'record_corrupt', error: '服务未返回当前评审版本，未采用', conflict: true }
    }
    setWrite(review.key, { pending: false, pendingIndex: undefined, pendingIntent: undefined, error: undefined, conflict: false })
    return { ok: true, revision: result.revision, intents: result.intents }
  }

  /** The one Host failure that means "the rightbar surface is not mounted yet". */
  function isBindingNotReady(value) {
    return /no session surface is mounted/i.test(errorMessage(value))
  }

  function invokeOpen(kind, sessionId, reviewId, evidenceId) {
    try {
      if (kind === 'review') {
        if (typeof host.openReview !== 'function') return { ok: false, error: '原生右栏不可用' }
        return host.openReview(sessionId, reviewId)
      }
      if (typeof host.openEvidence !== 'function') return { ok: false, error: '原生右栏不可用' }
      return host.openEvidence(sessionId, reviewId, evidenceId)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  /**
   * Open a review/evidence in the native right sidebar. The Host renders that
   * sidebar only while the Conversation panel is active (RightbarRoot gates on
   * activePanelId === null), so this first returns to the Conversation, then
   * bounded-waits — retrying ONLY the exact "no session surface is mounted"
   * binding error — before opening. Any other failure is final and is stored
   * on the controller (the inbox panel has just unmounted, so component-local
   * state would vanish); the inbox is then brought back to show it.
   */
  async function openResource(kind, key, evidenceId) {
    const review = findReview(key)
    if (state.sessionId === undefined) return { ok: false, code: 'invalid_session', error: '没有可用的会话' }
    if (review === null) return { ok: false, code: 'review_not_found', error: '该评审不在当前页' }
    if (review.invalid === true || review.reviewId === '') return { ok: false, code: 'invalid_review_id', error: '该评审标识无效，无法打开' }
    if (review.sessionId !== state.sessionId) return { ok: false, code: 'review_identity', error: '会话已切换，未打开' }
    if (kind !== 'review' && kind !== 'evidence') return { ok: false, code: 'invalid_request', error: '不支持的打开类型' }
    if (kind === 'evidence' && (typeof evidenceId !== 'string' || evidenceId === '')) return { ok: false, code: 'invalid_request', error: '证据标识无效' }
    const sessionId = state.sessionId
    const requestGeneration = generation
    const opToken = ++openSerial
    const onPage = () => state.sessionId === sessionId && generation === requestGeneration && openSerial === opToken
    setOpen({ status: 'opening', kind, reviewId: review.reviewId, evidenceId, error: undefined })
    try { if (typeof host.revealConversation === 'function') host.revealConversation() } catch { /* navigation is best-effort */ }
    let signal
    try { signal = typeof host.beginNavigation === 'function' ? host.beginNavigation() : undefined } catch { signal = undefined }
    const stopped = () => disposed || !onPage() || (signal !== undefined && signal.aborted === true)
    let result
    for (let attempt = 0; attempt < OPEN_WAIT_FRAMES; attempt += 1) {
      if (stopped()) return { ok: false, code: 'stale', error: '导航已取消，未打开右栏' }
      result = invokeOpen(kind, sessionId, review.reviewId, evidenceId)
      if (result !== null && typeof result === 'object' && result.ok === true) break
      if (!isBindingNotReady(result)) break
      await nextFrame()
    }
    if (stopped()) return { ok: false, code: 'stale', error: '导航已取消，未打开右栏' }
    if (result !== null && typeof result === 'object' && result.ok === true) {
      setOpen({ status: 'opened', kind, reviewId: review.reviewId, evidenceId, error: undefined })
      return { ok: true }
    }
    const message = errorMessage(result)
    setOpen({ status: 'failed', kind, reviewId: review.reviewId, evidenceId, error: message })
    // Come back so the failure is visible; a toast service is not verified here.
    try { if (typeof host.revealInbox === 'function') host.revealInbox() } catch { /* best-effort */ }
    return { ok: false, code: result !== null && typeof result === 'object' && typeof result.code === 'string' ? result.code : undefined, error: message }
  }

  function safeFind(sessionId, messageId) {
    if (typeof host.findAnchor === 'function') {
      try { return host.findAnchor(sessionId, messageId) } catch { return undefined }
    }
    return findAnchorInDocument(sessionId, messageId)
  }

  /** One bounded wait step; prefers the injected scheduler, then rAF, then a timer. */
  function nextFrame() {
    return new Promise((resolve) => {
      if (typeof host.nextFrame === 'function') {
        let outcome
        try { outcome = host.nextFrame() } catch { resolve(); return }
        if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') { outcome.then(() => resolve(), () => resolve()); return }
        resolve()
        return
      }
      const win = typeof window !== 'undefined' ? window : undefined
      if (win !== undefined && win !== null && typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(() => resolve())
        return
      }
      setTimeout(resolve, 16)
    })
  }

  /** Re-check the DOM for a bounded number of frames; never asserts success. */
  async function waitForAnchor(sessionId, messageId, signal, attempts, cancelled) {
    const stopped = typeof cancelled === 'function' ? cancelled : () => signal !== undefined && signal.aborted === true
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (stopped()) return undefined
      const element = safeFind(sessionId, messageId)
      if (element !== undefined && element !== null) return element
      await nextFrame()
    }
    if (stopped()) return undefined
    return safeFind(sessionId, messageId)
  }

  /** Resolve the Session face's history verbs, or undefined. */
  function sessionFace(sessionId) {
    const sessions = getSessions()
    if (sessions === null || sessions === undefined || typeof sessions.scope !== 'function') return undefined
    const scoped = sessions.scope(sessionId)
    if (scoped === undefined || scoped === null || typeof sessions.sessionOf !== 'function') return undefined
    const face = sessions.sessionOf(scoped)
    return face === undefined || face === null ? undefined : face
  }

  async function loadThrough(sessionId, seq) {
    if (typeof host.loadThrough === 'function') {
      try { await host.loadThrough(sessionId, seq); return true } catch { return false }
    }
    const face = sessionFace(sessionId)
    if (face === undefined || typeof face.loadThrough !== 'function') return false
    try { await face.loadThrough(seq); return true } catch { return false }
  }

  async function loadOlderPage(sessionId) {
    if (typeof host.loadOlder === 'function') {
      try { await host.loadOlder(sessionId); return true } catch { return false }
    }
    const face = sessionFace(sessionId)
    if (face === undefined || typeof face.loadOlder !== 'function') return false
    try { await face.loadOlder(); return true } catch { return false }
  }

  /** Scroll the found anchor into view; prefers the injected hook, then the element. */
  function scrollAnchor(element) {
    if (typeof host.scrollToAnchor === 'function') {
      try { host.scrollToAnchor(element); return } catch { /* fall through to the element */ }
    }
    try {
      if (element !== null && element !== undefined && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } catch { /* scrolling is cosmetic */ }
  }

  /**
   * Locate the message's existing Ciel anchor in the conversation. Switches to
   * the Conversation first (so its DOM is mounted), takes a FRESH navigation
   * signal afterwards (selectPanel aborts the previous one), then loads history
   * when needed and always re-checks the DOM before reporting success.
   */
  async function locate(key) {
    const review = findReview(key)
    if (review === null) return { ok: false, code: 'review_not_found', error: '该评审不在当前页' }
    const sessionId = state.sessionId
    if (sessionId === undefined) return { ok: false, code: 'invalid_session', error: '没有可用的会话' }
    if (review.sessionId !== undefined && review.sessionId !== sessionId) return { ok: false, code: 'review_identity', error: '会话已切换，未定位' }
    const sessions = getSessions()
    const snapshot = sessions !== null && sessions !== undefined && sessions.list !== null && sessions.list !== undefined && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
    if (snapshot !== undefined && snapshot !== null && currentSessionId(snapshot) !== sessionId) {
      setLocate(review.key, { phase: 'failed', error: '请先切回该会话再定位' })
      return { ok: false, code: 'review_identity', error: '请先切回该会话再定位' }
    }
    if (review.messageId === '') {
      setLocate(review.key, { phase: 'failed', error: '该评审没有消息标识，无法定位' })
      return { ok: false, code: 'invalid_request', error: '该评审没有消息标识，无法定位' }
    }
    const requestGeneration = generation
    const opToken = ++locateSerial
    locateTokens.set(review.key, opToken)
    const onPage = () => state.sessionId === sessionId && generation === requestGeneration && locateTokens.get(review.key) === opToken
    const finish = (patch) => {
      // Never write locate state onto a page/session that has since changed.
      if (onPage()) setLocate(review.key, patch)
    }
    const showFailure = (patch) => {
      // The panel was switched to the Conversation for the locate; bring it
      // back so the failure is visible. openPage preserves this locate state,
      // and the session-global notice keeps it visible even when the failing
      // review sits on a page other than the one the panel reopens on.
      if (!onPage()) return
      setLocate(review.key, patch)
      setLocateNotice({ reviewId: review.reviewId, error: patch.error })
      try { if (typeof host.revealInbox === 'function') host.revealInbox() } catch { /* best-effort */ }
    }
    setLocate(review.key, { phase: 'locating', error: undefined })
    setLocateNotice(null)
    try { if (typeof host.revealConversation === 'function') host.revealConversation() } catch { /* navigation is best-effort */ }
    let signal
    try { signal = typeof host.beginNavigation === 'function' ? host.beginNavigation() : undefined } catch { signal = undefined }
    const stopped = () => disposed || !onPage() || (signal !== undefined && signal.aborted === true)
    const cancel = () => {
      finish({ phase: 'failed', error: '导航已取消，未定位' })
      return { ok: false, code: 'stale', error: '导航已取消，未定位' }
    }
    let element = await waitForAnchor(sessionId, review.messageId, signal, ANCHOR_WAIT_FRAMES, stopped)
    if (stopped()) return cancel()
    if (element === undefined && review.anchorSeq !== undefined) {
      await loadThrough(sessionId, review.anchorSeq)
      if (stopped()) return cancel()
      element = await waitForAnchor(sessionId, review.messageId, signal, ANCHOR_WAIT_FRAMES_AFTER_LOAD, stopped)
      if (stopped()) return cancel()
    } else if (element === undefined) {
      // Legacy records carry no position: page backwards a bounded number of
      // times and keep re-checking the DOM. Never claim a hit without one.
      for (let page = 0; page < MAX_LOAD_OLDER_PAGES && element === undefined; page += 1) {
        if (stopped()) return cancel()
        const advanced = await loadOlderPage(sessionId)
        if (stopped()) return cancel()
        if (advanced === false) break
        element = await waitForAnchor(sessionId, review.messageId, signal, ANCHOR_WAIT_FRAMES, stopped)
      }
      if (stopped()) return cancel()
    }
    if (element === undefined || element === null) {
      const error = review.anchorSeq === undefined
        ? '未在对话中找到该消息的 Ciel 锚点（旧记录没有位置信息），尝试加载更早历史后仍未找到；请在对话中手动查找。'
        : '尝试加载该消息所在的历史后仍未找到 Ciel 锚点；请确认消息仍在当前会话中。'
      showFailure({ phase: 'failed', error })
      return { ok: false, code: 'not_found', error }
    }
    scrollAnchor(element)
    finish({ phase: 'located', error: undefined })
    return { ok: true }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    generation += 1
    writeTokens.clear()
    locateTokens.clear()
    if (sessionsUnsubscribe !== null) { sessionsUnsubscribe(); sessionsUnsubscribe = null }
    sessionsService = undefined
    listeners.clear()
    state = baseState(undefined)
  }

  return {
    getSnapshot,
    getPageToken: () => pageToken,
    subscribe,
    getSessions,
    bindSessions,
    openPage,
    syncSession,
    ensureLoaded,
    refresh,
    nextPage,
    prevPage,
    setFilter,
    setIntent,
    openResource,
    locate,
    dispose,
  }
}

// ── factory: components + native registration ────────────────────────────

/**
 * Build the inbox module. The returned API mirrors createCielSidebar:
 * install(ctx, options) registers the main panel and the sidebar entry, and
 * dispose (or the install disposer) tears both down.
 *
 * @param dependencies - { React, Tag?, Button? }; React is required.
 * @returns { install, dispose, getController, panelId, createController }.
 */
export function createCielInbox(dependencies) {
  const deps = dependencies === null || dependencies === undefined ? {} : dependencies
  const React = deps.React
  if (React === null || typeof React !== 'object' || typeof React.createElement !== 'function') {
    throw new TypeError('createCielInbox: React with createElement is required')
  }
  const h = React.createElement
  const Tag = deps.Tag
  const Button = deps.Button
  const nativeTag = typeof Tag === 'function' || (Tag !== null && typeof Tag === 'object')
  const nativeButton = typeof Button === 'function' || (Button !== null && typeof Button === 'object')

  /**
   * One action control: the shared platform Button primitive when supplied —
   * the same adapter the sidebar uses — otherwise a plain <button> for mocks
   * and tests. Every data-ciel-* test anchor, aria attribute, disabled state,
   * and conflict/saving prop passes through verbatim; only the native-only
   * variant/size/icon props are dropped in the fallback so React never sees
   * unknown attributes.
   */
  function button(props, children) {
    const actionProps = { size: 'md', 'data-ciel-action': '', ...props }
    // data-ciel-native-button marks ONLY the native primitive path; the mock
    // fallback never claims it, so the stylesheet can keep native sizing and
    // focus on the primitive and self-draw the fallback.
    if (nativeButton) return h(Button, { 'data-ciel-native-button': '', ...actionProps }, children)
    const rest = { ...actionProps }
    delete rest.variant
    delete rest.size
    delete rest.icon
    return h('button', { type: 'button', ...rest }, children)
  }

  /** One platform chip, or a plain span when Tag is absent. */
  function chip(textValue, tone, key) {
    return nativeTag ? h(Tag, { key, tone }, textValue) : h('span', { key, 'data-ciel-chip': tone }, textValue)
  }

  function statePanel(state, lines, extra) {
    return h('div', { className: 'ciel-inbox-state', 'data-ciel-inbox-state': state, ...(extra === undefined ? {} : extra) },
      ...lines.map((line, index) => h('p', { key: 'l' + index }, line)))
  }

  /** Stable subscribe/getSnapshot pair for one controller (useSyncExternalStore). */
  const controllerSubscriptions = new WeakMap()
  function controllerSubscription(controller) {
    let subscription = controllerSubscriptions.get(controller)
    if (subscription === undefined) {
      subscription = { subscribe: (listener) => controller.subscribe(listener), getSnapshot: () => controller.getSnapshot() }
      controllerSubscriptions.set(controller, subscription)
    }
    return subscription
  }

  /**
   * Subscribe one component to the controller; returns the live snapshot.
   * useSyncExternalStore keeps the subscription stable across renders, so an
   * emit re-renders once and the per-card element memo then skips every card
   * whose own inputs did not change.
   */
  function useInboxState(controller) {
    if (controller !== null && controller !== undefined && typeof React.useSyncExternalStore === 'function'
      && typeof controller.subscribe === 'function' && typeof controller.getSnapshot === 'function') {
      const subscription = controllerSubscription(controller)
      return React.useSyncExternalStore(subscription.subscribe, subscription.getSnapshot, subscription.getSnapshot)
    }
    const [, setTick] = React.useState(0)
    React.useEffect(() => {
      if (controller === undefined || controller === null) return undefined
      return controller.subscribe(() => setTick((value) => value + 1))
    }, [controller])
    return controller === undefined || controller === null ? undefined : controller.getSnapshot()
  }

  /** The left-sidebar entry: a static inbox glyph (no count or badge). */
  function InboxIcon(props) {
    const rawSize = props !== null && props !== undefined && Number.isFinite(props.size) ? props.size : 16
    const size = rawSize >= 12 && rawSize <= 24 ? rawSize : 16
    return h('span', { className: 'ciel-inbox-icon', 'data-ciel-inbox-icon': '', 'aria-hidden': 'true' },
      h('svg', { className: 'ciel-inbox-glyph', width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M2.2 3.4c0-.7.5-1.2 1.2-1.2h9.2c.7 0 1.2.5 1.2 1.2v9.2c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.2' }),
        h('path', { d: 'M2.2 9.1h3.1l.9 1.6h3.6l.9-1.6h3.1', fill: 'none', stroke: 'currentColor', strokeWidth: '1.2' })))
  }

  /**
   * One review card. A pure function of its own inputs (review / write /
   * locate / filter / controller), which is what lets memoReviewCard reuse an
   * untouched card's element while a card whose review or write state changed
   * is rebuilt. The annotation objects are used verbatim: the original
   * annotation.index keeps driving the save RPC and the evidence/locate
   * gestures, and a failure/cancel/incomplete group always keeps its status
   * copy even when the active filter has no matching annotation.
   */
  function ReviewCard(props) {
    const review = props.review
    const write = props.write
    const locate = props.locate
    const filter = props.filter
    const controller = props.controller
    const coverage = coverageLabel(review.coverage)
    const verdict = verdictLabel(review.verdict)
    // "全部" shows every annotation; an intent filter shows only the
    // annotations carrying that intent. Nothing is renumbered or rewritten.
    const shownAnnotations = filter === 'all'
      ? review.annotations
      : review.annotations.filter((annotation) => annotation.intent === filter)
    // A review writes as one group: every intent control on the card is
    // disabled while any annotation of that review is in flight.
    const saving = write !== undefined && write.pending === true
    const disabled = saving || review.invalid === true
    const renderAnnotation = (annotation) => {
      const intentButton = (intent) => button({
        key: intent,
        type: 'button',
        // Native selected state = variant + aria-pressed; the class is the
        // fallback's styling hook.
        variant: annotation.intent === intent ? 'primary' : 'outline',
        className: 'ciel-inbox-intent' + (annotation.intent === intent ? ' is-active' : ''),
        'data-ciel-intent': intent,
        'aria-pressed': annotation.intent === intent,
        disabled,
        onClick: () => { void controller.setIntent(review.key, annotation.index, intent) },
      }, INTENT_LABELS[intent] + (saving && write !== undefined && write.pendingIndex === annotation.index && write.pendingIntent === intent ? '…' : ''))
      return h('li', { key: 'a' + annotation.index, className: 'ciel-inbox-annotation', 'data-ciel-inbox-annotation': String(annotation.index), 'data-severity': annotation.severity },
        h('div', { className: 'ciel-inbox-annotation-head' },
          h('span', { className: 'ciel-inbox-meta' }, '#' + annotation.index),
          chip(annotation.severity === 'blocker' ? '阻塞' : '建议', annotation.severity === 'blocker' ? 'danger' : 'warning'),
          h('span', { className: 'ciel-inbox-annotation-title' }, annotation.title || '（无标题）')),
        annotation.anchor ? h('blockquote', { className: 'ciel-inbox-anchor', 'data-ciel-inbox-anchor': '' }, annotation.anchor) : null,
        annotation.comment ? h('p', { className: 'ciel-inbox-comment', 'data-ciel-inbox-comment': '' }, annotation.comment) : null,
        h('div', { className: 'ciel-inbox-annotation-foot' },
          ...annotation.evidenceIds.map((evidenceId) => button({
            key: evidenceId,
            type: 'button',
            className: 'ciel-inbox-evidence',
            'data-ciel-inbox-evidence': evidenceId,
            onClick: () => { void controller.openResource('evidence', review.key, evidenceId) },
          }, '回到会话查看证据 ' + evidenceId)),
          h('span', { className: 'ciel-inbox-intents' }, INBOX_INTENTS.map(intentButton))))
    }
    return h('li', { key: review.key, className: 'ciel-inbox-review', 'data-ciel-inbox-review': review.reviewId, 'data-ciel-inbox-review-status': review.status },
      h('div', { className: 'ciel-inbox-review-head' },
        h('span', { className: 'ciel-inbox-review-id', 'data-ciel-inbox-review-id': '' }, review.reviewId === '' ? '（无评审 ID）' : review.reviewId),
        chip(statusLabel(review.status), reviewClassification(review) === 'failed' ? 'danger' : reviewClassification(review) === 'complete' ? 'success' : 'neutral'),
        coverage === undefined ? null : chip(coverage, 'neutral'),
        verdict === undefined ? null : chip(verdict, verdict === 'changes' ? 'warning' : 'neutral'),
        h('span', { className: 'ciel-inbox-meta' }, 'v' + review.revision + (formatTime(review.createdAt) === '' ? '' : ' · ' + formatTime(review.createdAt))),
        h('span', { className: 'ciel-inbox-review-actions' },
          button({ type: 'button', 'data-ciel-inbox-view-review': review.reviewId, disabled: review.invalid === true, onClick: () => { void controller.openResource('review', review.key) } }, '回到会话查看评审'),
          button({
            type: 'button',
            'data-ciel-inbox-locate': review.reviewId,
            disabled: review.invalid === true || (locate !== undefined && locate.phase === 'locating'),
            onClick: () => { void controller.locate(review.key) },
          }, locate !== undefined && locate.phase === 'locating' ? '定位中…' : '定位'),
          locate !== undefined && locate.phase === 'located' ? h('span', { className: 'ciel-inbox-locate-note', 'data-ciel-inbox-locate-ok': '' }, '已定位') : null,
          locate !== undefined && locate.phase === 'failed' ? h('span', { className: 'ciel-inbox-locate-note', 'data-tone': 'danger', 'data-ciel-inbox-locate-error': '' }, locate.error || '定位失败') : null)),
      review.invalid === true ? h('p', { className: 'ciel-inbox-banner', 'data-tone': 'danger', 'data-ciel-inbox-invalid': '' }, '该评审标识无效，本组已停用查看与标记。') : null,
      review.summary === undefined ? null : h('p', { className: 'ciel-inbox-summary', 'data-ciel-inbox-summary': '' }, review.summary),
      review.error === undefined ? null : h('p', { className: 'ciel-inbox-review-error', 'data-ciel-inbox-review-error': '' }, '错误：' + review.error),
      review.annotations.length === 0
        // A group that really produced no annotation keeps its original
        // failure/cancel/incomplete copy in every view.
        ? h('p', { className: 'ciel-inbox-empty', 'data-ciel-inbox-no-annotations': '' }, emptyAnnotationsLabel(review))
        : shownAnnotations.length > 0
          // Approved on-demand disclosure for large cards: every annotation
          // node and its original index stay in the DOM, but >8 entries are
          // shown behind a native, uncontrolled <details> (the DOM owns the
          // open state, so a write re-render cannot force it closed). <=8 keeps
          // the exact previous expanded shape; status/summary/error text stays
          // OUTSIDE this element and is always visible.
          ? (shownAnnotations.length > 8
            ? h('details', {
                className: 'ciel-inbox-annotations-disclosure',
                'data-ciel-disclosure': String(shownAnnotations.length),
                'data-ciel-inbox-disclosure': String(shownAnnotations.length),
              },
                h('summary', { 'data-ciel-disclosure-summary': '', 'data-ciel-inbox-disclosure-summary': '' }, '批注明细 ' + shownAnnotations.length + ' 条'),
                h('ul', { className: 'ciel-inbox-annotations' }, ...shownAnnotations.map(renderAnnotation)))
            : h('ul', { className: 'ciel-inbox-annotations' }, ...shownAnnotations.map(renderAnnotation)))
          // The group DID produce annotations, just none of the selected
          // intent. It is still shown because its status is anomalous, and
          // the copy must not claim it never produced an annotation.
          : h('p', { className: 'ciel-inbox-empty', 'data-ciel-inbox-no-matching-annotations': '', 'data-ciel-inbox-review-no-matching-annotations': '' }, '本评审没有该意向批注（异常状态仍保留）。'),
      write !== undefined && (write.error !== undefined || write.conflict === true)
        ? h('p', { className: 'ciel-inbox-write-error', 'data-ciel-inbox-write-error': write.conflict === true ? 'conflict' : 'error' },
            write.conflict === true ? '状态冲突：' + write.error + '（请刷新本页后重试）' : '保存失败：' + write.error)
        : null)
  }

  /** The main panel. */
  function InboxPanel(props) {
    const controller = props !== null && props !== undefined ? props.controller : undefined
    const snapshot = useInboxState(controller)
    React.useEffect(() => {
      if (controller === undefined || controller === null) return undefined
      // Read on open (explicit first page), then refetch only when the current
      // session actually changes; a metadata-only emit must not rerun a page.
      void controller.openPage()
      const sessions = controller.getSessions()
      const list = sessions !== null && sessions !== undefined && sessions.list !== null && sessions.list !== undefined ? sessions.list : undefined
      if (list === undefined || typeof list.subscribe !== 'function') return undefined
      const onChange = () => {
        const value = typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        const current = currentSessionId(value)
        controller.syncSession(current)
        void controller.ensureLoaded()
      }
      return list.subscribe(onChange)
    }, [controller])

    if (controller === undefined || controller === null) {
      return statePanel('unavailable', ['收件箱模块不可用。'])
    }
    if (snapshot === undefined || snapshot === null) {
      return statePanel('unavailable', ['收件箱状态不可用。'])
    }
    if (snapshot.sessionId === undefined) {
      return h('section', { className: 'ciel-inbox', 'data-ciel-inbox': '', 'data-ciel-inbox-state': 'no-session' },
        statePanel('no-session', ['当前没有打开的会话。', '打开一个会话后，这里显示它的 Ciel 批注评审收件箱。']))
    }

    const sessionId = snapshot.sessionId
    // Derived values are cached per (reviews, filter): an emit that only
    // touched writes/locate/open leaves both the counts and the visible list
    // referentially stable, so the per-card element memo can do its job.
    const counts = cachedPageCounts(snapshot.reviews)
    const visible = cachedFilteredReviews(snapshot.reviews, snapshot.filter)
    const loadingFirstPage = snapshot.phase === 'loading' && snapshot.reviews.length === 0
    const failed = snapshot.phase === 'error'

    // Every tab number is page-local and says what it counts: the "all" tab
    // counts review groups, the three intent tabs count annotations. An
    // anomalous group with zero annotations therefore never inflates an
    // intent number; those groups are reported separately below.
    const filterCount = (filter) => (filter === 'all' ? counts.reviews + ' 项评审' : counts[filter] + ' 条批注')
    const filterButton = (filter) => button({
      key: filter,
      type: 'button',
      // The selected tab is carried by the native variant + aria-pressed, not
      // by the is-active color alone (the fallback drops variant and relies on
      // the class).
      variant: snapshot.filter === filter ? 'primary' : 'outline',
      className: 'ciel-inbox-filter' + (snapshot.filter === filter ? ' is-active' : ''),
      'data-ciel-inbox-filter': filter,
      'aria-pressed': snapshot.filter === filter,
      onClick: () => controller.setFilter(filter),
    }, FILTER_LABELS[filter] + ' ' + filterCount(filter))

    // The page identity is stable across writes and changes on a real page
    // change; the card memo is owned by this controller + token.
    const pageToken = controller !== null && controller !== undefined && typeof controller.getPageToken === 'function'
      ? controller.getPageToken()
      : undefined
    const renderReview = (review) => {
      const write = snapshot.writes[review.key]
      const locate = snapshot.locate[review.key]
      // Reuse the element for a card whose own inputs are referentially
      // unchanged: React then skips that subtree instead of redrawing all 25
      // cards when one write/locate value changes. The original annotation
      // index and every data-ciel anchor live inside ReviewCard unchanged.
      return memoReviewCard(controller, pageToken, review, { review, write, locate, filter: snapshot.filter }, () =>
        h(ReviewCard, { key: review.key, review, write, locate, filter: snapshot.filter, controller }))
    }

    return h('section', { className: 'ciel-inbox', 'data-ciel-inbox': '', 'data-ciel-inbox-state': snapshot.phase },
      h('header', { className: 'ciel-inbox-head' },
        h('div', { className: 'ciel-inbox-title' },
          h('h1', { 'data-ciel-inbox-title': '' }, INBOX_LABEL),
          h('span', { className: 'ciel-inbox-session', 'data-ciel-inbox-session': '' }, '会话 ' + shortId(sessionId, 12))),
        h('div', { className: 'ciel-inbox-tools' },
          button({ type: 'button', className: 'ciel-inbox-refresh', 'data-ciel-inbox-refresh': '', onClick: () => { void controller.refresh() } }, '刷新（回到首页）'),
          button({ type: 'button', className: 'ciel-inbox-page', 'data-ciel-inbox-prev': '', disabled: snapshot.cursorStack.length === 0, onClick: () => { void controller.prevPage() } }, '上一页'),
          h('span', { className: 'ciel-inbox-meta', 'data-ciel-inbox-page': '' }, '第 ' + snapshot.pageIndex + ' 页'),
          button({ type: 'button', className: 'ciel-inbox-page', 'data-ciel-inbox-next': '', disabled: snapshot.nextCursor === null, onClick: () => { void controller.nextPage() } }, '下一页'))),
      h('div', { className: 'ciel-inbox-filters', 'data-ciel-inbox-filters': '' },
        INBOX_FILTERS.map(filterButton),
        h('span', { className: 'ciel-inbox-pageinfo', 'data-ciel-inbox-pageinfo': '' }, '本页 ' + counts.reviews + ' 条 · 批注 ' + counts.annotations + ' 条' + (snapshot.limited ? ' · 本页受限' : ''))),
      h('p', { className: 'ciel-inbox-filter-note', 'data-ciel-inbox-filter-note': '' },
        '意向数字按本页批注统计（不是评审条数）；异常评审（失败 / 已取消 / 未完成）即使没有被选意向的批注，也仍会保留显示。'),
      h('p', { className: 'ciel-inbox-status-summary', 'data-ciel-inbox-status-summary': '' },
        '本页状态汇总：失败 ' + counts.failed + ' 项 · 已取消 ' + counts.cancelled + ' 项 · 未完成 ' + counts.incomplete + ' 项'),
      h('p', { className: 'ciel-inbox-banner', 'data-tone': 'neutral', 'data-ciel-inbox-disclaimer': '' }, '处理意向只记录你的处理计划，不代表问题已被证实或已修复；浏览与标记不调用模型、不修改输入草稿，也不改变已有的批注回传勾选。查看评审/证据会先回到会话视图（宿主右栏只在会话中挂载）。'),
      snapshot.open.status === 'opening' ? h('p', { className: 'ciel-inbox-banner', 'data-tone': 'neutral', 'data-ciel-inbox-open-progress': '' }, '正在回到会话并打开右栏…') : null,
      snapshot.open.status === 'failed' ? h('p', { className: 'ciel-inbox-banner', 'data-tone': 'danger', 'data-ciel-inbox-open-error': '' }, '无法打开右栏：' + (snapshot.open.error || '未知错误') + '（请重试）') : null,
      snapshot.locateNotice !== undefined && snapshot.locateNotice !== null
        && !visible.some((review) => review.reviewId === snapshot.locateNotice.reviewId)
        ? h('p', { className: 'ciel-inbox-banner', 'data-tone': 'danger', 'data-ciel-inbox-locate-notice': snapshot.locateNotice.reviewId }, '定位失败：评审 ' + snapshot.locateNotice.reviewId + '：' + snapshot.locateNotice.error)
        : null,
      failed ? h('p', { className: 'ciel-inbox-banner', 'data-tone': 'danger', 'data-ciel-inbox-error': '' }, '本页读取失败：' + (snapshot.error || '未知错误') + (snapshot.errorCode === undefined ? '' : '（' + snapshot.errorCode + '）')) : null,
      loadingFirstPage ? statePanel('loading', ['正在读取本页收件箱…']) : null,
      !loadingFirstPage && !failed && visible.length === 0
        ? (snapshot.reviews.length === 0
            ? statePanel('empty', ['本页没有评审记录。'])
            : statePanel('filtered', [
                '本页没有「' + FILTER_LABELS[snapshot.filter] + '」意向的批注；这不代表本页评审都正常，异常评审仍会保留显示。',
              ], { 'data-ciel-inbox-no-matching-annotations': '' }))
        : null,
      !loadingFirstPage && visible.length > 0 ? h('ul', { className: 'ciel-inbox-list', 'data-ciel-inbox-list': '' }, ...visible.map(renderReview)) : null)
  }

  let installed = null
  let disposed = false

  /**
   * Register the main panel and the sidebar entry.
   * @param ctx - a client context with slots.inject / slots.register.
   * @param options - call, getSessions, sessions, openReview, openEvidence,
   *   revealConversation, revealInbox, beginNavigation, findAnchor, scrollToAnchor,
   *   nextFrame, loadThrough, loadOlder, now, pageSize (all optional except call).
   * @returns an idempotent uninstall function.
   */
  function install(ctx, options) {
    if (disposed) throw new Error('createCielInbox: this instance is disposed')
    if (installed !== null) {
      if (installed.ctx === ctx) return installed.uninstall
      throw new Error('createCielInbox: already installed on another context')
    }
    if (ctx === null || typeof ctx !== 'object' || ctx.slots === null || typeof ctx.slots !== 'object'
      || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
      throw new TypeError('createCielInbox: install requires ctx.slots.inject/register')
    }
    const opts = options === null || options === undefined ? {} : options
    if (typeof opts.call !== 'function') throw new TypeError('createCielInbox: install requires call(method, request)')

    const controller = createInboxController({
      call: opts.call,
      getSessions: opts.getSessions,
      pageSize: opts.pageSize,
      now: opts.now,
      host: {
        openReview: opts.openReview,
        openEvidence: opts.openEvidence,
        revealConversation: opts.revealConversation,
        revealInbox: opts.revealInbox,
        beginNavigation: opts.beginNavigation,
        findAnchor: opts.findAnchor,
        scrollToAnchor: opts.scrollToAnchor,
        nextFrame: opts.nextFrame,
        loadThrough: opts.loadThrough,
        loadOlder: opts.loadOlder,
      },
    })
    // Bind the root sessions subscription now when the service is already
    // available; apply() rebinds via ctx.inject(['sessions']) once it settles.
    if (opts.sessions !== undefined && opts.sessions !== null) controller.bindSessions(opts.sessions)
    else if (typeof opts.getSessions === 'function') controller.bindSessions(opts.getSessions())
    const face = { controller }
    const cleanups = []
    const record = { ctx, cleanups, controller, uninstall: undefined }
    const uninstall = () => {
      if (installed !== record) return
      installed = null
      controller.dispose()
      const pending = cleanups.splice(0)
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        try { pending[index]() } catch { /* every disposer is idempotent on its own */ }
      }
    }
    record.uninstall = uninstall
    installed = record
    const own = (key, setup) => {
      const handle = ctx.slots.inject(key, setup)
      cleanups.push(typeof handle === 'function' ? handle : () => {})
    }
    try {
      own('main', () => ctx.slots.register({ name: 'main', key: INBOX_PANEL_ID, inject: () => face }, InboxPanel))
      own('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: INBOX_PANEL_ID, order: INBOX_PANEL_ORDER, label: INBOX_LABEL, inject: () => face }, InboxIcon))
    } catch (error) {
      uninstall()
      throw error
    }
    return uninstall
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (installed !== null) installed.uninstall()
  }

  return {
    install,
    dispose,
    getController: () => (installed === null ? undefined : installed.controller),
    /** Late binding for the root sessions subscription (the service may arrive after install). */
    bindSessions: (service) => {
      const controller = installed === null ? undefined : installed.controller
      if (controller !== undefined) controller.bindSessions(service)
    },
    panelId: INBOX_PANEL_ID,
    createController: createInboxController,
  }
}
