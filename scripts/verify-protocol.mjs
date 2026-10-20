#!/usr/bin/env node
// Current built DSH Registry + Gateway, production Ciel service and transport.
// In-memory carrier; no HTTP server, network access, keys or model adapter.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'

import { writeRecord } from '../plugin/record-store.js'

const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to the current built DSH checkout')
const requireTarget = createRequire(join(checkout, 'packages/core/tools/package.json'))
const shared = {
  '@deepseek-ai/cordis': requireTarget.resolve('@deepseek-ai/cordis'),
  '@deepseek-ai/schemastery': requireTarget.resolve('@deepseek-ai/schemastery'),
  '@deepseek-ai/dsh-typert-protocol': join(checkout, 'packages/typert/protocol/lib/index.js'),
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  return shared[specifier] ? { url: pathToFileURL(shared[specifier]).href, shortCircuit: true } : next(specifier, context)
} })
const { ADVISOR_REMOTE, ADVISOR_METHODS } = await import('../plugin/advisor-protocol.js')
const { Config, apply } = await import('../plugin/index.js')
const { Context } = await import(pathToFileURL(shared['@deepseek-ai/cordis']).href)
const { default: Registry } = await import(pathToFileURL(join(checkout, 'packages/typert/registry/lib/index.js')).href)
const { default: Gateway } = await import(pathToFileURL(join(checkout, 'packages/api/gateway/lib/index.js')).href)
const home = await mkdtemp('/tmp/ciel-protocol-dsh-')
const beforeHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const ctx = new Context(), owned = [], outcomes = []
const invoke = (method, request) => ctx.typertGateway.invoke({ namespace: 'cielAdvisor', method, args: { request } })
try {
  owned.push(ctx.plugin(Registry)); await owned.at(-1).await()
  if (existsSync(join(checkout, 'packages/api/remote-access/lib/index.js'))) {
    const { default: RemoteAccess } = await import(pathToFileURL(join(checkout, 'packages/api/remote-access/lib/index.js')).href)
    owned.push(ctx.plugin(RemoteAccess)); await owned.at(-1).await()
  }
  owned.push(ctx.plugin(Gateway)); await owned.at(-1).await()
  owned.push(ctx.plugin({name:'ciel-protocol-under-test',apply:c=>apply(c,Config({}))}));await owned.at(-1).await()
  assert.deepEqual(ADVISOR_METHODS,['readAdvice','callModelUsage'])
  assert.equal(ADVISOR_REMOTE.descriptors.length,2)
  assert.deepEqual((await invoke('callModelUsage',{sessionId:'s',kind:'tool',id:'missing'})),{modelUsage:null})
  assert.equal((await invoke('readAdvice',{sessionId:'s',callId:'missing'})).ok,false)
  await assert.rejects(invoke('readAdvice',{sessionId:'s',callId:{invalid:true}}),{code:'gateway/input-invalid'})
  const advice={schemaVersion:1,sessionId:'s',callId:'tool:c',kind:'tool',text:'Synthetic advice',items:[],issues:[],createdAt:1}
  await writeRecord('advice','s','tool:c',advice)
  const result=await invoke('readAdvice',{sessionId:'s',callId:'tool:c'})
  assert.equal(result.ok,true);assert.deepEqual(result.advice,advice)
  await assert.rejects(invoke('start',{sessionId:'s',messageId:'m'}))
  console.log(JSON.stringify({ok:true,mode:'actual DSH Registry/Gateway',methods:ADVISOR_METHODS,networkRequests:0,modelCalls:0}))
} finally {
  for(const scope of owned.reverse())await scope.dispose()
  if(beforeHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=beforeHome
  await rm(home,{recursive:true,force:true})
  hooks.deregister()
}
