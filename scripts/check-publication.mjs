import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--package')) throw new Error('Usage: node scripts/check-publication.mjs [--package]')
const pack = args.includes('--package')
const files = pack
  ? JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: resolve(root, 'plugin'), encoding: 'utf8' }))[0].files.map(file => `plugin/${file.path}`)
  : execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)

// These two curated summaries contain no raw transcripts.
const summaries = new Set(['docs/ab/ab-comparison-0.13.0.md', 'docs/ab/stability-verification.md'])
const forbiddenPath = /(?:^|\/)(?:\.npmrc|\.pypirc|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.[^/]*)?|secrets(?:\.[^/]*)?|cookies[^/]*|storage-state[^/]*|storageState[^/]*)$|\.(?:pem|key|p12|pfx|har|jsonl|tgz)$/i
const privateDirectory = /^(?:\.artifacts|\.local|\.auth|\.dsh|prototypes|docs\/images|test-results|playwright-report)\//
const media = /\.(?:png|jpe?g|gif|webp|avif|mp4|webm)$/i
const patterns = [
  ['credential', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{25,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['auth-url', /[?&](?:token|api_key|access_token|password)=[A-Za-z0-9_.~+/%=-]{12,}/gi],
  ['auth-value', /(?:Bearer\s+|(?:api[_-]?key|auth[_-]?token|password|secret)["\s]*[:=]\s*["'])([A-Za-z0-9_.~+/-]{20,})/gi],
  ['personal-path', /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\|\/mnt\/[a-z]\/Users\/)(?!example(?:[\/\\]|\b)|user(?:[\/\\]|\b)|tester(?:[\/\\]|\b))[^\s"'<>/\\)]+/g],
]

function isFakeFixture(file, kind, match, text) {
  if (file === 'plugin/test/review-corpus.test.js' && kind === 'personal-path') return match[0] === '/home/' + 'fake-user'
  if (file === 'plugin/test/review-corpus.test.js' && kind === 'auth-value') return match[1] === 'FAKE_LONG_BEARER_TOKEN'
  if (file === 'plugin/test/review-privacy.test.js' && kind === 'auth-value') return match[1] === 'FAKE_SECRET_TEST_VALUE_NOT_REAL'
  if (file !== 'plugin/test/review-evidence.test.js') return false
  if (kind === 'credential') return match[0] === 'sk-proj-' + 'abcdefghijklmnop'
  return kind === 'private-key' && text.slice(match.index + match[0].length).startsWith('\\nFAKE\\n')
}

const findings = []
function flag(file, kind, text = '', index = 0) {
  // Never print a matching value or the source line: it could contain a secret.
  findings.push({ file, kind, line: text.slice(0, index).split('\n').length })
}

for (const file of files) {
  const exampleEnv = /(?:^|\/)\.env\.(?:example|sample)$/.test(file)
  if ((!exampleEnv && forbiddenPath.test(file)) || privateDirectory.test(file) || media.test(file)
    || (file.startsWith('docs/ab/') && !summaries.has(file))
    || /^docs\/(?:stability-plan|upstream-agent-team-race-discussion)/.test(file)) flag(file, 'private-artifact')
  const data = readFileSync(resolve(root, file))
  if (data.includes(0)) continue // Media is blocked above; pixels still require human review.
  const text = data.toString('utf8')
  const home = homedir()
  if (home.length > 5 && text.includes(home)) flag(file, 'current-home-path', text, text.indexOf(home))
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!isFakeFixture(file, kind, match, text)) flag(file, kind, text, match.index)
    }
  }
}

if (findings.length) {
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.kind}`)
  process.exitCode = 1
} else {
  console.log(`Publication check passed: ${files.length} ${pack ? 'package' : 'tracked'} files; no matching private artifacts or credential patterns.`)
}
