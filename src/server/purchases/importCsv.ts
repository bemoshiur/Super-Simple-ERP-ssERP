/**
 * Bulk serial import, pure part: bytes -> text (UTF-8 / UTF-16 with BOM from Excel / Windows-1252 fallback), delimiter
 * detection (comma, semicolon, tab), an RFC 4180 CSV parser (quotes, doubled quotes, CRLF, newlines inside quotes) and the
 * row-by-row validation that needs no database. No DB / Node imports: unit-testable and safe in client components.
 */
import { fromMinor, toMinor } from '../money'
import { MAX_MINOR } from '../validation'
import { MAX_WARRANTY_MONTHS } from './schemas'
import { normalizeSerial, serialProblem } from './serialInput'

/** Hard cap on data rows in one import file (also the per-invoice unit cap, see MAX_UNITS_PER_INVOICE). */
export const MAX_IMPORT_ROWS = 5000
/** Largest accepted file. Next.js server actions accept 1 MB request bodies by default; 5000 rows fit in well under 400 KB. */
export const MAX_IMPORT_BYTES = 800_000
export const MAX_NOTE_LENGTH = 200

export type Delimiter = ',' | ';' | '\t'
export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'

// ------------------------------------------------------------------ bytes -> text

/** Decode an uploaded file. A BOM wins; BOM-less UTF-16 (NUL bytes at every other position) is detected; invalid UTF-8 falls back to Windows-1252. */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: Encoding } {
  const b = bytes
  const swap = (from: number) => {
    const n = Math.floor((b.length - from) / 2) * 2
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 2) {
      out[i] = b[from + i + 1]
      out[i + 1] = b[from + i]
    }
    return out
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2, 2 + Math.floor((b.length - 2) / 2) * 2)), encoding: 'utf-16le' }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16le').decode(swap(2)), encoding: 'utf-16be' }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8' }
  // BOM-less UTF-16: ASCII text has a NUL in every other byte.
  if (b.length >= 4) {
    const n = Math.min(b.length, 200)
    let evenNul = 0
    let oddNul = 0
    for (let i = 0; i < n; i++) {
      if (b[i] !== 0) continue
      if (i % 2 === 0) evenNul++
      else oddNul++
    }
    if (oddNul > n / 4 && evenNul === 0) return { text: new TextDecoder('utf-16le').decode(b.subarray(0, Math.floor(b.length / 2) * 2)), encoding: 'utf-16le' }
    if (evenNul > n / 4 && oddNul === 0) return { text: new TextDecoder('utf-16le').decode(swap(0)), encoding: 'utf-16be' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(b), encoding: 'windows-1252' }
  }
}

// ------------------------------------------------------------------ CSV

/** Quote-aware count of each candidate delimiter on the first non-empty line; the most frequent wins (comma on a tie). */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 }
  let q = false
  let seen = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') q = !q
    else if (q) continue
    else if (c === '\n' || c === '\r') {
      if (seen) break
    } else {
      if (c === ',' || c === ';' || c === '\t') counts[c]++
      if (c.trim() !== '') seen = true
    }
  }
  let best: Delimiter = ','
  for (const d of [';', '\t'] as const) if (counts[d] > counts[best]) best = d
  return best
}

export type CsvRecord = { /** 1-based line number of the record's first line (after the header = data row N+1). */ line: number; cells: string[]; /** Per cell: was it written in double quotes? */ quoted: boolean[] }

/** RFC 4180 parser. Blank records are dropped. Throws on a quote that is never closed. */
export function parseCsv(text: string, delimiter: Delimiter): CsvRecord[] {
  const out: CsvRecord[] = []
  let cells: string[] = []
  let quoted: boolean[] = []
  let cur = ''
  let q = false
  let line = 1
  let startLine = 1
  let hadQuote = false
  const endRecord = () => {
    cells.push(cur)
    quoted.push(hadQuote)
    if (!(cells.length === 1 && cells[0].trim() === '' && !hadQuote)) out.push({ line: startLine, cells, quoted })
    cells = []
    quoted = []
    cur = ''
    hadQuote = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else q = false
      } else {
        if (c === '\n') line++
        cur += c
      }
      continue
    }
    if (c === '"' && cur === '') {
      q = true
      hadQuote = true
    } else if (c === delimiter) {
      cells.push(cur)
      quoted.push(hadQuote)
      hadQuote = false
      cur = ''
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      startLine = line
    } else cur += c
  }
  if (q) throw new Error('A quoted value is never closed (missing closing quote).')
  if (cur !== '' || cells.length > 0 || hadQuote) endRecord()
  return out
}

// ------------------------------------------------------------------ header + raw rows

export type ImportRawRow = { line: number; serial: string; sku: string; unitCost: string; warranty: string; note: string; extraCells: boolean; /** The extra cells are all empty (trailing delimiters). */ extraEmpty: boolean; /** Comma file, unquoted cost followed by cells that read like the rest of a grouped amount (12,50,000). */ looksGrouped: boolean }

const ALIASES = {
  serial: ['serial', 'serial_no', 'serialno', 'serial_number', 'imei', 'serial/imei'],
  sku: ['product_sku', 'sku', 'productsku', 'product_code'],
  cost: ['unit_cost', 'cost', 'unitcost', 'purchase_price', 'unit_price'],
  warranty: ['warranty_months', 'warranty', 'warrantymonths'],
  note: ['note', 'notes', 'remark', 'remarks'],
} as const

// BOM / zero-width characters Excel and scanners sneak into headers and cells.
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g
const headerKey = (h: string) => h.replace(INVISIBLE, '').trim().toLowerCase().replace(/[\s-]+/g, '_')

const WESTERN = /^\d{1,3}(,\d{3})+(\.\d*)?$/
const LAKH = /^\d{1,2}(,\d{2})*,\d{3}(\.\d*)?$/
/** Unquoted cost cell + the next one or two plain-number cells read together as a Western or lakh grouped amount. */
function looksLikeSplitAmount(r: CsvRecord, costIdx: number): boolean {
  if (costIdx < 0 || r.quoted[costIdx] || !/^\d{1,3}$/.test((r.cells[costIdx] ?? '').trim())) return false
  const parts = [(r.cells[costIdx] ?? '').trim()]
  for (let n = 1; n <= 2; n++) {
    const next = (r.cells[costIdx + n] ?? '').trim()
    if (r.quoted[costIdx + n] || !/^\d{2,3}(\.\d+)?$/.test(next)) return false
    parts.push(next)
    const joined = parts.join(',')
    if (WESTERN.test(joined) || LAKH.test(joined)) return true
  }
  return false
}

export type ParsedImportFile = { encoding: Encoding; delimiter: Delimiter; rows: ImportRawRow[]; fileErrors: string[] }

/** Bytes -> header-mapped raw rows. Never throws: problems with the file as a whole come back in `fileErrors`. */
export function parseImportFile(bytes: Uint8Array): ParsedImportFile {
  const fail = (encoding: Encoding, delimiter: Delimiter, msg: string): ParsedImportFile => ({ encoding, delimiter, rows: [], fileErrors: [msg] })
  if (bytes.length === 0) return fail('utf-8', ',', 'The file is empty.')
  if (bytes.length > MAX_IMPORT_BYTES) return fail('utf-8', ',', `The file is too large (max ${Math.round(MAX_IMPORT_BYTES / 1000)} KB, about ${MAX_IMPORT_ROWS} rows). Split it into several files or remove unused columns.`)
  const { text, encoding } = decodeCsvBytes(bytes)
  const clean = text.replace(/^\ufeff/, '')
  const delimiter = detectDelimiter(clean)
  let records: CsvRecord[]
  try {
    records = parseCsv(clean, delimiter)
  } catch (e) {
    return fail(encoding, delimiter, e instanceof Error ? e.message : 'The file could not be read as CSV.')
  }
  if (records.length === 0) return fail(encoding, delimiter, 'The file has no rows.')
  const header = records[0].cells.map(headerKey)
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h))
  const idx = { serial: col(ALIASES.serial), sku: col(ALIASES.sku), cost: col(ALIASES.cost), warranty: col(ALIASES.warranty), note: col(ALIASES.note) }
  const ambiguous = (Object.keys(ALIASES) as (keyof typeof ALIASES)[]).filter((k) => header.filter((h) => (ALIASES[k] as readonly string[]).includes(h)).length > 1)
  if (ambiguous.length) return fail(encoding, delimiter, `More than one column maps to ${ambiguous.map((k) => (k === 'sku' ? 'product_sku' : k === 'cost' ? 'unit_cost' : k === 'warranty' ? 'warranty_months' : k)).join(', ')}. Keep exactly one such column in the header row.`)
  const missing = [idx.serial < 0 && 'serial', idx.sku < 0 && 'product_sku', idx.cost < 0 && 'unit_cost'].filter(Boolean)
  if (missing.length) return fail(encoding, delimiter, `The first row must be a header with the columns serial, product_sku, unit_cost (optional: warranty_months, note). Missing: ${missing.join(', ')}.`)
  const data = records.slice(1)
  if (data.length === 0) return fail(encoding, delimiter, 'The file has a header but no data rows.')
  if (data.length > MAX_IMPORT_ROWS) return fail(encoding, delimiter, `The file has ${data.length} rows; at most ${MAX_IMPORT_ROWS} per import. Split it into several files.`)
  const cell = (r: CsvRecord, i: number) => (i >= 0 ? (r.cells[i] ?? '') : '')
  const rows = data.map<ImportRawRow>((r) => ({
    line: r.line,
    serial: normalizeSerial(cell(r, idx.serial)),
    sku: cell(r, idx.sku).replace(INVISIBLE, '').trim(),
    unitCost: cell(r, idx.cost).replace(INVISIBLE, '').trim(),
    warranty: cell(r, idx.warranty).replace(INVISIBLE, '').trim(),
    note: cell(r, idx.note).replace(INVISIBLE, '').trim(),
    // Comma files: ANY cell beyond the header is suspect (an unquoted 12,50,000 splits into three); other delimiters only when it holds text.
    extraCells: r.cells.length > header.length && (delimiter === ',' || r.cells.slice(header.length).some((x) => x.trim() !== '')),
    extraEmpty: r.cells.slice(header.length).every((x) => x.trim() === ''),
    looksGrouped: delimiter === ',' && looksLikeSplitAmount(r, idx.cost),
  }))
  return { encoding, delimiter, rows, fileErrors: [] }
}

// ------------------------------------------------------------------ row validation (pure; DB facts passed in)

export type ImportProduct = { id: string; name: string; sku: string; trackSerial: boolean; active: boolean }
export type RowErrorCode = 'serial_missing' | 'serial_invalid' | 'sku_missing' | 'sku_unknown' | 'not_serial' | 'inactive' | 'duplicate_in_file' | 'exists' | 'cost_invalid' | 'warranty_invalid' | 'note_too_long' | 'note_invalid' | 'too_many_columns' | 'amount_unquoted'
export type RowError = { code: RowErrorCode; message: string }

export type ImportRow = {
  line: number
  serial: string
  sku: string
  /** "2000.00" when valid, the raw text otherwise. */
  unitCost: string
  warrantyMonths: number | null
  note: string
  productId: string | null
  productName: string | null
  errors: RowError[]
}

/** Money cell: strict (digits, optional 2 decimals, Western or lakh grouping), non-negative, within numeric(14,2). */
export function parseCostCell(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const s = raw.trim()
  if (s === '') return { ok: false, reason: 'unit_cost is empty' }
  if (/\.\d{3,}/.test(s)) return { ok: false, reason: `"${raw}" has more than 2 decimal places` }
  let minor: number
  try {
    minor = toMinor(s)
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid amount (use 1250.50, or quote lakh grouping like "12,50,000")` }
  }
  if (minor < 0) return { ok: false, reason: 'unit_cost cannot be negative' }
  if (minor > MAX_MINOR) return { ok: false, reason: 'unit_cost is too large' }
  return { ok: true, value: fromMinor(minor) }
}

export type RowLookups = {
  /** Resolve a SKU (company-scoped, done by the caller). */
  product: (sku: string) => ImportProduct | undefined
  /** Serials that already exist in this company. */
  existing: ReadonlySet<string>
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s)

/** Validate every raw row. Duplicates inside the file are flagged on every occurrence after the first. */
export function validateImportRows(raw: readonly ImportRawRow[], lookups: RowLookups): ImportRow[] {
  const firstLine = new Map<string, number>()
  return raw.map((r) => {
    const errors: RowError[] = []
    const add = (code: RowErrorCode, message: string) => errors.push({ code, message })
    // serial
    if (r.serial === '') add('serial_missing', 'serial is empty')
    else {
      const problem = serialProblem(r.serial)
      if (problem) add('serial_invalid', `serial ${problem} (1-64 printable characters, no spaces)`)
      const first = firstLine.get(r.serial)
      if (first !== undefined) add('duplicate_in_file', `serial already appears on row ${first}`)
      else firstLine.set(r.serial, r.line)
      if (lookups.existing.has(r.serial)) add('exists', 'serial is already recorded in your stock (check Serial Lookup)')
    }
    // product
    let product: ImportProduct | undefined
    if (r.sku === '') add('sku_missing', 'product_sku is empty')
    else {
      product = lookups.product(r.sku)
      if (!product) add('sku_unknown', `no product with SKU "${short(r.sku)}"`)
      else if (!product.trackSerial) add('not_serial', `${product.name} does not track serial numbers; add stock through a normal purchase`)
      else if (!product.active) add('inactive', `${product.name} is deactivated`)
    }
    // cost
    let unitCost = r.unitCost
    const cost = parseCostCell(r.unitCost)
    if (cost.ok) unitCost = cost.value
    else add('cost_invalid', cost.reason)
    // warranty
    let warrantyMonths: number | null = null
    if (r.warranty !== '') {
      if (/^\d{1,3}$/.test(r.warranty) && Number(r.warranty) <= MAX_WARRANTY_MONTHS) warrantyMonths = Number(r.warranty)
      else add('warranty_invalid', `warranty_months "${short(r.warranty)}" must be a whole number from 0 to ${MAX_WARRANTY_MONTHS}`)
    }
    if (r.note.length > MAX_NOTE_LENGTH) add('note_too_long', `note is longer than ${MAX_NOTE_LENGTH} characters`)
    if (/\p{Cc}/u.test(r.note)) add('note_invalid', 'note contains line breaks or control characters')
    if (r.extraCells)
      add(
        'too_many_columns',
        r.extraEmpty
          ? 'more cells than header columns: the line ends with extra empty cells (remove the trailing commas, or add matching header columns)'
          : 'more values than header columns (an amount with commas like 12,50,000 must be written in quotes: "12,50,000")',
      )
    else if (r.looksGrouped) add('amount_unquoted', `unit_cost "${short(r.unitCost)}" looks like part of a grouped amount split by commas; write it in quotes, e.g. "12,50,000"`)
    return { line: r.line, serial: r.serial, sku: r.sku, unitCost, warrantyMonths, note: r.note, productId: product?.id ?? null, productName: product?.name ?? null, errors }
  })
}

export type ImportSummary = {
  rows: number
  valid: number
  invalid: number
  products: number
  /** Sum of unit costs of the valid rows (before any discount), "0.00" style. */
  total: string
  /** Rows whose serial is new to the company and not repeated in the file. */
  newSerials: number
  duplicatesInFile: number
  alreadyExist: number
  unknownSku: number
  notSerial: number
}

export function summarizeImport(rows: readonly ImportRow[]): ImportSummary {
  const has = (r: ImportRow, c: RowErrorCode) => r.errors.some((e) => e.code === c)
  const valid = rows.filter((r) => r.errors.length === 0)
  return {
    rows: rows.length,
    valid: valid.length,
    invalid: rows.length - valid.length,
    products: new Set(valid.map((r) => r.productId)).size,
    total: fromMinor(valid.reduce((a, r) => a + toMinor(r.unitCost), 0)),
    newSerials: rows.filter((r) => r.serial !== '' && !has(r, 'exists') && !has(r, 'duplicate_in_file') && !has(r, 'serial_invalid')).length,
    duplicatesInFile: rows.filter((r) => has(r, 'duplicate_in_file')).length,
    alreadyExist: rows.filter((r) => has(r, 'exists')).length,
    unknownSku: rows.filter((r) => has(r, 'sku_unknown')).length,
    notSerial: rows.filter((r) => has(r, 'not_serial')).length,
  }
}

export type ImportGroup = { productId: string; unitCost: string; serials: string[]; serialMeta: { warrantyMonths: number | null; note: string | null }[] }

/** Valid rows -> purchase lines, one per (product, unit cost) in first-seen order. Serials keep file order. */
export function groupImportRows(rows: readonly ImportRow[]): ImportGroup[] {
  const groups = new Map<string, ImportGroup>()
  for (const r of rows) {
    if (r.errors.length || !r.productId) continue
    const key = `${r.productId}|${r.unitCost}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { productId: r.productId, unitCost: r.unitCost, serials: [], serialMeta: [] }))
    g.serials.push(r.serial)
    g.serialMeta.push({ warrantyMonths: r.warrantyMonths, note: r.note || null })
  }
  return [...groups.values()]
}

/** Error report rows for download (ready for toCsv, which neutralises =,+,-,@ formula starts). */
export const ERROR_CSV_COLUMNS = [
  { key: 'row', label: 'row', kind: 'int' as const },
  { key: 'serial', label: 'serial' },
  { key: 'product_sku', label: 'product_sku' },
  { key: 'unit_cost', label: 'unit_cost' },
  { key: 'warranty_months', label: 'warranty_months' },
  { key: 'note', label: 'note' },
  { key: 'problems', label: 'problems' },
]

export function errorCsvRows(rows: readonly ImportRow[], rawByLine: ReadonlyMap<number, ImportRawRow>) {
  return rows
    .filter((r) => r.errors.length > 0)
    .map((r) => {
      const raw = rawByLine.get(r.line)
      return { row: String(r.line), serial: raw?.serial ?? r.serial, product_sku: raw?.sku ?? r.sku, unit_cost: raw?.unitCost ?? r.unitCost, warranty_months: raw?.warranty ?? '', note: raw?.note ?? r.note, problems: r.errors.map((e) => e.message).join('; ') }
    })
}
