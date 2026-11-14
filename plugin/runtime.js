// Host module resolution for the two DSH packages Ciel must share with the
// process that runs it: @deepseek-ai/schemastery (one Schema identity, so the
// settings service accepts Ciel's config as its own) and
// @deepseek-ai/dsh-typert-protocol (one Remote-service identity, so the Gateway
// resolves Ciel's descriptors). A second copy of either is a real defect, so
// resolution is explicit and ordered instead of relying on whichever
// node_modules the installer happened to hoist.
//
// Everything here is synchronous on purpose: plugin/index.js and
// plugin/advisor-service.js keep plain top-level imports and no top-level await,
// which is what a loaded-by-path plugin needs.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The two shared host packages, in resolution-independent order. */
export const HOST_PACKAGES = Object.freeze(['@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol'])

const SCHEMASTERY = HOST_PACKAGES[0]
const TYPERT = HOST_PACKAGES[1]

/** Checkout-relative package directories that carry a resolvable node_modules. */
const CHECKOUT_BASES = Object.freeze([
  'packages/core/tools',
  'packages/llm/llm',
  'packages/core/session',
  'apps/cli',
  '.',
])

/** Install-root-relative directories a packaged Harness resolves modules from. */
const INSTALL_BASES = Object.freeze(['.', 'resources'])

// A built checkout also exposes the shared packages as first-class source
// packages that other DSH workspaces resolve by path; the checkout's linker may
// not publish them into any of CHECKOUT_BASES/node_modules.
const DIRECT_CHECKOUT_ROOTS = Object.freeze({
  [SCHEMASTERY]: Object.freeze(['vendor/schemastery']),
  [TYPERT]: Object.freeze(['packages/typert/protocol']),
})

/**
 * Raised when the host copy of a shared package cannot be located or loaded.
 * Carries the machine-readable `code`, the package name and every anchor that
 * was tried, so a broken install is diagnosable from the error alone.
 */
export class HostDependencyError extends Error {
  constructor(packageName, attempts, options) {
    const tried = attempts.length === 0 ? 'no host anchor was available' : attempts.join('; ')
    super(
      'Ciel cannot load the host copy of ' + packageName + '. ' +
      'Ciel is a plugin and must use the Harness process copy of this package, ' +
      'never a second copy of its own. Tried: ' + tried + '. ' +
      'Set DSH_CIEL_HOST_MODULES to the directory whose node_modules holds the Harness ' +
      'modules, or DSH_CHECKOUT to a built deepseek-harness checkout.',
    )
    this.name = 'HostDependencyError'
    this.code = 'CIEL_HOST_DEPENDENCY_UNAVAILABLE'
    this.packageName = packageName
    this.attempts = Object.freeze([...attempts])
    const cause = options && options.cause
    if (cause !== undefined) this.cause = cause
  }
}

/** Locate this plugin's own directory: the last-resort anchor. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Ordered anchors for host module resolution, most specific first:
 * an explicit override, a built checkout (its resolvable workspace packages,
 * then its source-mode workspace packages), a packaged install, the entry script
 * that started the host process, then this plugin's own node_modules.
 *
 * The checkout stage carries one extra `workspace: true` anchor holding the
 * checkout root. It is expanded per package by hostCandidates, inside that same
 * stage: a workspace copy must never outrank an explicit host override.
 * @returns {ReadonlyArray<{ source: string, base: string, workspace?: true }>}
 */
export function hostAnchors() {
  const anchors = []
  const push = (source, base, extra) => {
    if (typeof base === 'string' && base !== '') anchors.push(extra === undefined ? { source, base } : { source, base, ...extra })
  }
  const hostModules = process.env.DSH_CIEL_HOST_MODULES
  if (hostModules) push('DSH_CIEL_HOST_MODULES', hostModules)
  const checkout = process.env.DSH_CHECKOUT
  if (checkout) {
    for (const relative of CHECKOUT_BASES) push('DSH_CHECKOUT:' + relative, join(checkout, relative))
    push('DSH_CHECKOUT', checkout, { workspace: true })
  }
  const install = process.env.DSH_INSTALL_DIR
  if (install) for (const relative of INSTALL_BASES) push('DSH_INSTALL_DIR:' + relative, join(install, relative))
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    push('process.resourcesPath:app.asar/dsh', join(process.resourcesPath, 'app.asar', 'dsh'))
  }
  if (process.argv[1] && !process.argv[1].startsWith('-')) push('process.argv[1]', dirname(resolve(process.argv[1])))
  push('plugin', PLUGIN_DIR)
  return Object.freeze(anchors)
}

function readManifest(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Walk up from a resolved file to the package root that owns it. */
function packageRootOf(file, packageName) {
  let directory = dirname(file)
  for (;;) {
    const manifest = readManifest(directory)
    if (manifest && manifest.name === packageName) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Prefer the package's ES module entry: that is the instance the host imported. */
function entryFiles(root, manifest) {
  const pick = (value) => {
    if (typeof value === 'string') return value
    if (value === null || typeof value !== 'object') return undefined
    for (const key of ['import', 'module', 'default', 'node', 'require']) {
      if (typeof value[key] === 'string' && value[key].startsWith('./')) return value[key]
    }
    return undefined
  }
  const declared = manifest.exports && typeof manifest.exports === 'object' && '.' in manifest.exports
    ? manifest.exports['.']
    : manifest.exports
  const files = []
  const add = (value) => {
    if (typeof value === 'string' && value !== '') {
      const file = resolve(root, value)
      if (!files.includes(file)) files.push(file)
    }
  }
  add(pick(declared))
  add(manifest.module)
  add(manifest.main)
  add('./index.js')
  return files
}

/**
 * Every loadable entry for `packageName`, best first, plus the anchors that
 * failed before it. Exported so tests can assert the anchor order and the
 * failure report without touching the loader cache.
 *
 * The anchor list alone decides the order: no environment variable is read here,
 * so an explicit `anchors` argument is never preempted by DSH_CHECKOUT. A
 * checkout's source-mode workspace packages are expanded where that anchor
 * appears in the list, not before the list.
 */
export function hostCandidates(packageName, anchors = hostAnchors()) {
  const attempts = []
  const candidates = []
  const seen = new Set()
  const push = (source, file) => {
    const key = String(file).toLowerCase()
    if (seen.has(key) || !existsSync(file)) return
    seen.add(key)
    candidates.push({ source, file })
  }
  const pushRoot = (source, root) => {
    const manifest = readManifest(root)
    if (!manifest || manifest.name !== packageName) return false
    const before = candidates.length
    for (const file of entryFiles(root, manifest)) push(source, file)
    return candidates.length > before
  }
  for (const anchor of anchors) {
    if (anchor.workspace === true) {
      let matched = false
      for (const relative of DIRECT_CHECKOUT_ROOTS[packageName] || []) {
        if (pushRoot(anchor.source + ':' + relative, join(anchor.base, relative))) matched = true
      }
      if (!matched) attempts.push(anchor.source + ' (no workspace package)')
      continue
    }
    let resolved
    try {
      resolved = createRequire(join(anchor.base, 'ciel-host-anchor.cjs')).resolve(packageName)
    } catch (error) {
      attempts.push(anchor.source + ' (' + (error && error.code ? error.code : 'resolve failed') + ')')
      continue
    }
    const root = packageRootOf(resolved, packageName)
    if (root !== undefined) pushRoot(anchor.source, root)
    push(anchor.source, resolved)
  }
  return { attempts, candidates }
}

const loaded = new Map()

/**
 * Resolve and synchronously load one shared host package.
 * Results for the default anchor list are memoised; pass an explicit anchor list
 * to bypass and avoid the cache (used by tests).
 * @returns {{ packageName: string, source: string, file: string, module: unknown }}
 */
export function loadHostModule(packageName, anchors) {
  const shared = anchors === undefined
  if (shared && loaded.has(packageName)) return loaded.get(packageName)
  const { attempts, candidates } = hostCandidates(packageName, shared ? hostAnchors() : anchors)
  const failures = []
  const require = createRequire(import.meta.url)
  for (const candidate of candidates) {
    try {
      const value = require(candidate.file)
      const record = Object.freeze({ packageName, source: candidate.source, file: candidate.file, module: value })
      if (shared) loaded.set(packageName, record)
      return record
    } catch (error) {
      failures.push(candidate.file + ' (' + (error && error.code ? error.code : 'load failed') + ')')
    }
  }
  throw new HostDependencyError(packageName, [...attempts, ...failures])
}

/** Drop the memoised host modules so the next load re-runs resolution. */
export function resetHostModuleCache() {
  loaded.clear()
}

/** Diagnostics for one shared package, or undefined when it was never loaded. */
export function describeHostModule(packageName) {
  const record = loaded.get(packageName)
  return record === undefined ? undefined : { source: record.source, file: record.file }
}

/** The host's Schema class (the default export of @deepseek-ai/schemastery). */
export function hostSchemastery() {
  const value = loadHostModule(SCHEMASTERY).module
  return value !== null && typeof value === 'object' && value.default !== undefined ? value.default : value
}

/** The host's Typert protocol namespace (Remote, TypertRemoteService, ...). */
export function hostTypertProtocol() {
  return loadHostModule(TYPERT).module
}

export { SCHEMASTERY, TYPERT }
