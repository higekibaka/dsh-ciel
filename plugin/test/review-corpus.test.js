import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createReviewCorpus, detectSensitiveText } from '../review-corpus.js'

// Every filesystem fixture is fake and lives in a fresh tempdir; no credential
// records, live models, harness configuration or GUI are accessed by these tests.
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ciel-review-test-'))
  const root = path.join(base, 'project'), extra = path.join(base, 'extra'), outside = path.join(base, 'fake-home')
  for (const dir of [root, extra, outside]) await fs.mkdir(dir)
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  async function put(name, text = 'export const answer = 42\n') {
    const file = path.join(base, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
    return file
  }
  return { base, root, extra, outside, put }
}
function denied(action, forbidden = []) {
  assert.throws(action, error => {
    assert.equal(error.code, 'CIEL_REVIEW_ACCESS_LIMITED')
    assert.equal(error.message, 'Review data unavailable or outside allowed scope')
    for (const value of forbidden) assert.ok(!String(error.stack).includes(value))
    return true
  })
}
async function deniedAsync(action, forbidden = []) {
  await assert.rejects(action, error => {
    assert.equal(error.code, 'CIEL_REVIEW_ACCESS_LIMITED')
    for (const value of forbidden) assert.ok(!String(error.stack).includes(value))
    return true
  })
}

test('captures sources/docs, keeps legitimate session/key folders, exposes only virtual metadata', async t => {
  const f = await fixture(t)
  await f.put('project/src/main.js', 'alpha\nbeta.* literal\ngamma\n')
  await f.put('project/session/worker.ts')
  await f.put('project/sessions/index.js')
  await f.put('project/key/index.js')
  await f.put('project/README', 'project docs')
  const corpus = await createReviewCorpus({ root: f.root })
  t.after(() => corpus.dispose())
  assert.deepEqual(corpus.publicInfo(), { fileCount: 5, byteCount: 114, roots: ['/project'], truncated: false })
  assert.deepEqual(corpus.read({ file_path: 'src/main.js', offset: 2, limit: 1 }), { file_path: '/project/src/main.js', offset: 2, total_lines: 3, content: 'beta.* literal', truncated: true })
  assert.equal(corpus.read({ file_path: `${f.root}/src/main.js` }).content, 'alpha\nbeta.* literal\ngamma\n')
  assert.deepEqual(corpus.glob({ pattern: '**/*.js' }).paths, ['/project/key/index.js', '/project/sessions/index.js', '/project/src/main.js'])
  assert.deepEqual(corpus.grep({ pattern: '.*', include: '*.js' }).matches, [{ file_path: '/project/src/main.js', line_number: 2, line: 'beta.* literal' }])
  assert.deepEqual(corpus.grep({ pattern: '(a+)+$' }), { matches: [], truncated: false })
  assert.deepEqual(corpus.glob({ pattern: 'src/m?in.*' }).paths, ['/project/src/main.js'])
  assert.deepEqual(corpus.glob({ pattern: '*.no-match' }), { paths: [], truncated: false })
  assert.equal(JSON.stringify(corpus.publicInfo()).includes(f.base), false)
})

test('line counts do not invent an extra line for a final newline and preserve captured bytes', async t => {
  const f = await fixture(t)
  const cases = [['empty.txt', '', 0], ['one.txt', 'one\n', 1], ['two.txt', 'one\ntwo', 2], ['blank.txt', '\n', 1], ['crlf.txt', 'one\r\ntwo\r\n', 2]]
  for (const [name, content] of cases) await f.put('project/' + name, content)
  const corpus = await createReviewCorpus({ root: f.root })
  t.after(() => corpus.dispose())
  for (const [name, content, count] of cases) {
    const read = corpus.read({ file_path: name })
    assert.equal(read.total_lines, count, name)
    assert.equal(read.content, content, name)
    assert.equal(read.truncated, false)
  }
})

test('excludes fake sensitive/process records, archives, symlinks, hardlinks and secret-bearing source', async t => {
  const f = await fixture(t), sentinel = 'FAKE_REJECTED_SENTINEL_517'
  await f.put('project/normal.js', 'normal source')
  const excluded = ['.env', '.env.local', 'credentials.json', 'cookie.txt', 'auth-state.json', 'private.key', '.git/config.txt', '.dsh/session/thoughts.md', '.ssh/config', '.aws/config', '.session-repair/notes.md', 'node_modules/pkg/index.js', '.cache/index.js', 'archives/source.js', 'raw.log', 'raw.jsonl', 'session.gz', 'unlisted.blob']
  for (const name of excluded) await f.put(`project/${name}`, sentinel)
  await f.put('project/settings.js', `export const password = '${sentinel}'`)
  const outside = await f.put('fake-home/.dsh/sessions/thoughts.md', sentinel)
  await fs.symlink(outside, path.join(f.root, 'linked.md'))
  await fs.symlink(path.dirname(outside), path.join(f.root, 'linked-dir'))
  await fs.link(outside, path.join(f.root, 'hardlinked.md'))
  await f.put('project/binary.js', Buffer.from([0x61, 0, 0xff]))
  const corpus = await createReviewCorpus({ root: f.root, protectedRoots: [path.join(f.outside, '.dsh')] })
  t.after(() => corpus.dispose())
  assert.deepEqual(corpus.glob({ pattern: '**/*' }).paths, ['/project/normal.js'])
  assert.deepEqual(corpus.grep({ pattern: sentinel }), { matches: [], truncated: false })
  for (const file of [...excluded, 'settings.js', 'linked.md', 'linked-dir/thoughts.md', 'hardlinked.md', 'binary.js']) {
    denied(() => corpus.read({ file_path: file }), [sentinel, f.outside])
    denied(() => corpus.grep({ pattern: sentinel, path: file }), [sentinel, f.outside])
    denied(() => corpus.glob({ pattern: '*', path: file }), [sentinel, f.outside])
  }
})

test('ordinary auth/token/credentials source modules are admitted but credential data and disguised keys are not', async t => {
  const f = await fixture(t), marker = 'FAKE_REJECTED_CREDENTIAL_DATA'
  const sources = ['auth.ts', 'authentication.js', 'token.js', 'credentials.ts', 'credential-provider.py', 'cookie.ts', 'auth-state.ts']
  const data = ['auth.json', 'authentication.yaml', 'token.txt', 'credentials.json', 'credentials.yml', 'credentials.toml', 'cookie.xml', 'auth-state.json', 'auth-state.md', '.env.ts', '.env.local.js', 'private-key.ts', 'id_rsa.js', 'id_ed25519.ts', 'server.key.js', 'certificate.pem.ts']
  for (const name of sources) await f.put(`project/${name}`, 'export const reviewedImplementation = true')
  for (const name of data) await f.put(`project/${name}`, marker)
  await f.put('project/credentials-live.ts', 'export const password = "FAKE_PASSWORD_VALUE"')
  const corpus = await createReviewCorpus({ root: f.root })
  t.after(() => corpus.dispose())
  assert.deepEqual(corpus.glob({ pattern: '*' }).paths, sources.map(name => `/project/${name}`).sort())
  for (const name of sources) assert.match(corpus.read({ file_path: name }).content, /reviewedImplementation/)
  for (const name of [...data, 'credentials-live.ts']) denied(() => corpus.read({ file_path: name }), [marker, 'FAKE_PASSWORD_VALUE'])
  assert.deepEqual(corpus.grep({ pattern: marker }).matches, [])
})

test('synthesized Google, DeepSeek and npm token shapes reject otherwise ordinary source modules', async t => {
  const f = await fixture(t)
  // Deliberately synthesized shapes, never credentials read from any environment.
  const fakeTokens = ['AIza' + 'F'.repeat(35), 'npm_' + 'N'.repeat(36), 'sk-' + 'd'.repeat(32)]
  for (const [index, token] of fakeTokens.entries()) {
    assert.equal(detectSensitiveText(`const value = "${token}"`), true)
    await f.put(`project/provider-${index}.ts`, `export const value = "${token}"`)
  }
  await f.put('project/normal.ts', 'export const provider = process.env.PROVIDER')
  const corpus = await createReviewCorpus({ root: f.root })
  t.after(() => corpus.dispose())
  assert.deepEqual(corpus.glob({ pattern: '*' }).paths, ['/project/normal.ts'])
  for (const [index, token] of fakeTokens.entries()) {
    denied(() => corpus.read({ file_path: `provider-${index}.ts` }), [token])
    assert.deepEqual(corpus.grep({ pattern: token }).matches, [])
  }
  assert.equal(detectSensitiveText('Google AIza and npm_ prefixes alone are not credentials'), false)
})

test('explicit extra source approval works while protected extra roots fail closed', async t => {
  const f = await fixture(t)
  await f.put('project/index.js')
  await f.put('extra/other.js', 'extra source')
  await f.put('fake-home/.dsh/sessions/thoughts.md', 'FAKE_PRIVATE_THOUGHTS')
  const restricted = path.join(f.outside, '.dsh')
  const corpus = await createReviewCorpus({ root: f.root, additionalRoots: [f.extra], protectedRoots: [restricted] })
  t.after(() => corpus.dispose())
  assert.deepEqual(corpus.publicInfo().roots, ['/project', '/external-1'])
  assert.equal(corpus.read({ file_path: `${f.extra}/other.js` }).content, 'extra source')
  assert.deepEqual(corpus.glob({ pattern: '*.js', path: '/external-1' }).paths, ['/external-1/other.js'])
  assert.deepEqual(corpus.glob({ pattern: '*.js' }).paths, ['/project/index.js'])
  denied(() => corpus.read({ file_path: `${restricted}/sessions/thoughts.md` }), [restricted, 'FAKE_PRIVATE_THOUGHTS'])
  await deniedAsync(() => createReviewCorpus({ root: f.root, additionalRoots: [restricted], protectedRoots: [restricted] }), [restricted])
  await deniedAsync(() => createReviewCorpus({ root: f.root, additionalRoots: [f.extra], protectedRoots: [f.extra] }), [f.extra])
  await deniedAsync(() => createReviewCorpus({ root: f.root, additionalRoots: [f.root] }), [f.root])
})

test('protected nested trees are denied regardless of cwd or root alias', async t => {
  const f = await fixture(t)
  await f.put('project/allowed.js')
  const protectedFile = await f.put('project/internal/notes.md', 'FAKE_PROTECTED_NOTES')
  const corpus = await createReviewCorpus({ root: f.root, protectedRoots: [path.dirname(protectedFile)] })
  t.after(() => corpus.dispose())
  assert.deepEqual(corpus.glob({ pattern: '**/*' }).paths, ['/project/allowed.js'])
  for (const name of [protectedFile, '/project/internal/notes.md', 'internal/notes.md']) denied(() => corpus.read({ file_path: name }), [protectedFile])
})

test('rejects omitted queries, traversal, unapproved absolute paths and encoded/URI escapes', async t => {
  const f = await fixture(t)
  await f.put('project/a.js')
  const corpus = await createReviewCorpus({ root: f.root })
  t.after(() => corpus.dispose())
  for (const name of ['../a.js', 'src/../a.js', '/project/../project/a.js', `${f.outside}/missing.js`, 'file:///project/a.js', '/project/%2e%2e/a.js', 'src\\a.js', '/project/a.js\0', '/projectish/a.js', '']) {
    denied(() => corpus.read({ file_path: name }), [f.outside])
    denied(() => corpus.grep({ pattern: 'answer', path: name }), [f.outside])
    denied(() => corpus.glob({ pattern: '*', path: name }), [f.outside])
  }
  for (const method of ['read', 'grep', 'glob']) { denied(() => corpus[method]()); denied(() => corpus[method]({})) }
  for (const pattern of ['../*', '{a,b}', '[abc]', 'a\\b', '*'.repeat(257)]) denied(() => corpus.glob({ pattern }))
  denied(() => corpus.read({ file_path: 'a.js', offset: -1 }))
  denied(() => corpus.read({ file_path: 'a.js', limit: Infinity }))
})

test('snapshot is immutable and queries never call filesystem after capture', async t => {
  const f = await fixture(t)
  const live = await f.put('project/live.js', 'captured version')
  const corpus = await createReviewCorpus({ root: f.root })
  t.after(() => corpus.dispose())
  await fs.writeFile(live, 'FAKE_REJECTED_NEW_VERSION')
  await fs.rm(f.root, { recursive: true })
  const mocks = ['open', 'readFile', 'lstat', 'stat', 'readdir', 'opendir'].map(name => t.mock.method(fs, name, () => { throw new Error('filesystem query forbidden') }))
  try {
    assert.equal(corpus.read({ file_path: 'live.js' }).content, 'captured version')
    assert.equal(corpus.grep({ pattern: 'captured' }).matches.length, 1)
    assert.equal(corpus.grep({ pattern: 'FAKE_REJECTED' }).matches.length, 0)
    assert.deepEqual(corpus.glob({ pattern: '**/*.js' }).paths, ['/project/live.js'])
  } finally { for (const mock of mocks) mock.mock.restore() }
})

test('symlink swaps between lstat and open cannot capture fake outside file or directory', async t => {
  for (const directory of [false, true]) {
    const f = await fixture(t), sentinel = 'FAKE_SWAP_OUTSIDE_SENTINEL'
    const target = await f.put('fake-home/outside/data.js', sentinel)
    const candidate = directory ? path.join(f.root, 'swapdir') : await f.put('project/swap.js', 'safe')
    if (directory) await f.put('project/swapdir/safe.js', 'safe')
    const originalOpen = fs.open
    let swapped = false
    const openMock = t.mock.method(fs, 'open', async function (location, ...args) {
      if (!swapped && String(location).startsWith('/proc/self/fd/') && String(location).endsWith(directory ? '/swapdir' : '/swap.js')) {
        swapped = true
        await fs.rename(candidate, `${candidate}.saved`)
        await fs.symlink(directory ? path.dirname(target) : target, candidate)
      }
      return originalOpen.call(this, location, ...args)
    })
    let corpus
    try { corpus = await createReviewCorpus({ root: f.root }) } finally { openMock.mock.restore() }
    t.after(() => corpus.dispose())
    assert.equal(swapped, true)
    assert.deepEqual(corpus.grep({ pattern: sentinel }).matches, [])
    denied(() => corpus.read({ file_path: directory ? 'swapdir/data.js' : 'swap.js' }), [target, sentinel])
  }
})

test('same-path regular file replacement during capture is excluded', async t => {
  const f = await fixture(t)
  const candidate = await f.put('project/change.js', 'safe')
  const replacement = await f.put('fake-home/change.js', 'FAKE_CHANGED_INODE_SENTINEL')
  const originalOpen = fs.open
  let changed = false
  const openMock = t.mock.method(fs, 'open', async function (location, ...args) {
    if (!changed && String(location).endsWith('/change.js') && String(location).startsWith('/proc/self/fd/')) {
      changed = true; await fs.rename(replacement, candidate)
    }
    return originalOpen.call(this, location, ...args)
  })
  let corpus
  try { corpus = await createReviewCorpus({ root: f.root }) } finally { openMock.mock.restore() }
  t.after(() => corpus.dispose())
  assert.equal(changed, true)
  assert.deepEqual(corpus.glob({ pattern: '*' }).paths, [])
})

test('bounds are deterministic, bounded, and visible without rejected names', async t => {
  const f = await fixture(t)
  await f.put('project/z.js', 'z')
  await f.put('project/a.js', 'a\na\na')
  await f.put('project/b.js', 'b'.repeat(100))
  let corpus = await createReviewCorpus({ root: f.root, limits: { maxFiles: 1 } })
  assert.deepEqual(corpus.glob({ pattern: '*' }).paths, ['/project/a.js'])
  assert.equal(corpus.publicInfo().truncated, true); corpus.dispose()
  corpus = await createReviewCorpus({ root: f.root, limits: { maxFileBytes: 10, maxBytes: 10, maxResults: 1, maxReadLines: 1 } })
  assert.deepEqual(corpus.glob({ pattern: '*' }), { paths: ['/project/a.js'], truncated: true })
  assert.equal(corpus.publicInfo().fileCount, 2)
  assert.ok(corpus.publicInfo().byteCount <= 10)
  assert.equal(corpus.publicInfo().truncated, true)
  assert.equal(corpus.grep({ pattern: 'a' }).truncated, true)
  assert.equal(corpus.read({ file_path: 'a.js' }).content, 'a')
  denied(() => corpus.read({ file_path: 'b.js' }))
  denied(() => corpus.read({ file_path: 'a.js', limit: 2 })); corpus.dispose()
  corpus = await createReviewCorpus({ root: f.root, limits: { maxEntries: 1 } })
  assert.equal(corpus.publicInfo().fileCount, 0)
  assert.equal(corpus.publicInfo().truncated, true); corpus.dispose()
  corpus = await createReviewCorpus({ root: f.root, limits: { maxOutputBytes: 2 } })
  assert.equal(corpus.read({ file_path: 'a.js' }).content, 'a')
  assert.equal(corpus.read({ file_path: 'a.js' }).truncated, true)
  denied(() => corpus.grep({ pattern: 'a' }))
  denied(() => corpus.glob({ pattern: '*' }))
  denied(() => corpus.read({ file_path: 'b.js' }))
  corpus.dispose()
  await deniedAsync(() => createReviewCorpus({ root: f.root, limits: { maxBytes: 0 } }))
  await deniedAsync(() => createReviewCorpus({ root: f.root, limits: { maxFiles: 1000000 } }))
})

test('cancellation before and during capture and after creation fails closed; disposal is idempotent', async t => {
  const f = await fixture(t)
  await f.put('project/a.js')
  await deniedAsync(() => createReviewCorpus({ root: f.root, signal: AbortSignal.abort('FAKE_SECRET_ABORT_REASON') }), ['FAKE_SECRET_ABORT_REASON'])
  const controller = new AbortController(), originalOpen = fs.open
  const openMock = t.mock.method(fs, 'open', async function (location, ...args) {
    const handle = await originalOpen.call(this, location, ...args)
    if (String(location).endsWith('/a.js')) controller.abort('FAKE_SECRET_ABORT_REASON')
    return handle
  })
  try { await deniedAsync(() => createReviewCorpus({ root: f.root, signal: controller.signal }), ['FAKE_SECRET_ABORT_REASON']) } finally { openMock.mock.restore() }
  const later = new AbortController()
  const corpus = await createReviewCorpus({ root: f.root, signal: later.signal })
  later.abort()
  denied(() => corpus.glob({ pattern: '*' }))
  corpus.dispose(); corpus.dispose()
  for (const method of ['read', 'grep', 'glob', 'publicInfo', 'rewritePaths']) denied(() => corpus[method]())
})

test('root validation fails closed without probing broad home/OS records', async t => {
  const f = await fixture(t)
  const ordinaryFile = await f.put('file.js')
  await fs.symlink(f.root, path.join(f.base, 'root-link'))
  for (const root of [undefined, '/', '/home', '/home/fake-user', os.homedir(), '/etc', '/proc', f.base + '/missing', ordinaryFile, path.join(f.base, 'root-link')]) {
    await deniedAsync(() => createReviewCorpus({ root }), [f.base])
  }
})

test('path display rewriting never silently changes admitted source literals; protected references are withheld', async t => {
  const f = await fixture(t), protectedRoot = path.join(f.outside, '.dsh')
  const sourceText = `See ${f.root}/a.js and ${f.extra}/b.js.`
  await f.put('project/paths.md', sourceText)
  await f.put('project/readme.md', `${sourceText} Hidden ${protectedRoot}/sessions/fake-record.md`)
  const corpus = await createReviewCorpus({ root: f.root, additionalRoots: [f.extra], protectedRoots: [protectedRoot] })
  t.after(() => corpus.dispose())
  assert.equal(corpus.rewritePaths(`${f.root}/a.js '${f.extra}' ${protectedRoot}/sessions/record.md`), "/project/a.js '/external-1' [protected path]")
  assert.equal(corpus.rewritePaths(`${f.root}-other/a.js`), `${f.root}-other/a.js`)
  denied(() => corpus.read({ file_path: 'readme.md' }), [protectedRoot])
  assert.equal(corpus.read({ file_path: 'paths.md' }).content, sourceText)
  assert.equal(corpus.rewritePaths('arbitrary-unrecognized-secret'), 'arbitrary-unrecognized-secret')
})

test('nonregular sockets are excluded without opening them', async t => {
  const f = await fixture(t)
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(f.root, 'socket.js'), resolve) })
  try {
    const corpus = await createReviewCorpus({ root: f.root })
    assert.deepEqual(corpus.glob({ pattern: '*' }), { paths: [], truncated: false })
    denied(() => corpus.read({ file_path: 'socket.js' }))
    corpus.dispose()
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('missing procfs support is explicit and never uses an unsafe fallback', async t => {
  const f = await fixture(t)
  const statfsMock = t.mock.method(fs, 'statfs', async () => { throw new Error(`FAKE_OS_ERROR ${f.outside}`) })
  try {
    await assert.rejects(() => createReviewCorpus({ root: f.root }), error => {
      assert.equal(error.code, 'CIEL_REVIEW_ACCESS_LIMITED')
      assert.equal(error.reason, 'UNSUPPORTED_PLATFORM')
      assert.match(error.message, /Linux, descriptor-safe filesystem APIs/)
      assert.equal(error.stack.includes(f.outside), false)
      assert.equal(error.stack.includes('FAKE_OS_ERROR'), false)
      return true
    })
  } finally { statfsMock.mock.restore() }
})

test('rejected content also consumes bounded capture work and deep directories are excluded', async t => {
  const f = await fixture(t)
  await f.put('project/a.js', 'const password = "FAKE_SECRET"')
  await f.put('project/b.js', 'b'.repeat(100))
  await f.put('project/sub/deeper/deep.js', 'deep')
  const corpus = await createReviewCorpus({ root: f.root, limits: { maxBytes: 100, maxDepth: 1 } })
  assert.equal(corpus.publicInfo().truncated, true)
  assert.equal(corpus.publicInfo().fileCount, 0)
  assert.deepEqual(corpus.grep({ pattern: 'missing' }), { matches: [], truncated: true })
  denied(() => corpus.read({ file_path: 'b.js' }))
  denied(() => corpus.glob({ pattern: '*', path: 'sub/deeper' }))
  corpus.dispose()
})

test('sensitivity heuristic catches common credentials but makes no arbitrary-secret guarantee', () => {
  for (const text of [
    '-----BEGIN ' + 'PRIVATE KEY-----\nFAKE',
    'const credential = "' + 'AKIA' + 'ABCDEFGHIJKLMNOP' + '"',
    'const url = "https://fake-user:fake-password@example.invalid/path"',
    'const url = "postgres://fake-user:fake-password@localhost/db"',
    'fetch("https://example.invalid?access_token=FAKE_TOKEN")',
    'Authorization: Bearer FAKE_LONG_BEARER_TOKEN',
    'const apiKey = "FAKE_API_KEY"',
    '{"client_secret":"FAKE_CLIENT_SECRET"}',
    'PASSWORD=FAKE_PASSWORD',
  ]) assert.equal(detectSensitiveText(text), true)
  assert.equal(detectSensitiveText('export const answer = 42'), false)
  assert.equal(detectSensitiveText('const value = "arbitrary-hidden-secret-with-no-marker"'), false)
  assert.equal(detectSensitiveText('const token = process.env.ACCESS_TOKEN'), false)
  assert.equal(typeof detectSensitiveText('const password = "fake"'), 'boolean')
})

test('placeholder credential values never fail the review while real shapes still do', () => {
  for (const text of [
    'dsh web: http://127.0.0.1:3080/?token=…',
    'dsh web: http://127.0.0.1:3080/?token=...',
    'dsh web: http://127.0.0.1:3080/?token=<token>',
    'const apiKey = "YOUR_API_KEY"',
    'const token = "changeme"',
    'SECRET=[redacted]',
    'const token = "${ACCESS_TOKEN}"',
    'const apiKey = "example"',
    'const token = ""',
    // Markdown backticks, list punctuation, and prose wrappers must not turn a
    // placeholder into a credential value.
    '启动网址是 `http://127.0.0.1:3080/?token=…` 请替换',
    '（示例 ?token=…）',
    '规则写作 [?&]token=... 匹配',
    '| `?token=…`、`?token=...`、`?token=<token>` | 示例 |',
    'SECRET=changeme,',
  ]) assert.equal(detectSensitiveText(text), false)
  for (const text of [
    'dsh web: http://127.0.0.1:3080/?token=' + 'A'.repeat(43),
    'const apiKey = "FAKE_API_KEY"',
    '{"client_secret":"FAKE_CLIENT_SECRET"}',
    'PASSWORD=FAKE_PASSWORD',
  ]) assert.equal(detectSensitiveText(text), true)
})
