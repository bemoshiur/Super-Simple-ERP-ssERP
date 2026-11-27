#!/usr/bin/env node
/**
 * Markdown link check for the repository's documentation (no dependencies, no network).
 *
 * Checks every relative link and image in README*.md, the root community files, docs/**.md and the wiki sources in
 * docs/wiki/: the target file or folder must exist, and a `#anchor` must match a heading in the target Markdown file
 * (GitHub's slug rules, including non-Latin headings). External links (http, https, mailto) are not fetched.
 *
 * Wiki sources (docs/wiki/*.md) use GitHub wiki links: `[Text](Page-Name)` resolves to docs/wiki/Page-Name.md.
 *
 *   node scripts/check-links.mjs           # or: npm run check:docs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wikiDir = join(root, 'docs', 'wiki')

/** Markdown files to check. */
function collect() {
  const files = readdirSync(root)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(root, f))
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) files.push(p)
    }
  }
  walk(join(root, 'docs'))
  if (existsSync(join(root, '.github'))) walk(join(root, '.github'))
  return files
}

/** Text with fenced code blocks and inline code removed (links inside code are examples, not links). */
function stripCode(md) {
  return md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

/** GitHub heading slug: lower case, punctuation removed (letters, marks, numbers, spaces, `-`, `_` kept), spaces to `-`. */
export function slug(text) {
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
  return plain.replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/ /g, '-')
}

const anchorCache = new Map()
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file)
  const seen = new Map()
  const set = new Set()
  const text = readFileSync(file, 'utf8').replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slug(m[1].replace(/`/g, ''))
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    set.add(n === 0 ? base : `${base}-${n}`)
  }
  // Explicit HTML anchors: <a id="x"> / <a name="x">
  for (const m of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1])
  anchorCache.set(file, set)
  return set
}

const errors = []
const files = collect()
let links = 0

for (const file of files) {
  const isWiki = dirname(file) === wikiDir
  const body = stripCode(readFileSync(file, 'utf8'))
  const lines = body.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/!?\[(?:[^\]]|\][^(])*?\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1]
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue
      links++
      const where = `${relative(root, file)}:${i + 1}`
      const [pathPart, anchor] = target.split('#')
      let dest
      if (pathPart === '') dest = file
      else if (isWiki && !pathPart.includes('/') && !/\.[a-z0-9]+$/i.test(pathPart)) dest = join(wikiDir, `${decodeURIComponent(pathPart)}.md`)
      else dest = resolve(dirname(file), decodeURIComponent(pathPart))
      if (!existsSync(dest)) {
        errors.push(`${where}  missing target: ${target}`)
        continue
      }
      if (anchor !== undefined && anchor !== '') {
        if (statSync(dest).isDirectory() || !dest.endsWith('.md')) {
          errors.push(`${where}  anchor on a non-Markdown target: ${target}`)
          continue
        }
        const a = decodeURIComponent(anchor).toLowerCase()
        if (!anchorsOf(dest).has(a)) errors.push(`${where}  missing anchor #${anchor} in ${relative(root, dest)}`)
      }
    }
  })
}

if (errors.length) {
  console.error(`check-links: ${errors.length} broken link(s) in ${files.length} files:\n` + errors.map((e) => `  ${e}`).join('\n')) // log-ok: prints the link checker's own findings (file paths), no caught error or secret
  process.exit(1)
}
console.log(`check-links: ${links} relative links in ${files.length} Markdown files OK.`)
