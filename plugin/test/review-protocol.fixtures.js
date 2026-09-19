export const requestFixtures = {
  list: { sessionId: 's' }, start: { sessionId: 's', messageId: 'm' }, feedback: { legacy: true },
  prepareFeedback: { sessionId: 's', reviewId: 'r', messageId: 'm', items: [{ index: 0 }] },
  triage: { sessionId: 's', reviewId: 'r', changes: [{ index: 0, state: 'accept' }] },
  progress: { sessionId: 's', messageId: 'm' }, cancel: { sessionId: 's', messageId: 'm' },
  callModelUsage: { sessionId: 's', kind: 'tool', id: 'c' }, readReview: { sessionId: 's', reviewId: 'r' },
  readEvidence: { sessionId: 's', reviewId: 'r', evidenceId: 'e1' }, readAdvice: { sessionId: 's', callId: 'tool:c' },
  inboxList: { sessionId: 's', limit: 25 },
  inboxSetIntent: { sessionId: 's', reviewId: 'r', reviewFingerprint: 'a'.repeat(64), index: 0, expectedRevision: 0, intent: 'planned' },
}
export const resultFixtures = {
  list: { reviews: [], sentKeys: [], triage: {}, nextCursor: null, limited: false },
  start: { ok: true, review: { sessionId: 's', messageId: 'm', reviewId: 'r', status: 'completed', createdAt: 1, annotations: [] } },
  feedback: { ok: false, error: 'stale client' }, prepareFeedback: { ok: true, sessionId: 's', reviewId: 'r', messageId: 'm', text: 'fixture', count: 1 },
  triage: { ok: true }, progress: { inFlight: false }, cancel: { ok: true, cancelled: false }, callModelUsage: { modelUsage: null },
  readReview: { ok: true, review: { sessionId: 's', messageId: 'm', reviewId: 'r', status: 'completed', createdAt: 1, annotations: [] } },
  readEvidence: { ok: true, evidence: { id: 'e1', content: 'fixture', contentSha256: 'b'.repeat(64) } },
  readAdvice: { ok: true, advice: { sessionId: 's', callId: 'tool:c', text: 'fixture' } },
  inboxList: { ok: true, sessionId: 's', reviews: [], nextCursor: null, limited: false },
  inboxSetIntent: { ok: true, sessionId: 's', reviewId: 'r', reviewFingerprint: 'a'.repeat(64), revision: 1, intents: { 0: 'planned' } },
}

export function completeReviewFixture(result, request) {
  if (!result || typeof result !== 'object') return result
  const complete = row => row && typeof row === 'object' ? { sessionId: request.sessionId, createdAt: 0, status: 'completed', annotations: [], ...row } : row
  return { ...result, ...(Array.isArray(result.reviews) ? { reviews: result.reviews.map(complete) } : {}), ...(result.review ? { review: complete(result.review) } : {}) }
}
