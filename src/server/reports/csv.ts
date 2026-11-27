/**
 * CSV for Excel: UTF-8 BOM (so Bengali shows correctly), CRLF rows, RFC 4180 quoting, and CSV/formula-injection protection:
 * a TEXT cell that starts with = + - @ (also after leading spaces / unicode whitespace), TAB or CR gets a single quote prefix so spreadsheets never evaluate it.
 * Numeric columns (money/int/percent) holding plain numbers such as "-12.50" are written as-is.
 */
export const CSV_BOM = '﻿'
const DANGEROUS_START = /^[\s\u00a0\u2000-\u200b\u2028\u2029\u3000\ufeff]*[=+\-@]|^[\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

export type CsvKind = 'text' | 'money' | 'int' | 'date' | 'percent'

/** One cell, already stringified. `numeric` cells matching a plain number skip the injection prefix. */
export function csvCell(value: string | number | null | undefined, numeric = false): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (!(numeric && PLAIN_NUMBER.test(s)) && DANGEROUS_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export type CsvColumn = { key: string; label: string; kind?: CsvKind }

/** Header + rows. Header labels are escaped like text. Rows are objects keyed by column key. */
export function toCsvLines(columns: readonly CsvColumn[], rows: readonly Record<string, string | number | null | undefined>[]): string[] {
  const lines = [columns.map((c) => csvCell(c.label)).join(',')]
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key], !!c.kind && c.kind !== 'text' && c.kind !== 'date')).join(','))
  return lines
}

/** A complete CSV document (BOM + CRLF lines + trailing CRLF). */
export function toCsv(columns: readonly CsvColumn[], rows: readonly Record<string, string | number | null | undefined>[]): string {
  return CSV_BOM + toCsvLines(columns, rows).join('\r\n') + '\r\n'
}
