#!/usr/bin/env node
// Offline equivalent of scripts/check-docs.mjs + scripts/check-publication.mjs for
// sandboxes where `git` cannot be spawned. It reads the working tree instead of
// the tracked-file list and scans the files this plugin actually ships.
import { readFile, access, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Config, configValues } from '../plugin/index.js'
import { packageReadme, checkReadme, checkClassification, checkLinks } from './docs-contract.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFile(join(root, file), 'utf8')
const SKIP = new Set(['node_modules', '.git', '.tmp', '.pnpm', 'docs/images'])
// Mirrors the local-only entries in .gitignore so this offline check sees the
// same working set that "git ls-files" would report.
const IGNORED = [
  /^prototypes\//,
  /^docs\/stability-plan\.md$/,
  /^docs\/upstream-agent-team-race-discussion[^/]*\.md$/,
  /^docs\/ab\/(?!ab-comparison-0\.13\.0\.md$|stability-verification\.md$)/,
  /^docs\/images\//,
  /^(?:archive|\.local|\.artifacts|\.cache)\//,
  /^design-qa\.md$/,
]

async function walk(dir, base) {
  const out = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const rel = base === '' ? entry.name : base + '/' + entry.name
    if (IGNORED.some(pattern => pattern.test(rel))) continue
    if (entry.isDirectory()) out.push(...await walk(rel, rel))
    else out.push(rel)
  }
  return out
}

const tracked = new Set(await walk('', ''))
for (const path of [...tracked]) {
  try { await access(join(root, path)) } catch (error) { if (error.code === 'ENOENT') tracked.delete(path); else throw error }
}
const files = new Map(await Promise.all([...tracked].filter(path => path.endsWith('.md')).map(async path => [path, await read(path)])))
const manifest = JSON.parse(await read('plugin/package.json'))
const version = manifest.version
const defaults = configValues(Config({}))
const failures = []
const add = (file, errors) => failures.push(...errors.map(error => file + ': ' + error))

if (!files.get('CHANGELOG.md')?.includes('## [' + version + ']')) failures.push('CHANGELOG.md: missing current release entry')
for (const [file, language] of [['README.md', 'zh'], ['README.en.md', 'en'], ['plugin/README.md', 'en']]) {
  add(file, checkReadme(files.get(file) || '', version, Config.dict, defaults, language))
}
if (files.get('plugin/README.md') !== packageReadme(files.get('README.en.md') || '')) add('plugin/README.md', ['stale generated copy; run pnpm docs:sync'])
for (const [file, text] of files) {
  if (file !== 'CHANGELOG.md') add(file, checkClassification(text))
  add(file, checkLinks(file, text, files, tracked))
}

// Package manifest: every shipped path must exist.
for (const file of manifest.files) {
  if (!tracked.has('plugin/' + file)) failures.push('plugin/package.json: missing shipped file ' + file)
}

// Publication gate: the same credential/privacy patterns as check-publication.mjs,
// applied to the files this change touched and the plugin sources.
const patterns = [
  ['credential', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{25,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['auth-url', /[?&](?:token|api_key|access_token|password)=[A-Za-z0-9_.~+/%=-]{12,}/gi],
  ['auth-value', /(?:Bearer\s+|(?:api[_-]?key|auth[_-]?token|password|secret)["\s]*[:=]\s*["'])([A-Za-z0-9_.~+/-]{20,})/gi],
  ['personal-path', /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\|\/mnt\/[a-z]\/Users\/)(?!example(?:[\/\\]|\b)|user(?:[\/\\]|\b)|tester(?:[\/\\]|\b))[^\s"'<>/\\)]+/g],
]
const scanTargets = [...tracked].filter(file => (file.startsWith('plugin/') && !file.startsWith('plugin/README.md')))
scanTargets.push('README.md', 'README.en.md', 'plugin/README.md', 'SECURITY.md', 'docs/architecture.md', 'docs/compatibility-017.md')
scanTargets.push(...[...tracked].filter(file => file.startsWith('scripts/verify-')))
const allowlisted = new Set(['settings-fixture-secret', 'FAKE_LONG_BEARER_TOKEN'])
const seen = new Set()
for (const file of scanTargets) {
  if (seen.has(file)) continue
  seen.add(file)
  let text
  try { text = await read(file) } catch { continue }
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (kind === 'auth-value' && allowlisted.has(match[1])) continue
      failures.push(file + ': publication pattern ' + kind + ' at line ' + (text.slice(0, match.index).split('\n').length))
    }
  }
}

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log('Offline documentation and publication check passed: ' + files.size + ' Markdown files, ' + manifest.files.length + ' shipped files, ' + seen.size + ' scanned sources.')