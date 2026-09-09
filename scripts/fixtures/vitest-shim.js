// Minimal vitest surface for the target's test-support modules, which import
// vitest only for snapshot/assertion helpers. No test framework runs here.
export const expect = { addSnapshotSerializer() {} }
function makeFn(impl) {
  const fn = (...args) => (impl === undefined ? undefined : impl(...args))
  fn.mock = { calls: [], results: [] }
  fn.mockReturnValue = () => fn
  fn.mockResolvedValue = () => fn
  fn.mockImplementation = () => fn
  fn.mockClear = () => fn
  fn.mockReset = () => fn
  return fn
}
export const vi = { fn: makeFn, spyOn: () => makeFn(), restoreAllMocks() {}, clearAllMocks() {}, stubGlobal() {} }
export const afterEach = () => {}
export const beforeEach = () => {}
export const describe = () => {}
export const it = () => {}
export default { expect, vi, afterEach, beforeEach, describe, it }
