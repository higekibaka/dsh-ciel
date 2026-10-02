import { detectSensitiveText } from './review-corpus.js'

const publicText = (value, fallback) => {
  const text = typeof value === 'string' ? value.trim().slice(0, 1200) : ''
  return text && !detectSensitiveText(text) ? text : fallback
}

/** Each investigator may cite only receipts it actually received, or the
 * supplied author quote. Shared snapshot bytes do not grant sibling citations. */
export function investigationEvidence(corpus, ledger, providedRefs = []) {
  const seen = new Set(providedRefs)
  const query = name => args => {
    const result = corpus[name](args)
    for (const id of result.evidence_refs || []) seen.add(id)
    return result
  }
  return {
    corpus: { ...corpus, read: query('read'), grep: query('grep'), glob: query('glob') },
    ledger: {
      resolve(value) {
        const records = ledger.resolve(value)
        return records.every(record => seen.has(record.id)) ? records : []
      },
      selected(ids) { return ledger.selected([...ids].filter(id => seen.has(id))) },
    },
  }
}

/** An explicit row exists before dispatch, including when the deadline wins. */
export function investigationRow(suspect) {
  return {
    id: suspect.id, suspect: publicText(suspect.suspect, '疑点内容不可用'),
    ...(suspect.block ? { block: suspect.block } : {}),
    status: 'not-started', outcome: 'unchecked', reason: '尚未启动独立核查',
    toolCalls: 0, modelRequests: 0, elapsedMs: 0, evidenceRefs: [],
  }
}

export function finishInvestigation(row, parsed) {
  const outcome = parsed.outcomes.find(item => item.id === row.id)
  const settled = outcome && outcome.outcome !== 'unchecked'
  Object.assign(row, {
    status: settled ? 'settled' : 'unresolved',
    outcome: outcome?.outcome || 'unchecked',
    reason: publicText(outcome?.reason, settled
      ? '已给出证据引用；结论仍需结合证据判断。'
      : parsed.ledgerIssues?.length ? parsed.ledgerIssues.join('；') : '独立核查未取得足以判断正误的证据；模型未提供具体受阻说明。'),
    evidenceRefs: outcome?.evidenceRefs || [],
  })
}

export function failInvestigation(row, error, reason) {
  row.status = 'failed'
  row.outcome = 'unchecked'
  row.reason = publicText(reason || error?.message, '独立核查失败，未取得有效结果。')
  row.evidenceRefs = []
}

/** Recount once on the Host, preserving the original nomination order. A
 * worker cannot erase another worker's finding or manufacture a new id. */
export function mergeInvestigations(suspects, results) {
  const byId = new Map(results.map(result => [result.row.id, result]))
  const outcomes = [], annotations = [], records = new Map(), issues = new Set()
  let ignoredAnnotations = 0, verdictAdjusted = false
  for (const suspect of suspects) {
    const result = byId.get(suspect.id)
    const parsed = result?.parsed
    const outcome = parsed?.outcomes.find(row => row.id === suspect.id)
    outcomes.push(outcome || { id: suspect.id, outcome: 'unchecked', evidence: '', evidenceRefs: [] })
    if (!parsed) issues.add(suspect.id + '：独立核查未完成')
    for (const issue of parsed?.ledgerIssues || []) issues.add(issue)
    // One nominated issue owns one finding. Prefer its blocker, never another
    // suspect's annotation; at most eight annotations remain addressable.
    const matches = (parsed?.annotations || []).filter(a => a.suspect === suspect.id)
    const annotation = matches.find(a => a.severity === 'blocker') || matches[0]
    if (annotation) annotations.push(annotation)
    ignoredAnnotations += (parsed?.ignoredAnnotations || 0) + Math.max(0, matches.length - 1)
    for (const record of parsed?.evidenceRecords || []) records.set(record.id, record)
    verdictAdjusted ||= parsed?.verdictAdjusted === true
  }
  const stats = {
    checked: outcomes.length,
    confirmed: outcomes.filter(row => row.outcome === 'defect').length,
    excluded: outcomes.filter(row => row.outcome === 'cleared').length,
    unchecked: outcomes.filter(row => row.outcome === 'unchecked').length,
  }
  return {
    valid: true, outcomes, annotations, stats,
    verdict: annotations.some(a => a.severity === 'blocker') ? 'changes' : 'pass',
    verdictAdjusted, ignoredAnnotations, ledgerIssues: [...issues], evidenceRecords: [...records.values()],
  }
}
