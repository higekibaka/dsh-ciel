import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from './review-ui.harness.js'

test('advisor header, Jev summary, body and model line share one card-local inset', async t => {
  const styles = []
  const document = {
    createElement: () => ({ textContent: '', remove() {} }),
    head: { appendChild(node) { styles.push(node.textContent) } }, body: {},
  }
  const rt = await createRuntime({}, { document }); t.after(() => rt.dispose())
  const css = styles.join('\n')
  assert.match(css, /\.adv-card\{--ciel-advisor-inset:14px;/)
  assert.match(css, /\.adv-head\{padding:9px var\(--ciel-advisor-inset\);/)
  assert.match(css, /\.adv-card \.adv-head\[data-ciel-summary-head\]\{padding-inline:var\(--ciel-advisor-inset\)\}/)
  assert.match(css, /\.adv-card>\.ciel-model-usage,\.adv-card>\[data-ciel-advisor-jev-summary\]\{padding:6px var\(--ciel-advisor-inset\)\}/)
  assert.match(css, /\.adv-card>\[data-ciel-advisor-jev-summary\]\{margin:0;/)
  assert.match(css, /\.adv-body\{padding:4px var\(--ciel-advisor-inset\) 12px\}/)
})
