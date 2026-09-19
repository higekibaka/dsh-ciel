// Own only host Markdown anchors and their shared observer. React portals
// and review state remain owned by the caller. No RPC or model work here.
/**
 * One MutationObserver for every reviewed message on the page. A watcher
 * debounces 120ms, repaints only when its own marks/panel look destroyed,
 * and after three repaints that marked nothing it unregisters (the anchor
 * is truly unmatchable). The observer exists only while at least one
 * watcher is registered, so this helper has a bounded lifetime and no
 * per-message observer is created.
 */
function createMarkSupervisor(doc) {
  const watchers = new Set()
  let observer = null
  const observable = doc !== null && doc !== undefined && doc.body !== null && doc.body !== undefined && typeof MutationObserver === 'function'
  const flush = (mutations) => {
    for (const watcher of [...watchers]) {
      try { watcher.onMutations(mutations) } catch { /* one watcher must not break the others */ }
    }
  }
  return {
    add(watcher) {
      watchers.add(watcher)
      if (observer === null && observable) {
        observer = new MutationObserver(flush)
        observer.observe(doc.body, { childList: true, subtree: true })
      }
      return () => {
        watchers.delete(watcher)
        if (watchers.size === 0 && observer !== null) {
          observer.disconnect()
          observer = null
        }
      }
    },
    dispose() {
      watchers.clear()
      if (observer !== null) {
        observer.disconnect()
        observer = null
      }
    },
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
// shared flow column (flow items have no per-turn wrapper) — which is SAFE
// here, because matching is proximity-disambiguated and cleanup is by
// owned spans, so a big universe cannot leak across turns.
function findChatRoot(anchorEl, annotations) {
  const probes = (annotations || [])
    .filter((a) => a && typeof a.anchor === 'string')
    .map((a) => normalizeAnchor(a.anchor))
    .filter((s) => s.length >= 4)
    .map((s) => s.slice(0, 40))
  let node = anchorEl.parentElement
  // 渐进挂载兜底：长消息分多个 mutation 周期上树，probe 可能暂时落空。
  // 记住沿途第一个「够大」的祖先——被评审文本总在按钮自己的 flow item
  // 里，而匹配本来就是 proximity 消歧，落到这里不跨消息串味。
  let firstBig = null
  for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
    if (node === (anchorEl.ownerDocument && anchorEl.ownerDocument.body)) break
    const hay = textOf(node, anchorEl).replace(/\s+/g, ' ')
    if (firstBig === null && hay.length > 200) firstBig = node
    if (probes.length === 0 ? hay.length > 200 : probes.some((p) => hay.includes(p))) return node
  }
  return firstBig
}

// ── undo exactly what one effect created: mark spans unwrap back to
// their text; badge spans are chrome, not content — remove them outright.
// Spans already gone (React re-rendered the body) are skipped.
function clearOwned(created) {
  for (const item of created) {
    const span = item.el
    if (item.kind === 'gutter') {
      if (span.isConnected && span.parentNode) span.parentNode.removeChild(span)
      if (item.host && item.host.classList) item.host.classList.remove('dsr-blk', 'dsr-blk-hl')
      continue
    }
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

// ── 0.12.0 ①块级解析：entry.blocks（host 落库的 id+type 序号空间）对到
// 渲染 DOM 的顶层块元素。规则与切分器同纪律——宁简勿繁 + 失败退回
// proximity：候选 = root 内按文档序、位于按钮之前的块元素（P/H1-6/PRE/
// UL/OL/TABLE/BLOCKQUOTE/HR，未分类的薄壳 div 下降一层），取末尾
// blocks.length 个按序号 zip；类型不符即放弃该块映射。
function classifyBlockEl(el) {
  const tag = el.tagName
  if (/^H[1-6]$/.test(tag)) return 'heading'
  if (tag === 'PRE') return 'code'
  if (tag === 'UL' || tag === 'OL') return 'list'
  if (tag === 'TABLE') return 'table'
  if (tag === 'BLOCKQUOTE') return 'quote'
  if (tag === 'HR') return 'hr'
  if (tag === 'P') return 'paragraph'
  return null
}
function resolveBlockDoms(root, beforeEl, blocks) {
  const map = new Map()
  if (!root || !Array.isArray(blocks) || blocks.length === 0) return map
  const candidates = []
  const precedes = (el) => {
    if (!beforeEl || el === beforeEl || beforeEl.contains(el)) return false
    const pos = el.compareDocumentPosition(beforeEl)
    return (pos & 4) !== 0 // beforeEl follows el
  }
  // 有界 DFS：文档序收集按钮之前的块元素。命中的元素不再下降（块内嵌套
  // 如 blockquote>p 只记外层）；评审自身的 chrome 与按钮操作区跳过。
  const visit = (el) => {
    if (el.classList && (el.classList.contains('dsr-tail') || el.classList.contains('dsr-pop') || el.classList.contains('dsr-gutter'))) return
    if (beforeEl && el !== beforeEl && beforeEl.contains(el)) return
    const type = classifyBlockEl(el)
    if (type !== null) {
      if (precedes(el)) candidates.push({ el, type })
      return
    }
    for (const child of el.children) visit(child)
  }
  visit(root)
  if (candidates.length === 0) return map
  // 类型序列对齐 + 前缀位置对齐的混合：正文之后的交付物/折叠段会让
  // 候选比块少（渲染器把富代码卡渲成自定义组件而非 pre，折叠段整块
  // 不上树），盲目取末尾 N 个或要求全长相等都会清零。做法：对每个偏移
  // 按「类型一致数 / 重叠长度」打分取最优；匹配率 ≥60% 时按位置映射
  // 全部重叠块（吸收组件分类噪音），否则只映射类型一致的位置——对不
  // 上的块保持未映射，消费方退回 proximity。
  const overlap = (o) => Math.min(candidates.length - o, blocks.length)
  let bestOffset = -1
  let bestRatio = 0
  for (let o = 0; o < candidates.length; o += 1) {
    const n = overlap(o)
    if (n <= 0) break
    let score = 0
    for (let i = 0; i < n; i += 1) {
      if (candidates[o + i].type === blocks[i].type) score += 1
    }
    const ratio = score / n
    if (ratio > bestRatio) { bestRatio = ratio; bestOffset = o }
    if (ratio === 1) break
  }
  if (bestOffset < 0) return map
  const n = overlap(bestOffset)
  const positional = bestRatio >= 0.6
  for (let i = 0; i < n; i += 1) {
    if (positional || candidates[bestOffset + i].type === blocks[i].type) {
      map.set(blocks[i].id, candidates[bestOffset + i].el)
    }
  }
  return map
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
function wrapRange(doc, root, range, spanClass, badge, onActivate, created, index) {
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
    created.push({ kind: 'mark', el: span, index })
    if (node === last) lastSpan = span
  }
  if (lastSpan && lastSpan.parentNode) {
    lastSpan.parentNode.insertBefore(badge, lastSpan.nextSibling)
  } else if (last.parentNode) {
    last.parentNode.insertBefore(badge, last.nextSibling)
  }
  created.push({ kind: 'badge', el: badge, index })
}

// ── mark every annotation with per-item try/catch and return visible
// stats plus the owned span list for cleanup.
function markTurn(anchorEl, entry, rootHint, onOpen) {
  const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
  const stats = { marked: 0, total: 0, failures: [] }
  const created = []
  const root = rootHint !== undefined && rootHint !== null ? rootHint : findChatRoot(anchorEl, annotations)
  if (!root) {
    // A short, clean review has no annotation anchors to locate.
    if (annotations.length === 0) return { root: null, stats, created, byIndex: new Map() }
    stats.failures.push('chat root not found')
    console.error('advisor-review: chat root not found')
    return { root: null, stats, created, byIndex: new Map() }
  }
  const doc = root.ownerDocument
  // 0.12.0 ①：有块地图时先解析块级 DOM；块命中的批注挂 gutter 徽章
  // （零文本侵入），未命中的退回旧 proximity 划线（旧记录/解析失败）。
  const blockDoms = resolveBlockDoms(root, anchorEl, entry.blocks)
  const gutterByBlock = new Map() // blockEl -> gutter el（多块共用去重）
  annotations.forEach((a, i) => {
    if (!a || typeof a.anchor !== 'string') return
    const sev = a.severity === 'blocker' ? 'blocker' : 'nit'
    const open = event => onOpen(event, entry, a, i, doc)
    const mapped = typeof a.block === 'string' ? blockDoms.get(a.block) : undefined
    // 证据护栏：位置映射只是猜测，锚引文才是证据。块元素文本不含锚引文
    // 时（渲染器折叠/改写了块，如富代码卡）退回 proximity 找精确位置，
    // 绝把徽章挂到错块上。
    const blockEl = (() => {
      if (mapped === undefined) return undefined
      const probe = normalizeAnchor(a.anchor)
      if (probe.length < 4) return mapped
      const hay = textOf(mapped, anchorEl).replace(/\s+/g, ' ')
      return hay.includes(probe) ? mapped : undefined
    })()
    if (blockEl !== undefined) {
      stats.total += 1
      try {
        blockEl.classList.add('dsr-blk')
        let gutter = gutterByBlock.get(blockEl)
        if (gutter === undefined) {
          gutter = doc.createElement('span')
          gutter.className = 'dsr-gutter'
          blockEl.insertBefore(gutter, blockEl.firstChild)
          gutterByBlock.set(blockEl, gutter)
          created.push({ kind: 'gutter', el: gutter, host: blockEl })
        }
        const mark = doc.createElement('button')
        mark.type = 'button'
        mark.setAttribute('aria-label', '批注 ' + (i + 1) + ' · ' + sev + ' · ' + (a.title || '查看详情'))
        mark.className = 'dsr-gmark dsr-gmark-' + sev
        mark.textContent = String(i + 1)
        mark.title = (a.severity === 'blocker' ? 'blocker' : 'nit') + ' · ' + (a.title || '')
        mark.addEventListener('click', open)
        gutter.appendChild(mark)
        created.push({ kind: 'badge', el: mark, index: i })
        stats.marked += 1
      } catch (error) {
        stats.failures.push('#' + (i + 1) + ' ' + String(error && error.message || error))
      }
      return
    }
    const needle = normalizeAnchor(a.anchor)
    if (needle.length < 4) return
    stats.total += 1
    try {
      const range = locateRange(collectTextNodes(root, anchorEl), needle, anchorEl)
      if (!range) {
        stats.failures.push('#' + (i + 1) + ' anchor not found in DOM text')
        return
      }
      const badge = doc.createElement('button')
      badge.type = 'button'
      badge.setAttribute('aria-label', '批注 ' + (i + 1) + ' · ' + sev + ' · ' + (a.title || '查看详情'))
      badge.className = 'dsr-badge dsr-badge-' + sev
      badge.textContent = String(i + 1)
      badge.title = (a.severity === 'blocker' ? 'blocker' : 'nit') + ' · ' + (a.title || '')
      badge.addEventListener('click', open)
      wrapRange(doc, root, range, 'dsr-mark dsr-mark-' + sev, badge, open, created, i)
      stats.marked += 1
    } catch (error) {
      stats.failures.push('#' + (i + 1) + ' ' + String(error && error.message || error))
    }
  })
  if (stats.failures.length > 0) console.error('advisor-review mark failures:', stats.failures.join(' | '))
  // Spans grouped by annotation index: panel cards click-locate through this.
  const byIndex = new Map()
  for (const item of created) {
    if (item.index === undefined) continue
    if (!byIndex.has(item.index)) byIndex.set(item.index, [])
    byIndex.get(item.index).push(item.el)
  }
  return { root, stats, created, byIndex }
}


export { createMarkSupervisor, normalizeAnchor, clearOwned, findChatRoot, markTurn }
