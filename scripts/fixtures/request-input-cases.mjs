// Current-DSH request history scenarios. Model output and token pricing are
// synthetic; Session, AgentLoop, GoalService/driver, compaction transactions,
// fork, and the two-stage Ciel runtime execute their actual implementations.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectReviewRequest } from '../../plugin/review-input.js'

const lastDraft = parent => parent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
const human = (create, text) => create({ content: [{ type: 'text', text }], source: { kind: 'user' } })
async function loadGoal(ctx, load) {
  const mod = await load('packages/goal/goal')
  await ctx.plugin(mod.default || mod).await()
  return ctx.get('goals')
}
async function continueGoal(parent, create, goal) {
  parent.followup(create({ content: [{ type: 'text', text: 'GOAL_OBJECTIVE_MARKER generated continuation instructions' }],
    source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 } }))
  await parent.whenIdle()
}
async function compact(parent, checkout, owner = null) {
  const { BasicCompactionEngine } = await import(pathToFileURL(join(checkout, 'packages/compaction/compaction-basic/lib/index.js')).href)
  const nodes = parent.session.surface.nodes.filter(seq => parent.session.eventAt(seq).type !== 'system/message')
  assert.ok(nodes.length)
  if (!parent.ctx.get('compaction')) {
    await parent.ctx.plugin({ name: 'fixture-token-meter', apply(ctx) {
      ctx.provide('tokenMeter', {
        measure: session => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens: 10000, heuristicTokens: 10000 })) }),
        estimateMessage: () => 1,
      })
    } }).await()
    class ScriptedCompaction extends BasicCompactionEngine {
      async summarize() { return { summary: [{ type: 'text', text: 'SUMMARY_OPINION_MARKER' }], provider: 'fixture', model: 'summary' } }
    }
    await parent.ctx.plugin(ScriptedCompaction, { auto: false }).await()
  }
  const engine = parent.ctx.get('compaction')
  if (owner === null) await engine.compactNow(parent, new AbortController().signal)
  else await engine.compactRegion(nodes[0], nodes.at(-1), parent)
  assert.ok(parent.session.snapshotEvents().some(event => event.type === 'compaction/summary'))
}
function assertReviewMarkers(requests, offset, expected) {
  for (const request of requests.slice(offset)) {
    assert.equal(request.inputMarkers.SUMMARY_OPINION_MARKER, false, 'compactor opinion is never a human request')
    assert.equal(request.inputMarkers.GOAL_OBJECTIVE_MARKER, false, 'generated goal text is not a human request')
    for (const [marker, present] of Object.entries(expected)) assert.equal(request.inputMarkers[marker], present, marker)
  }
}

export async function runRequestInputCases({ runCase, textResponse, nativeToolResponse, suspects, toolResponse, pass }) {
  const draft = () => textResponse('The fixture has three lines.')
  const review = () => [textResponse(suspects), toolResponse(['read']), textResponse(pass)]
  for (const replacement of ['compact', 'unlinked']) await runCase('scripted-input-' + replacement, review(), {
    request: 'HUMAN_TASK_MARKER Check the file.', parentTools: true,
    parentScript: [nativeToolResponse(['read']), draft()],
    setupParent: async ({ parent, checkout, createUserMessage }) => {
      let applied = false
      parent.ctx.on('agent/pre-step', async (_event, next) => {
        if (!applied && parent.session.snapshotEvents().some(event => event.type === 'tool/result')) {
          applied = true
          if (replacement === 'compact') {
            await compact(parent, checkout, 'current-turn')
            await compact(parent, checkout, 'current-turn')
          } else {
            const old = parent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user')
            parent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'SUMMARY_OPINION_MARKER' }], source: { kind: 'plugin', plugin: 'fixture-replacement' } }),
              { surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq] })
          }
        }
        return next()
      })
    },
    expect: (result, _tools, requests) => {
      assert.equal(requests[1].inputMarkers.SUMMARY_OPINION_MARKER, true, 'replacement actually reaches the author')
      assert.equal(requests[1].inputMarkers.HUMAN_TASK_MARKER, false, 'original is shadowed in the author surface')
      assertReviewMarkers(requests, 2, { HUMAN_TASK_MARKER: replacement === 'compact' })
      assert.equal(result.review.status, replacement === 'compact' ? 'sound' : 'incomplete')
      if (replacement === 'unlinked') assert.ok(result.review.requestContext.reasons.includes('replaced-input'))
    },
  })
  await runCase('scripted-input-goal-driver', review(), {
    request: 'HUMAN_TASK_MARKER Check the file.', parentScript: [draft(), draft()],
    prepareReview: async ({ ctx, parent, load }) => {
      const goals = await loadGoal(ctx, load)
      const driver = await load('packages/goal/goal-round-driver')
      await ctx.plugin(driver.default || driver).await()
      goals.create(parent, { objective: 'GOAL_OBJECTIVE_MARKER', maxGoalRounds: 1 })
      const deadline = Date.now() + 2000
      while (!parent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'goal')) {
        if (Date.now() > deadline) throw new Error('native goal driver did not admit a round')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await parent.whenIdle()
    },
    expect: (result, _tools, requests) => {
      assert.equal(requests[1].inputMarkers.GOAL_OBJECTIVE_MARKER, true, 'actual native driver supplied its continuation prompt')
      assertReviewMarkers(requests, 2, { HUMAN_TASK_MARKER: true })
      assert.deepEqual(result.review.requestContext, { mode: 'goal-continuation', limited: false })
    },
  })
  await runCase('scripted-input-goal-refinement', review(), {
    request: 'HUMAN_TASK_MARKER Check the file.', parentScript: [draft(), draft(), draft()],
    prepareReview: async ({ ctx, parent, load, createUserMessage, checkout }) => {
      const goals = await loadGoal(ctx, load)
      const goal = goals.create(parent, { objective: 'GOAL_OBJECTIVE_MARKER' })
      parent.followup(human(createUserMessage, 'REFINEMENT_MARKER Include the last line.'))
      await parent.whenIdle()
      await compact(parent, checkout)
      await continueGoal(parent, createUserMessage, goal)
    },
    expect: (result, _tools, requests) => {
      assert.equal(requests[2].inputMarkers.SUMMARY_OPINION_MARKER, true)
      assertReviewMarkers(requests, 3, { HUMAN_TASK_MARKER: true, REFINEMENT_MARKER: true })
      assert.deepEqual(result.review.requestContext, { mode: 'goal-continuation', limited: false })
    },
  })
  await runCase('scripted-input-goal-edited', review(), {
    request: 'HUMAN_TASK_MARKER Old task.', parentScript: [draft(), draft()],
    prepareReview: async ({ ctx, parent, load, createUserMessage }) => {
      const goals = await loadGoal(ctx, load)
      const goal = goals.create(parent, { objective: 'Initial goal' })
      const changed = goals.edit(parent, { id: goal.id, revision: goal.revision }, { objective: 'GOAL_OBJECTIVE_MARKER Different goal' })
      await continueGoal(parent, createUserMessage, changed)
    },
    expect: (result, _tools, requests) => {
      assertReviewMarkers(requests, 2, { HUMAN_TASK_MARKER: false })
      assert.equal(result.review.status, 'incomplete')
      assert.ok(result.review.requestContext.reasons.includes('goal-origin-missing'))
    },
  })
  await runCase('scripted-input-goal-resumed', review(), {
    request: 'HUMAN_TASK_MARKER Original goal task.', parentScript: [draft(), draft(), draft()],
    prepareReview: async ({ ctx, parent, load, createUserMessage }) => {
      const goals = await loadGoal(ctx, load)
      const goal = goals.create(parent, { objective: 'GOAL_OBJECTIVE_MARKER' })
      const paused = goals.pause(parent, { id: goal.id, revision: goal.revision })
      parent.followup(human(createUserMessage, 'NEW_TASK_MARKER Work while the goal is paused.'))
      await parent.whenIdle()
      const resumed = goals.resume(parent, { id: paused.id, revision: paused.revision })
      await continueGoal(parent, createUserMessage, resumed)
    },
    expect: (result, _tools, requests) => {
      assertReviewMarkers(requests, 3, { HUMAN_TASK_MARKER: true, NEW_TASK_MARKER: false })
      assert.equal(result.review.status, 'incomplete')
      assert.ok(result.review.requestContext.reasons.includes('goal-origin-missing'))
    },
  })
  await runCase('scripted-input-historical-target', review(), {
    request: 'HUMAN_TASK_MARKER First task.', parentScript: [draft(), draft()],
    prepareReview: async ({ parent, createUserMessage, checkout }) => {
      const target = lastDraft(parent)
      parent.followup(human(createUserMessage, 'NEW_TASK_MARKER Different task.'))
      await parent.whenIdle()
      await compact(parent, checkout)
      return { target }
    },
    expect: (result, _tools, requests) => {
      assertReviewMarkers(requests, 2, { HUMAN_TASK_MARKER: true, NEW_TASK_MARKER: false })
      assert.equal(result.review.status, 'sound')
    },
  })
  for (const inherited of [true, false]) await runCase('scripted-input-fork-' + (inherited ? 'inherited' : 'new-task'), review(), {
    request: 'HUMAN_TASK_MARKER Original task.', parentScript: [draft(), draft(), draft()],
    prepareReview: async ({ ctx, parent, createUserMessage, checkout }) => {
      const target = lastDraft(parent)
      await compact(parent, checkout)
      const branch = ctx.get('sessions').fork(parent.session)
      parent.followup(human(createUserMessage, 'NEW_TASK_MARKER Parent-only later task.'))
      await parent.whenIdle()
      const handle = await ctx.get('agents').create({ sessionId: 'branch-' + parent.id, seed: branch.snapshotEvents(),
        inheritedEventCount: branch.snapshotEvents().length,
        meta: { cwd: parent.session.header.cwd, parentSession: parent.id, isSeeded: true },
        agentOptions: { provider: 'fixture', model: 'fixed' } })
      const child = handle.agent
      child.followup(human(createUserMessage, 'REFINEMENT_MARKER Child-only new task.'))
      await child.whenIdle()
      const chosen = inherited ? child.session.snapshotEvents().find(event => event.type === 'assistant/message' && event.data.message.id === target.data.message.id) : lastDraft(child)
      const projected = projectReviewRequest(child.session.snapshotEvents(), chosen)
      assert.equal(projected.text.includes('NEW_TASK_MARKER'), false)
      // Re-creating from the frozen prefix reproduces the same input decision.
      const replay = ctx.get('sessions').fork(child.session)
      assert.deepEqual(projectReviewRequest(replay.snapshotEvents(), chosen), projected)
      return { parent: child, target: chosen }
    },
    expect: (result, _tools, requests, { request }) => {
      assertReviewMarkers(requests, 3, { HUMAN_TASK_MARKER: inherited, NEW_TASK_MARKER: false, REFINEMENT_MARKER: !inherited })
      assert.equal(result.review.sessionId, request.sessionId)
      assert.equal(result.review.status, 'sound')
    },
  })
  await runCase('scripted-input-same-turn-steering', review(), {
    request: 'HUMAN_TASK_MARKER Initial requirement.', parentTools: true,
    parentScript: [nativeToolResponse(['read']), draft()],
    setupParent: async ({ parent, createUserMessage }) => {
      let steered = false
      parent.ctx.on('tools/result', (exec) => {
        if (!steered && exec.agent === parent && exec.name === 'read') {
          steered = true
          parent.steer(human(createUserMessage, 'REFINEMENT_MARKER Additional requirement.'))
        }
      })
    },
    expect: (result, _tools, requests) => {
      assert.equal(requests[1].inputMarkers.REFINEMENT_MARKER, true, 'native steer reached the next author step')
      assertReviewMarkers(requests, 2, { HUMAN_TASK_MARKER: true, REFINEMENT_MARKER: true })
      assert.equal(result.review.status, 'sound')
    },
  })
}
