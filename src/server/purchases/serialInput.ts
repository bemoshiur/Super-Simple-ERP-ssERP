/**
 * Pure serial-number input handling, shared by the purchase form (live feedback) and the server (zod).
 * No DB / Node imports: safe in client components.
 */

export const SERIAL_MAX_LENGTH = 64
/** Hard cap on serial units per purchase invoice (all lines together). */
export const MAX_UNITS_PER_INVOICE = 5000
/** How many offending serials to list in one message before "and N more". */
export const SERIAL_LIST_CAP = 20

// BOM and zero-width / invisible formatting characters that scanners and spreadsheets sneak in.
const INVISIBLE = /[﻿​-‍⁠­]/g
// Printable, no whitespace, no control/format/unassigned code points.
const VALID = /^[^\s\p{C}]+$/u

/** Strip invisible characters and surrounding whitespace. Case is preserved (serials are case-sensitive). */
export function normalizeSerial(raw: string): string {
  return raw.replace(INVISIBLE, '').trim()
}

/** Why a (normalised) serial is unacceptable, or null when it is fine. */
export function serialProblem(s: string): string | null {
  if (s.length === 0) return 'empty'
  if (s.length > SERIAL_MAX_LENGTH) return `longer than ${SERIAL_MAX_LENGTH} characters`
  if (!VALID.test(s)) return 'contains spaces or non-printable characters'
  return null
}

export type ParsedSerials = {
  /** Valid, unique serials in input order. */
  serials: string[]
  /** Values that appear more than once (exact match), listed once each. */
  duplicates: string[]
  /** Distinct serials that differ only by letter case, e.g. ["abc1", "ABC1"]. Allowed, but worth a warning. */
  caseOnly: string[][]
  invalid: { value: string; reason: string }[]
}

/** Normalised non-empty entries exactly as typed (duplicates kept), so the server can re-check everything. */
export function splitSerials(text: string): string[] {
  return (text ?? '').split(/[\r\n,\t]+/).map(normalizeSerial).filter(Boolean)
}

/** Split pasted/scanned text: one per line, commas and tabs also separate. Empty entries are ignored. */
export function parseSerialText(text: string): ParsedSerials {
  const parts = splitSerials(text)
  const seen = new Set<string>()
  const dup = new Set<string>()
  const invalid: ParsedSerials['invalid'] = []
  const serials: string[] = []
  for (const s of parts) {
    const problem = serialProblem(s)
    if (problem) {
      invalid.push({ value: s.length > 80 ? `${s.slice(0, 80)}…` : s, reason: problem })
      continue
    }
    if (seen.has(s)) {
      dup.add(s)
      continue
    }
    seen.add(s)
    serials.push(s)
  }
  const byLower = new Map<string, string[]>()
  for (const s of serials) {
    const k = s.toLowerCase()
    byLower.set(k, [...(byLower.get(k) ?? []), s])
  }
  return { serials, duplicates: [...dup], caseOnly: [...byLower.values()].filter((g) => g.length > 1), invalid }
}

/** Minimal CSV cell split honouring double quotes ("a,b" and "" escapes). */
function csvCells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',' || c === ';' || c === '\t') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/**
 * CSV upload -> textarea text (one serial per line). Accepts a single column, or a header row containing a
 * `serial` column (case-insensitive; also "serial_no", "serial no", "imei") whose cells are used.
 */
export function serialsFromCsv(csv: string): string {
  const lines = (csv ?? '').replace(INVISIBLE, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return ''
  const header = csvCells(lines[0]).map((h) => h.trim().toLowerCase())
  let col = header.findIndex((h) => ['serial', 'serial_no', 'serial no', 'serialno', 'imei'].includes(h))
  let rows = lines
  if (col >= 0) rows = lines.slice(1)
  else col = 0
  return rows
    .map((l) => normalizeSerial(csvCells(l)[col] ?? ''))
    .filter(Boolean)
    .join('\n')
}

/** "A, B, C" or "A, B, … and 7 more" (cap defaults to 20). */
export function formatSerialList(list: readonly string[], cap = SERIAL_LIST_CAP): string {
  if (list.length <= cap) return list.join(', ')
  return `${list.slice(0, cap).join(', ')} and ${list.length - cap} more`
}
