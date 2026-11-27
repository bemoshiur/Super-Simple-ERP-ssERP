/**
 * Pure inventory helpers (no DB / Node imports, safe on the client and in unit tests): adjustment reasons and rules,
 * the stock-card running balance (the SQL window function is the source of truth; this twin is for tests/previews),
 * and the stock-take count diff.
 */
import { normalizeSerial } from '../purchases/serialInput'

export const ADJUST_REASONS = ['count_correction', 'damage', 'loss', 'found', 'other'] as const
export type AdjustReason = (typeof ADJUST_REASONS)[number]

export const ADJUST_REASON_LABEL: Readonly<Record<AdjustReason, string>> = {
  count_correction: 'Count correction',
  damage: 'Damage',
  loss: 'Loss',
  found: 'Found',
  other: 'Other',
}

/** Serial units can only be taken out of stock by hand: marked damaged (reason damage) or lost (reason loss, status damaged). */
export const UNIT_ADJUST_REASONS = ['damage', 'loss'] as const satisfies readonly AdjustReason[]
export type UnitAdjustReason = (typeof UNIT_ADJUST_REASONS)[number]

/** Largest single quantity adjustment. */
export const MAX_ADJUST_QTY = 1_000_000

/**
 * Rules for a NON-serial quantity adjustment. Returns an error message, or null when valid:
 *  - qty is a non-zero whole number within +-MAX_ADJUST_QTY;
 *  - damage / loss can only reduce stock, found can only add stock (count correction / other: either way);
 *  - a reduction may not take on-hand below zero (pass `onHand` when known; the server re-checks under the product lock).
 */
export function adjustmentProblem(p: { reason: AdjustReason; qtyChange: number; onHand?: number; productName?: string }): string | null {
  const q = p.qtyChange
  if (!Number.isInteger(q) || q === 0) return 'Enter a whole number other than zero (use a minus sign to reduce stock).'
  if (Math.abs(q) > MAX_ADJUST_QTY) return `At most ${MAX_ADJUST_QTY.toLocaleString('en-US')} units per adjustment.`
  if ((p.reason === 'damage' || p.reason === 'loss') && q > 0) return `${ADJUST_REASON_LABEL[p.reason]} can only reduce stock: enter a negative quantity.`
  if (p.reason === 'found' && q < 0) return 'Found stock can only be added: enter a positive quantity.'
  if (p.onHand !== undefined && p.onHand + q < 0) {
    const name = p.productName ?? 'this product'
    return p.onHand <= 0 ? `${name} has no stock to reduce.` : `Only ${p.onHand} of ${name} in stock: you can reduce by at most ${p.onHand}.`
  }
  return null
}

/** Parse a signed whole-number quantity typed by a user ("-3", "+2", " 5 "). Null when it is not one. */
export function parseSignedQty(raw: unknown): number | null {
  const s = String(raw ?? '').trim().replace(/^\+/, '')
  if (!/^-?\d{1,9}$/.test(s)) return null
  const n = Number(s)
  return Object.is(n, -0) ? 0 : n
}

/**
 * Running balance over movements in ledger order (oldest first), the twin of the stock card's SQL window
 * `sum(qty_change) over (order by created_at, id)`.
 */
export function runningBalance<T extends { qtyChange: number }>(movements: readonly T[], opening = 0): (T & { balance: number })[] {
  let bal = opening
  return movements.map((m) => {
    bal += m.qtyChange
    return { ...m, balance: bal }
  })
}

// ------------------------------------------------------------------ stock-take

export type CountLineInput = { productId: string; counted: number | null }
export type SystemQty = { productId: string; name: string; sku: string; system: number }
export type CountDiffRow = SystemQty & { counted: number; diff: number }

/**
 * Non-serial count diff: one row per product that was actually counted (counted !== null), diff = counted - system.
 * Rows are returned in the order of `system`; products not in `system` are ignored.
 */
export function quantityDiff(system: readonly SystemQty[], counted: readonly CountLineInput[]): CountDiffRow[] {
  const byId = new Map(counted.filter((c) => c.counted !== null && c.counted !== undefined).map((c) => [c.productId, c.counted as number]))
  return system.filter((s) => byId.has(s.productId)).map((s) => ({ ...s, counted: byId.get(s.productId)!, diff: byId.get(s.productId)! - s.system }))
}

/** Split pasted/scanned serials (newline, comma, tab, semicolon), normalise, drop blanks and exact duplicates (first wins). */
export function parseScannedSerials(raw: string): { serials: string[]; duplicates: string[] } {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const part of String(raw ?? '').split(/[\r\n,;\t]+/)) {
    const s = normalizeSerial(part)
    if (!s) continue
    if (seen.has(s)) duplicates.push(s)
    else seen.add(s)
  }
  return { serials: [...seen], duplicates }
}

export type ExpectedUnit = { unitId: string; serialNo: string; productId: string }
export type KnownUnit = { unitId: string; serialNo: string; productId: string; productName: string; status: string }
export type UnexpectedSerial = { serialNo: string; reason: 'unknown' | 'not_in_stock' | 'other_product'; status: string | null; productName: string | null; unitId: string | null }

/**
 * Serial count diff for the products being counted:
 *  - missing = units the system says are in stock (for these products) that were not scanned;
 *  - unexpected = scanned serials that are unknown, not in stock, or belong to a product outside the count.
 * `known` holds what the database knows about the scanned serials (any product, any status). Matching is exact (case-sensitive).
 */
export function serialDiff(expected: readonly ExpectedUnit[], scanned: readonly string[], known: readonly KnownUnit[], countedProductIds: readonly string[]): { missing: ExpectedUnit[]; unexpected: UnexpectedSerial[]; matched: number } {
  const scannedSet = new Set(scanned)
  const expectedSet = new Set(expected.map((e) => e.serialNo))
  const inScope = new Set(countedProductIds)
  const knownBySerial = new Map(known.map((k) => [k.serialNo, k]))
  const missing = expected.filter((e) => !scannedSet.has(e.serialNo))
  const unexpected: UnexpectedSerial[] = []
  let matched = 0
  for (const s of scanned) {
    if (expectedSet.has(s)) {
      matched++
      continue
    }
    const k = knownBySerial.get(s)
    if (!k) unexpected.push({ serialNo: s, reason: 'unknown', status: null, productName: null, unitId: null })
    else if (!inScope.has(k.productId)) unexpected.push({ serialNo: s, reason: 'other_product', status: k.status, productName: k.productName, unitId: k.unitId })
    else unexpected.push({ serialNo: s, reason: 'not_in_stock', status: k.status, productName: k.productName, unitId: k.unitId })
  }
  return { missing, unexpected, matched }
}

export const UNEXPECTED_LABEL: Readonly<Record<UnexpectedSerial['reason'], string>> = {
  unknown: 'Unknown serial (not in your records)',
  not_in_stock: 'Recorded, but not in stock',
  other_product: 'Belongs to a product outside this count',
}

export type SheetRowLite = { productId: string; name: string; trackSerial: boolean; system: number }
export type MovedProduct = { productId: string; name: string; trackSerial: boolean; was: number; now: number }

/**
 * Reloading a count sheet (e.g. after "stock changed since the count"): keep every entered count whose product's system qty
 * is unchanged since the previous load, clear the ones that moved and report them (so only those need a recount).
 * Serial products cannot be cleared individually (one scan box), so moved serial products are only reported.
 */
export function mergeReloadedCounts(prev: readonly SheetRowLite[], next: readonly SheetRowLite[], counted: Readonly<Record<string, string>>): { counted: Record<string, string>; moved: MovedProduct[] } {
  const before = new Map(prev.map((r) => [r.productId, r]))
  const kept: Record<string, string> = {}
  const moved: MovedProduct[] = []
  for (const r of next) {
    const p = before.get(r.productId)
    if (!p) continue
    if (p.system !== r.system) {
      if (r.trackSerial || (counted[r.productId] ?? '').trim() !== '') moved.push({ productId: r.productId, name: r.name, trackSerial: r.trackSerial, was: p.system, now: r.system })
      continue
    }
    if (!r.trackSerial && counted[r.productId] !== undefined) kept[r.productId] = counted[r.productId]
  }
  return { counted: kept, moved }
}
