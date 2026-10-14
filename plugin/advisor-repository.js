import * as records from './record-store.js'
import { detectSensitiveText } from './sensitive-text.js'
import { modelUsageSnapshot } from './model-usage.js'
import { parseAdvisorItems } from './advisor-content.js'
export function createAdvisorRepository({ store = records, home } = {}) {
  const options = home === undefined ? {} : { home }
  const readRecord = (kind, session, id, opts) => store.readRecord(kind, session, id, { ...options, ...opts })
  const writeRecord = (kind, session, id, value, opts) => store.writeRecord(kind, session, id, value, { ...options, ...opts })
  const validSession = sessionId => typeof sessionId === 'string' && sessionId.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)
  const callRecordId = (kind, id) => kind + ':' + id
  async function persistCallModelUsage(sessionId, kind, id, usage) {
    if (!validSession(sessionId) || !(kind === 'tool') || typeof id !== 'string' || id === '') return false
    await writeRecord('calls', sessionId, callRecordId(kind, id), { kind, id, modelUsage: modelUsageSnapshot(usage), createdAt: Date.now() })
    return true
  }
  async function readCallModelUsage(sessionId, kind, id) {
    if (!validSession(sessionId) || !(kind === 'tool') || typeof id !== 'string' || id === '') return null
    const record = await readRecord('calls', sessionId, callRecordId(kind, id))
    return record ? modelUsageSnapshot(record.modelUsage) : null
  }
  async function persistAdvice(sessionId, kind, id, text, usage, operation, jev) {
    if (detectSensitiveText(text)) throw new Error('顾问输出含疑似敏感内容，未保存')
    const callId = callRecordId(kind, id)
    const parsed = parseAdvisorItems(text)
    await writeRecord('advice', sessionId, callId, { sessionId, callId, kind, text, ...parsed, modelUsage: modelUsageSnapshot(usage), ...(jev ? { jev } : {}), createdAt: Date.now() }, { beforeCommit: operation ? () => operation.beginCommit() : undefined })
  }
  return { persistCallModelUsage, readCallModelUsage, persistAdvice, readRecord }
}
export const advisorRepository = createAdvisorRepository()
export const { persistCallModelUsage, readCallModelUsage, persistAdvice } = advisorRepository
