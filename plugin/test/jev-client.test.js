// Shared Jev connection and response validation retained after review removal.
import { Config } from '../index.js'
import { resolvedConfig } from './config-fixture.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jevConnection, JEV_ENDPOINT } from '../jev-config.js'
import { JEV_MODEL, parseJevResponse, checkJevBatch } from '../jev-client.js'

test('Jev connection defaults, precedence and environment credential scope are explicit', () => {
  const defaults = resolvedConfig({})
  assert.equal(defaults.jevEndpoint, JEV_ENDPOINT)
  assert.equal(defaults.jevModel, JEV_MODEL)
  assert.equal(defaults.jevApiKey, undefined)
  assert.equal(Config.dict.jevApiKey.meta.role, 'secret')
  assert.equal(jevConnection({}, 'env-fixture').apiKey, 'env-fixture')
  assert.equal(jevConnection({ jevApiKey: 'saved-fixture' }, 'env-fixture').apiKey, 'saved-fixture')
  assert.equal(jevConnection({ jevEndpoint: 'https://proxy.invalid/systemone' }, 'env-fixture').apiKey, '')
  for (const config of [{ jevEndpoint: 'http://proxy.invalid' }, { jevEndpoint: 'https://user:password@proxy.invalid/' }, { jevModel: 'bad model' }, { jevApiKey: 'key with spaces' }]) {
    assert.throws(() => resolvedConfig(config))
  }
})

const body=()=>({model:JEV_MODEL,answers:{a1:{type:'choice',choice:'supports',confidence:0.8,probabilities:{supports:0.8,contradicts:0.1,insufficient:0.1}}},usage:{input_tokens:20,output_tokens:4}})
const prepared={request:{model:JEV_MODEL,state:{items:{a1:{advice:'Synthetic advice'}}},questions:{a1:{type:'choice'}}},checks:[{id:'a1',status:'pending'}]}
test('untrusted Jev distributions model and usage cannot enter stored reports',()=>{
 assert.equal(parseJevResponse(body(),['a1']).answers.a1.relation,'supports')
 for(const mutate of [b=>{b.answers.a1.choice='true'},b=>{b.answers.a1.probabilities.supports=0},b=>{b.answers.a1.confidence=2},b=>{b.model='unsafe model'},b=>{b.usage.input_tokens=-1},b=>{b.answers.extra=b.answers.a1}]){
  const b=body();mutate(b);assert.throws(()=>parseJevResponse(b,['a1']),/unavailable/)
 }
})
test('Jev transport rejects invalid connection and bounds oversized or hanging bodies without retry',async()=>{
 for(const options of [{endpoint:'http://invalid.test'},{endpoint:'https://u:p@invalid.test/'},{endpoint:'https://invalid.test/?key=x'},{model:'invalid model'},{apiKey:'invalid key'}]){
  let calls=0;const result=await checkJevBatch({prepared,enabled:true,apiKey:'fixture',...options,fetchImpl:async()=>{calls++;return Response.json(body())}})
  assert.equal(result.reason,'invalid-config');assert.equal(calls,0)
 }
 for(const [reason,fetchImpl] of [['invalid-response',async()=>new Response('x'.repeat(70*1024))],['timeout',async()=>new Response(new ReadableStream({start(){}}))],['http-error',async()=>new Response('PRIVATE_BODY',{status:503})]]){
  let calls=0;const result=await checkJevBatch({prepared,enabled:true,apiKey:'fixture',timeoutMs:10,fetchImpl:async(...args)=>{calls++;return fetchImpl(...args)}})
  assert.equal(result.reason,reason);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY|fixture/)
 }
})
