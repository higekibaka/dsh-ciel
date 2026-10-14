import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { detectSensitiveText } from './sensitive-text.js'
import { advisorRepository } from './advisor-repository.js'
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
  async readAdvice(request) {
    try {
      const { sessionId, callId } = request || {}
      const advice = await this.repository.readRecord('advice', sessionId, callId)
      if (!advice || advice.sessionId !== sessionId || advice.callId !== callId) return { ok: false, error: '顾问记录不存在或不属于此会话' }
      if (detectSensitiveText(advice.text)) return { ok: false, error: '顾问记录因隐私检查未提供' }
      return { ok: true, advice }
    } catch (error) { return { ok: false, error: '顾问记录不可用：' + (error.code || '读取失败') } }
  }

  async callModelUsage(request) {
    try {
      return { modelUsage: await this.repository.readCallModelUsage(request?.sessionId, request?.kind, request?.id) }
    } catch {
      return { ok: false, error: 'model usage record unavailable' }
    }
  }

}
