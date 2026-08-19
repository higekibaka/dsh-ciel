// Extracted verbatim from recovered/pkg12.client.js — the pure DOM engine.
// `emit` and `store` are provided by the test page.

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

