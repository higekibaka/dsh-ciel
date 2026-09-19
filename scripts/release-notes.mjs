#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const { version } = JSON.parse(await readFile(new URL('plugin/package.json', root), 'utf8'))
const changelog = await readFile(new URL('CHANGELOG.md', root), 'utf8')
const heading = `## [${version}]`
const start = changelog.indexOf(heading)
if (start < 0) throw new Error(`Missing changelog entry for ${version}`)
const bodyStart = changelog.indexOf('\n', start) + 1
const next = changelog.indexOf('\n## [', bodyStart)
const body = changelog.slice(bodyStart, next < 0 ? undefined : next).trim()
if (!body) throw new Error(`Empty changelog entry for ${version}`)
console.log(`Install: \`dsh plugin --profile web add dsh-ciel@${version}\`\n`)
console.log(body.replaceAll('](docs/', `](https://github.com/higekibaka/dsh-ciel/blob/v${version}/docs/`))
