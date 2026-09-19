import { reviewMessageKey } from '../review-identity.js'

export function createReviewProgress({ reviewCall, store, emit, hydrate, pin = () => () => {}, document, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  // ── shared progress poller (ReviewButton) ────────────────────────────
  // One interval serves every mounted ReviewButton, keyed by session+message:
  // the per-message empty tick is gone. A subscription probes immediately, is
  // single-flighted per key, and polls only while busy or in-flight. As soon
  // as no work item wants a probe (confirmed idle, no local busy), the shared
  // timer is DESTROYED — a confirmed-idle button keeps its subscription (so a
  // visibilitychange or remount can probe once) but burns no timer and issues
  // no RPC. A well-formed inFlight:false transition still force-rehydrates
  // the finished entry; a failed or malformed response is never treated as
  // completion. Hidden pages clear the timer and perform no probes, then
  // re-synchronize with one probe on becoming visible. The scheduler is
  // deliberately local and bounded: no push channel exists, and the existing
  // generation/hydrate contract must stay authoritative.
  const progressInflight = new Map()
  const pollSubscribers = new Set()
  let pollTimer = null
  let visibilityWatched = false
  // Set by the runtime teardown: after disposal no late promise callback
  // may resume a probe or re-arm the timer.
  let pollerDisposed = false
  const pageHidden = () => typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden'
  const wantsProbe = (sub) => !sub.paused && (sub.keepAlive === true || sub.idleRef.current !== true)
  const pollerWants = () => {
    for (const sub of pollSubscribers) if (wantsProbe(sub)) return true
    return false
  }
  const releasePollTimer = () => {
    if (pollTimer === null) return
    clearInterval(pollTimer)
    pollTimer = null
  }
  const ensurePollTimer = () => {
    // Only while some work item actually wants a probe, never while the
    // page is hidden, and never after disposal.
    if (pollTimer === null && !pollerDisposed && !pageHidden() && pollerWants()) pollTimer = setInterval(pollTick, 1000)
  }
  const probeAll = () => {
    if (pollerDisposed) return
    for (const sub of [...pollSubscribers]) if (!sub.paused) void pollProbe(sub)
  }
  const onVisibilityChange = () => {
    if (pollerDisposed) return
    if (pageHidden()) { releasePollTimer(); return }
    // Hidden pages did no work; re-synchronize every mounted button with a
    // single probe on return — including a confirmed-idle one, whose review
    // may have finished while the page was hidden.
    probeAll()
    if (pollerWants()) ensurePollTimer()
  }
  const watchVisibility = () => {
    if (visibilityWatched || typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return
    visibilityWatched = true
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  const unwatchVisibility = () => {
    if (!visibilityWatched) return
    visibilityWatched = false
    if (typeof document !== 'undefined' && document !== null && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  function pollTick() {
    if (pollerDisposed) { releasePollTimer(); return }
    if (pageHidden()) { releasePollTimer(); return }
    if (!pollerWants()) { releasePollTimer(); return }
    for (const sub of [...pollSubscribers]) {
      if (wantsProbe(sub)) {
        if (sub.retryTicks > 0) sub.retryTicks -= 1
        if (!sub.retryTicks) void pollProbe(sub)
      }
    }
  }
  function pollProbe(sub) {
    if (pollerDisposed || sub.active !== true || sub.paused || pageHidden()) return Promise.resolve()
    const key = reviewMessageKey(sub.sessionId, sub.messageId)
    const existing = progressInflight.get(key)
    if (existing !== undefined) {
      const ownerActive = [...existing.subscribers].some((owner) => owner.active)
      if (ownerActive) {
        // Same live generation: join the in-flight probe, but attach the
        // delivery for this subscription at most once so overlapping ticks
        // never queue duplicate deliveries for one promise.
        if (!existing.attached.has(sub)) {
          existing.attached.add(sub)
          existing.subscribers.add(sub)
          existing.promise.then((res) => { if (sub.active && !pollerDisposed) deliverProgress(sub, res) }).catch(() => {})
        }
        return existing.promise
      }
      // The in-flight probe belongs to a previous generation (its owner
      // unsubscribed). A new subscription must NOT adopt that response.
      // Wait for it to settle at most ONCE per subscription, then probe
      // fresh only if this subscription is still live, the poller is not
      // disposed, and the page is visible (a hidden settle must not start
      // an RPC). The waiting set stops a long request from accumulating one
      // callback per tick.
      if (!existing.waiting.has(sub)) {
        existing.waiting.add(sub)
        const stopWaiting = () => existing.waiting.delete(sub)
        existing.promise.then(() => {
          stopWaiting()
          if (sub.active && !pollerDisposed && !pageHidden()) void pollProbe(sub)
        }, stopWaiting).catch(() => {})
      }
      return existing.promise
    }
    const entry = { promise: null, subscribers: new Set([sub]), attached: new Set([sub]), waiting: new Set() }
    const pending = Promise.resolve()
      .then(() => reviewCall('progress', { sessionId: sub.sessionId, messageId: sub.messageId }))
      .catch(() => undefined)
      .finally(() => { if (progressInflight.get(key) === entry) progressInflight.delete(key) })
    entry.promise = pending
    progressInflight.set(key, entry)
    return pending.then((res) => { if (sub.active && !pollerDisposed) deliverProgress(sub, res) }).catch(() => {})
  }
  function deliverProgress(sub, res) {
    if (pollerDisposed) return
    // A failed probe never claims the review finished. Retry at 1/2/4
    // ticks, then pause; permanent capability errors pause immediately.
    const key = reviewMessageKey(sub.sessionId, sub.messageId)
    if (!res || res.ok === false || typeof res.inFlight !== 'boolean') {
      sub.failures = (sub.failures || 0) + 1
      sub.paused = res?.retryable === false || sub.failures >= 4
      sub.retryTicks = 2 ** (sub.failures - 1)
      store.progressErrors.set(key, String(res?.error || '进度返回格式无效') + (sub.paused ? '（同步已暂停）' : '（正在有限重试）'))
      emit()
      if (!pollerWants()) releasePollTimer()
      return
    }
    sub.failures = 0
    sub.retryTicks = 0
    if (store.progressErrors.delete(key)) emit()
    const inflight = res.inFlight === true
    if (sub.progRef.current && !inflight) {
      // The review ended elsewhere (or in a previous page lifetime): its
      // entry is persisted, so force a rehydrate for the terminal state.
      store.hydrated.delete(sub.sessionId)
      hydrate(sub.sessionId, { force: true })
    }
    sub.idleRef.current = !inflight
    sub.progRef.current = inflight ? res : null
    sub.setProg(inflight ? res : null)
    // Every work item is now known idle: destroy the shared timer. The
    // subscriptions stay for a later one-shot probe.
    if (!pollerWants()) releasePollTimer()
  }
  function subscribeProgress(sub) {
    if (pollerDisposed) return () => {}
    pollSubscribers.add(sub)
    const release = pin(sub.sessionId)
    sub.release = release
    sub.active = true
    sub.failures = 0
    sub.retryTicks = 0
    sub.paused = false
    sub.idleRef.current = false
    watchVisibility()
    // Hidden pages do no probe work on mount; the visibilitychange handler
    // probes immediately when the page becomes visible again.
    if (!pageHidden()) void pollProbe(sub)
    ensurePollTimer()
    return () => {
      if (!sub.active) return
      sub.active = false
      release()
      pollSubscribers.delete(sub)
      if (pollSubscribers.size === 0) { releasePollTimer(); unwatchVisibility(); return }
      if (!pollerWants()) releasePollTimer()
    }
  }
  function retryProgress(key) {
    if (pollerDisposed) return
    for (const sub of pollSubscribers) {
      if (key !== undefined && reviewMessageKey(sub.sessionId, sub.messageId) !== key) continue
      sub.failures = 0
      sub.retryTicks = 0
      sub.paused = false
      sub.idleRef.current = false
      if (!pageHidden()) void pollProbe(sub)
    }
    ensurePollTimer()
  }
  function dispose() {
    // Explicit disposal: deactivate every live subscription first, so a
    // promise that settles afterwards can neither deliver nor re-probe nor
    // re-arm the timer.
    pollerDisposed = true
    for (const sub of pollSubscribers) { sub.active = false; sub.release() }
    releasePollTimer()
    unwatchVisibility()
    pollSubscribers.clear()
    progressInflight.clear()
  }

  return { subscribeProgress, retryProgress, dispose }
}
