/** One deadline and one terminal decision for a review (or advisor request). */
export function createReviewOperation({ timeoutMs = 180000, maxRequests, now = Date.now, timers = globalThis } = {}) {
  const controller = new AbortController()
  const deadline = now() + timeoutMs
  let reason = '', requests = 0, phase = 'running', finish
  const done = new Promise(resolve => { finish = resolve })
  const cancel = (why = 'cancelled') => {
    if (phase !== 'running') return false
    phase = 'cancelled'
    reason = why
    controller.abort(new Error(why))
    return true
  }
  const check = () => {
    if (now() >= deadline) cancel('review timeout')
    if (controller.signal.aborted) throw new Error(reason)
  }
  const timer = timers.setTimeout(() => cancel('review timeout'), timeoutMs)
  timer?.unref?.()
  return {
    signal: controller.signal, cancel, check, done,
    phase: () => phase,
    // Called synchronously immediately before the summary's atomic rename.
    // After this point cancellation must report too late, never accepted.
    beginCommit() {
      check()
      if (phase !== 'running') throw new Error('review already settled')
      phase = 'committing'
      timers.clearTimeout(timer)
    },
    reason: () => reason,
    requests: () => requests,
    remainingMs: () => Math.max(0, deadline - now()),
    beforeRequest() {
      check()
      if (phase !== 'running') throw new Error('review already settled')
      if (maxRequests !== undefined && requests >= maxRequests) { cancel('model request limit reached'); check() }
      requests += 1
    },
    dispose() { timers.clearTimeout(timer); if (phase !== 'cancelled') phase = 'finished'; finish() },
  }
}
