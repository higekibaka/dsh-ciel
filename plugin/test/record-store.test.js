import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  RECORD_MAX_FILE_BYTES,
  RECORD_SCHEMA_VERSION,
  RecordStoreError,
  readRecord,
  recordRoot,
  writeRecord,
} from '../record-store.js'

// Every test injects options.home with a fresh temp directory. No test ever
// reads or writes the real DSH_HOME / ~/.dsh.
const homes = []
async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ciel-record-'))
  homes.push(home)
  return home
}
after(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
})

const fileNameFor = (id) => createHash('sha256').update(id, 'utf8').digest('base64url') + '.json'
const recordPath = (home, kind, sessionId, id) => join(home, 'ciel', 'v1', kind, sessionId, fileNameFor(id))

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

async function expectCode(code, fn) {
  let error
  try { await fn() } catch (caught) { error = caught }
  assert.ok(error instanceof RecordStoreError, 'expected RecordStoreError ' + code + ', got ' + error)
  assert.equal(error.code, code)
  return error
}

test('schema version is 1 and the root is the new ciel/v1 root', async () => {
  assert.equal(RECORD_SCHEMA_VERSION, 1)
  const home = await tempHome()
  const root = recordRoot(home)
  assert.equal(root, join(home, 'ciel', 'v1'))
  assert.ok(!root.includes('dsh-advisor'))
})

test('recordRoot defaults to DSH_HOME without reading the real home', async () => {
  const home = await tempHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(recordRoot(), join(home, 'ciel', 'v1'))
    // The default also drives write/read when options.home is absent.
    await writeRecord('advice', 'sess-default', 'k', { ok: true })
    assert.deepEqual(await readRecord('advice', 'sess-default', 'k'), { ok: true })
    assert.ok(await exists(recordPath(home, 'advice', 'sess-default', 'k')))
    assert.ok(!(await exists(join(home, 'dsh-advisor'))))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('writeRecord/readRecord round-trip arbitrary JSON and return identity metadata', async () => {
  const home = await tempHome()
  const value = { note: '证据', nested: { list: [1, null, true], text: 'a\nb' } }
  const meta = await writeRecord('calls', 'session-abc', 'toolcall:read:1', value, { home })
  assert.equal(meta.schemaVersion, 1)
  assert.equal(meta.kind, 'calls')
  assert.equal(meta.sessionId, 'session-abc')
  assert.equal(meta.id, 'toolcall:read:1')
  assert.ok(meta.bytes > 0)
  assert.deepEqual(await readRecord('calls', 'session-abc', 'toolcall:read:1', { home }), value)
})

test('records live at hashed filenames and never expose the opaque id as a path', async () => {
  const home = await tempHome()
  const sessionId = 'session-path'
  const colonId = 'toolcall:read:42'
  const slashId = 'weird/../../escape'
  await writeRecord('calls', sessionId, colonId, { a: 1 }, { home })
  await writeRecord('calls', sessionId, slashId, { b: 2 }, { home })
  const dir = join(home, 'ciel', 'v1', 'calls', sessionId)
  const names = await readdir(dir)
  assert.equal(names.length, 2)
  for (const name of names) {
    assert.equal(name, basename(name))
    assert.ok(!name.includes(':'))
    assert.ok(!name.includes('/'))
    assert.ok(!name.includes('..'))
    assert.match(name, /^[A-Za-z0-9_-]{43}\.json$/)
  }
  assert.deepEqual(await readRecord('calls', sessionId, colonId, { home }), { a: 1 })
  assert.deepEqual(await readRecord('calls', sessionId, slashId, { home }), { b: 2 })
})

test('directory mode is 0700 and record file mode is 0600', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-mode', 'k', { ok: 1 }, { home })
  assert.equal((await stat(join(home, 'ciel'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, 'ciel', 'v1'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, 'ciel', 'v1', 'advice'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, 'ciel', 'v1', 'advice', 'sess-mode'))).mode & 0o777, 0o700)
  assert.equal((await stat(recordPath(home, 'advice', 'sess-mode', 'k'))).mode & 0o777, 0o600)
})

test('missing records return null without creating directories', async () => {
  const home = await tempHome()
  assert.equal(await readRecord('advice', 'sess-missing', 'nope', { home }), null)
  assert.equal(await exists(recordRoot(home)), false)
  await writeRecord('advice', 'sess-missing', 'here', { ok: 1 }, { home })
  assert.equal(await readRecord('advice', 'sess-missing', 'other', { home }), null)
})

test('same-key writes atomically replace the prior value and leave no temp files', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-replace', 'key', { version: 1 }, { home })
  await writeRecord('advice', 'sess-replace', 'key', { version: 2 }, { home })
  assert.deepEqual(await readRecord('advice', 'sess-replace', 'key', { home }), { version: 2 })
  const dir = join(home, 'ciel', 'v1', 'advice', 'sess-replace')
  const names = await readdir(dir)
  assert.equal(names.filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(names.filter((name) => name.startsWith('.tmp-')).length, 0)
  const onDisk = JSON.parse(await readFile(recordPath(home, 'advice', 'sess-replace', 'key'), 'utf8'))
  assert.deepEqual(onDisk, { schemaVersion: 1, kind: 'advice', sessionId: 'sess-replace', id: 'key', value: { version: 2 } })
})

test('records are isolated by kind and by session', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-a', 'shared', 'advice-a', { home })
  await writeRecord('calls', 'sess-a', 'shared', 'calls-a', { home })
  await writeRecord('advice', 'sess-b', 'shared', 'advice-b', { home })
  assert.equal(await readRecord('advice', 'sess-a', 'shared', { home }), 'advice-a')
  assert.equal(await readRecord('calls', 'sess-a', 'shared', { home }), 'calls-a')
  assert.equal(await readRecord('advice', 'sess-b', 'shared', { home }), 'advice-b')
})

test('only advice and calls kinds are accepted', async () => {
  const home = await tempHome()
  await writeRecord('calls', 'sess-kinds', 'k', { route: 'x' }, { home })
  await writeRecord('advice', 'sess-kinds', 'k', { keys: ['a'] }, { home })
  assert.deepEqual(await readRecord('calls', 'sess-kinds', 'k', { home }), { route: 'x' })
  assert.deepEqual(await readRecord('advice', 'sess-kinds', 'k', { home }), { keys: ['a'] })
})

test('invalid kind, session and id are rejected before any filesystem work', async () => {
  const home = await tempHome()
  for (const kind of ['', 'unknown', 'reviews', 'evidence', 'feedback', 'inbox', 42, null, undefined]) {
    await expectCode('CIEL_RECORD_INVALID_KIND', () => writeRecord(kind, 'sess', 'id', 1, { home }))
  }
  for (const sessionId of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a b', 'sess:1', 'x'.repeat(129), 42, null, undefined]) {
    await expectCode('CIEL_RECORD_INVALID_SESSION', () => writeRecord('advice', sessionId, 'id', 1, { home }))
  }
  for (const id of ['', 'x'.repeat(513), 42, null, undefined, 'a\u0000b']) {
    await expectCode('CIEL_RECORD_INVALID_ID', () => writeRecord('advice', 'sess', id, 1, { home }))
  }
  assert.equal(await exists(recordRoot(home)), false)
})

test('a 512-character id and a colon id are accepted', async () => {
  const home = await tempHome()
  const longId = 'i'.repeat(512)
  await writeRecord('calls', 'sess-long', longId, 1, { home })
  await writeRecord('calls', 'sess-long', 'toolcall:grep:abc', 2, { home })
  assert.equal(await readRecord('calls', 'sess-long', longId, { home }), 1)
  assert.equal(await readRecord('calls', 'sess-long', 'toolcall:grep:abc', { home }), 2)
})

test('oversized record values fail explicitly and create nothing', async () => {
  const home = await tempHome()
  await expectCode('CIEL_RECORD_TOO_LARGE', () =>
    writeRecord('calls', 'sess-big', 'k', 'x'.repeat(RECORD_MAX_FILE_BYTES), { home }))
  assert.equal(await exists(recordRoot(home)), false)
})

test('unserializable values are rejected explicitly', async () => {
  const home = await tempHome()
  await expectCode('CIEL_RECORD_INVALID_VALUE', () => writeRecord('advice', 'sess', 'k', undefined, { home }))
  await expectCode('CIEL_RECORD_INVALID_VALUE', () => writeRecord('advice', 'sess', 'k', () => {}, { home }))
  await expectCode('CIEL_RECORD_INVALID_VALUE', () => writeRecord('advice', 'sess', 'k', 1n, { home }))
  const circular = {}
  circular.self = circular
  await expectCode('CIEL_RECORD_INVALID_VALUE', () => writeRecord('advice', 'sess', 'k', circular, { home }))
  assert.equal(await exists(recordRoot(home)), false)
})

test('options.home must be a nonempty string and never falls back on null', async () => {
  for (const home of ['', 42, null, {}]) {
    await expectCode('CIEL_RECORD_INVALID_HOME', () => writeRecord('advice', 'sess', 'id', 1, { home }))
    await expectCode('CIEL_RECORD_INVALID_HOME', () => readRecord('advice', 'sess', 'id', { home }))
  }
  await expectCode('CIEL_RECORD_INVALID_HOME', () => recordRoot(42))
  await expectCode('CIEL_RECORD_INVALID_HOME', () => recordRoot(''))
  await expectCode('CIEL_RECORD_INVALID_HOME', () => recordRoot(null))
})

test('corrupt records throw specific errors without exposing the body', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-corrupt', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'advice', 'sess-corrupt')
  await writeFile(join(dir, fileNameFor('bad')), 'not json SECRET-BODY')
  const error = await expectCode('CIEL_RECORD_CORRUPT', () => readRecord('advice', 'sess-corrupt', 'bad', { home }))
  assert.ok(!error.message.includes('SECRET-BODY'))
  assert.ok(!error.message.includes(home))
})

test('schema version mismatches and malformed envelopes are explicit', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-version', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'advice', 'sess-version')
  await writeFile(join(dir, fileNameFor('v2')), JSON.stringify({ schemaVersion: 2, kind: 'advice', sessionId: 'sess-version', id: 'v2', value: 1 }))
  await expectCode('CIEL_RECORD_VERSION', () => readRecord('advice', 'sess-version', 'v2', { home }))
  await writeFile(join(dir, fileNameFor('array')), JSON.stringify([1, 2, 3]))
  await expectCode('CIEL_RECORD_CORRUPT', () => readRecord('advice', 'sess-version', 'array', { home }))
  await writeFile(join(dir, fileNameFor('novalue')), JSON.stringify({ schemaVersion: 1, kind: 'advice', sessionId: 'sess-version', id: 'novalue' }))
  await expectCode('CIEL_RECORD_CORRUPT', () => readRecord('advice', 'sess-version', 'novalue', { home }))
})

test('reads verify exact ownership and refuse cross-identity records', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-own', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'advice', 'sess-own')
  await writeFile(join(dir, fileNameFor('stolen')), JSON.stringify({ schemaVersion: 1, kind: 'advice', sessionId: 'other-session', id: 'stolen', value: 1 }))
  await expectCode('CIEL_RECORD_IDENTITY', () => readRecord('advice', 'sess-own', 'stolen', { home }))
  // A record whose filename does not hash from its id is not adopted.
  await writeFile(join(dir, fileNameFor('mismatch')), JSON.stringify({ schemaVersion: 1, kind: 'advice', sessionId: 'sess-own', id: 'different-id', value: 1 }))
  await expectCode('CIEL_RECORD_IDENTITY', () => readRecord('advice', 'sess-own', 'mismatch', {home}))
})

test('a file larger than the per-file bound is refused before parsing', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-too-big', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'advice', 'sess-too-big')
  await writeFile(join(dir, fileNameFor('huge')), 'x'.repeat(RECORD_MAX_FILE_BYTES + 1024))
  await expectCode('CIEL_RECORD_TOO_LARGE', () => readRecord('advice', 'sess-too-big', 'huge', { home }))
})

test('concurrent same-key writes settle on one complete record with no temp files', async () => {
  const home = await tempHome()
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    writeRecord('advice', 'sess-race', 'key', { index }, { home })))
  const value = await readRecord('advice', 'sess-race', 'key', { home })
  assert.ok(value && Number.isInteger(value.index) && value.index >= 0 && value.index < 20)
  const names = await readdir(join(home, 'ciel', 'v1', 'advice', 'sess-race'))
  assert.equal(names.filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(names.filter((name) => name.startsWith('.tmp-')).length, 0)
})

test('symlinked record files and directories are refused', { skip: process.platform === 'win32' }, async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-sym', 'real', { ok: 1 }, { home })
  const target = join(home, 'outside.json')
  await writeFile(target, JSON.stringify({ schemaVersion: 1, kind: 'advice', sessionId: 'sess-sym', id: 'link', value: { pwned: true } }))
  const linkPath = recordPath(home, 'advice', 'sess-sym', 'link')
  await symlink(target, linkPath)
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => readRecord('advice', 'sess-sym', 'link', { home }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => writeRecord('advice', 'sess-sym', 'link', { x: 1 }, { home }))

  const home2 = await tempHome()
  const outsideDir = join(home2, 'outside-dir')
  await mkdir(outsideDir, { recursive: true })
  await mkdir(join(home2, 'ciel'), { recursive: true, mode: 0o700 })
  await symlink(outsideDir, join(home2, 'ciel', 'v1'))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => readRecord('advice', 'sess', 'id', { home: home2 }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => writeRecord('advice', 'sess', 'id', 1, { home: home2 }))
})

test('hard-linked record files are refused', { skip: process.platform === 'win32' }, async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-hard', 'base', { base: 1 }, { home })
  const source = join(home, 'source.json')
  await writeFile(source, JSON.stringify({ schemaVersion: 1, kind: 'advice', sessionId: 'sess-hard', id: 'hard', value: { linked: true } }))
  await link(source, recordPath(home, 'advice', 'sess-hard', 'hard'))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => readRecord('advice', 'sess-hard', 'hard', { home }))
})
