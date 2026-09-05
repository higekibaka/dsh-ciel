// Offline service harness: actual Cordis/Typert registration and production
// review orchestration; scripted subagent boundaries, no network or model SDK.
import { Context } from '@deepseek-ai/cordis'
import { AdvisorReviewService, Config } from '../index.js'

export const SUSPECT = '## suspects\n- suspect: wrong count | block: b1 | bearing: high | falsify: read file'
export const verdict = ({ checked = 1, confirmed = 0, excluded = 1, annotation = '' } = {}) => {
  const rows = Array.from({ length: checked }, (_, i) => {
    const outcome = i < confirmed ? 'defect' : i < confirmed + excluded ? 'cleared' : 'unchecked'
    return '- result: s' + (i + 1) + ' | outcome: ' + outcome + ' | evidence: ' + (outcome === 'unchecked' ? 'none' : 'read fixture.js:1 finding')
  })
  return '## dossier\n' + rows.join('\n') + '\n\n## verdict: ' + (confirmed ? 'changes' : 'pass') + '\nsummary: fixed fixture result\n' + annotation
}

let serial = 0
export async function reviewHarness(scripts = [], overrides = {}) {
  const ctx = new Context()
  const sid = 'offline-' + (++serial)
  const messageId = 'message-' + serial
  const parentEvents = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Check the file count.' }] } },
    { seq: 2, type: 'tool/call', data: { name: 'bash', callId: 'author-call' } },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ toolCallId: 'author-call', content: [{ type: 'text', text: 'AUTHOR_EVIDENCE_SENTINEL: 42 lines' }] }] } } },
    { seq: 4, type: 'assistant/message', data: { turn: 1, message: { id: messageId, content: [{ type: 'text', text: 'The file has 42 lines.' }] } } },
  ]
  const delivered = []
  const parent = { id: sid, session: { snapshotEvents: () => parentEvents }, followup: (message) => delivered.push(message) }
  const agents = new Map([[sid, parent]])
  const requests = []
  const disposals = []
  const executions = []
  const pending = new Set()
  let config = Config(overrides)
  let service
  const provider = ctx.plugin({ name: 'offline-model-boundary', apply(c) {
    c.provide('agents', { get: (id) => agents.get(id) })
    c.provide('subagents', { start: async (_backend, spec) => {
      const script = scripts[requests.length]
      if (script === undefined) throw new Error('unexpected extra model spawn')
      requests.push(spec)
      if (script?.spawnError) throw new Error(script.spawnError)
      const id = 'child-' + sid + '-' + requests.length
      const events = []
      const child = { id, ctx: { get: () => ({ presentAs() {} }) }, session: { snapshotEvents: () => events } }
      agents.set(id, child)
      let resolve
      let settled = false
      const result = new Promise((r) => { resolve = r })
      const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
      const abort = () => settle({ stopReason: 'aborted', output: [] })
      spec.signal.addEventListener('abort', abort, { once: true })
      if (spec.signal.aborted) abort()
      const drive = new Promise((done) => setImmediate(async () => {
        try {
          if (settled) return
          service.beforeRequest(id)
          const api = {
            signal: spec.signal,
            request: () => service.beforeRequest(id),
            visible(text) { events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }) },
            tool(name = 'read', args = {}) {
              events.push({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
              const denied = service.guard({ agent: child, name, arguments: args, signal: spec.signal })
              if (denied) return { denied }
              executions.push({ id, name })
              events.push({ type: 'tool/result', data: {} })
              return { ok: true }
            },
          }
          const value = typeof script === 'function' ? await script(api, spec) : script
          const out = typeof value === 'string' ? { text: value } : value || {}
          if (out.error) events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: out.error } } } })
          settle({ stopReason: out.stopReason || 'completed', output: out.text === undefined ? [] : [{ type: 'text', text: out.text }] })
        } catch (error) {
          events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: error.message } } } })
          settle({ stopReason: 'error', output: [] })
        } finally { done() }
      }))
      pending.add(drive)
      drive.finally(() => pending.delete(drive))
      return { id, localAgent: child, result, async dispose() {
        abort()
        await drive
        spec.signal.removeEventListener('abort', abort)
        agents.delete(id)
        disposals.push(id)
      } }
    } })
  } })
  await provider.await()
  const owner = ctx.plugin({ name: 'review-under-test', apply(c) {
    service = new AdvisorReviewService(c, new Set(), () => config)
    service.guardAvailable = true
    c.effect(() => async () => {
      const ops = [...service.activeOperations]
      for (const op of ops) op.cancel('plugin stopped')
      await Promise.all(ops.map((op) => op.done))
    })
  } })
  await owner.await()
  return {
    ctx, service, sid, messageId, requests, executions, delivered, disposals, parent,
    configure: (next) => { config = Config({ ...config, ...next }) },
    start: () => service.start({ sessionId: sid, messageId }),
    cancel: () => service.cancel({ sessionId: sid, messageId }),
    stop: () => owner.dispose(),
    async dispose() { await owner.dispose(); await Promise.all(pending); await provider.dispose() },
  }
}
