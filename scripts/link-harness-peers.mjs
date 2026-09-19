#!/usr/bin/env node
/** Bind a linked development plugin to the built Harness that runs it.
 * pnpm may otherwise keep a second, older dsh-scope identity under this repo.
 * Published installs use their package manager's peer dependency resolution.
 */
import { lstat, readlink, symlink, unlink, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const checkout = process.env.DSH_CHECKOUT || process.argv[2]
if (!checkout) throw new Error('Usage: DSH_CHECKOUT=/path/to/built/deepseek-harness node scripts/link-harness-peers.mjs')
const plugin = fileURLToPath(new URL('../plugin/', import.meta.url))
const packages = {
  '@deepseek-ai/dsh-subagent': 'packages/subagent/subagent',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-typert-protocol': 'packages/typert/protocol',
}
const links = []
for (const [name, relative] of Object.entries(packages)) {
  const target = resolve(checkout, relative)
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  if (manifest.name !== name) throw new Error('Unexpected package: ' + target)
  await lstat(join(target, 'lib/index.js'))
  const path = join(plugin, 'node_modules', name)
  const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (stat && !stat.isSymbolicLink()) throw new Error('Refusing to replace a non-symlink: ' + path)
  links.push({ name, path, target, previous: stat ? await readlink(path) : null })
}
const backup = await mkdtemp(join(tmpdir(), 'ciel-harness-peers-'))
await writeFile(join(backup, 'links.json'), JSON.stringify(links, null, 2) + '\n', { mode: 0o600 })
for (const link of links) {
  await mkdir(dirname(link.path), { recursive: true })
  if (link.previous !== null) await unlink(link.path)
  await symlink(link.target, link.path, 'dir')
}
console.log('Linked ' + links.length + ' shared peers to ' + resolve(checkout))
console.log('Previous links: ' + join(backup, 'links.json'))
