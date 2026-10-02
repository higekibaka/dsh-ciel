/** True only for coherent, positive accounting with no unresolved item.
 * Evidence coverage remains separate; this never changes saved verdicts. */
export function hasSettledReviewItems(review) {
  if (['error', 'cancelled', 'unverified'].includes(review?.status)) return false
  const s = review?.stats
  return !!s && [s.checked, s.confirmed, s.excluded, s.unchecked].every(n => Number.isSafeInteger(n) && n >= 0)
    && s.checked > 0 && s.unchecked === 0 && s.checked === s.confirmed + s.excluded
}

/** Presentation projections over saved records; never infer current workspace facts. */
export function reviewConclusion(review) {
  const count = Array.isArray(review.annotations) ? review.annotations.length : 0
  if (review.status === 'error') return '本次评审失败，未形成完整结论。'
  if (review.status === 'cancelled') return '评审已取消，已保存内容仅供参考。'
  const partial = review.coverage !== 'complete' || ['incomplete', 'unverified'].includes(review.status) || review.stats?.unchecked > 0
  if (partial && hasSettledReviewItems(review)) {
    return count ? '核查已完成，发现 ' + count + ' 条批注；部分证据或覆盖范围仍受限。'
      : '已完成 ' + review.stats.checked + ' 项核查，疑点均已排除；部分证据或覆盖范围仍受限。'
  }
  if (partial) return count ? `发现 ${count} 条批注，仍不能判定全部通过。` : '核查尚未完成，不能判定通过。'
  return count ? `发现 ${count} 条需要核对的批注。` : '已核实范围内未发现阻断问题。'
}

/** Format only known listing records. Unrecognized content retains the original renderer. */
export function listingPresentation(evidence) {
  if (!['listing', 'directory'].includes(evidence.kind) || !['available', 'limited', undefined].includes(evidence.status)) return null
  if (typeof evidence.content !== 'string' || evidence.content.length > 262144) return null
  let record
  try { record = JSON.parse(evidence.content) } catch { return null }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Array.isArray(record.paths) || record.paths.length > 500 || !record.paths.every(path => typeof path === 'string')) return null
  return { pattern: typeof record.pattern === 'string' ? record.pattern : null, paths: record.paths, truncated: evidence.truncated === true || record.truncated === true, raw: evidence.content }
}

/** One pending, plugin-owned decision; disposal always settles without editing the composer. */
export function createCielDecisionPrompt({ React, Modal, Button }) {
  const h = React.createElement
  const listeners = new Set()
  let current = null, active = true
  const publish = () => { for (const listener of listeners) listener() }
  const settle = choice => { const pending = current; current = null; publish(); pending?.resolve(choice) }
  function View() {
    const [, tick] = React.useState(0)
    React.useEffect(() => { const update = () => tick(n => n + 1); listeners.add(update); return () => listeners.delete(update) }, [])
    if (!current) return null
    const replacing = current.step === 'replace'
    const button = (label, choice, primary = false) => h(Button || 'button', { type: 'button', ...(Button ? { variant: primary ? 'primary' : 'toolbar', size: 'md' } : {}), onClick: () => settle(choice) }, label)
    const footer = h('div', { 'data-ciel-draft-confirm-actions': '' },
      replacing ? button('返回', 'back') : h(Button || 'button', { type: 'button', ...(Button ? { variant: 'toolbar', size: 'md' } : {}), onClick: () => { current = { ...current, step: 'replace' }; publish() } }, '替换现有草稿'),
      button('取消', 'cancel'), button(replacing ? '确认替换' : '追加到草稿末尾', replacing ? 'replace' : 'append', true))
    const close = () => settle('cancel')
    const body = h('div', { 'data-ciel-draft-confirm': '' },
      h('p', {}, replacing ? '现有文字和行内引用将被选中的批注替换；这一步不会发送消息。' : '输入框已有内容。追加会保留现有文字、引用和附件；你仍需确认后手动发送。'),
      replacing ? null : h('pre', {}, current.preview || '输入框已有内容'),
      h('p', {}, '如果等待期间会话或输入内容发生变化，本次操作会停止。'))
    if (typeof Modal !== 'function' && (typeof Modal !== 'object' || Modal === null)) return h('div', { role: 'dialog', 'aria-label': '批注草稿确认' }, body, footer)
    return h(Modal, { open: true, title: replacing ? '替换现有草稿？' : '保留你已有的草稿', closeLabel: '关闭', onClose: close, className: 'ciel-draft-modal', footer }, body)
  }
  return {
    View,
    async ask(preview) {
      if (!active) return 'cancel'
      if (current) throw new Error('请先处理当前的草稿确认。')
      if (listeners.size === 0) throw new Error('草稿确认界面尚未就绪，未修改输入框；请稍后重试。')
      let step = 'append'
      while (active) {
        const choice = await new Promise(resolve => { current = { preview: String(preview).slice(0,4000), step, resolve }; publish() })
        if (choice !== 'back') return choice
        step = 'append'
      }
      return 'cancel'
    },
    dispose() { active = false; settle('cancel'); listeners.clear() },
  }
}
