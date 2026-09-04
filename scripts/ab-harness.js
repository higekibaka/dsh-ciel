#!/usr/bin/env node
/**
 * A/B 评估台（0.13.0 验收：确认率 / 误报率 / 工具误用率 / 耗时）。
 *
 * 对 ab-corpus.json 的每个场景：开新会话 → 发 prompt → 等回复 → 触发批注
 * 评审 → 等终态 → 读取该会话 sidecar 评审条目，汇总指标写 JSON + Markdown。
 * 两批之间切换 critic 路由（settings.yaml 的 ciel.criticProvider/criticModel
 * + 重启实例）即得 A/B 对照。
 *
 * 用法：
 *   node scripts/ab-harness.js <实例URL带token> <输出前缀> [场景id逗号过滤]
 * 依赖：playwright（harness checkout 的依赖树）、实例侧 dsh-ciel 为最新代码。
 * 评审条目源：$DSH_HOME/dsh-advisor/reviews/<sessionId>.jsonl（按 mtime 归属）。
 */
const { chromium } = require('/home/hgk/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright')
const { readFileSync, writeFileSync, readdirSync, statSync } = require('fs')
const { join } = require('path')

const BASE = process.argv[2]
const OUT = process.argv[3] || '/tmp/ab'
const FILTER = process.argv[4] ? process.argv[4].split(',') : null
const CORPUS = JSON.parse(readFileSync(join(__dirname, 'ab-corpus.json'), 'utf8'))
const REVIEWS_DIR = join(process.env.HOME, '.dsh', 'dsh-advisor', 'reviews')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function newestReviewFile(since) {
  let best = null
  for (const name of readdirSync(REVIEWS_DIR)) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(REVIEWS_DIR, name)
    const m = statSync(path).mtimeMs
    if (m >= since && (best === null || m > best.m)) best = { path, m }
  }
  return best && best.path
}

function lastEntry(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

async function newSession(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'New Session')
    btn.click()
  })
  await sleep(1200)
  // 会话模型显式切 gemini（与批评者路由同家族时仍有效：批评者路由独立 pin）
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /Select model/i.test(b.getAttribute('aria-label') || ''))
    if (btn) btn.click()
  })
  await sleep(600)
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && /Gemini 3/i.test(e.textContent || ''))
    for (const e of els) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { e.click(); return } }
  })
  await sleep(600)
}

async function runScenario(page, scenario) {
  const t0 = Date.now()
  await newSession(page)
  await page.evaluate(() => { document.querySelector('[contenteditable]').focus() })
  await sleep(300)
  await page.keyboard.type(scenario.prompt, { delay: 3 })
  await sleep(300)
  await page.keyboard.press('Enter')

  // 等回复完成（该消息出现评审按钮）
  const baseCount = await page.evaluate(() => document.querySelectorAll('.dsr-btn').length)
  let replyReady = false
  for (let i = 0; i < 150; i += 1) {
    await sleep(1000)
    const n = await page.evaluate(() => document.querySelectorAll('.dsr-btn').length)
    if (n > baseCount) { replyReady = true; break }
  }
  if (!replyReady) return { id: scenario.id, error: 'reply never completed' }
  await sleep(800)
  const draft = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.dsr-btn'))
    let el = btns[btns.length - 1]
    // 沿祖先链找第一个「像消息正文容器」的节点（文本足够长且不含子按钮群）。
    while (el && (el.textContent || '').trim().length < 120) el = el.parentElement
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 600)
  })

  // 触发评审并计时
  const r0 = Date.now()
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.dsr-btn'))
    btns[btns.length - 1].click()
  })
  let done = false
  const labels = []
  for (let i = 0; i < 600; i += 1) {
    await sleep(400)
    const label = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.dsr-btn'))
      return btns.length ? btns[btns.length - 1].textContent : ''
    })
    if (label && labels[labels.length - 1] !== label) labels.push(label)
    if (label && !/评审中|批注评审/.test(label)) { done = true; break }
  }
  const reviewMs = Date.now() - r0
  if (!done) return { id: scenario.id, error: 'review never finished', reviewMs }

  // sidecar 归属：本次运行窗口内最新的评审文件
  await sleep(500)
  const file = newestReviewFile(t0)
  if (!file) return { id: scenario.id, error: 'sidecar not found', reviewMs }
  const entry = lastEntry(file)
  const annotations = Array.isArray(entry.annotations) ? entry.annotations : []
  const blockers = annotations.filter((a) => a.severity === 'blocker')
  const withEvidence = annotations.filter((a) => typeof a.evidence === 'string' && a.evidence !== '')
  const exp = scenario.expect
  const verdictOk = exp.verdict === undefined || entry.verdict === exp.verdict
  const blockersOk = (exp.maxBlockers === undefined || blockers.length <= exp.maxBlockers)
    && (exp.minBlockers === undefined || blockers.length >= exp.minBlockers)
  const annotationsOk = exp.minAnnotations === undefined || annotations.length >= exp.minAnnotations
  const evidenceOk = exp.evidenceRequired !== true
    || (annotations.length > 0 && annotations.every((a) => typeof a.evidence === 'string' && a.evidence !== ''))
  const pass = verdictOk && blockersOk && annotationsOk && evidenceOk
  return {
    id: scenario.id,
    file: file.split('/').pop(),
    reviewMs,
    verdict: entry.verdict,
    status: entry.status,
    stats: entry.stats,
    explore: entry.explore,
    counts: {
      annotations: annotations.length,
      blockers: blockers.length,
      withEvidence: withEvidence.length,
      downgraded: annotations.filter((a) => a.downgraded).length,
      anchorMatched: annotations.filter((a) => a.matched).length,
    },
    expectations: { verdictOk, blockersOk, annotationsOk, evidenceOk, pass },
    annotations: annotations.map((a) => ({
      sev: a.severity, title: a.title,
      evidence: a.evidence || null,
      downgraded: a.downgraded || null,
      comment: (a.comment || '').slice(0, 200),
    })),
    draft: draft.slice(0, 300),
    labels,
  }
}

;(async () => {
  const scenarios = FILTER ? CORPUS.filter((s) => FILTER.includes(s.id)) : CORPUS
  const browser = await chromium.launch({ executablePath: '/home/hgk/.local/bin/dsh-chrome', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewportSize({ width: 1400, height: 1100 })
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 })
  await sleep(2500)
  const results = []
  for (const s of scenarios) {
    console.log('▶', s.id)
    try {
      const r = await runScenario(page, s)
      results.push(r)
      console.log('  ', r.error ? 'ERROR: ' + r.error : `${r.verdict} · ${r.counts.blockers} blocker · ${r.reviewMs}ms · ${r.expectations.pass ? 'PASS' : 'FAIL(预期不符)'}`)
    } catch (error) {
      results.push({ id: s.id, error: String(error && error.message || error) })
      console.log('   ERROR:', error && error.message)
    }
  }
  await browser.close()
  const report = { at: new Date().toISOString(), base: BASE.replace(/token=.*/, 'token=…'), results }
  writeFileSync(OUT + '.json', JSON.stringify(report, null, 1))
  // Markdown 汇总
  let md = '# A/B 批次报告 ' + report.at + '\n\n'
  md += '| 场景 | verdict | blocker | evidence | 实测调用 | 耗时 | 预期符合 |\n|---|---|---|---|---|---|---|\n'
  for (const r of results) {
    if (r.error) { md += '| ' + r.id + ' | ERROR | — | — | — | — | ' + r.error + ' |\n'; continue }
    md += '| ' + r.id + ' | ' + r.verdict + ' | ' + r.counts.blockers + ' | ' + r.counts.withEvidence + '/' + r.counts.annotations
      + ' | ' + (r.explore ? r.explore.toolCalls + '/' + r.explore.budget : '—')
      + ' | ' + Math.round(r.reviewMs / 1000) + 's | ' + (r.expectations.pass ? '✓' : '✗') + ' |\n'
  }
  md += '\n'
  for (const r of results) {
    if (r.error || !r.annotations.length) continue
    md += '\n## ' + r.id + ' 批注明细（人工判真伪用）\n'
    for (const a of r.annotations) {
      md += '- [' + a.sev + '] ' + a.title + (a.evidence ? '\n  证据：' + a.evidence : '') + (a.downgraded ? '（' + a.downgraded + '）' : '') + '\n'
    }
  }
  writeFileSync(OUT + '.md', md)
  console.log('written:', OUT + '.json', OUT + '.md')
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1) })
