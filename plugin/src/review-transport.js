import { assertReviewResultIdentity } from '../review-protocol.js'
import { reviewErrorDetails, classifyReviewFailure } from '../review-errors.js'

/** Own one Remote mount, deduplicate readiness, and release late mounts on stop. */
export function createReviewTransport({ getRemote, getApi, descriptor }) {
  let active = true, mounted = false, pending, disposeMount, mountOwner
  async function ready() {
    if (!active) return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_DISPOSED') }
    if (pending) return pending
    if (mounted && getRemote() === mountOwner) return null
    pending = (async () => {
      try {
        if (mounted) {
          mounted = false
          const dispose = disposeMount
          disposeMount = undefined
          await dispose?.()
        }
        const remote = getRemote()
        if (!remote) return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_NOT_READY') }
        if (typeof remote.$mount !== 'function') return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_INTERFACE_MISMATCH') }
        const dispose = await remote.$mount(descriptor)
        if (!active) {
          await dispose?.()
          return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_DISPOSED') }
        }
        disposeMount = dispose
        mountOwner = remote
        mounted = true
        return null
      } catch (error) {
        return { ok: false, ...reviewErrorDetails(classifyReviewFailure(error, 'CIEL_REMOTE_MOUNT_FAILED').code) }
      }
    })()
    try { return await pending } finally { pending = undefined }
  }
  return {
    ready,
    async call(method, request) {
      const invocation = descriptor?.descriptors?.find(item => item.method === method)
      if (invocation) {
        try { invocation.parameters[0].codec.create().parse(request) }
        catch { return { ok: false, ...reviewErrorDetails('CIEL_PROTOCOL_REQUEST_INVALID') } }
      }
      const decode = value => {
        if (invocation) {
          try { invocation.result.create().parse(value); assertReviewResultIdentity(method, request, value) }
          catch { return { ok: false, ...reviewErrorDetails('CIEL_PROTOCOL_RESPONSE_INVALID') } }
        }
        return value
      }
      const failure = await ready()
      if (failure) return failure
      if (!active) return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_DISPOSED') }
      const api = getApi()
      if (!api) return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_NOT_READY') }
      if (typeof api[method] !== 'function') return { ok: false, ...reviewErrorDetails('CIEL_REMOTE_INTERFACE_MISMATCH') }
      try {
        const result = await api[method](request)
        if (result?.ok === true && Object.hasOwn(result, 'value')) return decode(result.value)
        if (result?.ok === false && result.error && typeof result.error === 'object') {
          const { code, message } = result.error
          const known = reviewErrorDetails(['gateway/input-invalid', 'gateway/arguments-invalid', 'gateway/bad-request'].includes(code) ? 'CIEL_PROTOCOL_REQUEST_INVALID' : code === 'gateway/result-invalid' ? 'CIEL_PROTOCOL_RESPONSE_INVALID' : code)
          return { ok: false, ...(known || { code: code || 'remote_error', error: String(message || '远程调用失败') }) }
        }
        return decode(result)
      } catch (error) {
        const known = reviewErrorDetails(error?.code)
        return { ok: false, ...(known || { code: 'transport_error', error: '评审连接失败；请检查连接并重试。', retryable: true }) }
      }
    },
    async dispose() {
      active = false
      await pending
      const dispose = disposeMount
      disposeMount = undefined
      mounted = false
      await dispose?.()
    },
  }
}
