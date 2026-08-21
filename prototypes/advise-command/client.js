// ═══════════════ /advise 命令卡片 · client 半 ═══════════════
// 双槽之二：conversation.chat.commandview 键控 'advise'（开放键域，附加式），
// 复用 0.8.0 顾问工具卡片的同一视觉语言（同一份 adv-* CSS 类），
// 数据源换成 CommandNode：args=问题原文，outcome=null → 在途，
// outcome.kind/text → 成败与顾问 Markdown 原文（客户端复刻同一解析器）。

const ADV_FIELD_NAMES = ['framing', 'pitfalls', 'verification_target']
const ADV_TIERS = ['high', 'mid', 'low']

// parseAdvisorItems 的客户端复刻（与 plugin/index.js 同一正则契约）。
function parseAdvisorItems(text) {
  const heads = []
  const re = /^## \[(high|mid|low)\][ \t]*(.*)$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    heads.push({ tier: m[1], title: (m[2] || '').trim(), at: m.index, end: re.lastIndex })
  }
  if (heads.length === 0) return { items: [], issues: [] }
  const issues = []
  if (heads.length > 6) issues.push('item count ' + heads.length + ' exceeds the 6-item cap')
  const items = []
  for (let i = 0; i < heads.length; i += 1) {
    const body = text.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : text.length)
    const field = (name) => {
      const match = new RegExp(
        '(?:^|\\n)[ \\t]*' + name + '[ \\t]*:[ \\t]*([\\s\\S]*?)(?=\\n[ \\t]*(?:' + ADV_FIELD_NAMES.join('|') + ')[ \\t]*:|$)',
      ).exec(body)
      return match ? match[1].trim() : ''
    }
    const item = {
      tier: heads[i].tier,
      title: heads[i].title.slice(0, 120),
      framing: field('framing').slice(0, 1200),
      pitfalls: field('pitfalls').slice(0, 1200),
      verificationTarget: field('verification_target').slice(0, 600),
    }
    if (item.framing === '') issues.push('item ' + (i + 1) + ' ("' + item.title + '") lacks framing')
    if (item.verificationTarget === '') issues.push('item ' + (i + 1) + ' ("' + item.title + '") lacks verification_target')
    items.push(item)
  }
  return { items, issues }
}

function clipAdv(text, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
}

// 与静态包同一份 adv-* CSS：重复注入的规则完全同文，无副作用，
// 且保证静态 dsh-advisor 不在场时本卡片仍然完整可见。
const ADVISOR_CARD_CSS = [
  '.adv-card{margin:8px 0;border:1px solid var(--dsw-alias-border-l2, rgba(130,130,130,.22));border-radius:12px;overflow:hidden;font-size:13px;line-height:1.6;background:var(--dsw-alias-bg-layer-2, rgba(255,255,255,.018))}',
  '.adv-head{padding:9px 14px;display:flex;gap:10px;align-items:center;cursor:pointer;user-select:none;background:rgba(127.5,127.5,127.5,.06);border-bottom:1px solid var(--dsw-alias-border-l2, rgba(130,130,130,.16))}',
  '.adv-head:hover{background:rgba(127.5,127.5,127.5,.12)}',
  '.adv-caret{flex:none;width:14px;opacity:.55;font-size:11px}',
  '.adv-head-icon{flex:none;font-size:13px}',
  '.adv-head-title{font-weight:600;font-size:13px}',
  '.adv-dots{display:inline-flex;gap:4px;align-items:center;margin-left:2px}',
  '.adv-dot{width:7px;height:7px;border-radius:50%}',
  '.adv-dot-high{background:#3fb950}',
  '.adv-dot-mid{background:#d29922}',
  '.adv-dot-low{background:#6e7681}',
  '.adv-head-note{margin-left:auto;font-size:11px;opacity:.5;font-family:ui-monospace,monospace}',
  '.adv-head-issues{font-size:11px;color:#d29922;font-family:ui-monospace,monospace}',
  '.adv-body{padding:10px 14px 12px}',
  '.adv-q{margin:0 0 10px;padding:6px 10px;border-left:2px solid rgba(130,130,130,.45);font-size:12px;opacity:.72;font-style:italic;white-space:pre-wrap;word-break:break-word}',
  '.adv-item{position:relative;padding:8px 0 8px 12px;border-top:1px solid rgba(130,130,130,.12)}',
  '.adv-item:first-of-type{border-top:none;padding-top:2px}',
  '.adv-item::before{content:"";position:absolute;left:0;top:10px;bottom:8px;width:2.5px;border-radius:2px}',
  '.adv-item:first-of-type::before{top:4px}',
  '.adv-item.t-high::before{background:#3fb950}',
  '.adv-item.t-mid::before{background:#d29922}',
  '.adv-item.t-low::before{background:#6e7681}',
  '.adv-item-head{display:flex;gap:8px;align-items:center;margin-bottom:5px}',
  '.adv-badge{flex:none;font-size:10px;font-family:ui-monospace,monospace;line-height:16px;padding:0 7px;border-radius:999px;font-weight:600}',
  '.adv-badge-high{color:#3fb950;background:rgba(63,185,80,.13)}',
  '.adv-badge-mid{color:#d29922;background:rgba(210,153,34,.13)}',
  '.adv-badge-low{color:#8b949e;background:rgba(139,148,158,.16)}',
  '.adv-item-title{font-weight:600;font-size:13.5px}',
  '.adv-field{margin:5px 0;white-space:pre-wrap;word-break:break-word}',
  '.adv-flabel{display:inline-block;font-size:10.5px;font-family:ui-monospace,monospace;margin-right:7px;padding:0 5px;border-radius:3px;background:rgba(130,130,130,.14);opacity:.8;vertical-align:1px}',
  '.adv-field-pitfalls .adv-flabel{color:#d29922;background:rgba(210,153,34,.12);opacity:1}',
  '.adv-field-vtarget .adv-flabel{color:#3fb950;background:rgba(63,185,80,.12);opacity:1}',
  '.adv-field-vtarget{font-size:12.5px}',
  '.adv-issues{margin-top:10px;padding:6px 10px;font-size:12px;color:#d29922;border:1px solid rgba(210,153,34,.35);border-radius:8px;background:rgba(210,153,34,.06)}',
  '.adv-raw{white-space:pre-wrap;word-break:break-word;opacity:.92;font-size:12.5px}',
  '.adv-err{color:#f85149;font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
].join('\n')

function AdviseItem(props) {
  const item = props.item
  const tier = ADV_TIERS.indexOf(item.tier) >= 0 ? item.tier : 'low'
  return React.createElement('div', { className: 'adv-item t-' + tier },
    React.createElement('div', { className: 'adv-item-head' },
      React.createElement('span', { className: 'adv-badge adv-badge-' + tier }, tier),
      React.createElement('span', { className: 'adv-item-title' }, String(item.title || '（无标题）'))),
    item.framing
      ? React.createElement('div', { className: 'adv-field' },
          React.createElement('span', { className: 'adv-flabel' }, '思路'),
          String(item.framing))
      : null,
    item.pitfalls
      ? React.createElement('div', { className: 'adv-field adv-field-pitfalls' },
          React.createElement('span', { className: 'adv-flabel' }, '陷阱'),
          String(item.pitfalls))
      : null,
    item.verificationTarget
      ? React.createElement('div', { className: 'adv-field adv-field-vtarget' },
          React.createElement('span', { className: 'adv-flabel' }, '验证目标'),
          String(item.verificationTarget))
      : null)
}

function AdviseCommandView(props) {
  const node = props.node
  const question = typeof node.args === 'string' ? node.args.trim() : ''
  const outcome = node.outcome
  const openState = React.useState(true)
  const open = openState[0]
  const setOpen = openState[1]

  // 在途：command/run 已落，command/done 未到。
  if (outcome === null || outcome === undefined) {
    return React.createElement('div', { className: 'adv-card' },
      React.createElement('div', { className: 'adv-head', style: { cursor: 'default' } },
        React.createElement('span', { className: 'adv-head-icon' }, '💡'),
        React.createElement('span', { className: 'adv-head-title', style: { opacity: .7 } }, '顾问咨询中…'),
        React.createElement('span', { className: 'adv-head-note' }, '/advise 人类触发'),
        question !== '' ? React.createElement('span', { className: 'adv-head-note', style: { marginLeft: 0 } }, clipAdv(question, 60)) : null))
  }

  const isError = outcome.kind === 'error'
  const body = typeof outcome.text === 'string' ? outcome.text : ''
  const parsed = isError ? { items: [], issues: [] } : parseAdvisorItems(body)
  const items = parsed.items
  const issues = parsed.issues

  const dots = []
  for (const t of ADV_TIERS) {
    for (const it of items) {
      if (it.tier === t) dots.push(React.createElement('span', { key: t + dots.length, className: 'adv-dot adv-dot-' + t }))
    }
  }
  const headText = isError
    ? '顾问咨询失败'
    : items.length > 0
      ? '顾问建议 · ' + items.length + ' 条'
      : '顾问建议（未解析出结构化条目，原文如下）'

  return React.createElement('div', { className: 'adv-card' },
    React.createElement('div', {
      className: 'adv-head',
      onClick: () => setOpen(!open),
      'aria-expanded': open,
    },
      React.createElement('span', { className: 'adv-caret' }, open ? '▾' : '▸'),
      React.createElement('span', { className: 'adv-head-icon' }, '💡'),
      React.createElement('span', { className: 'adv-head-title', style: isError ? { color: '#f85149' } : undefined }, headText),
      dots.length > 0 ? React.createElement('span', { className: 'adv-dots' }, dots) : null,
      issues.length > 0 ? React.createElement('span', { className: 'adv-head-issues' }, '解析问题 ' + issues.length) : null,
      React.createElement('span', { className: 'adv-head-note' }, '/advise 人类触发')),
    open
      ? React.createElement('div', { className: 'adv-body' },
          question !== '' ? React.createElement('div', { className: 'adv-q' }, '咨询：' + clipAdv(question, 300)) : null,
          isError
            ? React.createElement('div', { className: 'adv-err' }, body !== '' ? body : '（无错误详情）')
            : items.length > 0
              ? items.map((item, i) => React.createElement(AdviseItem, { key: i, item }))
              : React.createElement('div', { className: 'adv-raw' }, body !== '' ? body : '（空回复）'),
          issues.length > 0
            ? React.createElement('div', { className: 'adv-issues' }, '解析问题：' + issues.join('；'))
            : null)
      : null)
}

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    styles.insert(ADVISOR_CARD_CSS)
    slots.inject('conversation.chat.commandview', () => slots.register(
      { name: 'conversation.chat.commandview', key: 'advise' },
      (props) => React.createElement(AdviseCommandView, props),
    ))
  },
}
