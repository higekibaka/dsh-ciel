import test from 'node:test'
import assert from 'node:assert/strict'
import { toolEventView, gateFacts, reminderTextFor, createConsultationGate } from '../index.js'
const NL = String.fromCharCode(10)
const answer = ['## [high] 检查边界','framing: 多看一种情况','pitfalls: 别漏空值','verification_target: 验证空值'].join(NL)
const start = (seq, id, name, args = {}) => ({ seq, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'outer', subCallId: id, name, arguments: args } })
const end = (seq, id, name, text, isError = false) => ({ seq, type: 'tool/ptc-dispatch', data: { parentCallId: 'outer', subCallId: id, name, arguments: {}, isError, content: [{ type: 'text', text }] } })
const turn = { seq: 0, type: 'turn/start', data: { turn: 1 } }
const wrapper = { seq: 1, type: 'tool/call', data: { callId: 'outer', name: 'run_code' } }
const target = { seq: 20, type: 'assistant/message', data: { turn: 1 } }

test('PTC wrapper alone is not exploration; an actual dispatched read is', () => {
  const events = [turn, wrapper]
  const parent = { session: { snapshotEvents: () => events } }
  assert.equal(gateFacts(parent).explorationDone, false)
  events.push(start(2, 'read-1', 'read', { file_path: 'file.txt' }), end(3, 'read-1', 'read', 'contents'))
  assert.equal(gateFacts(parent).explorationDone, true)
})
test('PTC consultations count exact sub-call results and enforce independent work', () => {
  const events = [turn, wrapper, start(2, 'r1', 'read'), end(3, 'r1', 'read', 'x'), start(4, 'a1', 'ask_advisor'), end(5, 'a1', 'ask_advisor', answer)]
  const parent = { session: { snapshotEvents: () => events } }
  assert.equal(gateFacts(parent).settledThisTurn, 1)
  assert.equal(gateFacts(parent).workSinceLast, false)
  events.push({ seq: 6, type: 'tool/call', data: { name: 'run_code', callId: 'outer-2' } })
  assert.equal(gateFacts(parent).workSinceLast, false)
  events.push(start(7, 'r2', 'grep'))
  assert.equal(gateFacts(parent).workSinceLast, true)
})
test('event adaptation is read-only and idempotent with native events', () => {
  const events = [turn, wrapper, start(2, 'r1', 'read'), end(3, 'r1', 'read', 'x')]
  const before = JSON.stringify(events)
  const view = toolEventView(events)
  assert.equal(JSON.stringify(events), before)
  assert.deepEqual(toolEventView(view), view)
  assert.equal(view[2].data.callId, 'r1')
  assert.equal(view[3].data.message.content[0].toolCallId, 'r1')
})
test('sensitive-input rejections do not spend consultation quota', () => {
  const events = [turn, start(1, 'a1', 'ask_advisor'), end(2, 'a1', 'ask_advisor', 'Error: 咨询输入含疑似凭据，未发送给顾问', true)]
  assert.equal(gateFacts({ session: { snapshotEvents: () => events } }).settledThisTurn, 0)
})

test('reservation prevents parallel and pre-publication quota bypass, resets only on a new turn',()=>{
 const gate=createConsultationGate(),parent={}
 const facts={turnKey:1,settledThisTurn:0}
 const release=gate.reserve(parent,facts,1)
 assert.throws(()=>gate.reserve(parent,facts,1),/in flight/)
 release();release()
 assert.throws(()=>gate.reserve(parent,facts,1),/exhausted/)
 gate.reserve(parent,{turnKey:2,settledThisTurn:0},1)()
 assert.throws(()=>gate.reserve({},undefined,1),/telemetry unavailable/)
})
test('planning reminders use durable source identity and never consume a consultation',()=>{
 const events=[turn,{seq:1,type:'tool/call',data:{name:'todo_write',callId:'plan'}}]
 const parent={session:{snapshotEvents:()=>events}},current=()=>({enabled:true,planReminderEnabled:true})
 const reminder=reminderTextFor(parent,current)
 assert.match(reminder,/advisor:plan-reminder/)
 events.push({type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:reminder}]}})
 assert.equal(reminderTextFor(parent,current),reminder,'user quoting marker does not consume reminder')
 events.push({type:'user/message',data:{source:{kind:'runtime-context',sections:[{name:'advisor:plan-reminder'}]},content:[{type:'text',text:reminder}]}})
 assert.equal(reminderTextFor(parent,current),'')
 assert.equal(gateFacts(parent).settledThisTurn,0)
 assert.equal(reminderTextFor(parent,()=>({enabled:false,planReminderEnabled:true})),'')
})
test('failed provider execution spends quota while preflight rejections do not',()=>{
 const events=[turn,start(1,'a1','ask_advisor'),end(2,'a1','ask_advisor','provider failed',true)]
 assert.equal(gateFacts({session:{snapshotEvents:()=>events}}).settledThisTurn,1)
 assert.equal(gateFacts({session:{snapshotEvents:()=>{throw new Error('unavailable')}}}),undefined)
})
