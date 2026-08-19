// Harness driver: load test/harness.html, run window.__run(), print the
// assertion table, and screenshot before/after.
const puppeteer = require(process.env.HOME + '/.dsh/profiles/web/node_modules/puppeteer-core')

;(async () => {
  const browser = await puppeteer.launch({ executablePath: '/home/hgk/.local/bin/dsh-chrome', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 1200 })
  page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)))
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)))
  await page.goto('file:///home/hgk/123/test/harness.html')
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  const result = await page.evaluate(() => window.__run())
  console.log(JSON.stringify(result, null, 1))
  await page.screenshot({ path: '/home/hgk/123/test/harness-1.png', fullPage: true })
  await browser.close()

  const EXPECT = {
    't2_marks = 2 (turn2 marked)': result.t2_marks === 2,
    't1_marks_after_t2 = 0 (no leak)': result.t1_marks_after_t2 === 0,
    'dupMarkInTurn2 (duplicate lands in turn2)': result.dupMarkInTurn2 === true,
    'dupMarkInTurn1 = false (duplicate NOT in turn1)': result.dupMarkInTurn1 === false,
    'badgePairing all true': Array.isArray(result.badgePairing) && result.badgePairing.length === 2 && result.badgePairing.every(Boolean),
    't2_marks_after_t1 = 2 (turn2 survives turn1 marking)': result.t2_marks_after_t1 === 2,
    't1_marks = 1': result.t1_marks === 1,
    'panelBeforeTail': result.panelBeforeTail === true,
    't2_marks_after_clear = 0': result.t2_marks_after_clear === 0,
    't1_marks_after_clear = 1 (turn1 survives clear)': result.t1_marks_after_clear === 1,
    't2_badges_after_clear = 0 (no stray badge)': result.t2_badges_after_clear === 0,
    'strayBadgeText null': result.strayBadgeText === null,
    't2_marks_remark = 2 (single set after re-review)': result.t2_marks_remark === 2,
    't2_badges_remark = 2': result.t2_badges_remark === 2,
  }
  let pass = true
  for (const [k, v] of Object.entries(EXPECT)) { console.log((v ? 'PASS' : 'FAIL') + '  ' + k); if (!v) pass = false }
  console.log(pass ? 'ALL GREEN' : 'HAS FAILURES')
  process.exit(pass ? 0 : 1)
})().catch((e) => { console.error('FAIL', e); process.exit(1) })
