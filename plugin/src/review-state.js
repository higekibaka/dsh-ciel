import { reviewMessageKey } from '../review-identity.js'

function isListResultLoaded(res) {
  return !!res && res.ok !== false && Array.isArray(res.reviews)
}

// The ordering key used to fence which entry "wins" for a message. Host
// entries carry `createdAt`; client-transient entries (start failures) are
// stamped with Date.now() too, so they compete by time. Missing/non-finite
// timestamps sort as the OLDEST (-Infinity) so a real entry always beats
// untimestamped legacy data.
function entryTime(entry) {
  if (entry && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)) {
    return entry.createdAt
  }
  return -Infinity
}

// Durability tier: a durable HOST result (has a reviewId) outranks a
// client-side transient (transport error, `transient:true`) regardless of
// wall clock. An unmarked legacy entry (no reviewId, no transient flag)
// sits in between.
function entryRank(entry) {
  if (entry && entry.transient === true) return 0
  if (entry && typeof entry.reviewId === 'string' && entry.reviewId !== '') return 2
  return 1
}

// Whether `incoming` should replace `existing` for the same message.
// Durability wins first (a committed host result always beats a transient
// error, even one stamped later by the client wall clock); within the same
// tier newer timestamp wins. This prevents a lost-RPC transient at t=200
// from sticking past a durable host result committed at t=100. It also
// prevents a transient from ever overwriting an existing durable review.
function shouldReplace(existing, incoming) {
  if (existing === undefined) return true
  const er = entryRank(existing)
  const ir = entryRank(incoming)
  if (ir !== er) return ir > er
  return entryTime(incoming) >= entryTime(existing)
}

/** Follow bounded host pages; never label an unfinished traversal hydrated. */
async function loadReviewPages(call, sessionId, isActive = () => true) {
  const result = { reviews: [], sentKeys: [], triage: {} }, seen = new Set()
  let cursor, bytes = 0
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    if (!isActive()) throw new Error('Ciel client stopped')
    const page = await call('list', { sessionId, ...(cursor ? { cursor } : {}) })
    if (!isListResultLoaded(page)) return page
    bytes += JSON.stringify(page).length * 2
    if (bytes > 32 * 1024 * 1024) throw new Error('评审列表超过本页内存上限，未完整加载；请从夏尔收件箱分页查看；记录未删除')
    result.reviews.push(...page.reviews)
    if (Array.isArray(page.sentKeys)) result.sentKeys.push(...page.sentKeys)
    Object.assign(result.triage, page.triage || {})
    if (page.nextCursor == null) {
      if (page.limited) throw new Error('评审列表受限但缺少后续游标')
      return result
    }
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || seen.has(page.nextCursor)) throw new Error('评审分页没有进展')
    seen.add(page.nextCursor); cursor = page.nextCursor
  }
  throw new Error('评审分页超过上限，未完整加载')
}


// Page-owned review state. The bound covers INACTIVE result payloads; mounted
// sessions and work still in flight remain pinned and may exceed it.
export function createReviewState({ call: reviewCall, emit = () => {}, active = () => true, onEvict = () => {}, maxIdleSessions = 8, maxIdleBytes = 16 * 1024 * 1024 } = {}) {
  const store = {
    byMessage: new Map(),
    loadErrors: new Map(),
    progressErrors: new Map(),
    collapsed: new Set(), // Review identity, retained across panel repaint; page-local only.
    hydrated: new Set(),
    retrySessions: new Set(), // 加载失败的 session——重连后重试
    popover: null,
    // 回传状态，全部按 reviewId 归键——面板是 imperative DOM，React 重建
    // 后由 buildPanel 从这里重读，勾选/已回传/注记随重绘保留。
    feedback: {
      sel: new Map(),      // reviewId -> Set<annotation index>
      sent: new Map(),     // reviewId -> Set<index>（hydrate 自 sentKeys，发送后更新）
      note: new Map(),     // reviewId -> 面板头注记文本
      sending: new Set(),  // 有在途回传的 reviewId
      tick: new Map(),     // [sessionId,messageId] -> 重绘计数器（回传 settle 后 bump）
      filter: new Map(),   // reviewId -> 'all' | 'blocker'（分诊过滤）
      meta: new Map(),     // reviewId -> { triageStates, filter }（WAL 规范化元数据）
      touched: new Set(),  // 本次页面生命周期内被本地编辑过的 reviewId（防旧水合覆盖）
      triageChain: new Map(), // reviewId -> Promise，串行化分诊写入，避免竞态
    },
  }

  const sessions = new Map()
  let disposed = false
  const isActive = () => !disposed && active()
  function touch(sessionId) {
    let owned = sessions.get(sessionId)
    if (!owned) owned = { pins: 0, bytes: 0, messages: new Map(), reviews: new Set() }
    sessions.delete(sessionId); sessions.set(sessionId, owned)
    return owned
  }
  function evict(sessionId, owned) {
    for (const key of owned.messages.keys()) {
      store.byMessage.delete(key); store.progressErrors.delete(key); store.feedback.tick.delete(key)
    }
    for (const rid of owned.reviews) {
      for (const field of ['sel', 'sent', 'note', 'sending', 'filter', 'meta', 'touched', 'triageChain']) store.feedback[field].delete(rid)
      // Collapse keys contain the full session/message/review identity.
      for (const key of store.collapsed) if (key === rid || key.startsWith(JSON.stringify([sessionId]).slice(0, -1) + ',')) store.collapsed.delete(key)
    }
    for (const key of store.progressErrors.keys()) if (key.startsWith(JSON.stringify([sessionId]).slice(0, -1) + ',')) store.progressErrors.delete(key)
    store.loadErrors.delete(sessionId); store.hydrated.delete(sessionId); store.retrySessions.delete(sessionId)
    if (store.popover?.sessionId === sessionId) { store.popover = null; if (!disposed) emit() }
    sessions.delete(sessionId)
    onEvict(sessionId)
  }
  function prune() {
    const idle = [...sessions].filter(([, owned]) => owned.pins === 0)
    let bytes = idle.reduce((sum, [, owned]) => sum + owned.bytes, 0), count = idle.length
    for (const [id, owned] of idle) {
      if (count <= maxIdleSessions && bytes <= maxIdleBytes) break
      evict(id, owned); count--; bytes -= owned.bytes
    }
  }
  function pin(sessionId) {
    if (!isActive() || typeof sessionId !== 'string') return () => {}
    const owned = touch(sessionId); owned.pins++
    let released = false
    return () => {
      if (released) return
      released = true; owned.pins--
      // React cleans up and re-subscribes in the same task. Do not evict in
      // between those steps or before a request's result handler has run.
      Promise.resolve().then(() => { if (isActive()) prune() })
    }
  }
  function dispose() {
    disposed = true
    for (const [id, owned] of sessions) evict(id, owned)
    store.popover = null
    for (const value of Object.values(store)) if (typeof value?.clear === 'function') value.clear()
    for (const value of Object.values(store.feedback)) value.clear()
  }
  function absorb(entry, sessionId = entry?.sessionId) {
    if (!isActive() || !entry || typeof sessionId !== 'string' || typeof entry.messageId !== 'string') return
    if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return
    const owned = touch(sessionId)
    entry = { ...entry, sessionId }
    const key = reviewMessageKey(sessionId, entry.messageId)
    // Fence by createdAt/review generation: never let an older list entry or
    // an untimestamped legacy record clobber a newer start result.
    if (shouldReplace(store.byMessage.get(key), entry)) {
      const bytes = JSON.stringify(entry).length * 2
      owned.bytes += bytes - (owned.messages.get(key) || 0)
      owned.messages.set(key, bytes)
      if (typeof entry.reviewId === 'string') owned.reviews.add(entry.reviewId)
      store.byMessage.set(key, entry)
      prune()
    }
  }
  // Hydration is deduplicated (a concurrent non-force call joins the
  // in-flight one) and retryable: an error-shaped list result does NOT mark
  // the session loaded, so a mount/reconnect re-runs it. `force` bypasses
  // the loaded set for inFlight->false refreshes, and — importantly — when a
  // load is already running a forced call does NOT settle from that stale
  // query: it chains a FRESH load after it so the terminal result is seen.
  const hydratePromises = new Map()
  const forcedHydrates = new Map()
  async function hydrate(sessionId, { force = false } = {}) {
    if (!isActive() || typeof sessionId !== 'string') return
    touch(sessionId)
    if (!force && store.hydrated.has(sessionId)) return
    const prev = hydratePromises.get(sessionId)
    if (prev && !force) return prev
    if (prev) {
      if (forcedHydrates.has(sessionId)) return forcedHydrates.get(sessionId)
      const fresh = prev.then(() => { forcedHydrates.delete(sessionId); return hydrate(sessionId, { force: true }) })
      forcedHydrates.set(sessionId, fresh)
      return fresh
    }
    const release = pin(sessionId)
    const p = (async () => {
      let res
      try {
        res = await loadReviewPages(reviewCall, sessionId, () => isActive())
      } catch (error) {
        if (!isActive()) return
        store.hydrated.delete(sessionId)
        store.retrySessions.add(sessionId)
        store.loadErrors.set(sessionId, String(error?.message || error)); emit()
        console.error('review.list threw', error && error.message)
        return
      }
      if (!isActive()) return
      // Malformed / error-shaped return is NOT success — leave the session
      // un-loaded so the next mount/reconnect retries.
      if (!isListResultLoaded(res)) {
        store.hydrated.delete(sessionId)
        store.retrySessions.add(sessionId)
        store.loadErrors.set(sessionId, String(res?.error || '评审记录加载失败')); emit()
        console.error('review.list error-shaped', res && res.error)
        return
      }
      for (const r of res.reviews) absorb(r, sessionId)
      // 已回传去重键（reviewId#index）→ 置灰对应条目，刷新后不依赖服务端重放拒绝。
      const sentKeys = res.sentKeys && Array.isArray(res.sentKeys) ? res.sentKeys : []
      for (const key of sentKeys) {
        if (typeof key !== 'string') continue
        const at = key.lastIndexOf('#')
        if (at <= 0) continue
        const rid = key.slice(0, at)
        touch(sessionId).reviews.add(rid)
        const idx = Number(key.slice(at + 1))
        if (!Number.isInteger(idx)) continue
        if (!store.feedback.sent.has(rid)) store.feedback.sent.set(rid, new Set())
        store.feedback.sent.get(rid).add(idx)
      }
      // 0.12.0 ④分诊水合：WAL 里的采纳/忽略与过滤器恢复进 store（规范化
      // 为 meta，供 buildPanel 首建选择时应用）；仅对未被本地编辑过的
      // review 应用，防止旧水合覆盖新分诊。
      const triage = res.triage && typeof res.triage === 'object' ? res.triage : {}
      for (const [rid, t] of Object.entries(triage)) {
        touch(sessionId).reviews.add(rid)
        if (!t || typeof t !== 'object') continue
        if (store.feedback.touched.has(rid)) continue
        const states = t.states && typeof t.states === 'object' ? t.states : {}
        store.feedback.meta.set(rid, {
          triageStates: states,
          filter: t.filter === 'all' || t.filter === 'blocker' ? t.filter : undefined,
        })
        if (t.filter === 'all' || t.filter === 'blocker') store.feedback.filter.set(rid, t.filter)
      }
      if (!isActive()) return
      store.loadErrors.delete(sessionId)
      store.hydrated.add(sessionId)
      store.retrySessions.delete(sessionId)
      emit()
    })().finally(() => { if (hydratePromises.get(sessionId) === p) hydratePromises.delete(sessionId); release() })
    hydratePromises.set(sessionId, p)
    return p
  }

  return { store, absorb, hydrate, pin, prune, dispose, stats: () => ({ sessions: sessions.size, pinned: [...sessions.values()].filter(v => v.pins > 0).length, payloadBytes: [...sessions.values()].reduce((sum, v) => sum + v.bytes, 0) }) }
}

export { isListResultLoaded, shouldReplace, entryRank, entryTime, loadReviewPages }
