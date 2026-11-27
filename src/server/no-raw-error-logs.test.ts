import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard for CONTRIBUTING invariant 8 ("never log secrets"): a caught error must not be passed to console.* as-is,
 * because a DrizzleQueryError's message contains the SQL params (password hashes). Use safeLog / safeErrorInfo
 * from src/server/errors.ts instead. Simple scan: any console.error/warn/log/info call with a top-level argument
 * that is a bare error-looking identifier (or `String(e)` / `e.message`), or a template literal / string concatenation
 * that interpolates one (`${e}`, `${e.message}`, `'x: ' + err`), fails.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..')
const DIRS = ['src', 'scripts', 'e2e']
const ALLOW: string[] = [] // 'relative/path.ts' entries, each with a reason, if ever needed
const ERR_NAME = String.raw`(?:e|err|error|ex|cause|reason)`
const ERR_EXPR = String.raw`(?:${ERR_NAME}|String\(${ERR_NAME}\)|${ERR_NAME}\.(?:message|stack))`
const ERR_ARG = new RegExp(String.raw`^${ERR_EXPR}$`)
/** `${e}` / `${e.message}` / `${String(err)}` inside a template literal argument. */
const ERR_IN_TEMPLATE = new RegExp(String.raw`\$\{\s*${ERR_EXPR}\s*\}`)
/** 'failed: ' + e  /  e.message + '...' */
const ERR_CONCAT = new RegExp(String.raw`(?:\+\s*${ERR_EXPR}(?![\w.(])|(?:^|[^\w.])${ERR_EXPR}\s*\+)`)
const isRawError = (arg: string) => ERR_ARG.test(arg) || (arg.startsWith('`') && ERR_IN_TEMPLATE.test(arg)) || ERR_CONCAT.test(arg)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** Top-level comma-separated arguments of the call starting at `open` (index of '('). */
function argsAt(src: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let cur = ''
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      cur += ch
      if (ch === '\\') cur += src[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if ('([{'.includes(ch)) {
      depth++
      if (depth === 1) continue
    } else if (')]}'.includes(ch)) {
      depth--
      if (depth === 0) {
        args.push(cur.trim())
        return args
      }
    } else if (ch === ',' && depth === 1) {
      args.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  return args
}

export function rawErrorLogs(src: string): string[] {
  const hits: string[] = []
  const re = /console\.(error|warn|log|info)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    // An explicit, reviewed exception on the same line: `// log-ok: <why this error carries no secrets>`.
    const lineEnd = src.indexOf('\n', m.index)
    if (/\/\/\s*log-ok:\s*\S/.test(src.slice(m.index, lineEnd < 0 ? undefined : lineEnd))) continue
    const args = argsAt(src, m.index + m[0].length - 1)
    if (args.some(isRawError)) hits.push(`${m[0]}${args.join(', ')})`)
  }
  return hits
}

describe('no raw caught errors in logs', () => {
  it('the scanner catches the bad shapes and accepts the safe ones', () => {
    expect(rawErrorLogs(`console.error('[x] failed', e)`)).toHaveLength(1)
    expect(rawErrorLogs(`console.warn(err)`)).toHaveLength(1)
    expect(rawErrorLogs(`console.error('x', e.message)`)).toHaveLength(1)
    expect(rawErrorLogs(`console.error('x', safeErrorInfo(e))`)).toHaveLength(0)
    expect(rawErrorLogs('console.error(`x ${pgCodeOf(e)}`)')).toHaveLength(0)
  })

  it('also catches errors interpolated into template literals or concatenated strings', () => {
    expect(rawErrorLogs('console.error(`[x] failed: ${e}`)')).toHaveLength(1)
    expect(rawErrorLogs('console.warn(`failed ${e.message} for ${id}`)')).toHaveLength(1)
    expect(rawErrorLogs('console.log(`x ${String(err)}`)')).toHaveLength(1)
    expect(rawErrorLogs('console.error(`x ${error.stack}`)')).toHaveLength(1)
    expect(rawErrorLogs(`console.error('failed: ' + e)`)).toHaveLength(1)
    expect(rawErrorLogs(`console.error(e.message + ' (retrying)')`)).toHaveLength(1)
    // safe: helpers, other identifiers, fields that are not the error itself
    expect(rawErrorLogs('console.error(`x ${safeErrorInfo(e).code}`)')).toHaveLength(0)
    expect(rawErrorLogs('console.log(`${out}: ${Math.round(info.size / 1024)} KB`)')).toHaveLength(0)
    expect(rawErrorLogs('console.log(`exit ${ex2} ${eta}`)')).toHaveLength(0)
    expect(rawErrorLogs(`console.log('total: ' + elapsed)`)).toHaveLength(0)
    expect(rawErrorLogs('console.error(`x ${e.message}`) // log-ok: our own refusal text')).toHaveLength(0)
    expect(rawErrorLogs('console.error(`x ${e.message}`) // log-ok:')).toHaveLength(1)
  })

  it('src/, scripts/ (.ts and .mjs) and e2e/ log caught errors only through safeLog / safeErrorInfo', () => {
    const offenders: string[] = []
    for (const d of DIRS) {
      for (const file of walk(path.join(ROOT, d))) {
        const rel = path.relative(ROOT, file)
        if (ALLOW.includes(rel)) continue
        for (const hit of rawErrorLogs(readFileSync(file, 'utf8'))) offenders.push(`${rel}: ${hit}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
