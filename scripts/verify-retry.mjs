#!/usr/bin/env node
// Real DSH agent-loop/tool/subagent integration. Synthetic adapter only; no server.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
if (process.argv.length > 2) throw new Error('Offline verification takes no arguments; paid/live mode is not supported')
const checkout = process.env.DSH_CHECKOUT
if (!checkout) throw new Error('DSH_CHECKOUT must point to a built DSH checkout')
// One identity for the shared modules: this script and the plugin must use the
// TARGET's Cordis and Typert, never a second copy from the plugin workspace.
const targetRequire = createRequire(join(checkout, 'packages/core/tools/package.json'))
const targetCordis = targetRequire.resolve('@deepseek-ai/cordis')
const targetSchema = targetRequire.resolve('@deepseek-ai/schemastery')
const targetTypert = join(checkout, 'packages/typert/protocol/lib/index.js')
const resolutionHook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (process.env.CIEL_VERIFY_NATIVE_PEERS === '1') return nextResolve(specifier, context)
  if (specifier === '@deepseek-ai/cordis') return { url: pathToFileURL(targetCordis).href, shortCircuit: true }
  if (specifier === '@deepseek-ai/schemastery') return { url: pathToFileURL(targetSchema).href, shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-typert-protocol') return { url: pathToFileURL(targetTypert).href, shortCircuit: true }
  return nextResolve(specifier, context)
} })
const { Context } = await import(pathToFileURL(targetCordis).href)
// Load the plugin AFTER the hook so its static Typert import gets the target copy.
const ciel = await import(new URL('../plugin/index.js', import.meta.url).href)
const load = (relative) => import(pathToFileURL(join(checkout, relative, 'lib/index.js')).href)
const llmModule = await load('packages/llm/llm')
const { LlmAdapter, LlmError, resolveRetryPolicy, createUserMessage } = llmModule
const modules = await Promise.all([
  'packages/core/session', 'packages/core/system-prompt', 'packages/core/tools',
  'packages/core/agent', 'packages/session/session-projection', 'packages/core/agent-loop', 'packages/subagent/subagent',
  'packages/subagent/subagent-spawn-in-process', 'packages/interaction/commands', 'packages/llm/llm-retry',
].map(load))

const previousHome = process.env.DSH_HOME, previousFetch = globalThis.fetch
const home = await mkdtemp(join(tmpdir(), 'ciel-advisor-native-'))
process.env.DSH_HOME = home
let networkRequests = 0
const ctx = new Context()
const textResponse = text => [
  {type:'block-start',index:0,blockType:'text'},
  {type:'text-delta',index:0,text},
  {type:'block-end',index:0,block:{type:'text',text}},
  {type:'finish',reason:{kind:'stop'}},
]
class ScriptedAdapter extends LlmAdapter {
  constructor(script, delay = 1) { super(); this.script = script; this.requests = []; this.delay = delay }
  providerRetryPolicy() { return resolveRetryPolicy({mode:'normal',maxRetries:2,retryableCodes:['TRANSPORT'],backoff:{initialDelayMs:this.delay,maxDelayMs:this.delay,jitterRatio:0}}, 'Ciel retry fixture') }
  async resolveModel(provider,id) { return {provider,id,name:id} }
  async *stream(options) {
    this.requests.push({tools:(options.tools||[]).map(tool=>tool.name)})
    const text = this.script.shift()
    if (typeof text?.partial === 'string' && text.failure) {
      yield {type:'block-start',index:0,blockType:'text'}
      yield {type:'text-delta',index:0,text:text.partial}
      text.onFailure?.()
      throw text.failure
    }
    if (text instanceof Error) throw text
    assert.equal(typeof text, 'string', 'unexpected extra model-generation request')
    for (const frame of textResponse(text)) { options.signal.throwIfAborted(); yield frame }
  }
}
const answer = '## [high] Inspect ownership\nframing: Keep one owner.\npitfalls: Duplicate writers race.\nverification_target: Verify cancellation drains the child.'
const adapter = new ScriptedAdapter(['Synthetic parent response.',{partial:'DISCARDED_PARTIAL_OUTPUT',failure:new LlmError('fetch failed', 'TRANSPORT')},answer])
try {
  globalThis.fetch = async () => { networkRequests++; throw new Error('Network forbidden in offline verification') }
  const workingDirs = new WeakMap()
  ctx.provide('workingDirectory', {
    get: session => workingDirs.get(session) ?? session?.header?.cwd ?? home,
    current: agent => workingDirs.get(agent.session) ?? agent.session?.header?.cwd ?? home,
    ensure: async (agent, signal) => { signal?.throwIfAborted(); return workingDirs.get(agent.session) ?? agent.session?.header?.cwd ?? home },
    set: async (agent, targetPath, signal) => { signal?.throwIfAborted(); workingDirs.set(agent.session, targetPath); return targetPath },
    resolve: async (_agent, targetPath) => targetPath,
  })
  await ctx.plugin(llmModule.default||llmModule).await()
  for (const mod of modules) await ctx.plugin(mod.default||mod,mod.name==='agent-loop'?{agents:[]}:{}).await()
  const registration = ctx.get('llm').registerAdapter(['fixture'],adapter)
  const plugin=ctx.plugin(ciel,{...ciel.configValues(ciel.Config({})),provider:'fixture',model:'fixed',guidanceEnabled:false,planReminderEnabled:false,requireExploration:false,advisorJevEnabled:false})
  await plugin.await()
  const parent=await ctx.get('agentLoop').create('advisor-native-fixture',{provider:'fixture',model:'fixed'},{cwd:home})
  parent.followup(createUserMessage({content:[{type:'text',text:'Evaluate the fixture options.'}],source:{kind:'user'}}))
  await parent.whenIdle()
  const tools=ctx.get('tools')
  const invoke=(callId,args)=>tools.execute({agent:parent,callId,name:'ask_advisor',signal:new AbortController().signal,arguments:args})
  const rejected=await invoke('missing-context',{question:'Which approach?',context:''})
  assert.equal(rejected.isError,true)
  const sensitive=await invoke('private-context',{question:'Which approach?',context:'API_KEY=FAKE_CREDENTIAL_MARKER_ONLY'})
  assert.equal(sensitive.isError,true)
  assert.equal(adapter.requests.length,1,'admission rejections do not request advisor model')
  const results=await Promise.all(Array.from({length:4},(_,i)=>invoke('consult-'+i,{question:'Which boundary matters?',context:'The fixture has one process and one state owner.'})))
  assert.equal(results.filter(result=>!result.isError).length,1,'parallel consultation reservation admits only one child')
  const accepted=results.find(result=>!result.isError)
  assert.equal(accepted.value.text,answer)
  assert.deepEqual(accepted.value.modelUsage,{requested:{provider:'fixture',model:'fixed'},used:[{provider:'fixture',model:'fixed'}]})
  assert.deepEqual(accepted.meta.modelUsage,accepted.value.modelUsage)
  assert.equal(adapter.requests.length,3,'one parent response plus failed advisor request plus successful retry')
  assert.deepEqual(adapter.requests[1].tools,[],'advisor child has no tools')
  const service=ctx.get('cielAdvisor')
  assert.ok(service)
  const usage=await service.callModelUsage({sessionId:parent.id,kind:'tool',id:'consult-0'})
  assert.deepEqual(usage.modelUsage,accepted.value.modelUsage)
  const advice=await service.readAdvice({sessionId:parent.id,callId:'tool:consult-0'})
  assert.equal(advice.ok,true);assert.equal(advice.advice.text,answer)
  assert.equal(ctx.get('commands').find(parent,'advise'),undefined)
  assert.equal(ctx.get('agents').list().length,1,'only parent remains after advisor disposal')
  // A second session proves exhausted retries surface the original provider error.
  adapter.script.push('Second parent response.', ...Array.from({length:3}, () => new LlmError('fetch failed', 'TRANSPORT')))
  const second=await ctx.get('agentLoop').create('advisor-exhausted-fixture',{provider:'fixture',model:'fixed'},{cwd:home})
  second.followup(createUserMessage({content:[{type:'text',text:'Check retry exhaustion.'}],source:{kind:'user'}}))
  await second.whenIdle()
  const failed=await tools.execute({agent:second,callId:'exhausted',name:'ask_advisor',signal:new AbortController().signal,arguments:{question:'Which?',context:'Offline recovery fixture.'}})
  assert.equal(failed.isError,true)
  assert.match(JSON.stringify(failed),/fetch failed/)
  assert.doesNotMatch(JSON.stringify(failed),/model request limit reached/)
  assert.equal(adapter.requests.length,7,'three exhausted attempts allowed by provider policy')
  assert.ok(adapter.requests.slice(1,3).every(row=>row.tools.length===0))
  const controller = new AbortController()
  const slow = new ScriptedAdapter(['Cancellation parent.', {partial:'cancelled partial', failure:new LlmError('fetch failed','TRANSPORT'), onFailure:()=>setTimeout(()=>controller.abort(),25)}], 1000)
  registration()
  ctx.get('llm').registerAdapter(['fixture'],slow)
  const third=await ctx.get('agentLoop').create('advisor-cancel-fixture',{provider:'fixture',model:'fixed'},{cwd:home})
  third.followup(createUserMessage({content:[{type:'text',text:'Check cancellation.'}],source:{kind:'user'}}))
  await third.whenIdle()
  const cancelled=await tools.execute({agent:third,callId:'cancelled',name:'ask_advisor',signal:controller.signal,arguments:{question:'Which?',context:'Cancel during retry backoff.'}})
  assert.equal(cancelled.isError,true)
  assert.equal(slow.requests.length,2,'cancelled backoff never starts a second advisor request')
  assert.equal(ctx.get('agents').list().length,3,'all child agents are disposed')
  assert.equal((await service.readAdvice({sessionId:third.id,callId:'tool:cancelled'})).ok,false)
  await plugin.dispose()
  assert.equal(networkRequests,0)
  console.log(JSON.stringify({passed:true,mode:'real DSH agent-loop and scripted adapter',advisorRequests:5,networkRequests,retryRecovered:true,partialOutputDiscarded:true,backoffCancelled:true,retryExhaustionPreservesCause:true,checks:['admission','sensitive input','parallel gate','tool-free child','actual model provenance','durable readback','child disposal']}))
} finally {
  await ctx.fiber.dispose()
  resolutionHook.deregister()
  globalThis.fetch=previousFetch
  if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome
  await rm(home,{recursive:true,force:true})
}
