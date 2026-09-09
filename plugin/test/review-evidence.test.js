// Offline unit coverage for review-evidence.js: the host-owned evidence
// ledger, its corpus decorator, and the grounding pass. All fixtures live in a
// temp directory; no test reads the real DSH_HOME or a live filesystem path
// outside that temp root.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EVIDENCE_LIMITS,
  createEvidenceLedger,
  evidenceCorpus,
  evidenceRefs,
  groundReview,
} from '../review-evidence.js'

const workspace = await mkdtemp(join(tmpdir(), 'ciel-evidence-tests-'))
after(() => rm(workspace, { recursive: true, force: true }))

const sha = (text) => createHash('sha256').update(text).digest('hex')
const roots = () => [{ virtual: '/project', actual: workspace }]
const readResult = (overrides = {}) => ({
  file_path: '/project/a.txt',
  offset: 1,
  total_lines: 3,
  content: 'alpha\nbeta\ngamma\n',
  truncated: false,
  ...overrides,
})

test('read receipts keep the real captured bytes, line span, hash, and root mapping', async () => {
  const file = join(workspace, 'real.txt')
  const bytes = 'alpha\nbeta\ngamma\n'
  await writeFile(file, bytes, 'utf8')
  const captured = await readFile(file, 'utf8')
  const ledger = createEvidenceLedger({ roots: roots(), now: () => 111 })
  const annotated = ledger.record('read', { file_path: '/project/real.txt' }, {
    file_path: '/project/real.txt', offset: 1, total_lines: 3, content: captured, truncated: false,
  })
  assert.deepEqual(annotated.evidence_refs, ['e1'])
  assert.equal(annotated.content, bytes)
  assert.match(annotated.evidence_instruction, /host evidence_refs/)
  const record = ledger.get('e1')
  assert.equal(record.content, bytes)
  assert.equal(record.contentSha256, sha(bytes))
  assert.equal(record.startLine, 1)
  assert.equal(record.endLine, 3)
  assert.equal(record.totalLines, 3)
  assert.equal(record.currentPath, file)
  assert.equal(record.capturedAt, 111)
  assert.equal(record.status, 'available')
  assert.equal(record.truncated, false)
  // get() returns a detached clone, never the frozen internal entry.
  assert.notEqual(record, ledger.get('e1'))
  ledger.dispose()
})

test('line spans count trailing newlines and honor a later offset', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, { file_path: '/project/a.txt', offset: 10, total_lines: 20, content: 'x\ny\n', truncated: false })
  assert.equal(ledger.get('e1').endLine, 11)
  ledger.record('read', {}, { file_path: '/project/b.txt', offset: 5, total_lines: 5, content: 'only line', truncated: false })
  assert.equal(ledger.get('e2').endLine, 5)
  ledger.dispose()
})

test('UTF-8 capture counts real bytes and never splits a code point', () => {
  const ledger = createEvidenceLedger({ roots: roots(), limits: { maxSnippetBytes: 4 } })
  const annotated = ledger.record('read', {}, {
    file_path: '/project/u.txt', offset: 1, total_lines: 1, content: 'a你b', truncated: false,
  })
  assert.equal(annotated.content, 'a你')
  assert.equal(annotated.truncated, true)
  const record = ledger.get('e1')
  assert.equal(record.content, 'a你')
  assert.equal(record.contentSha256, sha('a你'))
  assert.equal(record.status, 'limited')
  assert.equal(ledger.stats().bytes, 4)
  ledger.dispose()
})

test('the byte bound clips, identical reads dedup, and the cumulative budget is enforced', () => {
  const ledger = createEvidenceLedger({ roots: roots(), limits: { maxSnippetBytes: 8, maxTotalBytes: 10 } })
  const first = ledger.record('read', {}, {
    file_path: '/project/long.txt', offset: 1, total_lines: 1, content: 'abcdefghij', truncated: false,
  })
  assert.equal(first.content, 'abcdefgh')
  assert.equal(ledger.stats().bytes, 8)
  const again = ledger.record('read', {}, {
    file_path: '/project/long.txt', offset: 1, total_lines: 1, content: 'abcdefghij', truncated: false,
  })
  assert.deepEqual(again.evidence_refs, ['e1'], 'a repeated read reuses its receipt')
  assert.equal(ledger.stats().records, 1)
  assert.equal(ledger.stats().bytes, 8)
  const second = ledger.record('read', {}, {
    file_path: '/project/other.txt', offset: 1, total_lines: 1, content: 'XY', truncated: false,
  })
  assert.equal(second.content, 'XY')
  assert.equal(ledger.stats().bytes, 10)
  const exhausted = ledger.record('read', {}, {
    file_path: '/project/third.txt', offset: 1, total_lines: 1, content: 'Z', truncated: false,
  })
  assert.deepEqual(exhausted.evidence_refs, [], 'no receipt once the total budget is spent')
  assert.equal(exhausted.content, '')
  assert.equal(exhausted.truncated, true)
  assert.equal(ledger.stats().records, 2)
  assert.equal(ledger.stats().bytes, 10)
  ledger.dispose()
})

test('the per-record line bound truncates and marks the receipt limited', () => {
  const ledger = createEvidenceLedger({ roots: roots(), limits: { maxLines: 2 } })
  const annotated = ledger.record('read', {}, {
    file_path: '/project/many.txt', offset: 1, total_lines: 9, content: 'l1\nl2\nl3\nl4\n', truncated: false,
  })
  assert.equal(annotated.content, 'l1\nl2\n')
  assert.equal(annotated.truncated, true)
  assert.equal(ledger.get('e1').endLine, 2)
  assert.equal(ledger.get('e1').status, 'limited')
  ledger.dispose()
})

test('an input-truncated receipt is stored as limited', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, { file_path: '/project/a.txt', offset: 1, total_lines: 999, content: 'x\n', truncated: true })
  const record = ledger.get('e1')
  assert.equal(record.status, 'limited')
  assert.equal(record.truncated, true)
  ledger.dispose()
})

test('sensitive content is withheld before storage, including in the receipt envelope', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  const secret = ledger.record('read', {}, {
    file_path: '/project/secret.txt', offset: 1, total_lines: 1, content: 'API_KEY=FAKE_CREDENTIAL_MARKER_ONLY', truncated: false,
  })
  assert.deepEqual(secret.evidence_refs, [])
  assert.equal(secret.content, '')
  assert.equal(ledger.get('e1'), null)
  const privateKey = ledger.record('read', {}, {
    file_path: '/project/key.txt', offset: 1, total_lines: 1, content: '-----BEGIN PRIVATE KEY-----\nFAKE\n', truncated: false,
  })
  assert.deepEqual(privateKey.evidence_refs, [])
  assert.equal(ledger.stats().records, 0)
  // The sensitive check also covers the whole JSON envelope, not just content.
  const envelope = ledger.record('read', {}, {
    file_path: '/project/sk-proj-abcdefghijklmnop', offset: 1, total_lines: 1, content: 'safe', truncated: false,
  })
  assert.deepEqual(envelope.evidence_refs, [])
  assert.equal(ledger.stats().records, 0)
  ledger.dispose()
})

test('author records keep only provenance, never the reported body', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  assert.equal(ledger.provided('API_KEY=FAKE_CREDENTIAL_MARKER_ONLY'), null)
  assert.equal(ledger.provided(''), null)
  const id = ledger.provided('author says the file has 3 lines')
  assert.equal(id, 'a1')
  const record = ledger.get('a1')
  assert.equal(record.kind, 'reported')
  assert.equal(record.origin, 'author-tool')
  assert.equal(record.tool, 'author-context')
  assert.equal(record.content, '')
  assert.equal(JSON.stringify(record).includes('author says'), false, 'the reported text is never archived')
  assert.equal(ledger.stats().bytes, 0)
  assert.equal(ledger.stats().records, 1)
  // Observed behavior: every provided() marker has the same dedup key (the
  // note is constant and the body is empty), so a second call reuses a1.
  assert.equal(ledger.provided('second note'), 'a1')
  assert.equal(ledger.stats().records, 1)
  ledger.dispose()
})

test('evidence references accept only exact e/a ids and dedup', () => {
  assert.deepEqual(evidenceRefs('e1,e2'), ['e1', 'e2'])
  assert.deepEqual(evidenceRefs('e1，e2、a1'), ['e1', 'e2', 'a1'])
  assert.deepEqual(evidenceRefs('e1，invented'), [])
  assert.deepEqual(evidenceRefs('  e1  a2  e1 '), ['e1', 'a2'])
  assert.deepEqual(evidenceRefs('e0'), [])
  assert.deepEqual(evidenceRefs('e1 x'), [])
  assert.deepEqual(evidenceRefs('e1- e2'), [])
  assert.deepEqual(evidenceRefs(''), [])
  assert.deepEqual(evidenceRefs(undefined), [])
})

test('resolve is all-or-nothing, so a forged or foreign id invalidates the whole citation', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, readResult())
  assert.equal(ledger.resolve('e1').length, 1)
  assert.deepEqual(ledger.resolve('e1 e99'), [])
  assert.deepEqual(ledger.resolve('e99'), [])
  const other = createEvidenceLedger({ roots: roots() })
  other.record('read', {}, readResult({ file_path: '/project/b.txt' }))
  other.record('read', {}, readResult({ file_path: '/project/c.txt' }))
  // e2 exists only in the other review, so it is not resolvable here.
  assert.deepEqual(ledger.resolve('e2'), [])
  assert.equal(other.resolve('e2').length, 1)
  ledger.dispose()
  other.dispose()
})

test('groundReview revalidates ids, recomputes stats, and keeps only defect annotations', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, readResult())
  const parsed = {
    verdict: 'pass',
    outcomes: [
      { id: 's1', outcome: 'defect', evidence: 'e1' },
      { id: 's2', outcome: 'cleared', evidence: 'e99' },
      { id: 's3', outcome: 'unchecked', evidence: 'e1' },
      { id: 's4', outcome: 'cleared', evidence: 'e1 e99' },
    ],
    annotations: [
      { suspect: 's1', severity: 'blocker', title: 'blocker', comment: 'c' },
      { suspect: 's2', severity: 'major', title: 'dropped' },
      { suspect: 's3', severity: 'nit', title: 'dropped' },
      { suspect: 's4', severity: 'minor', title: 'dropped' },
    ],
  }
  const grounded = groundReview(parsed, ledger)
  assert.deepEqual(grounded.stats, { checked: 4, confirmed: 1, excluded: 0, unchecked: 3 })
  assert.deepEqual(grounded.outcomes[0], {
    id: 's1', outcome: 'defect', evidence: 'e1 · /project/a.txt:1-3', evidenceRefs: ['e1'],
  })
  assert.deepEqual(grounded.outcomes[1], { id: 's2', outcome: 'unchecked', evidence: '', evidenceRefs: [] })
  assert.deepEqual(grounded.outcomes[2], { id: 's3', outcome: 'unchecked', evidence: '', evidenceRefs: [] })
  assert.deepEqual(grounded.outcomes[3], { id: 's4', outcome: 'unchecked', evidence: '', evidenceRefs: [] })
  assert.equal(grounded.annotations.length, 1)
  assert.equal(grounded.annotations[0].suspect, 's1')
  assert.equal(grounded.annotations[0].evidence, 'e1 · /project/a.txt:1-3')
  assert.deepEqual(grounded.annotations[0].evidenceRefs, ['e1'])
  assert.equal(grounded.ignoredAnnotations, 3)
  assert.equal(grounded.verdict, 'changes')
  assert.equal(grounded.verdictAdjusted, true)
  assert.ok(grounded.ledgerIssues.some((issue) => issue.includes('s2')))
  assert.ok(grounded.ledgerIssues.some((issue) => issue.includes('s4')))
  assert.equal(grounded.evidenceRecords.length, 1)
  assert.equal(grounded.evidenceRecords[0].id, 'e1')
  ledger.dispose()
})

test('groundReview recomputes a pass verdict and drops a cleared blocker', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, readResult())
  const grounded = groundReview({
    verdict: 'changes',
    outcomes: [{ id: 's1', outcome: 'cleared', evidence: 'e1' }],
    annotations: [{ suspect: 's1', severity: 'blocker', title: 'dropped' }],
  }, ledger)
  assert.equal(grounded.verdict, 'pass')
  assert.equal(grounded.verdictAdjusted, true)
  assert.equal(grounded.annotations.length, 0)
  assert.equal(grounded.stats.excluded, 1)
  assert.equal(grounded.ignoredAnnotations, 1)
  ledger.dispose()
})

test('groundReview without outcomes adds no fabricated records', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  const grounded = groundReview({ verdict: 'pass' }, ledger)
  assert.deepEqual(grounded.evidenceRecords, [])
  assert.equal('stats' in grounded, false)
  ledger.dispose()
})

test('groundReview flags author-only evidence and keeps its stored body empty', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.provided('author process note')
  const grounded = groundReview({
    verdict: 'pass',
    outcomes: [{ id: 's1', outcome: 'defect', evidence: 'a1' }],
    annotations: [{ suspect: 's1', severity: 'minor', title: 't' }],
  }, ledger)
  assert.equal(grounded.outcomes[0].outcome, 'defect')
  assert.deepEqual(grounded.outcomes[0].evidenceRefs, ['a1'])
  assert.match(grounded.outcomes[0].evidence, /作者工具记录/)
  assert.ok(grounded.ledgerIssues.some((issue) => issue.includes('作者工具记录')))
  assert.equal(grounded.evidenceRecords[0].content, '')
  ledger.dispose()
})

test('dispose clears receipts and makes the ledger unusable', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, readResult())
  ledger.dispose()
  for (const call of [
    () => ledger.get('e1'),
    () => ledger.resolve('e1'),
    () => ledger.selected(['e1']),
    () => ledger.stats(),
    () => ledger.record('read', {}, readResult()),
    () => ledger.provided('x'),
  ]) assert.throws(call, /Evidence ledger disposed/)
})

test('evidenceCorpus annotates captured reads and delegates corpus-only surfaces', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  const calls = []
  const corpus = {
    read: (args) => ({ file_path: args.file_path, offset: 1, total_lines: 1, content: 'hello\n', truncated: false }),
    grep: () => ({ matches: [{ file_path: '/project/a.txt', line_number: 4, line: 'needle' }], truncated: false }),
    glob: () => ({ paths: ['/project/a.txt'], truncated: false }),
    publicInfo: () => ({ fileCount: 1, byteCount: 6, roots: ['/project'], truncated: false }),
    rewritePaths: (text) => text.replace('/project', '/virtual'),
    dispose: () => { calls.push('corpus-dispose') },
  }
  const wrapped = evidenceCorpus(corpus, ledger)
  assert.equal(Object.isFrozen(wrapped), true)
  const read = wrapped.read({ file_path: '/project/a.txt' })
  assert.deepEqual(read.evidence_refs, ['e1'])
  const grep = wrapped.grep({ pattern: 'needle' })
  assert.equal(grep.matches[0].evidence_ref, 'e2')
  assert.equal(grep.matches[0].line, 'needle')
  const glob = wrapped.glob({ pattern: '*' })
  assert.deepEqual(glob.evidence_refs, ['e3'])
  assert.deepEqual(wrapped.publicInfo(), corpus.publicInfo())
  assert.equal(wrapped.rewritePaths('/project/x'), '/virtual/x')
  wrapped.dispose()
  assert.deepEqual(calls, ['corpus-dispose'])
  assert.equal(ledger.stats().records, 3, 'corpus disposal does not dispose the ledger')
  ledger.dispose()
})

test('an empty search still records a bounded, cited query receipt', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  const out = ledger.record('grep', { pattern: 'needle', path: '/project' }, { matches: [], truncated: false })
  assert.deepEqual(out.evidence_refs, ['e1'])
  const record = ledger.get('e1')
  assert.equal(record.kind, 'search')
  assert.match(record.content, /needle/)
  assert.match(record.content, /captured-source-only/)
  ledger.dispose()
})

test('invalid or unsupported receipts are rejected before storage', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  assert.throws(() => ledger.record('read', {}, { file_path: '/etc/passwd', offset: 1, total_lines: 1, content: 'x' }), /Invalid captured source receipt/)
  assert.throws(() => ledger.record('read', {}, { file_path: '/project/a.txt', offset: 0, total_lines: 1, content: 'x' }), /Invalid captured source receipt/)
  assert.throws(() => ledger.record('read', {}, { file_path: '/project/a.txt', offset: 1, total_lines: 1, content: 42 }), /Invalid captured source receipt/)
  assert.throws(() => ledger.record('grep', {}, { matches: [{ file_path: 'relative', line_number: 1, line: 'x' }] }), /Invalid captured search receipt/)
  assert.throws(() => ledger.record('glob', {}, { paths: ['/project/../x'] }), /Invalid captured listing receipt/)
  assert.throws(() => ledger.record('bash', {}, {}), /Unsupported evidence tool/)
  assert.equal(ledger.stats().records, 0)
  ledger.dispose()
})

test('limits are validated and maxRecords caps distinct receipts without breaking dedup', () => {
  assert.throws(() => createEvidenceLedger({ limits: { maxRecords: 0 } }), /Invalid evidence limit/)
  assert.throws(() => createEvidenceLedger({ limits: { maxSnippetBytes: EVIDENCE_LIMITS.maxSnippetBytes + 1 } }), /Invalid evidence limit/)
  assert.throws(() => createEvidenceLedger({ limits: { unknown: 1 } }), /Invalid evidence limit/)
  const ledger = createEvidenceLedger({ roots: roots(), limits: { maxRecords: 2 } })
  ledger.record('read', {}, { file_path: '/project/a.txt', offset: 1, total_lines: 1, content: 'a\n' })
  ledger.record('read', {}, { file_path: '/project/b.txt', offset: 1, total_lines: 1, content: 'b\n' })
  const capped = ledger.record('read', {}, { file_path: '/project/c.txt', offset: 1, total_lines: 1, content: 'c\n' })
  assert.deepEqual(capped.evidence_refs, [])
  assert.equal(ledger.stats().records, 2)
  const deduped = ledger.record('read', {}, { file_path: '/project/a.txt', offset: 1, total_lines: 1, content: 'a\n' })
  assert.deepEqual(deduped.evidence_refs, ['e1'])
  assert.equal(ledger.stats().records, 2)
  ledger.dispose()
})

test('get/resolve/selected return clones, so callers cannot mutate the archive', () => {
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, readResult())
  const copy = ledger.get('e1')
  copy.content = 'mutated'
  assert.equal(ledger.get('e1').content, 'alpha\nbeta\ngamma\n')
  assert.equal(ledger.resolve('e1')[0].content, 'alpha\nbeta\ngamma\n')
  assert.equal(ledger.selected(['e1'])[0].content, 'alpha\nbeta\ngamma\n')
  ledger.dispose()
})

test('modifying the current file after capture does not change the stored receipt', async () => {
  const file = join(workspace, 'live.txt')
  await writeFile(file, 'before\n', 'utf8')
  const ledger = createEvidenceLedger({ roots: roots() })
  ledger.record('read', {}, {
    file_path: '/project/live.txt', offset: 1, total_lines: 1, content: await readFile(file, 'utf8'), truncated: false,
  })
  await writeFile(file, 'after\n', 'utf8')
  const record = ledger.get('e1')
  assert.equal(record.content, 'before\n')
  assert.equal(record.contentSha256, sha('before\n'))
  assert.equal(record.currentPath, file)
  assert.equal(await readFile(file, 'utf8'), 'after\n')
  ledger.dispose()
})

test('currentPath is resolved once at capture and does not follow later root changes', () => {
  const mapping = [{ virtual: '/project', actual: workspace }]
  const ledger = createEvidenceLedger({ roots: mapping })
  ledger.record('read', {}, readResult())
  const captured = ledger.get('e1').currentPath
  mapping[0].actual = '/tmp/not-the-captured-root'
  assert.equal(ledger.get('e1').currentPath, captured)
  assert.equal(captured, join(workspace, 'a.txt'))
  ledger.dispose()
})

test('stats reports the active bounds', () => {
  const ledger = createEvidenceLedger({ roots: roots(), limits: { maxRecords: 2 } })
  assert.deepEqual(ledger.stats().limits, { ...EVIDENCE_LIMITS, maxRecords: 2 })
  ledger.dispose()
})
