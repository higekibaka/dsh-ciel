/** Offline documentation invariants; prose correctness still needs review. */
import { posix } from 'node:path'

export function packageReadme(english) {
  const start = english.indexOf('# dsh-ciel (Ciel)\n')
  if (start < 0) throw new Error('English README product heading is missing')
  return '<!-- Generated from README.en.md by scripts/sync-docs.mjs; do not edit directly. -->\n\n'
    + english.slice(start).replace(/\]\((?:\.\/)?(docs\/[^)]+|CHANGELOG\.md)\)/g,
      (_, path) => '](https://github.com/higekibaka/dsh-ciel/blob/main/' + path + ')')
}

export function checkReadme(text, version, fields, defaults, language) {
  const errors = []
  const current = text.match(/(?:当前版本：|Current release:)\s*\*\*\[([^\]]+)\]/)?.[1]
  if (current !== version) errors.push('current release must match plugin/package.json')
  for (const url of ['https://github.com/higekibaka/dsh-ciel/releases/tag/v' + version, 'https://www.npmjs.com/package/dsh-ciel/v/' + version]) {
    if (!text.includes('](' + url + ')')) errors.push('missing current release link: ' + url)
  }
  const installs = [...text.matchAll(/dsh plugin --profile web add dsh-ciel@([^\s`]+)/g)].map(m => m[1])
  if (!installs.length || installs.some(value => value !== version)) errors.push('install command version mismatch')
  const heading = language === 'zh' ? '## ' + version + ' 更新' : "## What's new in " + version
  if (!text.split('\n').includes(heading)) errors.push('release highlights heading mismatch')
  const rows = [...text.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \| ([^|]+) \|/gm)]
  const names = rows.map(row => row[1])
  const expected = Object.keys(fields).filter(key => !fields[key].meta.hidden)
  if (names.length !== new Set(names).size) errors.push('duplicate configuration field row')
  for (const name of expected) if (!names.includes(name)) errors.push('missing configuration row: ' + name)
  for (const [, name, cell] of rows) {
    if (!expected.includes(name)) { errors.push('unknown or retired configuration row: ' + name); continue }
    const value = defaults[name]
    const wanted = value === undefined ? (language === 'zh' ? '未设置' : 'unset')
      : '`' + (typeof value === 'string' ? value : JSON.stringify(value)) + '`'
    if (cell.trim() !== wanted) errors.push('configuration default mismatch: ' + name)
  }
  return errors
}

export function checkClassification(text) {
  const kinds = [...text.matchAll(/<!-- ciel-doc: (current|historical) -->/g)].map(m => m[1])
  if (kinds.length !== 1) return ['expected exactly one current/historical document marker']
  if (kinds[0] === 'current' && /^#{1,6} .*?(?:开发版|尚未发布|unreleased)/im.test(text)) return ['current page still has an unreleased feature heading']
  return []
}

function anchors(text) {
  const found = new Set(), counts = new Map()
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1].replace(/<[^>]*>/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-')
    const count = counts.get(slug) || 0
    counts.set(slug, count + 1)
    found.add(slug + (count ? '-' + count : ''))
  }
  return found
}

// Inline Markdown links only; remote URLs are never fetched.
export function checkLinks(file, text, files, tracked) {
  const errors = []
  for (const match of text.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue
    let path, fragment
    try { [path, fragment] = href.split('#').map(decodeURIComponent) } catch { errors.push('invalid encoded link'); continue }
    const target = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file
    if (!tracked.has(target)) { errors.push('link target is not a public repository file: ' + href); continue }
    if (fragment && target.endsWith('.md') && files.has(target) && !anchors(files.get(target)).has(fragment)) errors.push('missing heading anchor: ' + href)
  }
  return errors
}
