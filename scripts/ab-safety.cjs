// Pure correlation checks shared by the optional paid driver and offline tests.
function reviewFileName(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error('Missing or unsafe session identity; refusing sidecar guessing')
  return sessionId + '.jsonl'
}
function assertReviewIdentity(identity, provider, model) {
  if (!identity || typeof identity.messageId !== 'string' || !identity.messageId || identity.provider !== provider || identity.model !== model) {
    throw new Error('Critic identity/route is missing or mismatched; review NOT started')
  }
  reviewFileName(identity.sessionId)
}
function matchingReview(text, messageId, since) {
  const entries = String(text).split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const entry = entries.filter((e) => e && e.messageId === messageId && e.createdAt >= since).at(-1)
  if (!entry) throw new Error('No fresh review for the exact message; refusing unrelated sidecar data')
  return entry
}
module.exports = { reviewFileName, assertReviewIdentity, matchingReview }
