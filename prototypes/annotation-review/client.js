// Annotation-review prototype — client half (pkg-12: proximity matching +
// owned-span cleanup). Fixture analysis of the real chat DOM settled the
// container question for good: flow items (assistant-step, turn-tail) are
// SIBLINGS — there is no per-turn wrapper, so pkg-11's one-button bound found
// nothing and pkg-9/10's unbounded walk treated the whole column as one turn
// (cross-turn wiping, wrong-message badges). pkg-12 stops looking for a turn
// container altogether: (a) anchors are matched by PROXIMITY — the last
// occurrence before the message's own button in document order is always the
// reviewed text, duplicates in older turns can no longer win; (b) cleanup
// tracks exactly the spans this effect created ("owned spans") instead of
// querySelectorAll across a shared container, so one message's cleanup can
// never touch another's marks; (c) the card panel still inserts right before
// the message's own tail flow item, found by walking up from the button.
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert([
      '.dsr-btn{font-size:11px;padding:1px 8px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;opacity:.65;cursor:pointer}',
      '.dsr-btn:hover{opacity:1}',
      '.dsr-btn:disabled{cursor:wait;opacity:.45}',
      '.dsr-tail{margin:8px 0 2px;border:1px solid rgba(130,130,130,.28);border-radius:8px;overflow:hidden;font-size:13px;line-height:1.55}',
      '.dsr-tail-head{padding:6px 10px;font-size:12px;opacity:.75;border-bottom:1px solid rgba(130,130,130,.2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsr-item{padding:8px 10px;border-top:1px solid rgba(130,130,130,.14)}',
      '.dsr-item:first-of-type{border-top:none}',
      '.dsr-sev{display:inline-block;font-size:10.5px;font-family:ui-monospace,monospace;padding:0 6px;border-radius:3px;margin-right:6px;vertical-align:1px}',
      '.dsr-sev-blocker{color:#f85149;border:1px solid #f85149}',
      '.dsr-sev-nit{color:#d29922;border:1px solid #d29922}',
      '.dsr-title{font-weight:600}',
      '.dsr-unanchored{font-size:10.5px;opacity:.6;margin-left:6px}',
      '.dsr-anchor{margin:5px 0 3px;padding:3px 8px;border-left:2px solid rgba(130,130,130,.5);font-family:ui-monospace,monospace;font-size:11.5px;opacity:.7;white-space:pre-wrap;word-break:break-word}',
      '.dsr-comment{opacity:.92;white-space:pre-wrap;word-break:break-word}',
      '.dsr-raw{padding:8px 10px;white-space:pre-wrap;word-break:break-word;opacity:.85;font-size:12.5px}',
      '.dsr-error{padding:8px 10px;color:#f85149;font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
      // inline marks
      '.dsr-mark{cursor:pointer;border-radius:2px}',
      '.dsr-mark-blocker{text-decoration:underline wavy #f85149 1.5px;text-underline-offset:3px;background:rgba(248,81,73,.07)}',
      '.dsr-mark-nit{text-decoration:underline wavy #d29922 1.5px;text-underline-offset:3px;background:rgba(210,153,34,.07)}',
      '.dsr-badge{display:inline-block;font-size:9.5px;font-family:ui-monospace,monospace;line-height:1.4;padding:0 3px;border-radius:3px;margin-left:2px;vertical-align:super;cursor:pointer;user-select:none}',
      '.dsr-badge-blocker{color:#f85149;border:1px solid #f85149}',
      '.dsr-badge-nit{color:#d29922;border:1px solid #d29922}',
      // popover
      '.dsr-pop{position:fixed;z-index:99999;max-width:420px;border:1px solid rgba(130,130,130,.45);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.55;box-shadow:0 10px 32px rgba(0,0,0,.4);background:#1b2129;color:#e6e9ee}',
      '.dsr-pop-head{margin-bottom:5px}',
      '.dsr-pop-anchor{margin:6px 0 4px;padding:3px 8px;border-left:2px solid rgba(130,130,130,.5);font-family:ui-monospace,monospace;font-size:11.5px;opacity:.7;white-space:pre-wrap;word-break:break-word}',
      '.dsr-pop-comment{white-space:pre-wrap;word-break:break-word}',
    ].join('\n'))

    const listeners = new Set()
    const store = { byMessage: new Map(), hydrated: new Set(), popover: null }
    const emit = () => { for (const l of Array.from(listeners)) l() }
    function useStoreTick() {
      const [, set] = React.useState(0)
      React.useEffect(() => {
        const tick = () => set((v) => v + 1)
        listeners.add(tick)
        return () => { listeners.delete(tick) }
      }, [])
    }
    function absorb(entry) {
      if (!entry || typeof entry.messageId !== 'string') return
      store.byMessage.set(entry.messageId, entry)
    }
    async function hydrate(sessionId) {
      if (typeof sessionId !== 'string' || store.hydrated.has(sessionId)) return
      store.hydrated.add(sessionId)
      try {
        const res = await host.call('review.list', { sessionId })
        const reviews = res && Array.isArray(res.reviews) ? res.reviews : []
        for (const r of reviews) absorb(r)
        emit()
      } catch (error) {
        store.hydrated.delete(sessionId)
        console.error('review.list failed', error && error.message)
      }
    }

    // ── anchor normalization: anchors quote MARKDOWN SOURCE (with **, `, []()
    // etc.) while the DOM holds RENDERED text — strip markdown syntax from the
    // anchor, collapse whitespace on both sides, then substring-match.
    function normalizeAnchor(anchor) {
      return String(anchor)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*`_~#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    // ── text-node collection excluding our own chrome: the card panel quotes
    // the anchors and would self-match (reject .dsr-tail explicitly); the
    // popover lives outside the turn anyway.
    function inOurChrome(n) {
      const el = n.parentElement
      return el !== null && typeof el.closest === 'function' && el.closest('.dsr-tail') !== null
    }
    function collectTextNodes(container, excludeEl) {
      const doc = container.ownerDocument
      const walker = doc.createTreeWalker(container, 4, {
        acceptNode: (n) => (excludeEl.contains(n) || inOurChrome(n) ? 2 : n.nodeValue.trim() === '' ? 3 : 1),
      })
      const nodes = []
      let cur = walker.nextNode()
      while (cur) { nodes.push(cur); cur = walker.nextNode() }
      return nodes
    }
    function textOf(container, excludeEl) {
      return collectTextNodes(container, excludeEl).map((n) => n.nodeValue).join(' ')
    }

    // ── smallest ancestor of the button whose text holds at least one probe:
    // the text universe for matching. In the real chat DOM this settles on the
    // shared flow column (flow items have no per-turn wrapper) — which is now
    // SAFE, because matching is proximity-disambiguated and cleanup is by
    // owned spans, so a big universe cannot leak across turns.
    function findChatRoot(anchorEl, annotations) {
      const probes = (annotations || [])
        .filter((a) => a && typeof a.anchor === 'string')
        .map((a) => normalizeAnchor(a.anchor))
        .filter((s) => s.length >= 4)
        .map((s) => s.slice(0, 40))
      let node = anchorEl.parentElement
      for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
        if (node === (anchorEl.ownerDocument && anchorEl.ownerDocument.body)) return null
        const hay = textOf(node, anchorEl).replace(/\s+/g, ' ')
        if (probes.length === 0 ? hay.length > 200 : probes.some((p) => hay.includes(p))) return node
      }
      return null
    }

    // ── undo exactly what one effect created: mark spans unwrap back to
    // their text; badge spans are chrome, not content — remove them outright.
    // Spans already gone (React re-rendered the body) are skipped.
    function clearOwned(created) {
      for (const item of created) {
        const span = item.el
        if (!span.isConnected || !span.parentNode) continue
        const parent = span.parentNode
        if (item.kind === 'badge') {
          parent.removeChild(span)
        } else {
          parent.replaceChild(span.ownerDocument.createTextNode(span.textContent), span)
        }
        parent.normalize()
      }
    }

    // ── locate one normalized anchor in the concatenated text (whitespace
    // collapsed) and map it back to raw node/offset boundaries. Duplicate
    // phrases are disambiguated by PROXIMITY: the last occurrence whose start
    // node precedes `beforeEl` (the message's own button) wins — the reviewed
    // text always sits right above its own action row, while duplicates in
    // older turns are further up. Falls back to the first occurrence.
    function locateRange(nodes, needle, beforeEl) {
      let collapsed = ''
      const map = []
      let prevSpace = true
      for (let ni = 0; ni < nodes.length; ni += 1) {
        const v = nodes[ni].nodeValue
        for (let i = 0; i < v.length; i += 1) {
          const isSpace = /\s/.test(v[i])
          if (isSpace) {
            if (!prevSpace) { collapsed += ' '; map.push([ni, i]); prevSpace = true }
          } else { collapsed += v[i]; map.push([ni, i]); prevSpace = false }
        }
      }
      const before = (node) => {
        if (!beforeEl || node === beforeEl || beforeEl.contains(node)) return true
        const pos = node.compareDocumentPosition(beforeEl)
        return (pos & 4) !== 0 // DOCUMENT_POSITION_FOLLOWING: beforeEl follows node
      }
      let chosen = null
      let first = null
      let at = collapsed.indexOf(needle)
      while (at >= 0) {
        const start = map[at]
        const end = map[at + needle.length - 1]
        if (start && end) {
          const range = { startNode: nodes[start[0]], startOffset: start[1], endNode: nodes[end[0]], endOffset: end[1] + 1 }
          if (!first) first = range
          if (before(range.startNode)) chosen = range
        }
        at = collapsed.indexOf(needle, at + 1)
      }
      return chosen || first
    }

    // ── index-based portion splitting: the anchor occupies exactly
    // [startOffset, endOffset) of the raw text; split so it becomes whole text
    // node(s), then wrap them. The DFS is bounded by `root` so a bug can never
    // escape the chat root. Every created span is recorded in `created` for
    // owned cleanup.
    function wrapRange(doc, root, range, spanClass, badge, onActivate, created) {
      let first
      let last
      if (range.startNode === range.endNode) {
        const mid = range.startNode.splitText(range.startOffset)
        mid.splitText(range.endOffset - range.startOffset)
        first = mid
        last = mid
      } else {
        range.endNode.splitText(range.endOffset)
        first = range.startNode.splitText(range.startOffset)
        last = range.endNode
      }
      const nodes = []
      let cur = first
      while (cur) {
        if (cur.nodeType === 3) nodes.push(cur)
        if (cur === last) break
        let next = cur.firstChild || cur.nextSibling
        let climb = cur
        while (!next && climb !== root && climb.parentNode) { climb = climb.parentNode; next = climb.nextSibling }
        cur = next
      }
      let lastSpan = null
      for (const node of nodes) {
        if (node.nodeValue.trim() === '') continue
        const span = doc.createElement('span')
        span.className = spanClass
        span.addEventListener('click', onActivate)
        node.parentNode.replaceChild(span, node)
        span.appendChild(node)
        created.push({ kind: 'mark', el: span })
        if (node === last) lastSpan = span
      }
      if (lastSpan && lastSpan.parentNode) {
        lastSpan.parentNode.insertBefore(badge, lastSpan.nextSibling)
      } else if (last.parentNode) {
        last.parentNode.insertBefore(badge, last.nextSibling)
      }
      created.push({ kind: 'badge', el: badge })
    }

    // ── mark every annotation with per-item try/catch and return visible
    // stats plus the owned span list for cleanup.
    function markTurn(anchorEl, entry) {
      const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
      const stats = { marked: 0, total: 0, failures: [] }
      const created = []
      const root = findChatRoot(anchorEl, annotations)
      if (!root) {
        stats.failures.push('chat root not found')
        console.error('advisor-review: chat root not found')
        return { root: null, stats, created }
      }
      const doc = root.ownerDocument
      annotations.forEach((a, i) => {
        if (!a || typeof a.anchor !== 'string') return
        const needle = normalizeAnchor(a.anchor)
        if (needle.length < 4) return
        stats.total += 1
        try {
          const range = locateRange(collectTextNodes(root, anchorEl), needle, anchorEl)
          if (!range) {
            stats.failures.push('#' + (i + 1) + ' anchor not found in DOM text')
            return
          }
          const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
          const open = (event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            const docEl = doc.documentElement
            const maxX = Math.max(12, (docEl ? docEl.clientWidth : 800) - 440)
            store.popover = {
              annotation: a,
              index: i + 1,
              x: Math.min(Math.max(12, rect.left), maxX),
              y: rect.bottom + 6,
            }
            emit()
          }
          const badge = doc.createElement('span')
          badge.className = 'dsr-badge dsr-badge-' + sev
          badge.textContent = String(i + 1)
          badge.title = (a.severity === 'blocker' ? 'blocker' : 'nit') + ' · ' + (a.title || '')
          badge.addEventListener('click', open)
          wrapRange(doc, root, range, 'dsr-mark dsr-mark-' + sev, badge, open, created)
          stats.marked += 1
        } catch (error) {
          stats.failures.push('#' + (i + 1) + ' ' + String(error && error.message || error))
        }
      })
      if (stats.failures.length > 0) console.error('advisor-review mark failures:', stats.failures.join(' | '))
      return { root, stats, created }
    }

    // ── the annotation card panel: the same markup the chain tail used to
    // render, built as plain DOM (class names shared with the stylesheet).
    function appendSevBadge(doc, parent, sev) {
      const s = doc.createElement('span')
      s.className = 'dsr-sev dsr-sev-' + sev
      s.textContent = sev
      parent.appendChild(s)
    }
    function appendIndexBadge(doc, parent, sev, n) {
      const b = doc.createElement('span')
      b.className = 'dsr-badge dsr-badge-' + sev
      b.setAttribute('style', 'vertical-align:1px;margin-right:4px')
      b.textContent = String(n)
      parent.appendChild(b)
    }
    function buildPanel(doc, entry) {
      const panel = doc.createElement('div')
      panel.className = 'dsr-tail'
      if (entry.status === 'error') {
        const e = doc.createElement('div')
        e.className = 'dsr-error'
        e.textContent = '批注评审失败：' + String(entry.error || 'unknown')
        panel.appendChild(e)
        return panel
      }
      const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
      const stats = entry.markStats
      const head = doc.createElement('div')
      head.className = 'dsr-tail-head'
      head.textContent = entry.status === 'sound'
        ? '✓ 批评者：草案整体成立'
        : '批评者批注 · ' + annotations.length + ' 条'
          + (stats ? ' · 标记 ' + stats.marked + '/' + stats.total : '')
          + '（原文中的波浪下划线与角标可点击）'
          + (entry.status === 'completed-unparsed' ? '（未解析出结构化批注，原文如下）' : '')
          + (stats && stats.failures.length > 0 ? '　标记失败：' + stats.failures.join('；') : '')
      panel.appendChild(head)
      annotations.forEach((a, i) => {
        const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
        const item = doc.createElement('div')
        item.className = 'dsr-item'
        const row = doc.createElement('div')
        appendSevBadge(doc, row, sev)
        appendIndexBadge(doc, row, sev, i + 1)
        const title = doc.createElement('span')
        title.className = 'dsr-title'
        title.textContent = a.title || '（无标题）'
        row.appendChild(title)
        if (!a.matched) {
          const un = doc.createElement('span')
          un.className = 'dsr-unanchored'
          un.textContent = '未锚定'
          row.appendChild(un)
        }
        item.appendChild(row)
        if (a.anchor) {
          const an = doc.createElement('div')
          an.className = 'dsr-anchor'
          an.textContent = a.anchor.length > 220 ? a.anchor.slice(0, 219) + '…' : a.anchor
          item.appendChild(an)
        }
        const cm = doc.createElement('div')
        cm.className = 'dsr-comment'
        cm.textContent = a.comment || ''
        item.appendChild(cm)
        panel.appendChild(item)
      })
      if (typeof entry.raw === 'string' && entry.raw !== '') {
        const raw = doc.createElement('div')
        raw.className = 'dsr-raw'
        raw.textContent = entry.raw
        panel.appendChild(raw)
      }
      return panel
    }

    function ReviewButton(props) {
      useStoreTick()
      const messageId = props.messageId
      const sessionId = props.sessionId
      const [busy, setBusy] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => { void hydrate(sessionId) }, [sessionId])
      const entry = store.byMessage.get(messageId)
      // One effect owns every visual artifact for this message: inline marks,
      // badges, and the card panel inserted right before the message's own
      // tail flow item (the direct child of the chat root on the button's
      // ancestor path).
      React.useEffect(() => {
        const el = rootRef.current
        if (!el || !entry) return undefined
        const doc = el.ownerDocument
        let markResult = null
        if (entry.status !== 'error') {
          markResult = markTurn(el, entry)
          entry.markStats = markResult.stats
        }
        const root = markResult && markResult.root
          ? markResult.root
          : findChatRoot(el, Array.isArray(entry.annotations) ? entry.annotations : [])
        let panel = null
        if (root) {
          panel = buildPanel(doc, entry)
          let branch = el
          while (branch.parentElement && branch.parentElement !== root) branch = branch.parentElement
          root.insertBefore(panel, branch)
        }
        emit()
        return () => {
          if (markResult) clearOwned(markResult.created)
          if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
        }
      }, [entry])
      const count = entry && Array.isArray(entry.annotations) ? entry.annotations.length : 0
      const label = busy
        ? '评审中…'
        : entry === undefined
          ? '批注评审'
          : entry.status === 'sound'
            ? '✓ 无阻断 (' + count + ')'
            : entry.status === 'error'
              ? '评审失败 · 重试'
              : '批注 ' + count + ' · 复审'
      const onClick = () => {
        if (busy) return
        setBusy(true)
        host.call('review.start', { sessionId, messageId })
          .then((res) => {
            if (res && res.review) absorb(res.review)
            else if (!res || !res.ok) {
              store.byMessage.set(messageId, { messageId, status: 'error', error: String(res && res.error || 'unknown error'), annotations: [] })
            }
            if (!res || !res.ok) console.error('review.start failed:', res && res.error)
            emit()
          })
          .catch((error) => {
            store.byMessage.set(messageId, { messageId, status: 'error', error: String(error && error.message || error), annotations: [] })
            console.error('review.start rpc threw:', error && error.message)
            emit()
          })
          .then(() => setBusy(false))
      }
      const stats = entry && entry.markStats
      const tip = entry && entry.status === 'error'
        ? String(entry.error || 'unknown error')
        : '让批评者模型对这条回复做锚定批注评审'
          + (stats ? '（标记 ' + stats.marked + '/' + stats.total + (stats.failures.length > 0 ? '，失败：' + stats.failures.join('；') : '') + '）' : '')
      return React.createElement('button', {
        className: 'dsr-btn',
        onClick,
        disabled: busy,
        title: tip,
        ref: rootRef,
      }, label)
    }

    // ── frame overlay: the annotation popover, positioned at the clicked mark.
    function PopoverLayer() {
      useStoreTick()
      const pop = store.popover
      React.useEffect(() => {
        if (!pop) return undefined
        const doc = typeof document !== 'undefined' ? document : null
        if (!doc) return undefined
        const close = () => { store.popover = null; emit() }
        doc.addEventListener('click', close)
        return () => doc.removeEventListener('click', close)
      }, [pop])
      if (!pop || !pop.annotation) return null
      const a = pop.annotation
      const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
      return React.createElement('div', {
        className: 'dsr-pop',
        style: { left: pop.x + 'px', top: pop.y + 'px' },
        onClick: (event) => event.stopPropagation(),
      },
        React.createElement('div', { className: 'dsr-pop-head' },
          (() => {
            const s = React.createElement('span', { className: 'dsr-sev dsr-sev-' + sev }, sev)
            return s
          })(),
          React.createElement('span', { className: 'dsr-badge dsr-badge-' + sev, style: { verticalAlign: '1px', marginRight: '5px' } }, String(pop.index)),
          React.createElement('span', { className: 'dsr-title' }, a.title || '（无标题）')),
        a.anchor ? React.createElement('div', { className: 'dsr-pop-anchor' }, a.anchor.length > 220 ? a.anchor.slice(0, 219) + '…' : a.anchor) : null,
        React.createElement('div', { className: 'dsr-pop-comment' }, a.comment || ''))
    }

    slots.inject('conversation.chat.assistant-actions', () => slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'advisor-review', order: 20, label: '批注评审' },
      (props) => React.createElement(ReviewButton, props),
    ))
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'advisor-review-popover' },
      () => React.createElement(PopoverLayer, null),
    ))
  },
}
