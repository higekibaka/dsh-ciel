import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  RECORD_MAX_ENUMERATED_FILES,
  RECORD_MAX_FILE_BYTES,
  RECORD_MAX_LIST_BYTES,
  RECORD_MAX_LIST_RECORDS,
  RECORD_PAGE_DEFAULT_LIMIT,
  RECORD_PAGE_MAX_LIMIT,
  RECORD_SCHEMA_VERSION,
  RecordStoreError,
  listRecords,
  listRecordsPage,
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

/** Follow listRecordsPage cursors until the terminal page. */
async function pageThrough(kind, sessionId, options = {}) {
  const pages = []
  let cursor
  for (let guard = 0; guard < 10000; guard += 1) {
    const page = await listRecordsPage(kind, sessionId, cursor === undefined ? options : { ...options, cursor })
    pages.push(page)
    if (page.nextCursor === null) return pages
    cursor = page.nextCursor
  }
  throw new Error('pagination did not terminate')
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
    // The default also drives write/read/list when options.home is absent.
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
  const meta = await writeRecord('evidence', 'session-abc', 'toolcall:read:1', value, { home })
  assert.equal(meta.schemaVersion, 1)
  assert.equal(meta.kind, 'evidence')
  assert.equal(meta.sessionId, 'session-abc')
  assert.equal(meta.id, 'toolcall:read:1')
  assert.ok(meta.bytes > 0)
  assert.deepEqual(await readRecord('evidence', 'session-abc', 'toolcall:read:1', { home }), value)
})

test('records live at hashed filenames and never expose the opaque id as a path', async () => {
  const home = await tempHome()
  const sessionId = 'session-path'
  const colonId = 'toolcall:read:42'
  const slashId = 'weird/../../escape'
  await writeRecord('evidence', sessionId, colonId, { a: 1 }, { home })
  await writeRecord('evidence', sessionId, slashId, { b: 2 }, { home })
  const dir = join(home, 'ciel', 'v1', 'evidence', sessionId)
  const names = await readdir(dir)
  assert.equal(names.length, 2)
  for (const name of names) {
    assert.equal(name, basename(name))
    assert.ok(!name.includes(':'))
    assert.ok(!name.includes('/'))
    assert.ok(!name.includes('..'))
    assert.match(name, /^[A-Za-z0-9_-]{43}\.json$/)
  }
  assert.deepEqual(await readRecord('evidence', sessionId, colonId, { home }), { a: 1 })
  assert.deepEqual(await readRecord('evidence', sessionId, slashId, { home }), { b: 2 })
})

test('directory mode is 0700 and record file mode is 0600', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-mode', 'k', { ok: 1 }, { home })
  assert.equal((await stat(join(home, 'ciel'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, 'ciel', 'v1'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, 'ciel', 'v1', 'reviews'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(home, 'ciel', 'v1', 'reviews', 'sess-mode'))).mode & 0o777, 0o700)
  assert.equal((await stat(recordPath(home, 'reviews', 'sess-mode', 'k'))).mode & 0o777, 0o600)
})

test('missing records and sessions return null or an empty list without creating dirs', async () => {
  const home = await tempHome()
  assert.equal(await readRecord('reviews', 'sess-missing', 'nope', { home }), null)
  assert.deepEqual(await listRecords('reviews', 'sess-missing', { home }), [])
  assert.equal(await exists(recordRoot(home)), false)
  await writeRecord('reviews', 'sess-missing', 'here', { ok: 1 }, { home })
  assert.equal(await readRecord('reviews', 'sess-missing', 'other', { home }), null)
  assert.deepEqual(await listRecords('reviews', 'other-session', { home }), [])
})

test('same-key writes atomically replace the prior value and leave no temp files', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-replace', 'key', { version: 1 }, { home })
  await writeRecord('reviews', 'sess-replace', 'key', { version: 2 }, { home })
  assert.deepEqual(await readRecord('reviews', 'sess-replace', 'key', { home }), { version: 2 })
  const dir = join(home, 'ciel', 'v1', 'reviews', 'sess-replace')
  const names = await readdir(dir)
  assert.equal(names.filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(names.filter((name) => name.startsWith('.tmp-')).length, 0)
  const onDisk = JSON.parse(await readFile(recordPath(home, 'reviews', 'sess-replace', 'key'), 'utf8'))
  assert.deepEqual(onDisk, { schemaVersion: 1, kind: 'reviews', sessionId: 'sess-replace', id: 'key', value: { version: 2 } })
})

test('records are isolated by kind and by session', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-a', 'shared', 'reviews-a', { home })
  await writeRecord('evidence', 'sess-a', 'shared', 'evidence-a', { home })
  await writeRecord('reviews', 'sess-b', 'shared', 'reviews-b', { home })
  assert.equal(await readRecord('reviews', 'sess-a', 'shared', { home }), 'reviews-a')
  assert.equal(await readRecord('evidence', 'sess-a', 'shared', { home }), 'evidence-a')
  assert.equal(await readRecord('reviews', 'sess-b', 'shared', { home }), 'reviews-b')
  assert.deepEqual(await listRecords('reviews', 'sess-a', { home }), ['reviews-a'])
  assert.deepEqual(await listRecords('evidence', 'sess-a', { home }), ['evidence-a'])
  assert.deepEqual(await listRecords('reviews', 'sess-b', { home }), ['reviews-b'])
})

test('listRecords returns a value array sorted deterministically by id', async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-sort', 'b', 'B', { home })
  await writeRecord('advice', 'sess-sort', 'a', 'A', { home })
  await writeRecord('advice', 'sess-sort', 'c', 'C', { home })
  assert.deepEqual(await listRecords('advice', 'sess-sort', { home }), ['A', 'B', 'C'])
  await writeRecord('advice', 'sess-sort2', 'z10', 10, { home })
  await writeRecord('advice', 'sess-sort2', 'z2', 2, { home })
  await writeRecord('advice', 'sess-sort2', 'z1', 1, { home })
  assert.deepEqual(await listRecords('advice', 'sess-sort2', { home }), [1, 10, 2])
})

test('reserved kinds calls and feedback are accepted', async () => {
  const home = await tempHome()
  await writeRecord('calls', 'sess-kinds', 'k', { route: 'x' }, { home })
  await writeRecord('feedback', 'sess-kinds', 'k', { keys: ['a'] }, { home })
  assert.deepEqual(await readRecord('calls', 'sess-kinds', 'k', { home }), { route: 'x' })
  assert.deepEqual(await readRecord('feedback', 'sess-kinds', 'k', { home }), { keys: ['a'] })
})

test('invalid kind, session and id are rejected before any filesystem work', async () => {
  const home = await tempHome()
  for (const kind of ['', 'unknown', 'Reviews', 42, null, undefined]) {
    await expectCode('CIEL_RECORD_INVALID_KIND', () => writeRecord(kind, 'sess', 'id', 1, { home }))
  }
  for (const sessionId of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a b', 'sess:1', 'x'.repeat(129), 42, null, undefined]) {
    await expectCode('CIEL_RECORD_INVALID_SESSION', () => writeRecord('reviews', sessionId, 'id', 1, { home }))
  }
  for (const id of ['', 'x'.repeat(513), 42, null, undefined, 'a\u0000b']) {
    await expectCode('CIEL_RECORD_INVALID_ID', () => writeRecord('reviews', 'sess', id, 1, { home }))
  }
  assert.equal(await exists(recordRoot(home)), false)
})

test('a 512-character id and a colon id are accepted', async () => {
  const home = await tempHome()
  const longId = 'i'.repeat(512)
  await writeRecord('evidence', 'sess-long', longId, 1, { home })
  await writeRecord('evidence', 'sess-long', 'toolcall:grep:abc', 2, { home })
  assert.equal(await readRecord('evidence', 'sess-long', longId, { home }), 1)
  assert.equal(await readRecord('evidence', 'sess-long', 'toolcall:grep:abc', { home }), 2)
})

test('oversized record values fail explicitly and create nothing', async () => {
  const home = await tempHome()
  await expectCode('CIEL_RECORD_TOO_LARGE', () =>
    writeRecord('evidence', 'sess-big', 'k', 'x'.repeat(RECORD_MAX_FILE_BYTES), { home }))
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
    await expectCode('CIEL_RECORD_INVALID_HOME', () => writeRecord('reviews', 'sess', 'id', 1, { home }))
    await expectCode('CIEL_RECORD_INVALID_HOME', () => readRecord('reviews', 'sess', 'id', { home }))
    await expectCode('CIEL_RECORD_INVALID_HOME', () => listRecords('reviews', 'sess', { home }))
  }
  await expectCode('CIEL_RECORD_INVALID_HOME', () => recordRoot(42))
  await expectCode('CIEL_RECORD_INVALID_HOME', () => recordRoot(''))
  await expectCode('CIEL_RECORD_INVALID_HOME', () => recordRoot(null))
})

test('corrupt records throw specific errors without exposing the body', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-corrupt', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'reviews', 'sess-corrupt')
  await writeFile(join(dir, fileNameFor('bad')), 'not json SECRET-BODY')
  const error = await expectCode('CIEL_RECORD_CORRUPT', () => readRecord('reviews', 'sess-corrupt', 'bad', { home }))
  assert.ok(!error.message.includes('SECRET-BODY'))
  assert.ok(!error.message.includes(home))
  const listError = await expectCode('CIEL_RECORD_CORRUPT', () => listRecords('reviews', 'sess-corrupt', { home }))
  assert.ok(!listError.message.includes('SECRET-BODY'))
  assert.ok(listError.message.includes(fileNameFor('bad')))
})

test('schema version mismatches and malformed envelopes are explicit', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-version', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'reviews', 'sess-version')
  await writeFile(join(dir, fileNameFor('v2')), JSON.stringify({ schemaVersion: 2, kind: 'reviews', sessionId: 'sess-version', id: 'v2', value: 1 }))
  await expectCode('CIEL_RECORD_VERSION', () => readRecord('reviews', 'sess-version', 'v2', { home }))
  await writeFile(join(dir, fileNameFor('array')), JSON.stringify([1, 2, 3]))
  await expectCode('CIEL_RECORD_CORRUPT', () => readRecord('reviews', 'sess-version', 'array', { home }))
  await writeFile(join(dir, fileNameFor('novalue')), JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: 'sess-version', id: 'novalue' }))
  await expectCode('CIEL_RECORD_CORRUPT', () => readRecord('reviews', 'sess-version', 'novalue', { home }))
})

test('reads verify exact ownership and refuse cross-identity records', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-own', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'reviews', 'sess-own')
  await writeFile(join(dir, fileNameFor('stolen')), JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: 'other-session', id: 'stolen', value: 1 }))
  await expectCode('CIEL_RECORD_IDENTITY', () => readRecord('reviews', 'sess-own', 'stolen', { home }))
  await expectCode('CIEL_RECORD_IDENTITY', () => listRecords('reviews', 'sess-own', { home }))
  // A record whose filename does not hash from its id is not adopted.
  await writeFile(join(dir, fileNameFor('mismatch')), JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: 'sess-own', id: 'different-id', value: 1 }))
  await expectCode('CIEL_RECORD_IDENTITY', () => listRecords('reviews', 'sess-own', { home }))
})

test('a file larger than the per-file bound is refused before parsing', async () => {
  const home = await tempHome()
  await writeRecord('reviews', 'sess-too-big', 'ok', { ok: 1 }, { home })
  const dir = join(home, 'ciel', 'v1', 'reviews', 'sess-too-big')
  await writeFile(join(dir, fileNameFor('huge')), 'x'.repeat(RECORD_MAX_FILE_BYTES + 1024))
  await expectCode('CIEL_RECORD_TOO_LARGE', () => readRecord('reviews', 'sess-too-big', 'huge', { home }))
  await expectCode('CIEL_RECORD_TOO_LARGE', () => listRecords('reviews', 'sess-too-big', { home }))
})

test('listRecords refuses more than 200 records instead of truncating', async () => {
  const home = await tempHome()
  const dir = join(home, 'ciel', 'v1', 'reviews', 'sess-limit')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (let index = 0; index <= RECORD_MAX_LIST_RECORDS; index += 1) {
    await writeFile(join(dir, fileNameFor('r' + index)), '{}')
  }
  await expectCode('CIEL_RECORD_LIST_LIMIT', () => listRecords('reviews', 'sess-limit', { home }))
})

test('listRecords refuses a session over the aggregate byte bound', async () => {
  const home = await tempHome()
  const sessionId = 'sess-bytes'
  const dir = join(home, 'ciel', 'v1', 'evidence', sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const payload = 'x'.repeat(510000)
  const perRecord = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, kind: 'evidence', sessionId, id: 'big', value: payload }), 'utf8')
  const count = Math.ceil(RECORD_MAX_LIST_BYTES / perRecord) + 1
  assert.ok(count <= RECORD_MAX_LIST_RECORDS)
  for (let index = 0; index < count; index += 1) {
    const id = 'big-' + index
    await writeFile(join(dir, fileNameFor(id)), JSON.stringify({ schemaVersion: 1, kind: 'evidence', sessionId, id, value: payload }))
  }
  await expectCode('CIEL_RECORD_LIST_BYTES', () => listRecords('evidence', sessionId, { home }))
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
  await writeRecord('reviews', 'sess-sym', 'real', { ok: 1 }, { home })
  const target = join(home, 'outside.json')
  await writeFile(target, JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: 'sess-sym', id: 'link', value: { pwned: true } }))
  const linkPath = recordPath(home, 'reviews', 'sess-sym', 'link')
  await symlink(target, linkPath)
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => readRecord('reviews', 'sess-sym', 'link', { home }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => writeRecord('reviews', 'sess-sym', 'link', { x: 1 }, { home }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => listRecords('reviews', 'sess-sym', { home }))

  const home2 = await tempHome()
  const outsideDir = join(home2, 'outside-dir')
  await mkdir(outsideDir, { recursive: true })
  await mkdir(join(home2, 'ciel'), { recursive: true, mode: 0o700 })
  await symlink(outsideDir, join(home2, 'ciel', 'v1'))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => readRecord('reviews', 'sess', 'id', { home: home2 }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => writeRecord('reviews', 'sess', 'id', 1, { home: home2 }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => listRecords('reviews', 'sess', { home: home2 }))
})

test('hard-linked record files are refused', { skip: process.platform === 'win32' }, async () => {
  const home = await tempHome()
  await writeRecord('advice', 'sess-hard', 'base', { base: 1 }, { home })
  const source = join(home, 'source.json')
  await writeFile(source, JSON.stringify({ schemaVersion: 1, kind: 'advice', sessionId: 'sess-hard', id: 'hard', value: { linked: true } }))
  await link(source, recordPath(home, 'advice', 'sess-hard', 'hard'))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => readRecord('advice', 'sess-hard', 'hard', { home }))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () => listRecords('advice', 'sess-hard', { home }))
})

// ── listRecordsPage: long-session pagination ─────────────────────────────

test('listRecordsPage pages 201 small records with no gaps or duplicates', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-201'
  for (let index = 0; index <= 200; index += 1) {
    await writeRecord('reviews', sessionId, 'r' + index, { index }, { home })
  }
  // The legacy full-list API keeps its hard bound while pagination serves it.
  await expectCode('CIEL_RECORD_LIST_LIMIT', () => listRecords('reviews', sessionId, { home }))
  const pages = await pageThrough('reviews', sessionId, { home })
  assert.deepEqual(pages.map((page) => page.values.length), [RECORD_PAGE_DEFAULT_LIMIT, RECORD_PAGE_DEFAULT_LIMIT, 1])
  assert.equal(pages[0].limited, true)
  assert.equal(pages[1].limited, true)
  assert.equal(pages[2].limited, false)
  assert.equal(pages[2].nextCursor, null)
  for (const page of pages.slice(0, 2)) assert.match(page.nextCursor, /^[A-Za-z0-9_-]{43}\.json$/)
  const seen = pages.flatMap((page) => page.values.map((value) => value.index))
  assert.equal(seen.length, 201)
  assert.equal(new Set(seen).size, 201)
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 201 }, (_, index) => index))
})

test('listRecordsPage honors an explicit limit and returns stable filename order', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-limit'
  const ids = ['zeta', 'alpha', 'mike', 'bravo', 'yankee']
  for (const id of ids) await writeRecord('advice', sessionId, id, { id }, { home })
  const expected = [...ids].sort((a, b) => (fileNameFor(a) < fileNameFor(b) ? -1 : 1))
  const pages = await pageThrough('advice', sessionId, { home, limit: 2 })
  assert.deepEqual(pages.map((page) => page.values.length), [2, 2, 1])
  assert.deepEqual(pages.flatMap((page) => page.values.map((value) => value.id)), expected)
  assert.equal(pages.at(-1).nextCursor, null)
  assert.equal(pages.at(-1).limited, false)
})

test('listRecordsPage defaults to 100, accepts up to 200, and rejects bad limits', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-default'
  for (let index = 0; index < 101; index += 1) await writeRecord('reviews', sessionId, 'k' + index, index, { home })
  const first = await listRecordsPage('reviews', sessionId, { home })
  assert.equal(first.values.length, RECORD_PAGE_DEFAULT_LIMIT)
  assert.equal(first.limited, true)
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{43}\.json$/)
  const max = await listRecordsPage('reviews', sessionId, { home, limit: RECORD_PAGE_MAX_LIMIT })
  assert.equal(max.values.length, 101)
  assert.equal(max.nextCursor, null)
  assert.equal(max.limited, false)
  for (const limit of [0, -1, RECORD_PAGE_MAX_LIMIT + 1, 1.5, '100', null, NaN, Infinity]) {
    await expectCode('CIEL_RECORD_INVALID_LIMIT', () => listRecordsPage('reviews', sessionId, { home, limit }))
  }
})

test('listRecordsPage validates cursors and never turns one into a path or raw id', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-cursor'
  const rawId = 'toolcall:read:SENTINEL-RAW-ID'
  await writeRecord('reviews', sessionId, rawId, 'raw', { home })
  await writeRecord('reviews', sessionId, 'second', 'two', { home })
  const ordered = [fileNameFor(rawId), fileNameFor('second')].sort()
  for (const cursor of ['../escape', 'x', 'e'.repeat(44) + '.json', 'a'.repeat(43) + '.json/', '', 123, {}, [], true]) {
    await expectCode('CIEL_RECORD_INVALID_CURSOR', () => listRecordsPage('reviews', sessionId, { home, cursor }))
  }
  // A syntactically valid cursor for a name that does not exist is opaque and safe.
  const afterAll = await listRecordsPage('reviews', sessionId, { home, cursor: 'z'.repeat(43) + '.json' })
  assert.deepEqual(afterAll, { values: [], nextCursor: null, limited: false })
  const firstPage = await listRecordsPage('reviews', sessionId, { home, limit: 1 })
  assert.equal(firstPage.nextCursor, ordered[0])
  assert.notEqual(firstPage.nextCursor, rawId)
  assert.match(firstPage.nextCursor, /^[A-Za-z0-9_-]{43}\.json$/)
  const rest = await listRecordsPage('reviews', sessionId, { home, cursor: firstPage.nextCursor })
  assert.equal(rest.values.length, 1)
  assert.equal(rest.nextCursor, null)
})

test('listRecordsPage stops at the per-page byte budget and continues with the cursor', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-bytes'
  const total = 40
  const payload = 'x'.repeat(450000)
  for (let index = 0; index < total; index += 1) {
    await writeRecord('evidence', sessionId, 'big-' + index, { index, payload }, { home })
  }
  const first = await listRecordsPage('evidence', sessionId, { home, limit: RECORD_PAGE_MAX_LIMIT })
  assert.ok(first.values.length > 0 && first.values.length < total)
  assert.equal(first.limited, true)
  assert.notEqual(first.nextCursor, null)
  const pages = await pageThrough('evidence', sessionId, { home, limit: RECORD_PAGE_MAX_LIMIT })
  for (const page of pages) {
    const bytes = page.values.reduce((sum, value) =>
      sum + Buffer.byteLength(JSON.stringify({ schemaVersion: 1, kind: 'evidence', sessionId, id: 'big-' + value.index, value })), 0)
    assert.ok(bytes <= RECORD_MAX_LIST_BYTES, 'page bytes ' + bytes + ' exceed the page budget')
  }
  const seen = pages.flatMap((page) => page.values.map((value) => value.index))
  assert.equal(seen.length, total)
  assert.equal(new Set(seen).size, total)
  assert.equal(pages.at(-1).nextCursor, null)
})

test('listRecordsPage never swallows corrupt or cross-identity records across pages', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-corrupt'
  await writeRecord('reviews', sessionId, 'a', { a: 1 }, { home })
  await writeRecord('reviews', sessionId, 'b', { b: 2 }, { home })
  const dir = join(home, 'ciel', 'v1', 'reviews', sessionId)
  const [first, second] = [fileNameFor('a'), fileNameFor('b')].sort()
  await writeFile(join(dir, second), 'not json SECRET-BODY')
  const page1 = await listRecordsPage('reviews', sessionId, { home, limit: 1 })
  assert.equal(page1.nextCursor, first)
  const error = await expectCode('CIEL_RECORD_CORRUPT', () =>
    listRecordsPage('reviews', sessionId, { home, cursor: first }))
  assert.ok(!error.message.includes('SECRET-BODY'))
  assert.ok(error.message.includes(second))

  const home2 = await tempHome()
  const sessionId2 = 'sess-page-identity'
  await writeRecord('reviews', sessionId2, 'a', { a: 1 }, { home: home2 })
  await writeRecord('reviews', sessionId2, 'b', { b: 2 }, { home: home2 })
  const dir2 = join(home2, 'ciel', 'v1', 'reviews', sessionId2)
  const [first2, second2] = [fileNameFor('a'), fileNameFor('b')].sort()
  await writeFile(join(dir2, second2), JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: 'other-session', id: 'b', value: 2 }))
  const page2 = await listRecordsPage('reviews', sessionId2, { home: home2, limit: 1 })
  assert.equal(page2.nextCursor, first2)
  await expectCode('CIEL_RECORD_IDENTITY', () =>
    listRecordsPage('reviews', sessionId2, { home: home2, cursor: first2 }))
})

test('listRecordsPage applies the same link and size boundaries', { skip: process.platform === 'win32' }, async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-huge'
  await writeRecord('reviews', sessionId, 'a', { a: 1 }, { home })
  await writeFile(join(home, 'ciel', 'v1', 'reviews', sessionId, fileNameFor('huge')), 'x'.repeat(RECORD_MAX_FILE_BYTES + 1024))
  await expectCode('CIEL_RECORD_TOO_LARGE', () =>
    listRecordsPage('reviews', sessionId, { home, limit: RECORD_PAGE_MAX_LIMIT }))

  const home2 = await tempHome()
  const sessionId2 = 'sess-page-sym'
  await writeRecord('reviews', sessionId2, 'a', { a: 1 }, { home: home2 })
  const target = join(home2, 'outside.json')
  await writeFile(target, JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: sessionId2, id: 'link', value: 1 }))
  await symlink(target, recordPath(home2, 'reviews', sessionId2, 'link'))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () =>
    listRecordsPage('reviews', sessionId2, { home: home2, limit: RECORD_PAGE_MAX_LIMIT }))

  const home3 = await tempHome()
  const sessionId3 = 'sess-page-hard'
  await writeRecord('reviews', sessionId3, 'a', { a: 1 }, { home: home3 })
  const source = join(home3, 'source.json')
  await writeFile(source, JSON.stringify({ schemaVersion: 1, kind: 'reviews', sessionId: sessionId3, id: 'hard', value: 1 }))
  await link(source, recordPath(home3, 'reviews', sessionId3, 'hard'))
  await expectCode('CIEL_RECORD_UNSAFE_PATH', () =>
    listRecordsPage('reviews', sessionId3, { home: home3, limit: RECORD_PAGE_MAX_LIMIT }))
})

test('listRecordsPage returns an empty terminal page without repeating records', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-empty'
  await writeRecord('reviews', sessionId, 'a', 'A', { home })
  await writeRecord('reviews', sessionId, 'b', 'B', { home })
  const byName = { [fileNameFor('a')]: 'A', [fileNameFor('b')]: 'B' }
  const ordered = Object.keys(byName).sort()
  const expected = ordered.map((name) => byName[name])
  const walk = await pageThrough('reviews', sessionId, { home, limit: 1 })
  assert.deepEqual(walk.map((page) => page.values), expected.map((value) => [value]))
  assert.equal(walk.at(-1).nextCursor, null)
  const terminal = await listRecordsPage('reviews', sessionId, { home, cursor: ordered[1] })
  assert.deepEqual(terminal, { values: [], nextCursor: null, limited: false })
  const repeated = await listRecordsPage('reviews', sessionId, { home, cursor: ordered[1] })
  assert.deepEqual(repeated, { values: [], nextCursor: null, limited: false })
  // A missing session and an explicit null cursor both behave as a fresh walk.
  assert.deepEqual(await listRecordsPage('reviews', 'sess-page-none', { home }), { values: [], nextCursor: null, limited: false })
  assert.deepEqual(await listRecordsPage('reviews', sessionId, { home, cursor: null, limit: 5 }), { values: expected, nextCursor: null, limited: false })
})

test('listRecordsPage bounds directory enumeration with an explicit error', async () => {
  const home = await tempHome()
  const sessionId = 'sess-page-enum'
  const dir = join(home, 'ciel', 'v1', 'reviews', sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const total = RECORD_MAX_ENUMERATED_FILES + 1
  const batch = 500
  for (let start = 0; start < total; start += batch) {
    const count = Math.min(batch, total - start)
    await Promise.all(Array.from({ length: count }, (_, offset) =>
      writeFile(join(dir, fileNameFor('f' + (start + offset))), '')))
  }
  const error = await expectCode('CIEL_RECORD_ENUM_LIMIT', () => listRecordsPage('reviews', sessionId, { home }))
  assert.ok(error.message.includes(String(RECORD_MAX_ENUMERATED_FILES)))
})

test('listRecordsPage validates kind, session and home like the other APIs', async () => {
  const home = await tempHome()
  await expectCode('CIEL_RECORD_INVALID_KIND', () => listRecordsPage('nope', 'sess', { home }))
  await expectCode('CIEL_RECORD_INVALID_SESSION', () => listRecordsPage('reviews', '../escape', { home }))
  await expectCode('CIEL_RECORD_INVALID_HOME', () => listRecordsPage('reviews', 'sess', { home: null }))
  assert.equal(await exists(recordRoot(home)), false)
})
