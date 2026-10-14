/**
 * Ciel record store — schema v1.
 *
 * This module owns the advisor data root: `<home>/ciel/v1`. It never reads or writes the legacy
 * `<home>/dsh-advisor` root; old records are intentionally not migrated.
 *
 * On-disk layout (one record per file, never an append-only log):
 *
 *   <home>/ciel/v1/<kind>/<sessionId>/<base64url(sha256(id))>.json
 *
 * Envelope (exactly the persisted schema):
 *
 *   { schemaVersion: 1, kind, sessionId, id, value }
 *
 * Why a hashed filename: an `id` may be an opaque host toolCallId that
 * contains ':' and other characters that must never be interpreted as a path.
 * The id is stored verbatim inside the envelope and the file is addressed by a
 * fixed-length base64url SHA-256 of it, so no id text ever reaches the
 * filesystem namespace.
 *
 * Security posture: this defends ordinary path bypass for an unprivileged local
 * attacker — traversal, symlinked directories/files, hard-linked files,
 * oversized files, torn/replaced reads. It does NOT defend against a malicious
 * privileged process that can rewrite the tree concurrently. The store only
 * persists caller-supplied JSON; privacy filtering of `value` belongs to the
 * caller and this module never copies full source trees or credentials on its
 * own.
 *
 * `options.home` exists only for tests to inject a temporary directory; every
 * public read/write/list function accepts it. Production callers omit it and
 * the module resolves `DSH_HOME` (falling back to `~/.dsh`).
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The persisted envelope schema version. */
export const RECORD_SCHEMA_VERSION = 1

/** Active advisor record kinds; historical data remains untouched. */
export const RECORD_KINDS = Object.freeze(['advice', 'calls'])

/** Hard per-file bound; an oversized record is an explicit error, never truncated. */
export const RECORD_MAX_FILE_BYTES = 512 * 1024

/** Identity length caps. */
export const RECORD_MAX_SESSION_ID_LENGTH = 128
export const RECORD_MAX_ID_LENGTH = 512

const KIND_SET = new Set(RECORD_KINDS)
// sessionId becomes a directory name, so it must be a single safe path segment:
// no separators, no '.' / '..' (the leading-alphanumeric rule also excludes
// hidden directories). Dots remain legal inside the id.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STORE_PARTS = Object.freeze(['ciel', 'v1'])
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

/** A store failure with a stable machine-readable `code` and a body-free message. */
export class RecordStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RecordStoreError'
    this.code = code
    // Never retain a raw stack with host paths; the code is the contract.
    this.stack = 'RecordStoreError: ' + message
  }
}

function fail(code, message) {
  throw new RecordStoreError(code, message)
}

function assertKind(kind) {
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    fail('CIEL_RECORD_INVALID_KIND', 'unsupported record kind')
  }
}

function assertSessionId(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > RECORD_MAX_SESSION_ID_LENGTH ||
    sessionId === '.' ||
    sessionId === '..' ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    fail('CIEL_RECORD_INVALID_SESSION', 'invalid session id')
  }
}

function assertId(id) {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > RECORD_MAX_ID_LENGTH ||
    id.includes('\u0000')
  ) {
    fail('CIEL_RECORD_INVALID_ID', 'invalid record id')
  }
}

function resolveHome(home) {
  if (typeof home !== 'string' || home.length === 0) {
    fail('CIEL_RECORD_INVALID_HOME', 'invalid home directory')
  }
  return resolve(home)
}

function homeFromOptions(options) {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    fail('CIEL_RECORD_INVALID_HOME', 'options must be an object')
  }
  const home = options?.home
  // Only an absent key falls back to the environment; an explicit null/'' is a
  // caller bug, not an invitation to touch the real home.
  if (home !== undefined) return resolveHome(home)
  return resolveHome(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

/**
 * The schema-v1 store root for `home` (default: `DSH_HOME` or `~/.dsh`).
 * Pure path computation; it does not create, read or validate the directory.
 */
export function recordRoot(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(resolveHome(home), ...STORE_PARTS)
}

function recordFileName(id) {
  return createHash('sha256').update(id, 'utf8').digest('base64url') + '.json'
}

async function lstatOrNull(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

function assertRealDirectory(stats) {
  if (stats.isSymbolicLink()) {
    fail('CIEL_RECORD_UNSAFE_PATH', 'record directory must not be a symbolic link')
  }
  if (!stats.isDirectory()) {
    fail('CIEL_RECORD_UNSAFE_PATH', 'record path component is not a directory')
  }
}

/**
 * Walk the store components without creating anything. Returns the session
 * directory, or null when the store/session simply does not exist yet. Any
 * symlinked or non-directory component is refused.
 */
async function locateStoreDir(home, kind, sessionId) {
  let current = resolveHome(home)
  for (const part of [...STORE_PARTS, kind, sessionId]) {
    const next = join(current, part)
    const stats = await lstatOrNull(next)
    if (stats === null) return null
    assertRealDirectory(stats)
    current = next
  }
  return current
}

/**
 * Create the store/session directory tree (mode 0700) component by component,
 * re-validating each component so a pre-existing symlink cannot be followed.
 */
async function ensureStoreDir(home, kind, sessionId) {
  const base = resolveHome(home)
  await mkdir(base, { recursive: true, mode: 0o700 })
  let current = base
  for (const part of [...STORE_PARTS, kind, sessionId]) {
    const next = join(current, part)
    let stats = await lstatOrNull(next)
    if (stats === null) {
      try {
        await mkdir(next, { mode: 0o700 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      stats = await lstat(next)
    }
    assertRealDirectory(stats)
    // Creation mode is already 0700; chmod also tightens a pre-existing
    // directory. Best effort: some filesystems reject chmod.
    await chmod(next, 0o700).catch(() => {})
    current = next
  }
  return current
}

/** Refuse to atomically replace anything that is not a plain, unlinked file. */
async function assertReplaceableFile(path) {
  const stats = await lstatOrNull(path)
  if (stats === null) return
  if (stats.isSymbolicLink()) {
    fail('CIEL_RECORD_UNSAFE_PATH', 'refusing to replace a symbolic link')
  }
  if (!stats.isFile()) {
    fail('CIEL_RECORD_UNSAFE_PATH', 'refusing to replace a non-regular file')
  }
  if (stats.nlink > 1) {
    fail('CIEL_RECORD_UNSAFE_PATH', 'refusing to replace a hard-linked file')
  }
}

/**
 * Write `serialized` to `path` atomically: create a random temp file in the
 * same directory with O_EXCL, fsync it, then rename over the target. Same-key
 * writes therefore atomically replace the prior record (the intended way to
 * publish final advice); cross-identity replacement cannot happen
 * because the target filename is derived from kind/session/id.
 */
async function atomicWriteFile(path, serialized, beforeCommit) {
  const temp = join(dirname(path), '.tmp-' + randomBytes(16).toString('hex'))
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(serialized)
    await handle.sync()
    await handle.close()
    handle = undefined
    // Synchronous terminal fence: no await may separate it from publication.
    beforeCommit?.()
    await rename(temp, path)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * Bounded, symlink-safe read. Returns `{ buffer, stats }`, or null when the
 * file is missing and `allowMissing` is true. The file is opened with
 * O_NOFOLLOW, its size is checked BEFORE allocation, and size/identity are
 * re-checked after the read so a torn or replaced file cannot be parsed.
 */
async function readRecordFile(path, { allowMissing = true } = {}) {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (allowMissing) return null
      fail('CIEL_RECORD_CHANGED', 'record disappeared during listing')
    }
    if (error.code === 'ELOOP') {
      fail('CIEL_RECORD_UNSAFE_PATH', 'record file must not be a symbolic link')
    }
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      fail('CIEL_RECORD_UNSAFE_PATH', 'record path is not a regular file')
    }
    if (before.nlink > 1) {
      fail('CIEL_RECORD_UNSAFE_PATH', 'record file must not be hard-linked')
    }
    if (before.size > RECORD_MAX_FILE_BYTES) {
      fail('CIEL_RECORD_TOO_LARGE', 'record file exceeds ' + RECORD_MAX_FILE_BYTES + ' bytes')
    }
    if (before.size === 0) {
      fail('CIEL_RECORD_CORRUPT', 'record file is empty')
    }
    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, offset, before.size - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    if (offset !== before.size) {
      fail('CIEL_RECORD_CHANGED', 'record file changed while reading')
    }
    const after = await handle.stat()
    if (
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs
    ) {
      fail('CIEL_RECORD_CHANGED', 'record file changed while reading')
    }
    return { buffer, stats: before }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Parse and structurally validate an envelope. Messages never include the body. */
function parseRecord(buffer) {
  let record
  try {
    record = JSON.parse(buffer.toString('utf8'))
  } catch {
    fail('CIEL_RECORD_CORRUPT', 'record is not valid JSON')
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail('CIEL_RECORD_CORRUPT', 'record envelope is not an object')
  }
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION) {
    const got = typeof record.schemaVersion === 'number' ? ' (' + record.schemaVersion + ')' : ''
    fail('CIEL_RECORD_VERSION', 'unsupported record schema version' + got)
  }
  return record
}

function hasOwnValue(record) {
  return Object.prototype.hasOwnProperty.call(record, 'value')
}

/** Exact ownership check: kind, session and id must all match the request. */
function assertRecordIdentity(record, kind, sessionId, id) {
  if (record.kind !== kind || record.sessionId !== sessionId || record.id !== id) {
    fail('CIEL_RECORD_IDENTITY', 'stored record does not belong to the requested identity')
  }
  if (!hasOwnValue(record)) {
    fail('CIEL_RECORD_CORRUPT', 'record envelope is missing its value')
  }
  return record.value
}

/**
 * Persist one record under `<home>/ciel/v1/<kind>/<sessionId>/`.
 * A same-key write atomically replaces the previous record; a write can never
 * replace a record of another kind/session/id. Returns frozen identity metadata
 * (never a copy of `value`).
 *
 * @param {string} kind advice | calls
 * @param {string} sessionId safe single path segment
 * @param {string} id opaque id (may contain ':')
 * @param {unknown} value JSON-serializable payload
 * @param {{ home?: string, beforeCommit?: () => void }} [options] home override and synchronous publication fence
 */
export async function writeRecord(kind, sessionId, id, value, options = {}) {
  assertKind(kind)
  assertSessionId(sessionId)
  assertId(id)
  const home = homeFromOptions(options)
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    fail('CIEL_RECORD_INVALID_VALUE', 'record value is not JSON-serializable')
  }
  let serialized
  try {
    serialized = JSON.stringify({
      schemaVersion: RECORD_SCHEMA_VERSION,
      kind,
      sessionId,
      id,
      value,
    })
  } catch {
    fail('CIEL_RECORD_INVALID_VALUE', 'record value is not JSON-serializable')
  }
  if (typeof serialized !== 'string') {
    fail('CIEL_RECORD_INVALID_VALUE', 'record value is not JSON-serializable')
  }
  // JSON.stringify drops function/symbol/toJSON-undefined values entirely; an
  // envelope that lost its value is a caller bug, not a record.
  let carried
  try {
    carried = JSON.parse(serialized)
  } catch {
    fail('CIEL_RECORD_INVALID_VALUE', 'record value is not JSON-serializable')
  }
  if (carried === null || typeof carried !== 'object' || !hasOwnValue(carried)) {
    fail('CIEL_RECORD_INVALID_VALUE', 'record value is not JSON-serializable')
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > RECORD_MAX_FILE_BYTES) {
    fail('CIEL_RECORD_TOO_LARGE', 'record exceeds ' + RECORD_MAX_FILE_BYTES + ' bytes')
  }
  const dir = await ensureStoreDir(home, kind, sessionId)
  const path = join(dir, recordFileName(id))
  await assertReplaceableFile(path)
  await atomicWriteFile(path, serialized, options.beforeCommit)
  return Object.freeze({ schemaVersion: RECORD_SCHEMA_VERSION, kind, sessionId, id, bytes })
}

/**
 * Read one record and return its `value`. A missing record (or missing store)
 * returns null. Bad JSON, an unsupported schemaVersion, an empty/oversized file
 * or an identity mismatch throws a `RecordStoreError`; error messages never
 * contain the stored body.
 *
 * @param {string} kind
 * @param {string} sessionId
 * @param {string} id
 * @param {{ home?: string }} [options] home injection for tests only
 * @returns {Promise<unknown|null>}
 */
export async function readRecord(kind, sessionId, id, options = {}) {
  assertKind(kind)
  assertSessionId(sessionId)
  assertId(id)
  const home = homeFromOptions(options)
  const dir = await locateStoreDir(home, kind, sessionId)
  if (dir === null) return null
  const read = await readRecordFile(join(dir, recordFileName(id)))
  if (read === null) return null
  return assertRecordIdentity(parseRecord(read.buffer), kind, sessionId, id)
}
