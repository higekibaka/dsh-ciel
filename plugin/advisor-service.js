import { hostTypertProtocol } from './runtime.js'
import { detectSensitiveText } from './sensitive-text.js'
import { advisorRepository } from './advisor-repository.js'

// One Remote-service identity with the Harness process: the typert Gateway
// resolves these descriptors against the protocol copy it imported itself.
const { TypertRemoteService, Remote } = hostTypertProtocol()

function remoteMarker(prototype, name) {
  let initializer
  Remote(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn) { initializer = fn },
  })
  return initializer
}

export class AdvisorService extends TypertRemoteService {
 constructor(ctx, repository = advisorRepository) {
  super(ctx, 'cielAdvisor')
  this.repository = repository
  for (const method of ['readAdvice','callModelUsage']) remoteMarker(Object.getPrototypeOf(this), method).call(this)
 }
  // Failures carry a stable machine-readable `code` next to the human `error`
  // string. The code is additive: the protocol already accepts an optional
  // `code`, old clients ignore it, and the prose stays byte-identical so log
  // replay and existing UI copy keep working.
  async readAdvice(request) {
    try {
      const { sessionId, callId } = request || {}
      const advice = await this.repository.readRecord('advice', sessionId, callId)
      if (!advice || advice.sessionId !== sessionId || advice.callId !== callId) {
        return { ok: false, code: 'CIEL_ADVICE_NOT_FOUND', error: '顾问记录不存在或不属于此会话' }
      }
      if (detectSensitiveText(advice.text)) {
        return { ok: false, code: 'CIEL_ADVICE_SENSITIVE', error: '顾问记录因隐私检查未提供' }
      }
      return { ok: true, advice }
    } catch (error) {
      return { ok: false, code: 'CIEL_ADVICE_UNAVAILABLE', error: '顾问记录不可用：' + (error.code || '读取失败') }
    }
  }

  async callModelUsage(request) {
    try {
      return { modelUsage: await this.repository.readCallModelUsage(request?.sessionId, request?.kind, request?.id) }
    } catch {
      return { ok: false, code: 'CIEL_USAGE_UNAVAILABLE', error: 'model usage record unavailable' }
    }
  }

}
