// Advisor Remote lifecycle retained after removal of review transport.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadClientFactory,flush} from './advisor-ui.harness.js'
import {Context,getTraceable,symbols} from '@deepseek-ai/cordis'
function fixture(remote,api) {
 const cleanups=[]
 const plugin=loadClientFactory().factory({createElement:()=>null,useState:()=>[],useEffect(){}})
 plugin.apply({settingsScope:{bind:()=>({getSnapshot:()=>({status:'ready',value:{},user:{},writable:true}),subscribe:()=>()=>{}})},
   get:key=>key==='remote'?remote():key==='remote.cielAdvisor'?api:undefined,on:()=>()=>{},slots:{inject:()=>()=>{},register:()=>()=>{}},
   effect(fn){const off=fn();if(typeof off==='function')cleanups.push(off)}})
 const call=plugin.__test.runtime.advisorCall
 return {call,async dispose(){await Promise.all(cleanups.map(fn=>fn()))}}
}
test('Cordis facade churn does not remount while advisor reads are active',async t=>{
 const ctx=new Context();let mounts=0,disposals=0,release
 const remote={[symbols.tracker]:{property:'ctx'},ctx:null,async $mount(){mounts++;return()=>{disposals++}}}
 const rt=fixture(()=>getTraceable(ctx,remote),{callModelUsage:()=>new Promise(resolve=>{release=()=>resolve({modelUsage:null})})});t.after(()=>rt.dispose())
 await flush();const pending=rt.call('callModelUsage',{sessionId:'s',kind:'tool',id:'c'});await flush()
 assert.equal(mounts,1);assert.equal(disposals,0);release();assert.deepEqual(await pending,{modelUsage:null})
 await rt.dispose();assert.equal(disposals,1)
})
test('malformed or removed requests never dispatch and malformed results fail explicitly',async t=>{
 let calls=0
 const rt=fixture(()=>({$mount:async()=>()=>{}}),{callModelUsage:async()=>{calls++;return{modelUsage:'wrong'}}});t.after(()=>rt.dispose())
 assert.equal((await rt.call('start',{})).ok,false)
 assert.equal((await rt.call('readAdvice',{sessionId:'s',callId:[]})).ok,false)
 assert.equal(calls,0)
 assert.equal((await rt.call('callModelUsage',{sessionId:'s',kind:'tool',id:'c'})).ok,false)
 assert.equal(calls,1)
})
test('disposal during Remote mount releases its late registration without dispatch',async()=>{
 let release,mounts=0,calls=0
 const mounted=new Promise(resolve=>{release=resolve})
 const rt=fixture(()=>({$mount:()=>mounted}),{callModelUsage:async()=>{calls++;return{modelUsage:null}}})
 const pending=rt.call('callModelUsage',{sessionId:'s',kind:'tool',id:'c'})
 const stopping=rt.dispose();release(()=>{mounts++});await stopping
 assert.equal((await pending).ok,false);assert.equal(calls,0);assert.equal(mounts,1)
})
