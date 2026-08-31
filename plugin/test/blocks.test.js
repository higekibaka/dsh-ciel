// Block-splitter tests: host copy correctness, plus host/client parity over
// the shared fixtures — the two copies must never drift (0.12.0 ① 单点故障).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BLOCK_FIXTURES } from './blocks.fixtures.js'

const { splitMarkdownBlocks } = await import('../index.js')

function shape(blocks) {
  return blocks.map((b) => [b.type, b.text])
}

for (const fx of BLOCK_FIXTURES) {
  test(`host splitMarkdownBlocks: ${fx.name}`, () => {
    const blocks = splitMarkdownBlocks(fx.text)
    assert.deepEqual(shape(blocks), fx.expect)
    assert.deepEqual(blocks.map((b) => b.id), blocks.map((_, i) => 'b' + (i + 1)))
  })
}

// ── client copy parity ────────────────────────────────────────────────────
// Load the client factory with a stubbed ModuleLoader; the factory only
// touches window at load time, so a plain eval harness suffices.

function loadClientModule() {
  let captured = null
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const windowStub = {
    __ModuleLoader__: { load: (m) => { captured = m } },
  }
  const reactStub = new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'createElement') return () => ({})
      if (prop === 'useState') return (v) => [v, () => {}]
      if (prop === 'useEffect') return () => {}
      return () => {}
    },
  })
  const fn = new Function('window', 'document', src)
  fn.call({}, windowStub, {})
  const module = captured.factory((name) => (name === 'react' ? reactStub : {}))
  return module.exports ?? module
}

test('client and host splitters agree on every fixture', () => {
  const client = loadClientModule()
  const clientSplit = client.__test.splitMarkdownBlocks
  assert.equal(typeof clientSplit, 'function')
  for (const fx of BLOCK_FIXTURES) {
    assert.deepEqual(
      clientSplit(fx.text).map((b) => [b.id, b.type, b.text]),
      splitMarkdownBlocks(fx.text).map((b) => [b.id, b.type, b.text]),
      `fixture "${fx.name}" drifted between host and client copies`,
    )
  }
})
