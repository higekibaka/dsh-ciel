#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { packageReadme } from './docs-contract.mjs'
const root = new URL('../', import.meta.url)
const output = packageReadme(await readFile(new URL('README.en.md', root), 'utf8'))
const path = new URL('plugin/README.md', root)
const current = await readFile(path, 'utf8')
if (current !== output) await writeFile(path, output)
console.log('Synced plugin/README.md from README.en.md')
