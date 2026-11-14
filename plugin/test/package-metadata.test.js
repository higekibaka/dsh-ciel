import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const locale = (name) => JSON.parse(readFileSync(new URL('../locale/' + name, import.meta.url), 'utf8'))

const SHARED = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol']

/** Sentence case: one leading capital, every later word free of a capital. */
const SENTENCE_CASE = /^[A-Z][^ ]*(?: [^A-Z ].*)*$/

test('both shipped locales describe the plugin through meta.title and meta.description', () => {
  for (const [name, title, description] of [
    ['en.json', SENTENCE_CASE, /\S/],
    ['zh.json', /[\u4e00-\u9fff]/, /[\u4e00-\u9fff]/],
  ]) {
    const parsed = locale(name)
    assert.deepEqual(Object.keys(parsed), ['meta'], name + ' carries only the meta block')
    assert.deepEqual(Object.keys(parsed.meta).sort(), ['description', 'title'], name + ' carries exactly a title and a description')
    assert.equal(typeof parsed.meta.title, 'string')
    assert.equal(typeof parsed.meta.description, 'string')
    assert.ok(parsed.meta.title.trim().length > 0 && parsed.meta.title.length <= 64, name + ' title is a short label')
    assert.ok(parsed.meta.description.trim().length > 0 && parsed.meta.description.length <= 400, name + ' description stays a summary')
    assert.match(parsed.meta.title, title, name + ' title follows the plugin manager convention')
    assert.match(parsed.meta.description, description, name + ' description is written in that language')
    assert.equal(parsed.meta.detail, undefined, name + ' must not invent the unsupported meta.detail field')
  }
})

test('the English title stays sentence case and the descriptions name the advisor role', () => {
  const en = locale('en.json').meta
  assert.notEqual(en.title, en.title.toUpperCase())
  assert.match(en.description, /advisor/i)
  assert.match(en.description, /Decision/i, 'the optional Gemini Decision check is part of the positioning')
  assert.match(locale('zh.json').meta.description, /顾问/)
})

test('the manifest exports and ships the runtime and both locale files by exact path', () => {
  assert.equal(manifest.exports['./runtime'], './runtime.js')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  for (const file of ['runtime.js', 'locale/en.json', 'locale/zh.json']) {
    assert.ok(manifest.files.includes(file), 'plugin/package.json must ship ' + file)
    statSync(new URL('../' + file, import.meta.url))
  }
  assert.equal(manifest.files.includes('locale'), false, 'a bare directory name does not satisfy the exact-path check')
  assert.equal(manifest.files.includes('runtime'), false)
  assert.ok(manifest.files.every((file) => statSync(new URL('../' + file, import.meta.url))))
})

test('the plugin declares no runtime dependency and treats both shared packages as optional peers', () => {
  assert.equal(manifest.dependencies, undefined, 'a plugin must not install its own copy of a host package')
  for (const name of SHARED) {
    assert.ok(name in manifest.peerDependencies, name + ' is a peer dependency')
    assert.equal(manifest.peerDependenciesMeta[name].optional, true, name + ' is an optional peer')
    assert.ok(name in manifest.devDependencies, name + ' stays installable for offline unit tests')
  }
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-typert-protocol'].optional, true)
})

test('the shared manifests still describe this plugin the way the package manager expects', () => {
  assert.equal(manifest.name, 'dsh-ciel')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.icon, './icon.svg')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})
