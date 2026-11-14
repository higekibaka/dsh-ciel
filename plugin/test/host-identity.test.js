import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { AdvisorService } from '../advisor-service.js'
import { Config } from '../index.js'
import { describeHostModule, hostSchemastery, hostTypertProtocol, loadHostModule } from '../runtime.js'

const SCHEMASTERY = '@deepseek-ai/schemastery'
const TYPERT = '@deepseek-ai/dsh-typert-protocol'

test('the plugin config is an instance of the host Schema class', () => {
  const hostSchema = hostSchemastery()
  assert.equal(typeof hostSchema, 'function')
  assert.equal(hostSchema, hostSchemastery(), 'the host Schema class is memoised, never re-created')
  assert.ok(Config instanceof hostSchema, 'a second Schema copy would build a config this instance check rejects')
})

test('the advisor service extends the host Typert base class', () => {
  const hostProtocol = hostTypertProtocol()
  assert.equal(typeof hostProtocol.TypertRemoteService, 'function')
  assert.equal(typeof hostProtocol.Remote, 'function')
  assert.equal(Object.getPrototypeOf(AdvisorService), hostProtocol.TypertRemoteService)
})

test('schemastery loads the ES module entry the host imports, not the CommonJS build', async () => {
  const record = loadHostModule(SCHEMASTERY)
  assert.match(record.file, /lib[\\/]index\.mjs$/, 'the import condition is the instance the host already holds')
  const imported = await import(pathToFileURL(record.file).href)
  assert.equal(imported.default, record.module.default, 'require() of the ES module build shares the import() binding')
  assert.equal(record.module.default, hostSchemastery())
  assert.ok(describeHostModule(SCHEMASTERY).source.length > 0)
})

test('the Typert protocol loads one instance with the same exported classes', async () => {
  const record = loadHostModule(TYPERT)
  assert.match(record.file, /lib[\\/]index\.js$/)
  const imported = await import(pathToFileURL(record.file).href)
  for (const name of ['Remote', 'TypertRemoteService']) {
    assert.equal(imported[name], record.module[name], name + ' is one class object, not two')
  }
  assert.equal(record.module.TypertRemoteService, hostTypertProtocol().TypertRemoteService)
  assert.ok(describeHostModule(TYPERT).source.length > 0)
})
