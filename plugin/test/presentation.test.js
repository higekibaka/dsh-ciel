import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewConclusion, listingPresentation, createCielDecisionPrompt, hasSettledReviewItems } from '../src/presentation.js'

test('incomplete and failed reviews never become an all-clear conclusion',()=>{
 assert.match(reviewConclusion({status:'incomplete',coverage:'partial',annotations:[{}]}),/不能判定全部通过/)
 assert.match(reviewConclusion({status:'sound',coverage:'complete',stats:{unchecked:1},annotations:[]}),/不能判定通过/)
 assert.match(reviewConclusion({status:'error',coverage:'complete',annotations:[]}),/失败/)
 assert.match(reviewConclusion({status:'sound',coverage:'complete',annotations:[]}),/已核实范围内/)
})
test('listing projection preserves paths and truncation without inventing current files',()=>{
 const content=JSON.stringify({pattern:'*test*',paths:['/project/a.js','/project/b.js'],truncated:true})
 const result=listingPresentation({kind:'listing',status:'available',content})
 assert.deepEqual(result.paths,['/project/a.js','/project/b.js']);assert.equal(result.raw,content);assert.equal(result.truncated,true)
 assert.equal('currentPath' in result,false)
 for(const status of ['withheld','unrecognized'])assert.equal(listingPresentation({kind:'listing',status,content}),null)
 for(const content of ['broken','{"paths":[1]}','{"entries":[]}'])assert.equal(listingPresentation({kind:'listing',status:'available',content}),null)
 assert.equal(listingPresentation({kind:'source',status:'available',content}),null)
})
function prompt(){
 const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState:()=>[0,()=>{}],useEffect:effect=>effect()}
 const instance=createCielDecisionPrompt({React,Modal:undefined,Button:undefined});instance.View();return instance
}
function label(node){return typeof node==='string'?node:node?.children?.map(label).join('')||''}
function find(node,text){if(node?.type==='button'&&label(node)===text)return node;for(const child of node?.children||[]){const result=find(child,text);if(result)return result}return null}
test('draft prompt defaults to append and requires an explicit second step for replacement',async()=>{
 const p=prompt();const result=p.ask('keep my draft')
 assert.ok(find(p.View(),'追加到草稿末尾'));assert.equal(find(p.View(),'确认替换'),null)
 find(p.View(),'替换现有草稿').props.onClick();assert.ok(find(p.View(),'确认替换'))
 find(p.View(),'返回').props.onClick();await Promise.resolve();assert.ok(find(p.View(),'追加到草稿末尾'))
 find(p.View(),'追加到草稿末尾').props.onClick();assert.equal(await result,'append');p.dispose()
})
test('cancel and plugin disposal settle a pending decision without choosing a write',async()=>{
 const p=prompt();let result=p.ask('keep');find(p.View(),'取消').props.onClick();assert.equal(await result,'cancel')
 result=p.ask('keep');await assert.rejects(p.ask('second'),/先处理/);p.dispose();assert.equal(await result,'cancel');assert.equal(await p.ask('late'),'cancel')
})


test('missing overlay mount rejects instead of leaving the composer decision pending',async()=>{
 const React={createElement(){},useState:()=>[0,()=>{}],useEffect(){}}
 const p=createCielDecisionPrompt({React})
 await assert.rejects(p.ask('keep'),/尚未就绪/)
 p.dispose()
})

test('all six settled items with limited evidence are completed checks, not an all-clear certificate', () => {
  const review = { status: 'incomplete', coverage: 'partial', verdict: 'pass',
    stats: { checked: 6, confirmed: 0, excluded: 6, unchecked: 0 }, annotations: [] }
  assert.equal(hasSettledReviewItems(review), true)
  assert.match(reviewConclusion(review), /已完成 6 项核查，疑点均已排除/)
  assert.match(reviewConclusion(review), /受限/)
  assert.doesNotMatch(reviewConclusion(review), /尚未完成|全部通过|无阻断/)
  assert.equal(review.coverage, 'partial')
  for (const stats of [
    { checked: 6, confirmed: 0, excluded: 5, unchecked: 1 },
    { checked: 6, confirmed: 0, excluded: 5, unchecked: 0 },
    { checked: 0, confirmed: 0, excluded: 0, unchecked: 0 },
  ]) assert.equal(hasSettledReviewItems({ ...review, stats }), false)
  assert.equal(hasSettledReviewItems({ ...review, status: 'cancelled' }), false)
})
