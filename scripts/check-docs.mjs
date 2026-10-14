#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Config, configValues } from '../plugin/index.js'
import { packageReadme, checkReadme, checkClassification, checkLinks } from './docs-contract.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8')
const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
for (const path of tracked) { try { await access(new URL('../' + path, import.meta.url)) } catch (error) { if (error.code !== 'ENOENT') throw error; tracked.delete(path) } }
const files = new Map(await Promise.all([...tracked].filter(path => path.endsWith('.md')).map(async path => [path, await read(path)])))
const { version } = JSON.parse(await read('plugin/package.json'))
const defaults = configValues(Config({})), failures = []
if (!files.get('CHANGELOG.md')?.includes('## [' + version + ']')) failures.push('CHANGELOG.md: missing current release entry')
const add = (file, errors) => failures.push(...errors.map(error => file + ': ' + error))
for (const [file, language] of [['README.md', 'zh'], ['README.en.md', 'en'], ['plugin/README.md', 'en']]) {
  add(file, checkReadme(files.get(file), version, Config.dict, defaults, language))
}
if (files.get('plugin/README.md') !== packageReadme(files.get('README.en.md'))) add('plugin/README.md', ['stale generated copy; run pnpm docs:sync'])
for (const [file, text] of files) {
  if (file !== 'CHANGELOG.md') add(file, checkClassification(text))
  add(file, checkLinks(file, text, files, tracked))
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log('Documentation check passed: ' + files.size + ' public Markdown files; Config defaults, generated README, classification and current relative links agree.')
