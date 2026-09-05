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
 * 依赖与环境（均可移植，不含本机路径）：
 *   - playwright：默认 require('playwright')；找不到时设 CIEL_AB_PLAYWRIGHT
 *     指向其模块入口（如某 checkout 的 node_modules/playwright）。
 *   - 浏览器：默认 playwright 的 channel:'chrome'；或设 CIEL_AB_CHROME 指向
 *     可执行文件。
 *   - 语料里的 {REPO} 占位符替换为本仓库根目录（scripts/.. 自动推导）——
 *     被评审的文件随仓库走，任何机器克隆后即可跑。
 *   - 评审条目源：$DSH_HOME（缺省 ~/.dsh）/dsh-advisor/reviews/<sessionId>.jsonl。
 */
if (process.env.CIEL_ALLOW_PAID_TESTS !== '1') {
  console.error('Paid A/B testing is disabled. Set CIEL_ALLOW_PAID_TESTS=1 explicitly; prefer keyless verify-runtime.mjs first.')
  process.exit(2)
}
const MODEL = process.env.CIEL_AB_MODEL
const CRITIC_MODEL = process.env.CIEL_AB_CRITIC_MODEL || MODEL
const CRITIC_PROVIDER = process.env.CIEL_AB_CRITIC_PROVIDER
if (!MODEL || !CRITIC_PROVIDER) {
  console.error('Set CIEL_AB_MODEL and CIEL_AB_CRITIC_PROVIDER explicitly; no implicit Google route.')
  process.exit(2)
}
let chromium
try {
  chromium = (process.env.CIEL_AB_PLAYWRIGHT
    ? require(process.env.CIEL_AB_PLAYWRIGHT)
    : require('playwright')).chromium
} catch {
  console.error('playwright not found: run `npm i playwright`, or set CIEL_AB_PLAYWRIGHT to its module path')
  process.exit(1)
}
const { readFileSync, writeFileSync } = require('fs')
const { join, dirname } = require('path')
const { reviewFileName, assertReviewIdentity, matchingReview } = require('./ab-safety.cjs')

const BASE = process.argv[2]
const OUT = process.argv[3] || '/tmp/ab'
const FILTER = process.argv[4] ? process.argv[4].split(',') : null
const REPO_ROOT = dirname(__dirname)
const CORPUS = JSON.parse(readFileSync(join(__dirname, 'ab-corpus.json'), 'utf8'))
  .map((s) => ({ ...s, prompt: s.prompt.replaceAll('{REPO}', REPO_ROOT) }))
const REVIEWS_DIR = join(process.env.DSH_HOME || join(process.env.HOME, '.dsh'), 'dsh-advisor', 'reviews')
const CHROME = process.env.CIEL_AB_CHROME || undefined

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function reviewFile(sessionId) { return join(REVIEWS_DIR, reviewFileName(sessionId)) }
function lastEntry(path, messageId, since) { return matchingReview(readFileSync(path, 'utf8'), messageId, since) }

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
  // 0.1.3 新版选择器：chip → 「Model <当前>」行 → 模型列表（provider 分组，
  // 可能需展开）→ 精确点 gemini-3.8-flash。任一环节失败打印可见文本排查。
  const expandRow = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*')).filter((e) => {
      const t = (e.textContent || '').trim()
      return /^Model\b/.test(t) && t.length < 30
    })
    const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const el = vis[vis.length - 1]
    if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40) }
    return null
  })
  await sleep(800)
  const picked = await page.evaluate((model) => {
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const els = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && normalize(e.textContent || '') === normalize(model))
    for (const e of els) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { e.click(); return (e.textContent || '').trim() } }
    return null
  }, MODEL)
  if (picked === null) throw new Error('Requested author model was not selected; no prompt sent (row: ' + expandRow + ')')
  await sleep(600)
  const confirmed = await page.evaluate((model) => {
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /Select model/i.test(b.getAttribute('aria-label') || ''))
    return !!btn && normalize(btn.textContent || '').includes(normalize(model))
  }, MODEL)
  if (!confirmed) throw new Error('Cannot confirm author route after selection; no prompt sent')
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
  const baseCount = await page.evaluate(() => document.querySelectorAll('.dsr-btn[data-ciel-message-id]').length)
  let replyReady = false
  for (let i = 0; i < 300; i += 1) {
    await sleep(1000)
    const n = await page.evaluate(() => document.querySelectorAll('.dsr-btn[data-ciel-message-id]').length)
    if (n > baseCount) { replyReady = true; break }
  }
  if (!replyReady) return { id: scenario.id, error: 'reply never completed' }
  await sleep(800)
  const draft = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.dsr-btn[data-ciel-message-id]'))
    let el = btns[btns.length - 1]
    // 沿祖先链找第一个「像消息正文容器」的节点（文本足够长且不含子按钮群）。
    while (el && (el.textContent || '').trim().length < 120) el = el.parentElement
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 600)
  })

  // Correlate the exact session/message and verify the critic route before
  // spending on review. Older clients without these attrs must fail closed.
  const identity = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.dsr-btn[data-ciel-message-id]')).at(-1)
    return btn ? { sessionId: btn.dataset.cielSessionId, messageId: btn.dataset.cielMessageId, provider: btn.dataset.cielCriticProvider, model: btn.dataset.cielCriticModel } : null
  })
  assertReviewIdentity(identity, CRITIC_PROVIDER, CRITIC_MODEL)
  const file = reviewFile(identity.sessionId)
  const r0 = Date.now()
  await page.evaluate((messageId) => {
    const btn = Array.from(document.querySelectorAll('.dsr-btn[data-ciel-message-id]')).find((b) => b.dataset.cielMessageId === messageId)
    if (!btn || btn.disabled) throw new Error('Exact review button is unavailable')
    btn.click()
  }, identity.messageId)
  let done = false
  const labels = []
  for (let i = 0; i < 600; i += 1) {
    await sleep(400)
    const label = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.dsr-btn[data-ciel-message-id]'))
      return btns.length ? btns[btns.length - 1].textContent : ''
    })
    if (label && labels[labels.length - 1] !== label) labels.push(label)
    if (label && !/评审中|批注评审/.test(label)) { done = true; break }
  }
  const reviewMs = Date.now() - r0
  if (!done) return { id: scenario.id, error: 'review never finished', reviewMs }

  // Never infer ownership from modification time or another session's work.
  await sleep(500)
  const entry = lastEntry(file, identity.messageId, r0)
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
  const complete = !['error', 'cancelled', 'incomplete', 'completed-unparsed'].includes(entry.status)
  const pass = complete && verdictOk && blockersOk && annotationsOk && evidenceOk
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
  const browser = await chromium.launch(CHROME
    ? { executablePath: CHROME, args: ['--no-sandbox'] }
    : { channel: 'chrome', args: ['--no-sandbox'] })
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
