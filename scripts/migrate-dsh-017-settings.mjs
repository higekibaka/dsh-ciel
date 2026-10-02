#!/usr/bin/env node
/** Retarget legacy namespaces before DSH's one-time import; default dry-run. */
import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const aliases = {
  ciel: 'advisor',
  'dsh-theme-endfield-glass': 'endfield-glass',
  'subagent-model-selection': 'subagent-model-selection-settings',
  'agent-presets': 'agent-preset-registry',
}
export function migrateDocument(document) {
  const changes = []
  for (const [legacy, entry] of Object.entries(aliases)) {
    const original = document.get(legacy, true)
    if (original === undefined) continue
    const section = original.clone()
    if (!section.items || section.items.some(pair => typeof pair.key?.value !== 'string')) throw new Error(`Invalid settings mapping: ${legacy}`)
    // The registry separates the deployment default from the user's selection.
    if (legacy === 'agent-presets' && section.has('default')) {
      if (section.has('selectedDefault')) section.delete('default')
      else section.items.find(pair => pair.key.value === 'default').key.value = 'selectedDefault'
    }
    let target = document.get(entry, true)
    if (target !== undefined && (!target.items || target.items.some(pair => typeof pair.key?.value !== 'string'))) throw new Error(`Invalid settings mapping: ${entry}`)
    // An existing destination is an explicit migrated choice; keep its fields.
    if (target === undefined) { document.set(entry, section.clone()); target = document.get(entry, true) }
    else for (const pair of section.items) if (!target.has(pair.key.value)) target.add(pair.clone())
    const oldKey = document.contents.items.find(pair => pair.key?.value === legacy)?.key
    const newKey = document.contents.items.find(pair => pair.key?.value === entry)?.key
    if (oldKey?.commentBefore && newKey) newKey.commentBefore = [oldKey.commentBefore, newKey.commentBefore].filter(Boolean).join('\n')
    document.delete(legacy)
    changes.push({ from: legacy, to: entry, fields: section.items.length })
  }
  return changes
}
export async function main(args = process.argv.slice(2)) {
  const values = new Map(), flags = new Set()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') flags.add(args[i])
    else if (['--home', '--file', '--checkout'].includes(args[i]) && args[i + 1]) values.set(args[i], args[++i])
    else throw new Error('Usage: --home /path/to/dsh-home [--file settings.yaml.imported] [--checkout /path/to/dsh] [--apply]')
  }
  if (!values.has('--home')) throw new Error('--home is required; no implicit writes to your daily Home')
  const home = resolve(values.get('--home')), filename = resolve(home, values.get('--file') || 'settings.yaml')
  const checkout = values.get('--checkout') || process.env.DSH_CHECKOUT
  if (!checkout) throw new Error('Pass --checkout or DSH_CHECKOUT to resolve the installed YAML parser')
  const { parseDocument, isMap } = createRequire(join(resolve(checkout), 'packages/settings/settings/package.json'))('yaml')
  const original = await readFile(filename, 'utf8')
  const document = parseDocument(original)
  if (document.errors.length || !isMap(document.contents)) throw new Error('Settings document must be a valid YAML mapping')
  const changes = migrateDocument(document)
  const plan = { mode: flags.has('--apply') ? 'apply' : 'dry-run', file: filename, changes }
  if (flags.has('--apply') && changes.length) {
    const info = await stat(filename)
    const backup = filename + '.pre-dsh-017-' + Date.now(), temporary = filename + '.dsh-017-' + process.pid
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 })
    try {
      await writeFile(temporary, document.toString(), { flag: 'wx', mode: info.mode & 0o600 })
      if (await readFile(filename, 'utf8') !== original) throw new Error('Settings changed while preparing migration; refusing to overwrite')
      await rename(temporary, filename)
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    plan.backup = backup
  }
  console.log(JSON.stringify(plan, null, 2)) // Names/counts only; never configuration values.
  return plan
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) await main()
