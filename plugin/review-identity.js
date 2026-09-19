// A DSH fork preserves message IDs. Every message cache must include its session.
export const reviewMessageKey = (sessionId, messageId) => JSON.stringify([sessionId, messageId])
