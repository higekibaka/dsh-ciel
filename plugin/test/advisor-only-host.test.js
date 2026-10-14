import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, configValues } from '../index.js'
import { createAdvisorOperation } from '../advisor-operation.js'
import { ADVISOR_METHODS, parseAdvisorRequest, advisorInvocation } from '../advisor-protocol.js'
import { RECORD_KINDS } from '../record-store.js'

function clock() {
 let time = 0, callback, cleared = false
 return { now: () => time, advance: n => { time += n }, fire: () => callback(),
 timers: { setTimeout(fn) { callback = fn; return { unref() {} } }, clearTimeout() { cleared = true } },
 cleared: () => cleared }
}
test('advisor config and wire surface contain no retired review capability', () => {
 const value = configValues(Config({}))
 assert.deepEqual(Object.keys(value).filter(key=>/^critic|^jevEnabled$/.test(key)), [])
 assert.deepEqual(ADVISOR_METHODS, ['readAdvice','callModelUsage'])
 assert.deepEqual(RECORD_KINDS, ['advice','calls'])
 for(const method of ADVISOR_METHODS) assert.equal(advisorInvocation(method).service, 'cielAdvisor')
 for(const method of ['start','feedback','cancel','inboxList','readReview']) assert.throws(()=>parseAdvisorRequest(method,{}))
 assert.throws(()=>parseAdvisorRequest('callModelUsage',{sessionId:'s1',kind:'command',id:'old'}))
})
test('provider retries share one consultation deadline, not a one-request quota', () => {
 const c=clock(), op=createAdvisorOperation({timeoutMs:100,now:c.now,timers:c.timers})
 for(let i=0;i<6;i++) { op.beforeRequest(); c.advance(10) }
 assert.equal(op.remainingMs(),40)
 assert.equal(op.signal.aborted,false)
 c.advance(40)
 assert.throws(()=>op.beforeRequest(),/advisor timeout/)
 assert.equal(op.signal.aborted,true)
 op.dispose()
})
test('cancellation wins over retries and prevents late publication', async () => {
 const c=clock(), op=createAdvisorOperation({timeoutMs:100,now:c.now,timers:c.timers})
 op.beforeRequest(); assert.equal(op.cancel('caller cancelled'),true)
 assert.throws(()=>op.beforeRequest(),/caller cancelled/)
 assert.throws(()=>op.beginCommit(),/caller cancelled/)
 assert.equal(op.cancel(),false)
 op.dispose(); await op.done; assert.equal(c.cleared(),true)
})
test('timer cancellation and atomic publication fence remain independent of retries', async () => {
 const c=clock(), op=createAdvisorOperation({timeoutMs:100,now:c.now,timers:c.timers})
 c.fire(); assert.throws(()=>op.beforeRequest(),/advisor timeout/); op.dispose()
 const d=clock(), committed=createAdvisorOperation({timeoutMs:100,now:d.now,timers:d.timers})
 committed.beforeRequest(); committed.beginCommit()
 assert.equal(d.cleared(),true); assert.equal(committed.cancel(),false)
 assert.throws(()=>committed.beforeRequest(),/already settled/)
 assert.throws(()=>committed.beginCommit(),/already settled/)
 committed.dispose(); await committed.done
})
