// Build test/harness.html: real chat-turn fixture (cloned into two turns with
// a shared duplicate phrase) + extracted engine + scenario hooks.
const { readFileSync, writeFileSync } = require('fs')

const fixture = readFileSync('/home/hgk/123/test/fixture-chat.html', 'utf8')
const engine = readFileSync('/home/hgk/123/test/engine.js', 'utf8')

const styles = [
  '.dsr-btn{font-size:11px;padding:1px 8px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;opacity:.65;cursor:pointer}',
  '.dsr-tail{margin:8px 0 2px;border:1px solid rgba(130,130,130,.28);border-radius:8px;overflow:hidden;font-size:13px;line-height:1.55}',
  '.dsr-tail-head{padding:6px 10px;font-size:12px;opacity:.75;border-bottom:1px solid rgba(130,130,130,.2);display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.dsr-item{padding:8px 10px;border-top:1px solid rgba(130,130,130,.14)}',
  '.dsr-sev{display:inline-block;font-size:10.5px;font-family:ui-monospace,monospace;padding:0 6px;border-radius:3px;margin-right:6px;vertical-align:1px}',
  '.dsr-sev-blocker{color:#f85149;border:1px solid #f85149}',
  '.dsr-sev-nit{color:#d29922;border:1px solid #d29922}',
  '.dsr-title{font-weight:600}',
  '.dsr-unanchored{font-size:10.5px;opacity:.6;margin-left:6px}',
  '.dsr-anchor{margin:5px 0 3px;padding:3px 8px;border-left:2px solid rgba(130,130,130,.5);font-family:ui-monospace,monospace;font-size:11.5px;opacity:.7;white-space:pre-wrap;word-break:break-word}',
  '.dsr-comment{opacity:.92;white-space:pre-wrap;word-break:break-word}',
  '.dsr-mark{cursor:pointer;border-radius:2px}',
  '.dsr-mark-blocker{text-decoration:underline wavy #f85149 1.5px;text-underline-offset:3px;background:rgba(248,81,73,.07)}',
  '.dsr-mark-nit{text-decoration:underline wavy #d29922 1.5px;text-underline-offset:3px;background:rgba(210,153,34,.07)}',
  '.dsr-badge{display:inline-block;font-size:9.5px;font-family:ui-monospace,monospace;line-height:1.4;padding:0 3px;border-radius:3px;margin-left:2px;vertical-align:super;cursor:pointer;user-select:none}',
  '.dsr-badge-blocker{color:#f85149;border:1px solid #f85149}',
  '.dsr-badge-nit{color:#d29922;border:1px solid #d29922}',
  '.dsr-error{padding:8px 10px;color:#f85149;font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
  '.dsr-raw{padding:8px 10px;white-space:pre-wrap;word-break:break-word;opacity:.85;font-size:12.5px}',
  'body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:860px;margin:20px auto;background:#123;color:#e6e9ee;padding:12px}',
].join('\n')

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${styles}</style></head>
<body>
<h3 style="opacity:.6">DOM harness — two turns, one shared phrase</h3>
<div id="stage"></div>
<script>
const FIXTURE = ${JSON.stringify(fixture)}
</script>
<script>
// ── stage setup: parse the fixture column, clone its assistant-step + turn-
// tail pair into a second turn sharing the phrase "所有权系统", and inject a
// synthetic review button into each turn-tail's action row.
const store = { popover: null }
const emit = () => {}
const holder = document.createElement('div')
holder.innerHTML = FIXTURE
const column = holder.firstElementChild
const step1 = column.querySelector('[data-chat-flow-kind="assistant-step"]')
const tail1 = column.querySelector('[data-chat-flow-kind="turn-tail"]')
const step2 = step1.cloneNode(true)
const tail2 = tail1.cloneNode(true)
// patch turn 2's body text: keep markdown shape, share the duplicate phrase
const md = step2.querySelectorAll('p')
md.forEach((p, i) => {
  if (i === 0) p.textContent = '借用检查器在编译期验证所有引用：任何引用的存活时间都不能超过其指向值的所有权系统生命周期。'
  else p.remove()
})
step2.setAttribute('data-chat-flow-key', '14:assistant-step6:99')
tail2.setAttribute('data-chat-flow-key', '9:turn-tail2')
column.appendChild(step2)
column.appendChild(tail2)
function injectButton(tail, label) {
  const copyBtn = tail.querySelector('button[aria-label="Copy"]')
  const bar = copyBtn.parentElement
  const b = document.createElement('button')
  b.className = 'dsr-btn'
  b.textContent = label
  bar.insertBefore(b, bar.children[3] || null)
  return b
}
const btn1 = injectButton(tail1, '批注 1 · 复审')
const btn2 = injectButton(tail2, '批注 2 · 复审')
document.getElementById('stage').appendChild(column)
</script>
<script>
${engine}
</script>
<script>
// ── scenario API for the driver
const REVIEW_1 = { messageId: 'm1', status: 'completed', annotations: [
  { severity: 'nit', title: '释放时机未量化', anchor: '当所有者离开其作用域时，该值会被自动释放', comment: '「离开作用域」的精确时点（词法作用域结束 vs NLL 提前结束）未说明。', matched: true },
] }
const REVIEW_2 = { messageId: 'm2', status: 'completed', annotations: [
  { severity: 'blocker', title: '借用规则过度简化', anchor: '借用检查器在编译期验证所有引用', comment: '并非所有引用都在编译期可知：RefCell 把检查推迟到运行期。', matched: true },
  { severity: 'nit', title: '术语首次出现未展开', anchor: '所有权系统', comment: '重复短语：两轮都有，标记必须落在第二轮。', matched: true },
] }
function marksIn(el) { return el.querySelectorAll('.dsr-mark').length }
function badgesIn(el) { return Array.from(el.querySelectorAll('.dsr-badge')).filter((b) => !b.closest('.dsr-tail')).length }
window.__run = function () {
  const out = {}
  // 1. mark turn 2
  const r2 = markTurn(btn2, REVIEW_2)
  out.r2 = { root: !!r2.root, stats: r2.stats, created: r2.created.length }
  out.t2_marks = marksIn(step2)
  out.t1_marks_after_t2 = marksIn(step1)
  out.dupMarkInTurn2 = (() => {
    const marks = Array.from(step2.querySelectorAll('.dsr-mark'))
    return marks.some((m) => m.textContent.includes('所有权系统'))
  })()
  out.dupMarkInTurn1 = (() => {
    const marks = Array.from(step1.querySelectorAll('.dsr-mark'))
    return marks.some((m) => m.textContent === '所有权系统')
  })()
  // badge pairing: every badge's previous sibling is a mark
  out.badgePairing = Array.from(column.querySelectorAll('.dsr-badge')).filter((b) => !b.closest('.dsr-tail')).map((b) => {
    const p = b.previousElementSibling
    return p && p.classList.contains('dsr-mark')
  })
  // 2. mark turn 1 — turn 2's marks must survive
  const r1 = markTurn(btn1, REVIEW_1)
  out.r1 = { root: !!r1.root, stats: r1.stats, created: r1.created.length }
  out.t2_marks_after_t1 = marksIn(step2)
  out.t1_marks = marksIn(step1)
  // 3. panel insertion for turn 2: lands right before tail2's flow item
  const panel2 = buildPanel(document, { ...REVIEW_2, markStats: r2.stats })
  let branch = btn2
  while (branch.parentElement && branch.parentElement !== r2.root) branch = branch.parentElement
  r2.root.insertBefore(panel2, branch)
  out.panelBeforeTail = panel2.nextElementSibling === branch
  out.panelClass = panel2.className
  // 4. clear turn 2's owned spans: turn 1 intact, no bare badge text
  clearOwned(r2.created)
  out.t2_marks_after_clear = marksIn(step2)
  out.t1_marks_after_clear = marksIn(step1)
  const strayBadgeText = (() => {
    const walker = document.createTreeWalker(step2, 4, null)
    let n = walker.nextNode()
    while (n) { if (/^\\s*12?\\s*$/.test(n.nodeValue) && n.nodeValue.trim().length <= 2 && n.parentElement.tagName !== 'P') return n.nodeValue; n = walker.nextNode() }
    return null
  })()
  out.strayBadgeText = strayBadgeText
  out.t2_badges_after_clear = badgesIn(step2)
  // 5. re-mark turn 2 with a fresh entry (re-review): exactly one set of marks
  const r2b = markTurn(btn2, REVIEW_2)
  out.t2_marks_remark = marksIn(step2)
  out.t2_badges_remark = badgesIn(step2)
  return out
}
</script>
</body></html>`

writeFileSync('/home/hgk/123/test/harness.html', html)
console.log('harness built:', html.length, 'chars')
