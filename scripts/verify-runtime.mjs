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
const { LlmAdapter, createUserMessage } = llmModule
const modules = await Promise.all([
  'packages/core/session', 'packages/core/system-prompt', 'packages/core/tools',
  'packages/core/agent', 'packages/session/session-projection', 'packages/core/agent-loop', 'packages/subagent/subagent',
  'packages/subagent/subagent-spawn-in-process', 'packages/interaction/commands',
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
  constructor(script) { super(); this.script = script; this.requests = [] }
  async resolveModel(provider,id) { return {provider,id,name:id} }
  async *stream(options) {
    this.requests.push({tools:(options.tools||[]).map(tool=>tool.name)})
    const text = this.script.shift()
    assert.equal(typeof text, 'string', 'unexpected extra model-generation request')
    for (const frame of textResponse(text)) { options.signal.throwIfAborted(); yield frame }
  }
}
const answer = '## [high] Inspect ownership\nframing: Keep one owner.\npitfalls: Duplicate writers race.\nverification_target: Verify cancellation drains the child.'
const adapter = new ScriptedAdapter(['Synthetic parent response.',answer])
try {
  globalThis.fetch = async () => { networkRequests++; throw new Error('Network forbidden in offline verification') }
  await ctx.plugin(llmModule.default||llmModule).await()
  for (const mod of modules) await ctx.plugin(mod.default||mod,mod.name==='agent-loop'?{agents:[]}:{}).await()
  ctx.get('llm').registerAdapter(['fixture'],adapter)
  const plugin=ctx.plugin(ciel,{...ciel.configValues(ciel.Config({})),provider:'fixture',model:'fixed',guidanceEnabled:false,planReminderEnabled:false,requireExploration:false,maxCallsPerTurn:1,advisorJevEnabled:false})
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
  assert.equal(adapter.requests.length,2,'one parent response plus one advisor generation')
  assert.deepEqual(adapter.requests[1].tools,[],'advisor child has no tools')
  const service=ctx.get('cielAdvisor')
  assert.ok(service)
  const usage=await service.callModelUsage({sessionId:parent.id,kind:'tool',id:'consult-0'})
  assert.deepEqual(usage.modelUsage,accepted.value.modelUsage)
  const advice=await service.readAdvice({sessionId:parent.id,callId:'tool:consult-0'})
  assert.equal(advice.ok,true);assert.equal(advice.advice.text,answer)
  const followup=await invoke('quota-exhausted',{question:'Again?',context:'No new work.'})
  assert.equal(followup.isError,true)
  assert.equal(adapter.requests.length,2)
  assert.equal(ctx.get('commands').find(parent,'advise'),undefined)
  assert.equal(ctx.get('agents').list().length,1,'only parent remains after advisor disposal')
  await plugin.dispose()
  assert.equal(networkRequests,0)
  console.log(JSON.stringify({passed:true,mode:'real DSH agent-loop and scripted adapter',advisorRequests:1,networkRequests,checks:['admission','sensitive input','parallel gate','tool-free child','actual model provenance','durable readback','parent-turn quota','child disposal']}))
} finally {
  await ctx.fiber.dispose()
  resolutionHook.deregister()
  globalThis.fetch=previousFetch
  if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome
  await rm(home,{recursive:true,force:true})
}
