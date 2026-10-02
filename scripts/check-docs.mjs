#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Config, configValues } from '../plugin/index.js'
import { packageReadme, checkReadme, checkClassification, checkLinks } from './docs-contract.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8')
const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
const files = new Map(await Promise.all([...tracked].filter(path => path.endsWith('.md')).map(async path => [path, await read(path)])))
const { version } = JSON.parse(await read('plugin/package.json'))
const defaults = configValues(Config({})), failures = []
const add = (file, errors) => failures.push(...errors.map(error => file + ': ' + error))
for (const [file, language] of [['README.md', 'zh'], ['README.en.md', 'en'], ['plugin/README.md', 'en']]) {
  add(file, checkReadme(files.get(file), version, Config.dict, defaults, language))
}
if (files.get('plugin/README.md') !== packageReadme(files.get('README.en.md'))) add('plugin/README.md', ['stale generated copy; run pnpm docs:sync'])
const changelog = files.get('CHANGELOG.md')
if (!/^## \[Unreleased\]$/m.test(changelog)) add('CHANGELOG.md', ['missing Unreleased section'])
const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1])
if (releases[0] !== version) add('CHANGELOG.md', ['newest version heading differs from package version'])
if (new Set(releases).size !== releases.length) add('CHANGELOG.md', ['duplicate release heading'])
for (const [file, text] of files) {
  if (file !== 'CHANGELOG.md') add(file, checkClassification(text))
  add(file, checkLinks(file, text, files, tracked))
}
const index = files.get('docs/index.md') || ''
if (!index.includes('当前发布基线：**Ciel ' + version + '**')) add('docs/index.md', ['current release baseline mismatch'])
const ci = await read('.github/workflows/ci.yml')
for (const [, target, commit] of ci.matchAll(/- target: (\S+)\s+commit: ([a-f0-9]{40})/g)) {
  if (!index.includes(target + '：' + commit)) add('docs/index.md', ['missing pinned CI target: ' + target])
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log('Documentation check passed: ' + files.size + ' public Markdown files; release, Config defaults, generated README, classification, relative links and CI targets agree.')
