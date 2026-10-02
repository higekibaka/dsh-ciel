import { createHash } from 'node:crypto'
import path from 'node:path'
import { detectSensitiveText } from './review-corpus.js'
import { EPHEMERAL_EVIDENCE_TOOLS } from './review-evidence-policy.js'

// Archive bounds only: they must not truncate exploration of the snapshot.
export const EVIDENCE_LIMITS = Object.freeze({ maxRecords: 128, maxSnippetBytes: 16 * 1024, maxTotalBytes: 128 * 1024, maxLines: 200 })
const clone = value => JSON.parse(JSON.stringify(value))
const hash = text => createHash('sha256').update(text).digest('hex')
const NL = String.fromCharCode(10)
const positive = n => Number.isSafeInteger(n) && n > 0
const sourcePath = value => typeof value === 'string' && /^[/](?:project|external-[1-9][0-9]*)(?:[/]|$)/.test(value) && !value.split('/').some(p => p === '..' || p === '.') && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '%' || c.charCodeAt(0) === 92)

/** Exact references, not extraction that could bless invented prose. */
export function evidenceRefs(value) {
  if (typeof value !== 'string' || !/^[ea][1-9][0-9]*(?:[ ,，、]+[ea][1-9][0-9]*)*$/.test(value.trim())) return []
  return [...new Set(value.trim().split(/[ ,，、]+/))]
}
function clipSnippet(text, byteLimit, lineLimit) {
  let content = '', bytes = 0, lines = 1
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > byteLimit || lines > lineLimit) break
    content += char; bytes += size
    if (char === NL) lines++
  }
  return { content, bytes, truncated: content.length < text.length }
}

/** Host-owned per-review receipts. Only captured corpus results enter it. */
export function createEvidenceLedger({ roots = [], now = Date.now, limits = {} } = {}) {
  const bounds = { ...EVIDENCE_LIMITS, ...limits }
  for (const [key, value] of Object.entries(bounds)) if (!Object.hasOwn(EVIDENCE_LIMITS, key) || !positive(value) || value > EVIDENCE_LIMITS[key]) throw new Error('Invalid evidence limit')
  const entries = new Map(), duplicates = new Map()
  let usedBytes = 0, metadataBytes = 0, serial = 0, reportedSerial = 0, disposed = false
  const active = () => { if (disposed) throw new Error('Evidence ledger disposed') }
  function currentPath(virtual) {
    for (const root of roots) if (typeof root.virtual === 'string' && path.isAbsolute(root.actual || '') && (virtual === root.virtual || virtual.startsWith(root.virtual + '/'))) return path.join(root.actual, virtual.slice(root.virtual.length))
  }
  function add(input, prefix = 'e') {
    active()
    if (detectSensitiveText(input.content || '') || detectSensitiveText(JSON.stringify(input))) return null
    const text = input.content || ''
    // Dedup before spending the remaining byte budget: repeated reads do not
    // manufacture ever smaller receipts as the archive approaches its bound.
    const fullKey = JSON.stringify([prefix, input.kind, input.origin, input.tool, input.path, input.startLine, hash(text), input.totalLines, !!input.truncated, input.temporal, input.observedAt, input.sourceSeqs])
    if (duplicates.has(fullKey)) return entries.get(duplicates.get(fullKey))
    if (entries.size >= bounds.maxRecords) return null
    // Automatically supplied metadata must not consume the entire archive
    // before investigators can capture decisive source lines.
    const metadata = ['host-fact', 'tool-output', 'directory'].includes(input.kind)
    const available = Math.min(bounds.maxTotalBytes - usedBytes, metadata ? Math.max(0, Math.floor(bounds.maxTotalBytes / 2) - metadataBytes) : Infinity)
    const clipped = clipSnippet(text, Math.min(bounds.maxSnippetBytes, available), bounds.maxLines)
    if (text && !clipped.content) return null
    const record = { ...input, content: clipped.content, capturedAt: now(), truncated: !!(input.truncated || clipped.truncated), status: input.truncated || clipped.truncated ? 'limited' : 'available' }
    if (input.kind === 'source') {
      const count = clipped.content === '' ? 0 : clipped.content.split(NL).length - (clipped.content.endsWith(NL) ? 1 : 0)
      record.endLine = record.startLine + Math.max(0, count - 1)
      record.currentPath = currentPath(record.path)
      record.workspaceRoot = roots[0]?.actual
    }
    record.contentSha256 = hash(clipped.content)
    record.id = prefix === 'a' ? 'a' + (++reportedSerial) : 'e' + (++serial)
    usedBytes += clipped.bytes
    if (metadata) metadataBytes += clipped.bytes
    const owned = Object.freeze(record)
    entries.set(record.id, owned); duplicates.set(fullKey, record.id)
    return owned
  }
  function annotate(result, records, limited = false) {
    return {
      ...result,
      evidence_refs: records.filter(Boolean).map(r => r.id),
      evidence_spans: records.filter(Boolean).map(r => ({ id: r.id, ...(r.path ? { path: r.path, start_line: r.startLine, end_line: r.endLine } : {}), content: r.content, truncated: r.truncated })),
      evidence_limited: limited,
      evidence_instruction: 'Cite only these host evidence_refs in dossier evidence fields, e.g. evidence: e1,e2. Each reference covers ONLY its evidence_spans content, not the entire read/search result. For exploration use capture_evidence:false; then read the decisive lines with capture_evidence:true to archive a citation. Archive limits do not shorten source content. Missing references cannot substantiate a settled outcome.',
    }
  }
  return Object.freeze({
    record(tool, args, result) {
      active()
      if (tool === 'read') {
        if (!sourcePath(result.file_path) || !positive(result.offset) || typeof result.content !== 'string') throw new Error('Invalid captured source receipt')
      } else if (tool === 'grep') {
        for (const match of result.matches || []) if (!sourcePath(match.file_path) || !positive(match.line_number) || typeof match.line !== 'string') throw new Error('Invalid captured search receipt')
      } else if (tool === 'glob') {
        if (!(result.paths || []).every(sourcePath)) throw new Error('Invalid captured listing receipt')
      } else throw new Error('Unsupported evidence tool')
      // Full query output still passes the same content/envelope screening.
      // A failed archive admission must not be confused with this withholding.
      if (detectSensitiveText(JSON.stringify(result))) {
        return annotate(tool === 'read'
          ? { file_path: result.file_path, offset: result.offset, total_lines: result.total_lines, content: '', truncated: true, withheld: true }
          : { [tool === 'grep' ? 'matches' : 'paths']: [], truncated: true, withheld: true }, [], true)
      }
      if (args.capture_evidence === false) return annotate(result, [])
      if (tool === 'read') {
        const receipt = add({ kind: 'source', origin: 'review-tool', tool, path: result.file_path, startLine: result.offset, totalLines: result.total_lines, content: result.content, truncated: !!result.truncated })
        return annotate(result, [receipt], !receipt || receipt.content !== result.content)
      }
      if (tool === 'grep') {
        const matches = [], receipts = []
        for (const match of result.matches || []) {
          const receipt = add({ kind: 'source', origin: 'review-tool', tool, path: match.file_path, startLine: match.line_number, content: match.line })
          matches.push({ ...match, ...(receipt ? { evidence_ref: receipt.id } : {}) }); receipts.push(receipt)
        }
        if (!result.matches?.length) {
          const query = { pattern: args.pattern, ...(args.path ? { path: args.path } : {}), ...(args.include ? { include: args.include } : {}) }
          receipts.push(add({ kind: 'search', origin: 'review-tool', tool, content: JSON.stringify({ query, matches: [], scope: 'captured-source-only', truncated: !!result.truncated }), truncated: !!result.truncated }))
        }
        return annotate({ ...result, matches }, receipts, receipts.some(r => !r || r.truncated))
      }
      if (tool === 'glob') {
        const receipt = add({ kind: 'listing', origin: 'review-tool', tool, content: JSON.stringify({ pattern: args.pattern, paths: result.paths, scope: 'captured-source-only', truncated: !!result.truncated }), truncated: !!result.truncated })
        return annotate(result, [receipt], !receipt || receipt.truncated)
      }
      throw new Error('Unsupported evidence tool')
    },
    /** Only the explicitly projected fields of historical Host metadata enter.
     * No full headers, schemas, credentials, prompts or current defaults. */
    hostFact(fact) {
      active()
      if (!['model-route', 'session-policy', 'tool-declarations'].includes(fact?.topic)
        || typeof fact.content !== 'string' || !Array.isArray(fact.sourceSeqs)
        || !fact.sourceSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)) return null
      return add({ kind: 'host-fact', origin: 'session-metadata', tool: fact.topic, content: fact.content,
        temporal: 'target-reply-history', sourceSeqs: [...fact.sourceSeqs],
        ...(Number.isFinite(fact.observedAt) ? { observedAt: fact.observedAt } : {}),
      })
    },
    /** Safe, bounded output already selected for this target turn. It is a
     * historical tool observation, never an independent rerun or a raw log. */
    providedQuote(quote) {
      active()
      if (!EPHEMERAL_EVIDENCE_TOOLS.has(quote?.name) || typeof quote.text !== 'string' || !quote.text) return null
      return add({ kind: 'tool-output', origin: 'session-tool', tool: quote.name, content: quote.text,
        temporal: 'author-turn', isError: quote.isError === true, truncated: quote.truncated === true,
        ...(Number.isSafeInteger(quote.sourceSeq) ? { sourceSeqs: [quote.sourceSeq] } : {}),
        ...(Number.isFinite(quote.observedAt) ? { observedAt: quote.observedAt } : {}),
        note: '宿主记录的本轮工具输出，不是评审者独立重跑；输出内容仍需按其来源、时间和范围解释。',
      }, 'a')
    },
    directoryManifest(manifest) {
      active()
      if (!manifest || !sourcePath(manifest.path) || !Array.isArray(manifest.entries)) return null
      return add({ kind: 'directory', origin: 'snapshot-metadata', tool: 'root-entries', path: manifest.path,
        content: JSON.stringify(manifest), temporal: 'review-start', observedAt: manifest.observedAt,
        truncated: manifest.complete !== true,
      })
    },
    // Legacy callers/records keep their provenance-only representation.
    provided(text) {
      active()
      if (!text || detectSensitiveText(text)) return null
      return add({ kind: 'reported', origin: 'author-tool', tool: 'author-context', content: '', note: '作者提供的本轮工具记录，不是评审者独立重跑；原始输出未另行归档。' }, 'a')?.id || null
    },
    get(id) { active(); const record = entries.get(id); return record ? clone(record) : null },
    resolve(value) { active(); const ids = evidenceRefs(value); return ids.length && ids.every(id => entries.has(id)) ? ids.map(id => clone(entries.get(id))) : [] },
    selected(ids) { active(); return [...new Set(ids)].map(id => entries.get(id)).filter(Boolean).map(clone) },
    stats() { active(); return { records: entries.size, bytes: usedBytes, limits: { ...bounds } } },
    dispose() { entries.clear(); duplicates.clear(); usedBytes = 0; metadataBytes = 0; disposed = true },
  })
}

/** Decorate already-captured data, never reopen a live filesystem path. */
export function evidenceCorpus(corpus, ledger) {
  return Object.freeze({
    read: args => ledger.record('read', args, corpus.read(args)),
    grep: args => ledger.record('grep', args, corpus.grep(args)),
    glob: args => ledger.record('glob', args, corpus.glob(args)),
    publicInfo: () => corpus.publicInfo(),
    directoryManifests: () => corpus.directoryManifests?.() || [],
    rewritePaths: text => corpus.rewritePaths(text),
    dispose: () => corpus.dispose(),
  })
}

/** Ground the suspect identity ledger, then recount on the host. */
export function groundReview(parsed, ledger) {
  if (!Array.isArray(parsed.outcomes)) return { ...parsed, evidenceRecords: [] }
  const issues = [...(parsed.ledgerIssues || [])], used = new Set()
  const outcomes = parsed.outcomes.map(row => {
    if (row.outcome === 'unchecked') return { ...row, evidence: '', evidenceRefs: [] }
    const receipts = ledger.resolve(row.evidence)
    if (!receipts.length) {
      issues.push('证据引用缺失或不属于本次读取：' + row.id)
      return { id: row.id, outcome: 'unchecked', evidence: '', evidenceRefs: [] }
    }
    const ids = receipts.map(r => r.id); ids.forEach(id => used.add(id))
    if (receipts.some(r => r.truncated)) issues.push('部分引用片段受范围或大小限制')
    if (receipts.some(r => r.origin === 'author-tool')) issues.push('部分依据来自作者工具记录，未独立重跑且未另存原文')
    const evidence = receipts.map(r => r.id + ' · ' + (r.kind === 'source' ? r.path + ':' + r.startLine + '-' + r.endLine
      : r.kind === 'host-fact' ? '历史宿主事实 · ' + r.tool
        : r.kind === 'tool-output' ? '历史工具输出 · ' + r.tool
          : r.kind === 'directory' ? '评审时目录清单 · ' + r.path
            : r.origin === 'author-tool' ? '作者工具记录' : r.kind === 'search' ? '受限搜索结果' : '受限文件清单')).join('；')
    return { ...row, evidence, evidenceRefs: ids }
  })
  const byId = new Map(outcomes.map(row => [row.id, row]))
  const annotations = parsed.annotations.filter(a => byId.get(a.suspect)?.outcome === 'defect').map(a => ({ ...a, evidence: byId.get(a.suspect).evidence, evidenceRefs: byId.get(a.suspect).evidenceRefs }))
  const stats = { checked: outcomes.length, confirmed: outcomes.filter(r => r.outcome === 'defect').length, excluded: outcomes.filter(r => r.outcome === 'cleared').length, unchecked: outcomes.filter(r => r.outcome === 'unchecked').length }
  const verdict = annotations.some(a => a.severity === 'blocker') ? 'changes' : 'pass'
  return { ...parsed, outcomes, annotations, stats, verdict, verdictAdjusted: parsed.verdictAdjusted || verdict !== parsed.verdict, ledgerIssues: [...new Set(issues)], evidenceRecords: ledger.selected(used), ignoredAnnotations: (parsed.ignoredAnnotations || 0) + parsed.annotations.length - annotations.length }
}
