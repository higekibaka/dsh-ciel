import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Standalone, read-only review snapshot. Capture at REVIEW START, not before author work.
 * Strict capture supports Linux + Node.js >=22 + mounted, accessible procfs only.
 * Required descriptor/filesystem features are checked; fixture tests run on Node24.
 * Ancestors and children are opened through pinned directory descriptors with
 * O_NOFOLLOW; lstat/fstat identity and post-read metadata checks reject swaps.
 * Symlinks, multiply-linked files and nonregular files are never admitted.
 * This is not isolation from hostile in-process code or a privileged mount attacker.
 * Secret detection is deliberately heuristic: arbitrary secrets hidden in otherwise
 * allowed source are NOT detected. No author tool-output sharing is implemented.
 * Queries are synchronous and use owned in-memory strings only. grep is a LITERAL
 * substring search, NOT a regular expression. glob supports *, ?, and ** segments.
 * Tool path metadata is virtual; admitted source text is not silently rewritten.
 * Files containing protected absolute references are withheld as a whole.
 * publicInfo contains no rejected names or values.
 */
const MESSAGE = 'Review data unavailable or outside allowed scope'
const DEFAULTS = Object.freeze({ maxFiles: 2000, maxBytes: 8 * 1024 * 1024, maxFileBytes: 256 * 1024, maxEntries: 20000, maxDepth: 32, maxResults: 250, maxReadLines: 2000, maxOutputBytes: 256 * 1024 })
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.md', '.mdx', '.txt', '.rst', '.adoc', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.json', '.yaml', '.yml', '.toml', '.xml', '.graphql', '.gql', '.sql', '.py', '.pyi', '.rb', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.kts', '.swift', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.lua', '.php', '.r', '.ex', '.exs', '.erl', '.hrl', '.hs', '.scala', '.proto', '.dockerfile', '.cmake'])
const BASENAMES = new Set(['readme', 'license', 'licence', 'notice', 'copying', 'authors', 'changelog', 'contributing', 'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'cmakelists.txt', '.gitignore', '.gitattributes', '.editorconfig'])
const BLOCKED_DIRS = new Set(['.git', '.dsh', '.ssh', '.aws', '.azure', '.config', '.local', '.session-repair', '.cache', '.npm', '.pnpm-store', '.yarn', '.venv', 'venv', '__pycache__', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'logs', 'log', 'cache', 'caches', 'archives', 'archive'])
// Credential-looking DATA names remain excluded; ordinary implementation modules
// (auth.ts, token.js, credentials.py, etc.) still pass through content screening.
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.py', '.pyi', '.rb', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.kts', '.swift', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.lua', '.php', '.r', '.ex', '.exs', '.erl', '.hrl', '.hs', '.scala'])
const CREDENTIAL_DATA_NAME = /(?:^|[._-])(?:credentials?|secrets?|cookies?|auth(?:entication)?|tokens?)(?:[._-]|$)/i
// Renaming key material to a source extension must not bypass admission policy.
const ALWAYS_BLOCKED_NAME = /(?:^|[._-])(?:private[-_]?keys?|id_rsa|id_ed25519|id_dsa|id_ecdsa|session[-_]?records?|thought[-_]?records?)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)(?:[._-]|$)/i
const within = (value, root) => value === root || value.startsWith(root + '/')
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino
const unchanged = (a, b) => identity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n
function limited(reason = 'ACCESS_LIMITED') {
  const error = new Error(MESSAGE)
  error.code = 'CIEL_REVIEW_ACCESS_LIMITED'
  error.reason = reason
  // Do not expose host module paths through a consumer that formats error.stack.
  error.stack = `Error: ${MESSAGE}`
  return error
}
function unsupported() {
  const error = limited('UNSUPPORTED_PLATFORM')
  error.message = 'Restricted review capture requires Linux, descriptor-safe filesystem APIs, and accessible procfs descriptor traversal'
  error.stack = `Error: ${error.message}`
  return error
}
function checkSignal(signal) { if (signal?.aborted) throw limited('CANCELLED') }
function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\\%:\x00-\x1f\x7f]/.test(value) && !value.split('/').includes('..')
}
function absolute(value) {
  if (!validPath(value) || !path.isAbsolute(value)) throw limited()
  return path.posix.normalize(value).replace(/\/$/, '') || '/'
}
function blockedName(name) {
  const lower = name.toLowerCase()
  return lower === '.env' || lower.startsWith('.env.') || lower.startsWith('.env-')
    || ALWAYS_BLOCKED_NAME.test(name)
    || (CREDENTIAL_DATA_NAME.test(name) && !CODE_EXTENSIONS.has(path.extname(lower)))
    || /\.(?:pem|key|p12|pfx|keystore|log|jsonl|ndjson|zip|gz|bz2|xz|zst|tar|sqlite|db)$/i.test(name)
}
function allowedFile(name) { return !blockedName(name) && (EXTENSIONS.has(path.extname(name).toLowerCase()) || BASENAMES.has(name.toLowerCase())) }

/**
 * Values that only document a credential field: the shapes a real secret is
 * replaced BY. Treating these as secrets made ordinary prose and code examples
 * ("?token=…", "YOUR_API_KEY", "[redacted]") fail the whole review, so a match
 * whose value is one of them is not counted. A real secret never spells itself
 * out as a placeholder.
 */
const PLACEHOLDER_VALUE = /^(?:\.{2,}|…+|<[^<>]*>|\{\{?[^{}]*\}?\}|\[(?:redacted|hidden|removed|masked|secret|token|api[-_ ]?key)\]|x{3,}|\*{3,}|-{3,}|redacted|hidden|masked|placeholder|example|sample|dummy|your[-_ ].*|changeme|change[-_ ]?me|password|passwd|token|secret|api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|todo|tbd|null|none|undefined|true|false|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z_][A-Za-z0-9_]*|env\.[A-Za-z_][A-Za-z0-9_]*)$/i

/** The shortest value a real credential-shaped field is expected to carry. */
const SECRET_MIN_LENGTH = 8

/** Wrapper punctuation a documented placeholder is commonly quoted or listed in. */
const TRAILING_PUNCTUATION = /[)\]}>"'\u0060+,;:!?。，、；：！？）】」』]+$/u

/** Strip the wrapper punctuation a placeholder may be wrapped in. */
function cleanValue(value) {
  return value.replace(TRAILING_PUNCTUATION, '')
}

/** Whether a captured credential-shaped value is a placeholder, not a secret. */
function placeholderValue(value) {
  const cleaned = cleanValue(value)
  if (cleaned.length < SECRET_MIN_LENGTH && value.length < SECRET_MIN_LENGTH) return true
  return PLACEHOLDER_VALUE.test(cleaned) || PLACEHOLDER_VALUE.test(value)
}

/** Whether any query parameter carries a credential-looking value. */
function querySecret(text) {
  for (const match of text.matchAll(/[?&](?:access_token|api_key|token|password|secret)=([^\s&#"'\u0060<>]+)/gi)) {
    if (!placeholderValue(match[1])) return true
  }
  return false
}

/** Whether any assignment or key carries a quoted credential-looking value. */
function assignedSecret(text) {
  const quoted = /\b(?:[A-Za-z0-9_]*(?:password|passwd|api_?key|access_?token|auth_?token|client_?secret|private_?key)|secret|token)\s*["']?\s*[:=]\s*["'\u0060]([^"'\u0060\r\n]{4,})["'\u0060]/gi
  for (const match of text.matchAll(quoted)) {
    if (!placeholderValue(match[1])) return true
  }
  const bare = /\b(?:PASSWORD|PASSWD|API_KEY|ACCESS_TOKEN|CLIENT_SECRET|SECRET)\s*=\s*([^\s"'\u0060;$]{4,})/g
  for (const match of text.matchAll(bare)) {
    if (!placeholderValue(match[1])) return true
  }
  return false
}

/** Returns only a boolean, never matched text. False is NOT a guarantee of safety. */
export function detectSensitiveText(text) {
  if (typeof text !== 'string') return true
  return /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(text)
    || /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])|\bnpm_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/.test(text)
    || /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text)
    || querySecret(text)
    || /\b(?:authorization\s*[:=]\s*["'\u0060]?\s*)?(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|Basic\s+[A-Za-z0-9+/]{12,}={0,2})/i.test(text)
    || assignedSecret(text)
}

function segmentMatch(pattern, value) {
  let p = 0, v = 0, star = -1, retry = 0
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++ }
    else if (pattern[p] === '*') { star = p++; retry = v }
    else if (star >= 0) { p = star + 1; v = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
function wildcard(pattern, value) {
  if (!pattern.includes('/')) return segmentMatch(pattern, value.split('/').at(-1))
  const ps = pattern.split('/'), vs = value.split('/')
  let row = new Array(vs.length + 1).fill(false); row[0] = true
  for (const p of ps) {
    const next = new Array(vs.length + 1).fill(false)
    if (p === '**') {
      next[0] = row[0]
      for (let i = 1; i <= vs.length; i++) next[i] = row[i] || next[i - 1]
    } else for (let i = 1; i <= vs.length; i++) next[i] = row[i - 1] && segmentMatch(p, vs[i - 1])
    row = next
  }
  return row[vs.length]
}
function checkedPattern(pattern) {
  if (!validPath(pattern) || pattern.length > 256 || pattern.startsWith('/') || /[\[\]{}]/.test(pattern)) throw limited('INVALID_QUERY')
  return pattern.replace(/^\.\//, '')
}

export async function createReviewCorpus({ root, additionalRoots = [], protectedRoots = [], signal, limits = {} } = {}) {
  checkSignal(signal)
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK || !['statfs', 'opendir', 'open', 'lstat'].every(name => typeof fs[name] === 'function')) {
    throw unsupported()
  }
  if (!Array.isArray(additionalRoots) || !Array.isArray(protectedRoots) || additionalRoots.length > 16 || protectedRoots.length > 128 || !limits || typeof limits !== 'object') throw limited()
  const bounds = { ...DEFAULTS }
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[key]) throw limited('INVALID_LIMITS')
    bounds[key] = value
  }
  const roots = [root, ...additionalRoots].map(absolute)
  const protectedPaths = [...new Set([...protectedRoots.map(absolute), path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.aws'), ...(process.env.DSH_HOME ? [absolute(process.env.DSH_HOME)] : [])])]
  const broad = new Set(['/', '/home', '/root', '/tmp', '/var', '/var/tmp', '/var/lib', '/var/log', '/var/cache', '/var/spool', '/var/backups', '/usr', '/usr/local', '/opt', '/srv', '/etc', '/proc', '/sys', '/dev', '/run', '/boot', '/mnt', '/media', os.homedir()])
  for (const r of roots) {
    if (broad.has(r) || /^\/home\/[^/]+$/.test(r) || ['/etc', '/proc', '/sys', '/dev', '/run', '/boot', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/var/log', '/var/cache', '/var/spool', '/var/backups'].some(p => within(r, p)) || protectedPaths.some(p => within(r, p)) || r.split('/').some(p => BLOCKED_DIRS.has(p.toLowerCase()) || blockedName(p))) throw limited()
  }
  // Overlapping approvals are ambiguous and may otherwise create alternate aliases.
  if (roots.some((r, i) => roots.some((other, j) => i !== j && (within(r, other) || within(other, r))))) throw limited()
  let mappings = roots.map((real, i) => ({ real, virtual: i === 0 ? '/project' : `/external-${i}` }))
  let redactions = [...protectedPaths].sort((a, b) => b.length - a.length)
  const files = new Map(), directories = new Set()
  let bytes = 0, scannedBytes = 0, entries = 0, truncated = false, disposed = false
  const handles = new Set()
  const anchor = handle => `/proc/self/fd/${handle.fd}`
  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  async function close(handle) { handles.delete(handle); await handle.close().catch(() => {}) }
  async function openChecked(parent, name, directory) {
    checkSignal(signal)
    const location = `${anchor(parent)}/${name}`
    const before = await fs.lstat(location, { bigint: true })
    if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n)) throw limited()
    const handle = await fs.open(location, openFlags | (directory ? constants.O_DIRECTORY : 0))
    handles.add(handle)
    const after = await handle.stat({ bigint: true })
    if (!identity(before, after) || (directory ? !after.isDirectory() : !after.isFile() || after.nlink !== 1n)) { await close(handle); throw limited() }
    return handle
  }
  async function openRoot(real) {
    let current = await fs.open('/', openFlags | constants.O_DIRECTORY); handles.add(current)
    try {
      for (const part of real.split('/').filter(Boolean)) {
        const next = await openChecked(current, part, true)
        await close(current); current = next
      }
      return current
    } catch (error) { await close(current); throw error }
  }
  function rewriteOwned(text) {
    // Boundary-aware replacement; never replace a sibling root such as /app-backup.
    const boundary = char => !char || /[\s/"'`<>()[\]{},;:!?=]/.test(char)
    const replaceRoot = (input, real, replacement, redactTail) => {
      let output = '', start = 0, at
      while ((at = input.indexOf(real, start)) !== -1) {
        const before = input[at - 1], after = input[at + real.length]
        if ((at === 0 || /[\s"'`<>()[\]{},;:=]/.test(before)) && boundary(after)) {
          let end = at + real.length
          if (redactTail) while (end < input.length && !/[\s"'`<>()[\]{},;!?]/.test(input[end])) end++
          output += input.slice(start, at) + replacement; start = end
        } else { output += input.slice(start, at + real.length); start = at + real.length }
      }
      return output + input.slice(start)
    }
    for (const real of redactions) text = replaceRoot(text, real, '[protected path]', true)
    for (const { real, virtual } of [...mappings].sort((a, b) => b.real.length - a.real.length)) text = replaceRoot(text, real, virtual, false)
    return text
  }
  async function captureFile(parent, name, virtual) {
    let handle
    try {
      handle = await openChecked(parent, name, false)
      const before = await handle.stat({ bigint: true })
      if (before.size > BigInt(bounds.maxFileBytes) || before.size > BigInt(bounds.maxBytes - scannedBytes)) { truncated = true; return }
      scannedBytes += Number(before.size)
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let used = 0
      while (used < buffer.length) {
        checkSignal(signal)
        const result = await handle.read(buffer, used, buffer.length - used, used)
        if (!result.bytesRead) break
        used += result.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const linked = await fs.lstat(`${anchor(parent)}/${name}`, { bigint: true })
      if (used !== Number(before.size) || !unchanged(before, after) || !unchanged(after, linked) || !linked.isFile()) return
      checkSignal(signal)
      let text
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)) } catch { return }
      if (text.includes('\0') || detectSensitiveText(text)) return
      // Never silently edit source literals: an aliased path string could
      // change the meaning of code under review. Withhold protected references
      // as a whole; admitted source bytes stay exact (path metadata is virtual).
      if (redactions.some(root => text.includes(root))) return
      const size = Buffer.byteLength(text)
      if (size > bounds.maxFileBytes || size > bounds.maxBytes - bytes) { truncated = true; return }
      files.set(virtual, text); bytes += size
    } catch (error) { if (signal?.aborted) throw limited('CANCELLED') /* unreadable/changed files are excluded */ }
    finally { if (handle) await close(handle) }
  }
  async function walk(handle, real, virtual, depth) {
    checkSignal(signal)
    // Streaming enumeration bounds memory even when a directory has millions of entries.
    // If enumeration overflows, admit none of that directory's entries rather than
    // a filesystem-order-dependent prefix.
    const names = []
    const stream = await fs.opendir(anchor(handle))
    try {
      for await (const entry of stream) {
        checkSignal(signal)
        if (entries >= bounds.maxEntries) { truncated = true; names.length = 0; break }
        entries++; names.push(entry.name)
      }
    } finally { await stream.close().catch(() => {}) }
    directories.add(virtual)
    names.sort()
    for (const name of names) {
      checkSignal(signal)
      if (files.size >= bounds.maxFiles || bytes >= bounds.maxBytes) { truncated = true; break }
      if (!validPath(name) || blockedName(name) || BLOCKED_DIRS.has(name.toLowerCase())) continue
      const childReal = `${real}/${name}`, childVirtual = `${virtual}/${name}`
      if (childReal.length > 4096 || protectedPaths.some(p => within(childReal, p))) continue
      let stat
      try { stat = await fs.lstat(`${anchor(handle)}/${name}`, { bigint: true }) } catch { continue }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (depth >= bounds.maxDepth || entries >= bounds.maxEntries) { truncated = true; continue }
        let child
        try { child = await openChecked(handle, name, true); await walk(child, childReal, childVirtual, depth + 1) }
        catch { if (signal?.aborted) throw limited('CANCELLED') }
        finally { if (child) await close(child) }
      } else if (stat.isFile() && stat.nlink === 1n && allowedFile(name)) await captureFile(handle, name, childVirtual)
    }
  }
  try {
    try {
      const proc = await fs.statfs('/proc/self/fd')
      if (proc.type !== 0x9fa0) throw unsupported()
    } catch { throw unsupported() }
    for (const mapping of mappings) {
      checkSignal(signal)
      const handle = await openRoot(mapping.real)
      try { await walk(handle, mapping.real, mapping.virtual, 0) } finally { await close(handle) }
    }
    checkSignal(signal)
  } catch (error) {
    files.clear(); directories.clear()
    if (error?.code === 'CIEL_REVIEW_ACCESS_LIMITED') throw error
    throw limited(signal?.aborted ? 'CANCELLED' : 'CAPTURE_UNAVAILABLE')
  } finally { await Promise.all([...handles].map(close)) }

  function active() { if (disposed) throw limited('DISPOSED'); checkSignal(signal) }
  function resolve(input = '/project') {
    active()
    if (!validPath(input)) throw limited('INVALID_QUERY')
    let result = input
    if (input.startsWith('/')) {
      const original = mappings.find(m => within(input, m.real))
      if (original) result = original.virtual + input.slice(original.real.length)
    } else result = '/project/' + input
    result = path.posix.normalize(result).replace(/\/$/, '')
    if (!mappings.some(m => within(result, m.virtual)) || (!files.has(result) && !directories.has(result))) throw limited()
    return result
  }
  function scoped(input) {
    const scope = resolve(input)
    return [...files.keys()].filter(name => within(name, scope)).sort().map(name => [name, files.get(name), files.has(scope) ? path.posix.basename(name) : name.slice(scope.length + 1)])
  }
  function integer(value, fallback, maximum) {
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw limited('INVALID_QUERY')
    return value
  }
  return Object.freeze({
    read(args) {
      active()
      if (!args || !Object.hasOwn(args, 'file_path')) throw limited('INVALID_QUERY')
      const name = resolve(args.file_path)
      if (!files.has(name)) throw limited()
      const offset = integer(args.offset, 1, Number.MAX_SAFE_INTEGER), count = integer(args.limit, bounds.maxReadLines, bounds.maxReadLines)
      const stored = files.get(name)
      const lines = stored === '' ? [] : stored.split('\n')
      // A final newline terminates the last line; it does not create a phantom
      // extra content line. Match the official reader's streaming semantics.
      if (lines.at(-1) === '') lines.pop()
      const selected = lines.slice(offset - 1, offset - 1 + count)
      let content = '', used = 0
      for (const line of selected) {
        const next = (used ? '\n' : '') + line
        if (Buffer.byteLength(content) + Buffer.byteLength(next) > bounds.maxOutputBytes) {
          if (!used) throw limited('QUERY_LIMIT')
          break
        }
        content += next; used++
      }
      let newlineOmitted = false
      if (used > 0 && offset - 1 + used === lines.length && stored.endsWith('\n')) {
        if (Buffer.byteLength(content) + 1 <= bounds.maxOutputBytes) content += '\n'
        else newlineOmitted = true
      }
      return { file_path: name, offset, total_lines: lines.length, content, truncated: offset - 1 + used < lines.length || newlineOmitted }
    },
    grep(args) {
      active()
      if (!args || typeof args.pattern !== 'string' || !args.pattern.length || args.pattern.length > 4096) throw limited('INVALID_QUERY')
      const include = args.include === undefined ? undefined : checkedPattern(args.include)
      const matches = []; let outputBytes = 0
      for (const [name, text, relative] of scoped(args.path)) {
        checkSignal(signal)
        if (include && !wildcard(include, relative)) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) if (lines[i].includes(args.pattern)) {
          const size = Buffer.byteLength(lines[i]) + Buffer.byteLength(name) + 32
          if (matches.length >= bounds.maxResults || outputBytes + size > bounds.maxOutputBytes) {
            if (!matches.length) throw limited('QUERY_LIMIT')
            return { matches, truncated: true }
          }
          matches.push({ file_path: name, line_number: i + 1, line: lines[i] }); outputBytes += size
        }
      }
      return { matches, truncated }
    },
    glob(args) {
      active()
      if (!args) throw limited('INVALID_QUERY')
      const pattern = checkedPattern(args.pattern), paths = []; let outputBytes = 0
      for (const [name, , relative] of scoped(args.path)) if (wildcard(pattern, relative)) {
        const size = Buffer.byteLength(name)
        if (paths.length >= bounds.maxResults || outputBytes + size > bounds.maxOutputBytes) {
          if (!paths.length) throw limited('QUERY_LIMIT')
          return { paths, truncated: true }
        }
        paths.push(name); outputBytes += size
      }
      return { paths, truncated }
    },
    publicInfo() { active(); return { fileCount: files.size, byteCount: bytes, roots: mappings.map(m => m.virtual), truncated } },
    rewritePaths(text) { active(); if (typeof text !== 'string' || text.length > bounds.maxBytes) throw limited('INVALID_QUERY'); return rewriteOwned(text) },
    dispose() { files.clear(); directories.clear(); mappings = []; redactions = []; bytes = 0; disposed = true },
  })
}
