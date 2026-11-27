/**
 * Pure rendering helpers for activity_log before/after and record_history diffs. Output is plain strings that React
 * renders as text (never HTML). Huge values are truncated; nested values are shown as compact JSON.
 */
export const MAX_VALUE_CHARS = 200
export const MAX_ROWS = 60

export type DiffRow = { key: string; before: string; after: string; changed: boolean }

/** Human-readable text for any JSON value, truncated to `max` characters. */
export function displayValue(v: unknown, max = MAX_VALUE_CHARS): string {
  let s: string
  if (v === null || v === undefined || v === '') s = '—'
  else if (typeof v === 'string') s = v
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
  else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) s = v.join(', ') || '—'
  else {
    try {
      s = JSON.stringify(v) ?? '—'
    } catch {
      s = '[unprintable]'
    }
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Turn a camelCase / snake_case key into words: "openingBalance" -> "Opening balance". */
export function humanKey(k: string): string {
  const words = k
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  return words ? words[0].toUpperCase() + words.slice(1) : k
}

/** Activity before/after objects -> one row per key (union of both sides, stable order, capped). */
export function diffRows(before: unknown, after: unknown): DiffRow[] {
  const b = isRecord(before) ? before : before === null || before === undefined ? {} : { value: before }
  const a = isRecord(after) ? after : after === null || after === undefined ? {} : { value: after }
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].slice(0, MAX_ROWS)
  return keys.map((key) => {
    const bv = displayValue(b[key])
    const av = displayValue(a[key])
    return { key: humanKey(key), before: key in b ? bv : '', after: key in a ? av : '', changed: key in b && key in a && bv !== av }
  })
}

/** record_history diff `{field: {from, to}}` -> rows. Anything not in that shape is shown as a single value. */
export function historyRows(diff: unknown): DiffRow[] {
  if (!isRecord(diff)) return [{ key: 'Change', before: '', after: displayValue(diff), changed: true }]
  return Object.entries(diff)
    .slice(0, MAX_ROWS)
    .map(([key, v]) =>
      isRecord(v) && ('from' in v || 'to' in v)
        ? { key: humanKey(key), before: displayValue(v.from), after: displayValue(v.to), changed: true }
        : { key: humanKey(key), before: '', after: displayValue(v), changed: true },
    )
}
