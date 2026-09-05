import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCriticReview, reviewCoverage, splitMarkdownBlocks } from '../index.js'
const draft = '第一个文件有 3 行。\n\n第二个文件有 2 行。'
const blocks = splitMarkdownBlocks(draft)
const all = [{ id: 's1', block: 'b1' }, { id: 's2', block: 'b2' }]
const parse = (text, selected = all) => parseCriticReview(text, draft, blocks, { explore: true, selected, allSuspects: all })
const row = (id, outcome, evidence = 'read fixture.txt:1-3') => '- result: ' + id + ' | outcome: ' + outcome + ' | evidence: ' + evidence
const annotation = (id, block = 'b1') => '### [nit] 条件性提醒\nsuspect: ' + id + '\nblock: ' + block + '\nevidence: read fixture.txt:1\ncomment: should not leak'

test('withheld nit and duplicate self-accounting cannot inflate the host pool', () => {
  const text = '## dossier\n' + row('s1', 'cleared') + '\n' + row('s2', 'unchecked', 'none') + '\n## verdict: pass\nstats: 排查 2 · 证伪 0 · 排除 1 · 未查 1\n' + annotation('s2', 'b2')
  const result = parse(text, [all[0]])
  assert.deepEqual(result.stats, { checked: 2, confirmed: 0, excluded: 1, unchecked: 1 })
  assert.deepEqual(result.annotations, [])
  assert.equal(result.ignoredAnnotations, 1)
  assert.equal(reviewCoverage(result, { explore: true, suspects: { total: 2 } }).coverage, 'partial')
})

test('cleared and unchecked outcomes forbid annotations even for selected ids', () => {
  const text = '## dossier\n' + row('s1', 'cleared') + '\n' + row('s2', 'unchecked', 'none') + '\n## verdict: changes\n' + annotation('s1') + '\n' + annotation('s2', 'b2')
  const result = parse(text)
  assert.equal(result.annotations.length, 0)
  assert.equal(result.verdict, 'pass')
  assert.equal(result.ignoredAnnotations, 2)
})

test('self-invented ids and extreme model stats never expand the pool', () => {
  const text = '## dossier\n' + row('s1', 'cleared') + '\n' + row('s99', 'defect') + '\n## verdict: changes\nstats: 排查 999 · 证伪 888 · 排除 100 · 未查 11\n' + annotation('s99')
  const result = parse(text)
  assert.equal(result.stats.checked, 2)
  assert.equal(result.stats.unchecked, 1)
  assert.equal(result.annotations.length, 0)
})

test('valid defect keeps its cited annotation; the host calculates X/Y/Z', () => {
  const text = '## dossier\n' + row('s1', 'defect') + '\n' + row('s2', 'cleared') + '\n## verdict: pass\n### [blocker] 行数错误\nsuspect: s1\nblock: b1\nanchor: 第一个文件有 3 行。\ncomment: the fixture disagrees'
  const result = parse(text)
  assert.equal(result.verdict, 'changes')
  assert.equal(result.annotations[0].severity, 'blocker')
  assert.equal(result.annotations[0].evidence, 'read fixture.txt:1-3')
  assert.equal(result.annotations[0].downgraded, undefined)
  assert.deepEqual(result.stats, { checked: 2, confirmed: 1, excluded: 1, unchecked: 0 })
})

test('cross-block anchors or block identities cannot rebind an annotation', () => {
  const text = '## dossier\n' + row('s1', 'defect') + '\n' + row('s2', 'cleared') + '\n## verdict: changes\n' + annotation('s1', 'b2')
  const result = parse(text)
  assert.equal(result.annotations.length, 0)
  assert.equal(result.stats.confirmed, 0)
  assert.equal(result.stats.unchecked, 1)
})

test('duplicate outcome ids, missing rows and evidence-less results remain unchecked', () => {
  for (const rows of [row('s1', 'cleared') + '\n' + row('s1', 'defect'), row('s1', 'cleared', 'none'), '']) {
    const result = parse('## dossier\n' + rows + '\n## verdict: pass')
    assert.deepEqual(result.stats, { checked: 2, confirmed: 0, excluded: 0, unchecked: 2 })
    assert.equal(reviewCoverage(result, { explore: true, suspects: { total: 2 } }).coverage, 'partial')
  }
})

test('salvage cannot erase frozen findings or invent newly settled outcomes', () => {
  const text = '## dossier\n' + row('s1', 'unchecked', 'none') + '\n' + row('s2', 'defect') + '\n## verdict: changes\n' + annotation('s2', 'b2')
  const result = parseCriticReview(text, draft, blocks, {
    explore: true, selected: all, allSuspects: all,
    frozenRows: [{ id: 's1', outcome: 'cleared', evidence: 'read fixture.txt:1-3' }, { id: 's2', outcome: 'unchecked', evidence: '' }],
  })
  assert.deepEqual(result.stats, { checked: 2, confirmed: 0, excluded: 1, unchecked: 1 })
  assert.equal(result.annotations.length, 0)
})

test('benign result-key casing and whitespace variations normalize', () => {
  const result = parse('## dossier\n- RESULT: S1 | OUTCOME: CLEARED | EVIDENCE: read fixture.txt:1\n' + row('s2', 'cleared') + '\n## verdict: pass')
  assert.deepEqual(result.stats, { checked: 2, confirmed: 0, excluded: 2, unchecked: 0 })
  assert.deepEqual(result.ledgerIssues, [])
})
