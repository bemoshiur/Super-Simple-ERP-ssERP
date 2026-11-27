#!/usr/bin/env node
// Licence guard: proves that no tracked file is copied from (or derived from) a
// commercial UI theme kept locally as a reference.
//
// Usage:
//   node scripts/theme-inventory.mjs              # both modes (reference mode skips if no ref dir)
//   node scripts/theme-inventory.mjs --identifiers # identifier mode only (CI)
//   node scripts/theme-inventory.mjs --reference   # reference mode only
//   node scripts/theme-inventory.mjs --list        # print every flagged path (no summary limit)
//   node scripts/theme-inventory.mjs --reference --probe a.tsx b.scss   # check these files instead of the repository
// --identifiers and --reference together run both modes (same as passing neither).
//
// Reference mode: THEME_REF_DIR (one or more directories separated by ":"; default: every top-level, git-ignored
// folder named like a vendor package, <Name>_v<version>/) is walked; every tracked file is compared to every
// reference file by sha256 (=> "identical") and by normalised-line overlap
// (>= THEME_SIMILARITY, default 0.7, of the tracked file's significant lines
// found in one reference file => "derived"), by the longest run of identical consecutive non-blank lines shared with one
// reference file (>= THEME_BLOCK_LINES, default 8 => "copied block") and by 8-token shingles (>= THEME_SHINGLE,
// default 0.5, of the file's shingles found in one reference file => "derived"). Skips with exit 0 when no reference
// directory exists (the reference is a paid product and is never committed).
//
// Identifier mode: fails when a tracked file mentions the theme's name or its
// vendor outside the files that are allowed to document their removal.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const args = new Set(argv)
const probeAt = argv.indexOf('--probe')
const probe = probeAt >= 0 ? argv.slice(probeAt + 1).filter((a) => !a.startsWith('--')) : null
// Each flag selects a mode; no flag, or both flags, runs both.
const runIdentifiers = args.has('--identifiers') || !args.has('--reference')
const runReference = args.has('--reference') || !args.has('--identifiers')
const listAll = args.has('--list')

// Files that may name the removed theme: the licence history.
const IDENTIFIER_ALLOW = new Set(['docs/THIRD_PARTY.md', 'CHANGELOG.md'])
// The two identifiers, assembled so that this guard does not trip over itself.
const NAMES = [['u', 'bold'], ['coder', 'themes'], ['theme', 'forest'], ['en', 'vato']].map((p) => p.join(''))

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.scss', '.css', '.json', '.md', '.html', '.svg', '.yml', '.yaml', '.txt',
])
const SKIP_DIRS = new Set(['node_modules', '.next', '.git'])
const MIN_SIGNIFICANT_LINES = 4
const SHINGLE = 8 // tokens per shingle
const MIN_SHINGLES = 20 // files with fewer shingles are too small to judge this way

/** Tracked files plus new files that are not ignored (what the next commit can contain); deleted files are skipped. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 << 20 })
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile())
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, acc)
    else if (st.isFile()) acc.push(full)
  }
  return acc
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
/** 32-bit FNV-1a: cheap hash for line windows and shingles (collisions only ever over-report, never hide). */
function fnv(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193)
  return h >>> 0
}
/** Every non-blank line, whitespace-collapsed and lower-cased (no minimum length: braces count too). */
const blockLines = (text) => text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean)
/** Hashes of every window of `n` consecutive lines. */
function windows(lines, n) {
  const out = []
  for (let i = 0; i + n <= lines.length; i++) out.push(fnv(lines.slice(i, i + n).join('\n')))
  return out
}
/** Hashes of every run of SHINGLE consecutive tokens (identifiers, numbers, single punctuation marks). */
function shingles(text) {
  const tokens = text.toLowerCase().match(/[a-z0-9_$#.-]+|[^\sa-z0-9_$#.-]/g) ?? []
  const out = new Set()
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(fnv(tokens.slice(i, i + SHINGLE).join(' ')))
  return out
}
/** Longest run of identical consecutive lines shared by `a` and `b` (classic DP over the two line lists). */
function longestBlock(a, b) {
  let best = 0
  let prev = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint32Array(b.length + 1)
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) best = Math.max(best, (cur[j] = prev[j - 1] + 1))
    prev = cur
  }
  return best
}

// A line is "significant" when, after collapsing whitespace and stripping quotes
// and trailing punctuation, it still carries at least 12 characters and is not
// one of the ubiquitous boilerplate lines every React/Sass project shares.
const BOILERPLATE = new Set([
  "use client", 'export default app', 'import react from react', "import type { metadata } from next",
  'children: react.reactnode', 'children', 'return (', 'export default function',
])
function significantLines(text) {
  const set = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .trim()
      .toLowerCase()
      .replace(/["'`;,]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[{}()[\]<>/]+$/g, '')
      .trim()
    if (line.length < 12) continue
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    if (BOILERPLATE.has(line)) continue
    set.add(line)
  }
  return set
}

function identifierMode(files) {
  const hits = []
  for (const p of files) {
    if (IDENTIFIER_ALLOW.has(p)) continue
    if (NAMES.some((n) => p.toLowerCase().includes(n))) {
      hits.push(`${p} (path)`)
      continue
    }
    if (!TEXT_EXT.has(extname(p).toLowerCase()) && extname(p) !== '') continue
    let text
    try {
      text = readFileSync(join(ROOT, p), 'utf8')
    } catch {
      continue
    }
    text.split(/\r?\n/).forEach((line, i) => {
      if (NAMES.some((n) => line.toLowerCase().includes(n))) hits.push(`${p}:${i + 1}`)
    })
  }
  if (hits.length) {
    console.error(`check:theme (identifiers): ${hits.length} hit(s) of theme identifiers:`)
    for (const h of hits) console.error(`  ${h}`)
    return false
  }
  console.log(`check:theme (identifiers): OK - ${files.length} tracked files, no theme identifiers.`)
  return true
}

/** Top-level folders named <Name>_v<version> (how vendor packages unpack) that git ignores. */
function defaultRefDirs() {
  return readdirSync(ROOT).filter((name) => {
    if (!/^[A-Za-z][\w-]*_v\d[\w.]*$/.test(name) || !statSync(join(ROOT, name)).isDirectory()) return false
    try {
      execFileSync('git', ['check-ignore', '-q', name], { cwd: ROOT })
      return true
    } catch {
      return false
    }
  })
}

function referenceMode(files) {
  const dirs = (process.env.THEME_REF_DIR ? process.env.THEME_REF_DIR.split(':').filter(Boolean) : defaultRefDirs())
    .map((d) => join(ROOT, d))
    .filter((d) => existsSync(d))
  if (!dirs.length) {
    console.log('check:theme (reference): SKIPPED - no reference directory present (set THEME_REF_DIR).')
    return true
  }
  const threshold = Number(process.env.THEME_SIMILARITY || '0.7')
  const blockMin = Number(process.env.THEME_BLOCK_LINES || '8')
  const shingleThreshold = Number(process.env.THEME_SHINGLE || '0.5')
  const windowIndex = new Map() // hash of blockMin consecutive lines -> Set<ref index>
  const shingleIndex = new Map() // shingle hash -> ref index | Set<ref index>
  const refLines = []

  const refByHash = new Map()
  const lineIndex = new Map() // significant line -> Set<ref index>
  const refNames = []
  for (const dir of dirs) {
    for (const full of walk(dir)) {
      const buf = readFileSync(full)
      const rel = relative(ROOT, full)
      if (buf.length > 0 && !refByHash.has(sha(buf))) refByHash.set(sha(buf), rel)
      if (!TEXT_EXT.has(extname(full).toLowerCase()) || buf.length > 2_000_000) continue
      const idx = refNames.push(rel) - 1
      const text = buf.toString('utf8')
      for (const line of significantLines(text)) {
        let s = lineIndex.get(line)
        if (!s) lineIndex.set(line, (s = new Set()))
        s.add(idx)
      }
      refLines[idx] = blockLines(text)
      for (const w of windows(refLines[idx], blockMin)) {
        let s = windowIndex.get(w)
        if (!s) windowIndex.set(w, (s = new Set()))
        s.add(idx)
      }
      for (const h of shingles(text)) {
        const cur = shingleIndex.get(h)
        if (cur === undefined) shingleIndex.set(h, idx)
        else if (typeof cur === 'number') {
          if (cur !== idx) shingleIndex.set(h, new Set([cur, idx]))
        }
        else cur.add(idx)
      }
    }
  }

  const identical = []
  const derived = []
  const blocks = []
  const shingled = []
  for (const p of files) {
    const buf = readFileSync(join(ROOT, p))
    if (buf.length === 0) continue
    const same = refByHash.get(sha(buf))
    if (same) {
      identical.push({ p, ref: same })
      continue
    }
    if (!TEXT_EXT.has(extname(p).toLowerCase())) continue
    const text = buf.toString('utf8')
    // 1. a copied block of blockMin+ consecutive lines (exact length confirmed against the candidate files)
    const own = blockLines(text)
    const candidates = new Set()
    for (const w of windows(own, blockMin)) for (const r of windowIndex.get(w) ?? []) candidates.add(r)
    let block = { len: 0, ref: -1 }
    for (const r of candidates) {
      const len = longestBlock(own, refLines[r])
      if (len > block.len) block = { len, ref: r }
    }
    if (block.len >= blockMin) {
      blocks.push({ p, ref: refNames[block.ref], len: block.len })
      continue
    }
    // 2. token shingles
    const sh = shingles(text)
    if (sh.size >= MIN_SHINGLES) {
      const hits = new Map()
      for (const h of sh) {
        const refs = shingleIndex.get(h)
        if (refs === undefined) continue
        for (const r of typeof refs === 'number' ? [refs] : refs) hits.set(r, (hits.get(r) || 0) + 1)
      }
      let top = [0, -1]
      for (const [r, c] of hits) if (c > top[0]) top = [c, r]
      if (top[0] / sh.size >= shingleThreshold) {
        shingled.push({ p, ref: refNames[top[1]], ratio: top[0] / sh.size })
        continue
      }
    }
    // 3. significant-line overlap
    const lines = significantLines(text)
    if (lines.size < MIN_SIGNIFICANT_LINES) continue
    const counts = new Map()
    for (const line of lines) {
      const refs = lineIndex.get(line)
      if (!refs) continue
      for (const r of refs) counts.set(r, (counts.get(r) || 0) + 1)
    }
    let best = 0
    let bestRef = -1
    for (const [r, c] of counts) if (c > best) [best, bestRef] = [c, r]
    const ratio = best / lines.size
    if (ratio >= threshold) derived.push({ p, ref: refNames[bestRef], ratio })
  }

  const show = (rows, fmt) => {
    const limit = listAll ? rows.length : 40
    rows.slice(0, limit).forEach((r) => console.error(`  ${fmt(r)}`))
    if (rows.length > limit) console.error(`  ... ${rows.length - limit} more (use --list)`)
  }
  console.log(
    `check:theme (reference): ${files.length} tracked files vs ${refByHash.size} reference files in ${dirs
      .map((d) => relative(ROOT, d))
      .join(', ')}`,
  )
  if (identical.length) {
    console.error(`  identical: ${identical.length}`)
    show(identical, (r) => `${r.p}  ==  ${r.ref}`)
  }
  if (derived.length) {
    console.error(`  derived (>= ${Math.round(threshold * 100)}% shared significant lines): ${derived.length}`)
    show(derived, (r) => `${r.p}  ~${Math.round(r.ratio * 100)}%  ${r.ref}`)
  }
  if (blocks.length) {
    console.error(`  copied block (>= ${blockMin} identical consecutive lines): ${blocks.length}`)
    show(blocks, (r) => `${r.p}  ${r.len} lines  ${r.ref}`)
  }
  if (shingled.length) {
    console.error(`  derived (>= ${Math.round(shingleThreshold * 100)}% shared ${SHINGLE}-token shingles): ${shingled.length}`)
    show(shingled, (r) => `${r.p}  ~${Math.round(r.ratio * 100)}%  ${r.ref}`)
  }
  if (identical.length || derived.length || blocks.length || shingled.length) return false
  console.log('check:theme (reference): OK - 0 identical, 0 derived, 0 copied blocks.')
  return true
}

const files = probe ?? trackedFiles()
let ok = true
if (runIdentifiers) ok = identifierMode(files) && ok
if (runReference) ok = referenceMode(files) && ok
process.exit(ok ? 0 : 1)
