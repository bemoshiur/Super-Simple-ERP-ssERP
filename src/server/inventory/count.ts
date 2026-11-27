/**
 * Stock-take helper (reads only): load a count sheet and compute the diff between what was counted and what the system
 * says. Quantities come from the same definitions as everywhere else (stockRows / onHandQty); serial discrepancies are
 * reported, never changed. Applying non-serial corrections lives in adjustments.ts (applyStockCount).
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { branchLabel, type BranchFilter } from '../branch'
import { schema, type Db } from '../db'
import { FieldErrors, zodPathErrors } from '../errors'
import { stockRows } from '../reports/stock'
import { onHandQty } from '../sales/sales'
import { parseScannedSerials, quantityDiff, serialDiff, type CountDiffRow, type ExpectedUnit, type UnexpectedSerial } from './pure'
import { MAX_COUNT_PRODUCTS, MAX_COUNT_SERIALS, countSchema, countSheetSchema } from './schemas'

export type CountSheetRow = { productId: string; name: string; sku: string; category: string | null; trackSerial: boolean; system: number }

/** Products to count (active, or inactive still holding stock), by category / search / tracking, with their system quantity. Max 500. */
export async function loadCountSheet(db: Db, companyId: string, branch: BranchFilter, input: unknown): Promise<{ rows: CountSheetRow[]; truncated: boolean }> {
  const r = countSheetSchema.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  const f = r.data
  const { rows, truncated } = await stockRows({ db, companyId, branch, limit: MAX_COUNT_PRODUCTS }, { categoryId: f.categoryId ?? undefined, q: f.q || undefined, tracking: f.tracking === 'all' ? undefined : f.tracking })
  // Costs are never sent to the count sheet.
  return { rows: rows.map((x) => ({ productId: x.id, name: x.name, sku: x.sku, category: x.category, trackSerial: x.trackSerial, system: x.onHand })), truncated }
}

export type CountDiff = {
  rows: CountDiffRow[]
  missing: (ExpectedUnit & { productName: string })[]
  unexpected: UnexpectedSerial[]
  matched: number
  duplicates: string[]
  totals: { counted: number; over: number; short: number; unchanged: number; missing: number; unexpected: number }
}

/**
 * Diff a submitted count against the system NOW (system quantities are re-read server-side; client values are ignored
 * for the diff). Products of another company are rejected.
 */
export async function computeCountDiff(db: Db, companyId: string, branch: BranchFilter, input: unknown): Promise<CountDiff> {
  const r = countSchema.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  const d = r.data
  const p = schema.products
  const qtyIds = [...new Set(d.lines.map((l) => l.productId))]
  const serialIds = [...new Set(d.serialProductIds)]
  const all = [...new Set([...qtyIds, ...serialIds])]
  const prods = all.length ? await db.select({ id: p.id, name: p.name, sku: p.sku, trackSerial: p.trackSerial }).from(p).where(and(eq(p.companyId, companyId), inArray(p.id, all))) : []
  const byId = new Map(prods.map((x) => [x.id, x]))
  if (prods.length !== all.length) throw new FieldErrors({ lines: 'Some products were not found. Reload the count sheet.' }, 'Some products were not found. Reload the count sheet.')
  if (qtyIds.some((id) => byId.get(id)!.trackSerial)) throw new FieldErrors({ lines: 'Serial products are counted by scanning their serials, not by quantity.' })
  if (serialIds.some((id) => !byId.get(id)!.trackSerial)) throw new FieldErrors({ scanned: 'Only serial-tracked products can be counted by serial.' })

  // ---- quantities ----
  const onHand = await onHandQty(db, companyId, branch, qtyIds)
  const system = qtyIds.map((id) => ({ productId: id, name: byId.get(id)!.name, sku: byId.get(id)!.sku, system: onHand.get(id) ?? 0 }))
  const rows = quantityDiff(system, d.lines.map((l) => ({ productId: l.productId, counted: l.counted })))

  // ---- serials ----
  const { serials, duplicates } = parseScannedSerials(d.scanned)
  if (serials.length > MAX_COUNT_SERIALS) throw new FieldErrors({ scanned: `At most ${MAX_COUNT_SERIALS} serials per count.` })
  const u = schema.productUnits
  const expected = serialIds.length
    ? await db
        .select({ unitId: u.id, serialNo: u.serialNo, productId: u.productId })
        .from(u)
        .where(and(eq(u.companyId, companyId), branch ? eq(u.branchId, branch) : undefined, inArray(u.productId, serialIds), eq(u.status, 'in_stock')))
        .orderBy(asc(u.serialNo))
    : []
  const known: { unitId: string; serialNo: string; productId: string; productName: string; status: string; branchId: string | null }[] = []
  for (let i = 0; i < serials.length; i += 1000) {
    const part = serials.slice(i, i + 1000)
    known.push(
      ...(await db
        .select({ unitId: u.id, serialNo: u.serialNo, productId: u.productId, productName: p.name, status: u.status, branchId: u.branchId })
        .from(u)
        .innerJoin(p, and(eq(p.id, u.productId), eq(p.companyId, companyId)))
        .where(and(eq(u.companyId, companyId), inArray(u.serialNo, part)))),
    )
  }
  // A unit counted here but recorded in another branch is "not in stock" HERE: say only where it is and its status
  // (no product, no unit id: another branch's details stay private).
  if (branch)
    for (const k of known) {
      if (k.branchId && k.branchId !== branch) {
        k.status = `${k.status === 'in_stock' ? 'in stock' : k.status.replace('_', ' ')} at ${(await branchLabel(db, companyId, k.branchId))?.name ?? 'another branch'}`
        k.productName = ''
        k.unitId = ''
      }
    }
  const sd = serialDiff(expected, serials, known, serialIds)
  return {
    rows,
    missing: sd.missing.map((m) => ({ ...m, productName: byId.get(m.productId)?.name ?? '' })),
    unexpected: sd.unexpected.map((x) => (x.unitId === '' ? { ...x, unitId: null, productName: null } : x)),
    matched: sd.matched,
    duplicates,
    totals: {
      counted: rows.length,
      over: rows.filter((x) => x.diff > 0).length,
      short: rows.filter((x) => x.diff < 0).length,
      unchanged: rows.filter((x) => x.diff === 0).length,
      missing: sd.missing.length,
      unexpected: sd.unexpected.length,
    },
  }
}

/** CSV rows for the diff report (the route handler adds the header and injection protection via toCsv). */
export function countDiffCsvRows(diff: CountDiff): Record<string, string | number | null>[] {
  return [
    ...diff.rows.map((r) => ({ section: 'Quantity', product: r.name, sku: r.sku, serial: null, system: r.system, counted: r.counted, diff: r.diff, note: r.diff === 0 ? 'OK' : r.diff > 0 ? 'Over' : 'Short' })),
    ...diff.missing.map((m) => ({ section: 'Missing serial', product: m.productName, sku: null, serial: m.serialNo, system: null, counted: null, diff: null, note: 'In stock in the system but not scanned' })),
    ...diff.unexpected.map((x) => ({ section: 'Unexpected serial', product: x.productName, sku: null, serial: x.serialNo, system: null, counted: null, diff: null, note: x.reason === 'unknown' ? 'Unknown serial' : x.reason === 'other_product' ? `Belongs to another product (${x.status})` : `Not in stock (${x.status})` })),
  ]
}

export const COUNT_CSV_COLUMNS = [
  { key: 'section', label: 'Section', kind: 'text' },
  { key: 'product', label: 'Product', kind: 'text' },
  { key: 'sku', label: 'SKU', kind: 'text' },
  { key: 'serial', label: 'Serial', kind: 'text' },
  { key: 'system', label: 'System qty', kind: 'int' },
  { key: 'counted', label: 'Counted qty', kind: 'int' },
  { key: 'diff', label: 'Difference', kind: 'int' },
  { key: 'note', label: 'Note', kind: 'text' },
] as const
