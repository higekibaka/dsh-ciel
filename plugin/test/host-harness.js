// Offline service harness: actual Cordis/Typert registration and production
// review orchestration; scripted subagent boundaries, no network or model SDK.
import { Context } from '@deepseek-ai/cordis'
import { AdvisorReviewService, Config } from '../index.js'

export const SUSPECT = '## suspects\n- suspect: wrong count | block: b1 | bearing: high | falsify: read file'
export const verdict = ({ checked = 1, confirmed = 0, excluded = 1, annotation = '', evidence = 'read fixture.js:1 finding' } = {}) => {
  const rows = Array.from({ length: checked }, (_, i) => {
    const outcome = i < confirmed ? 'defect' : i < confirmed + excluded ? 'cleared' : 'unchecked'
    return '- result: s' + (i + 1) + ' | outcome: ' + outcome + ' | evidence: ' + (outcome === 'unchecked' ? 'none' : evidence)
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
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the file count.' }] } },
    { seq: 2, type: 'tool/call', data: { name: 'bash', callId: 'author-call' } },
    { seq: 3, type: 'tool/result', data: { message: { content: [{ toolCallId: 'author-call', content: [{ type: 'text', text: 'AUTHOR_EVIDENCE_SENTINEL: 42 lines' }] }] } } },
    { seq: 4, type: 'assistant/message', data: { turn: 1, message: { id: messageId, content: [{ type: 'text', text: 'The file has 42 lines.' }] } } },
  ]
  const delivered = []
  const parent = { id: sid, session: { header: { id: sid, cwd: '/fixture-project' }, snapshotEvents: () => parentEvents }, followup: (message) => delivered.push(message) }
  const agents = new Map([[sid, parent]])
  const requests = []
  const disposals = []
  const executions = []
  const pending = new Set()
  let config = Config(overrides)
  let service
  let isolationCallbacks
  const controls = new Map()
  const childEventLog = []
  let lastControl
  let ptcSerial = 0
  const provider = ctx.plugin({ name: 'offline-model-boundary', apply(c) {
    c.provide('agents', { get: (id) => agents.get(id) })
    c.provide('subagents', { registerProvider: () => () => {}, start: async (_backend, spec) => {
      const script = scripts[requests.length]
      if (script === undefined) throw new Error('unexpected extra model spawn')
      requests.push(spec)
      if (script?.spawnError) throw new Error(script.spawnError)
      const id = 'child-' + sid + '-' + requests.length
      const events = []
      childEventLog.push(events)
      const child = { id, ctx: { get: () => ({ presentAs() {} }) }, session: { snapshotEvents: () => events } }
      agents.set(id, child)
      const control = isolationCallbacks.claimControl(spec)
      if (!control) throw new Error('missing fake isolation capability')
      controls.set(id, control)
      isolationCallbacks.bindControl(control, child)
      lastControl = control
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
          service.coordinator.beforeRequest(id)
          const api = {
            signal: spec.signal,
            child,
            control,
            request: () => service.coordinator.beforeRequest(id),
            visible(text) { events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }) },
            // PTC path: the outer run_code transport and every nested dispatch
            // pass through the fail-closed per-control gate, exactly as the
            // private child registry will. Nested results are JSON strings.
            runCode(calls = [], { description = 'fixture program' } = {}) {
              const outerCallId = 'run-code-' + (++ptcSerial)
              const outerArguments = { code: '/* fixture program */', description }
              events.push({ type: 'tool/call', data: { name: 'run_code', callId: outerCallId, arguments: JSON.stringify(outerArguments) } })
              const transportDenied = control.guard({ agent: child, name: 'run_code', arguments: outerArguments, signal: spec.signal })
              if (transportDenied) return { denied: transportDenied }
              const outputs = []
              calls.forEach((call, index) => {
                const subCallId = outerCallId + ':ptc:' + (index + 1)
                events.push({ type: 'tool/ptc-dispatch-start', data: { rootCallId: outerCallId, parentCallId: outerCallId, subCallId, name: call.name, arguments: call.args } })
                const denied = control.guard({ agent: child, name: call.name, arguments: call.args, parent: Symbol('ptc-outer'), signal: spec.signal })
                let value
                if (denied) value = { error: denied }
                else {
                  executions.push({ id, name: call.name })
                  try { value = control.corpus[call.name](call.args) } catch (error) { value = { error: error.message } }
                }
                events.push({ type: 'tool/ptc-dispatch', data: { rootCallId: outerCallId, parentCallId: outerCallId, subCallId, name: call.name, arguments: call.args, isError: !!value.error, content: [{ type: 'text', text: JSON.stringify(value) }] } })
                outputs.push(value)
              })
              events.push({ type: 'tool/result', data: { message: { content: [{ toolCallId: outerCallId, content: [{ type: 'text', text: JSON.stringify(outputs) }] }] } } })
              return outputs
            },
            tool(name = 'read', args = {}) {
              events.push({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
              const denied = service.coordinator.guard({ agent: child, name, arguments: args, signal: spec.signal })
              if (denied) return { denied }
              executions.push({ id, name })
              // Same order as the real restricted reader: guard first, then the
              // evidence-wrapped corpus, so evidence_refs come from a real read.
              const result = control.corpus[name](args)
              events.push({ type: 'tool/result', data: { message: { content: [{ toolCallId: name + '-call', content: [{ type: 'text', text: JSON.stringify(result) }] }] } } })
              return result
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
        isolationCallbacks.unbindControl(controls.get(id), id)
        controls.delete(id)
        disposals.push(id)
      } }
    } })
  } })
  await provider.await()
  const owner = ctx.plugin({ name: 'review-under-test', apply(c) {
    // This suite tests orchestration, not filesystem security. Real corpus/runner
    // isolation has separate integration tests; never mistake this fake for it.
    service = new AdvisorReviewService(c, new Set(), () => config, new Set(), {
      // Production wraps this corpus with evidenceCorpus(), so every reader
      // result is recorded in the real host ledger and carries evidence_refs.
      // No test may pre-seed an eN id without this read actually running.
      createCorpus: async () => ({
        read: (args = {}) => ({
          file_path: typeof args.file_path === 'string' ? args.file_path : '/project/fixture.js',
          offset: Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1,
          total_lines: 42,
          content: Array.from({ length: 42 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n',
          truncated: false,
        }),
        grep: (args = {}) => ({
          matches: typeof args.pattern === 'string' && args.pattern !== ''
            ? [{ file_path: '/project/fixture.js', line_number: 1, line: 'line 1 contains ' + args.pattern }]
            : [],
          truncated: false,
        }),
        glob: () => ({ paths: ['/project/fixture.js'], truncated: false }),
        publicInfo: () => ({ fileCount: 1, byteCount: 42, roots: ['/project'], truncated: false }),
        rewritePaths: (text) => text,
        dispose() {},
      }),
      createProvider: async (callbacks) => { isolationCallbacks = callbacks; return { name: 'ciel-review-private' } },
    })
    service.coordinator.guardAvailable = true
    c.effect(() => async () => {
      const ops = [...service.coordinator.activeOperations]
      for (const op of ops) op.cancel('plugin stopped')
      await Promise.all(ops.map((op) => op.done))
    })
  } })
  await owner.await()
  return {
    ctx, service, sid, messageId, requests, executions, delivered, disposals, parent,
    childEvents: childEventLog, lastControl: () => lastControl,
    configure: (next) => { config = Config({ ...config, ...next }) },
    start: () => service.start({ sessionId: sid, messageId }),
    cancel: () => service.cancel({ sessionId: sid, messageId }),
    stop: () => owner.dispose(),
    async dispose() { await owner.dispose(); await Promise.all(pending); await provider.dispose() },
  }
}
