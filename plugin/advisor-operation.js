/** One consultation deadline; provider policy owns request retries. */
export function createAdvisorOperation({ timeoutMs = 180000, now = Date.now, timers = globalThis } = {}) {
  const controller = new AbortController()
  const deadline = now() + timeoutMs
  let reason = '', phase = 'running', finish
  const done = new Promise(resolve => { finish = resolve })
  const cancel = (why = 'advisor cancelled') => {
    if (phase !== 'running') return false
    phase = 'cancelled'
    reason = why
    controller.abort(new Error(why))
    return true
  }
  const check = () => {
    if (now() >= deadline) cancel('advisor timeout')
    if (controller.signal.aborted) throw new Error(reason)
  }
  const timer = timers.setTimeout(() => cancel('advisor timeout'), timeoutMs)
  timer?.unref?.()
  return {
    signal: controller.signal, cancel, check, done,
    remainingMs: () => Math.max(0, deadline - now()),
    beforeRequest() {
      check()
      if (phase !== 'running') throw new Error('advisor already settled')
    },
    beginCommit() {
      check()
      if (phase !== 'running') throw new Error('advisor already settled')
      phase = 'committing'
      timers.clearTimeout(timer)
    },
    dispose() { timers.clearTimeout(timer); if (phase !== 'cancelled') phase = 'finished'; finish() },
  }
}
