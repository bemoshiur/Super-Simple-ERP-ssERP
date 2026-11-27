/**
 * Bulk serial import (purchases.create): a CSV of serial, product_sku, unit_cost (+ warranty_months, note) becomes ONE
 * purchase invoice in ONE transaction. The dry run (previewSerialImport) validates every row and writes nothing; the
 * import (importSerialPurchase) re-validates from the same file (the client is never trusted), refuses the WHOLE file when a
 * single row is wrong, and then goes through createPurchase, so totals, discount allocation, serial uniqueness, locks,
 * payments and the activity log are exactly those of a hand-typed invoice.
 */
import { createHash } from 'node:crypto'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { WriteCtx } from '../branch'
import { schema, type Db } from '../db'
import { FieldErrors, zodPathErrors } from '../errors'
import { toCsv } from '../reports/csv'
import { optionalId, optionalText, moneyField } from '../validation'
import { createPurchase, existingSerials, resolvePurchaseKey } from './purchases'
import {
  ERROR_CSV_COLUMNS,
  MAX_IMPORT_BYTES,
  errorCsvRows,
  groupImportRows,
  parseImportFile,
  summarizeImport,
  validateImportRows,
  type Delimiter,
  type Encoding,
  type ImportGroup,
  type ImportProduct,
  type ImportRow,
  type ImportSummary,
  type ParsedImportFile,
} from './importCsv'
import { MAX_LINES_PER_INVOICE, dateField } from './schemas'
import { computePurchaseTotals } from './totals'

const chunks = <T>(arr: T[], n: number): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

/** The top-level invoice fields shared with the purchase form. companyId/userId never come from here. */
export const importFieldsSchema = z.object({
  vendorId: z.uuid('Choose a vendor'),
  date: dateField,
  note: optionalText(500),
  discount: moneyField().default('0.00'),
  paid: moneyField().default('0.00'),
  accountId: optionalId,
  /** Client-generated UUID per import attempt: a double click / retry returns the invoice already created. */
  idempotencyKey: z.uuid('Invalid request key').optional().nullable(),
})
export type ImportFieldsInput = z.input<typeof importFieldsSchema>

export type ImportInput = ImportFieldsInput & { bytes: Uint8Array }

/** Products of THIS company by SKU: exact match first, then a case-insensitive match when it is unambiguous. */
async function loadProducts(db: Pick<Db, 'select'>, companyId: string, skus: string[]): Promise<(sku: string) => ImportProduct | undefined> {
  const p = schema.products
  const exact = new Map<string, ImportProduct>()
  const lower = new Map<string, ImportProduct[]>()
  for (const part of chunks([...new Set(skus)], 1000)) {
    const rows = await db
      .select({ id: p.id, name: p.name, sku: p.sku, trackSerial: p.trackSerial, active: p.active })
      .from(p)
      .where(and(eq(p.companyId, companyId), inArray(sql<string>`lower(${p.sku})`, part.map((x) => x.toLowerCase()))))
      .orderBy(asc(p.sku))
    for (const r of rows) {
      exact.set(r.sku, r)
      const k = r.sku.toLowerCase()
      lower.set(k, [...(lower.get(k) ?? []), r])
    }
  }
  return (sku) => {
    const hit = exact.get(sku)
    if (hit) return hit
    const cands = lower.get(sku.toLowerCase())
    return cands && cands.length === 1 ? cands[0] : undefined
  }
}

type Analysis = { file: ParsedImportFile; rows: ImportRow[]; groups: ImportGroup[]; summary: ImportSummary; fileErrors: string[] }

async function analyse(db: Pick<Db, 'select'>, companyId: string, bytes: Uint8Array): Promise<Analysis> {
  const file = parseImportFile(bytes)
  if (file.fileErrors.length) return { file, rows: [], groups: [], summary: summarizeImport([]), fileErrors: file.fileErrors }
  const product = await loadProducts(db, companyId, file.rows.map((r) => r.sku).filter(Boolean))
  const existing = await existingSerials(db, companyId, [...new Set(file.rows.map((r) => r.serial).filter(Boolean))])
  const rows = validateImportRows(file.rows, { product, existing })
  const groups = groupImportRows(rows)
  const fileErrors: string[] = []
  if (groups.length > MAX_LINES_PER_INVOICE) fileErrors.push(`This file has ${groups.length} different product and unit-cost combinations; an invoice holds at most ${MAX_LINES_PER_INVOICE} lines. Split the file.`)
  return { file, rows, groups, summary: summarizeImport(rows), fileErrors }
}

export type ImportPreview = {
  /** True only when the file and every row are valid and the invoice fields are fine: the Import button may be enabled. */
  canImport: boolean
  encoding: Encoding
  delimiter: Delimiter
  fileErrors: string[]
  /** Problems with the vendor / date / discount / payment fields, keyed like the purchase form. */
  headerErrors: Record<string, string>
  summary: ImportSummary
  /** Invoice amounts the import would create (from the valid rows; exact). */
  totals: { subtotal: string; discount: string; total: string; paid: string; due: string } | null
  lines: number
  /** All rows with errors (capped at `shownErrors`), then a few valid rows as a sample. */
  rows: ImportRow[]
  rowsTruncated: boolean
  /** The complete error report (CSV-injection-safe, UTF-8 with BOM) ready to download; '' when there are no errors. */
  errorCsv: string
}

export const PREVIEW_ERROR_ROWS = 500
export const PREVIEW_OK_ROWS = 25

/** Dry run: validate everything, write nothing. */
export async function previewSerialImport(db: Db, companyId: string, input: ImportInput): Promise<ImportPreview> {
  const a = await analyse(db, companyId, input.bytes)
  const headerErrors: Record<string, string> = {}
  const f = importFieldsSchema.safeParse(input)
  if (!f.success) Object.assign(headerErrors, zodPathErrors(f.error))
  let totals: ImportPreview['totals'] = null
  if (f.success) {
    const d = f.data
    const [vendor] = await db.select({ active: schema.vendors.active }).from(schema.vendors).where(and(eq(schema.vendors.id, d.vendorId), eq(schema.vendors.companyId, companyId)))
    if (!vendor) headerErrors.vendorId = 'Vendor not found'
    else if (!vendor.active) headerErrors.vendorId = 'This vendor is deactivated. Restore it first.'
    const t = computePurchaseTotals({ items: a.groups.map((g) => ({ qty: g.serials.length, unitCost: g.unitCost })), discount: d.discount, paid: d.paid })
    if (t.ok) {
      totals = { subtotal: t.totals.subtotal, discount: t.totals.discount, total: t.totals.total, paid: t.totals.paid, due: t.totals.due }
      if (t.totals.paid !== '0.00') {
        if (!d.accountId) headerErrors.accountId = 'Choose the account this payment was made from'
        else {
          const [acc] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.id, d.accountId), eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true)))
          if (!acc) headerErrors.accountId = 'Account not found'
        }
      }
    } else if (a.groups.length) {
      for (const [k, v] of Object.entries(t.errors)) if (k === 'discount' || k === 'paid' || k === 'items') headerErrors[k === 'items' ? 'file' : k] = v
    }
  }
  const bad = a.rows.filter((r) => r.errors.length > 0)
  const good = a.rows.filter((r) => r.errors.length === 0)
  const shownBad = bad.slice(0, PREVIEW_ERROR_ROWS)
  const rawByLine = new Map(a.file.rows.map((r) => [r.line, r]))
  const canImport = a.fileErrors.length === 0 && a.rows.length > 0 && bad.length === 0 && Object.keys(headerErrors).length === 0
  return {
    canImport,
    encoding: a.file.encoding,
    delimiter: a.file.delimiter,
    fileErrors: a.fileErrors,
    headerErrors,
    summary: a.summary,
    totals,
    lines: a.groups.length,
    rows: [...shownBad, ...good.slice(0, PREVIEW_OK_ROWS)],
    rowsTruncated: bad.length > shownBad.length || good.length > PREVIEW_OK_ROWS,
    errorCsv: bad.length ? toCsv(ERROR_CSV_COLUMNS, errorCsvRows(bad, rawByLine)) : '',
  }
}

/** sha256 of the uploaded bytes + the invoice fields: the same key with another file or other amounts is refused. */
function importRequestHash(bytes: Uint8Array, d: z.output<typeof importFieldsSchema>): string {
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  return createHash('sha256').update(JSON.stringify({ f: fileHash, v: d.vendorId, d: d.date, n: d.note ?? null, x: d.discount, p: d.paid, a: d.accountId ?? null })).digest('hex')
}

export type ImportedPurchase = { id: string; invoiceNo: string; total: string; due: string; units: number; lines: number; duplicate: boolean }

/**
 * Import the file as ONE purchase. Nothing is saved when anything is wrong (bad file, any bad row, bad invoice fields).
 * Lines are grouped per (product, unit cost); the invoice discount is allocated by createPurchase exactly as for a typed invoice.
 */
export async function importSerialPurchase(db: Db, companyId: string, userId: string, input: ImportInput, ctx: WriteCtx): Promise<ImportedPurchase> {
  if (input.bytes.length > MAX_IMPORT_BYTES) throw new FieldErrors({ file: 'The file is too large.' })
  const f = importFieldsSchema.safeParse(input)
  if (!f.success) throw new FieldErrors(zodPathErrors(f.error))
  const d = f.data
  // A retry / double click after success: the serials now exist, so answer from the key BEFORE validating the file again.
  const requestHash = importRequestHash(input.bytes, d)
  if (d.idempotencyKey) {
    const prior = await resolvePurchaseKey(db, companyId, d.idempotencyKey, requestHash)
    if (prior) {
      const [{ units }] = await db.select({ units: count() }).from(schema.productUnits).innerJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, schema.productUnits.purchaseItemId), eq(schema.purchaseItems.companyId, companyId))).where(and(eq(schema.productUnits.companyId, companyId), eq(schema.purchaseItems.purchaseId, prior.id)))
      const [{ lines }] = await db.select({ lines: count() }).from(schema.purchaseItems).where(and(eq(schema.purchaseItems.companyId, companyId), eq(schema.purchaseItems.purchaseId, prior.id)))
      return { id: prior.id, invoiceNo: prior.invoiceNo, total: prior.total, due: prior.due, units: Number(units), lines: Number(lines), duplicate: true }
    }
  }
  const a = await analyse(db, companyId, input.bytes)
  if (a.fileErrors.length) throw new FieldErrors({ file: a.fileErrors[0] }, a.fileErrors[0])
  const bad = a.rows.filter((r) => r.errors.length > 0)
  if (bad.length) {
    const msg = `${bad.length} of ${a.rows.length} rows have problems, so nothing was imported. Fix the file (the dry run lists every problem) and try again.`
    throw new FieldErrors({ file: msg }, msg)
  }
  const units = a.rows.length
  const r = await createPurchase(
    db,
    companyId,
    userId,
    {
      vendorId: d.vendorId,
      date: d.date,
      note: d.note ?? 'Bulk serial import',
      items: a.groups.map((g) => ({ productId: g.productId, qty: g.serials.length, unitCost: g.unitCost, serials: g.serials, serialMeta: g.serialMeta })),
      discount: d.discount,
      paid: d.paid,
      accountId: d.accountId,
      idempotencyKey: d.idempotencyKey ?? null,
    },
    { branchId: ctx.branchId, restrict: ctx.restrict, source: 'import', requestHash },
  )
  return { id: r.id, invoiceNo: r.invoiceNo, total: r.total, due: r.due, units, lines: a.groups.length, duplicate: r.duplicate }
}
