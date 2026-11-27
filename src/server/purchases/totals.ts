/**
 * Pure purchase money math on integer minor units (never floats). Used by the form for live totals and by the
 * server as the single source of truth (client-sent totals are never stored).
 */
import { fromMinor, toMinor } from '../money'
import { MAX_MINOR } from '../validation'

export type TotalsInput = {
  items: { qty: number | string; unitCost: string | number }[]
  discount?: string | number | null
  paid?: string | number | null
}

export type Totals = {
  /** Gross line totals (qty * unit cost). */
  lines: string[]
  /** Line totals after the allocated invoice discount; they sum exactly to `total`. */
  netLines: string[]
  subtotal: string
  discount: string
  total: string
  paid: string
  due: string
}
export type TotalsResult = { ok: true; totals: Totals } | { ok: false; errors: Record<string, string> }

const parse = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 0
  try {
    return toMinor(typeof v === 'string' ? v.trim() : v)
  } catch {
    return null
  }
}

/** subtotal = sum(qty * unit cost); total = subtotal - discount; due = total - paid. Rejects negatives and overflow. */
export function computePurchaseTotals(input: TotalsInput): TotalsResult {
  const errors: Record<string, string> = {}
  const lines: number[] = []
  input.items.forEach((it, i) => {
    const qty = typeof it.qty === 'number' ? it.qty : /^\d{1,9}$/.test(String(it.qty).trim()) ? Number(String(it.qty).trim()) : NaN
    const cost = parse(it.unitCost)
    if (!Number.isInteger(qty) || qty < 1) errors[`items.${i}.qty`] = 'Quantity must be a whole number of at least 1'
    if (cost === null) errors[`items.${i}.unitCost`] = 'Enter a valid amount'
    else if (cost < 0) errors[`items.${i}.unitCost`] = 'Unit cost cannot be negative'
    lines.push(Number.isInteger(qty) && cost !== null ? qty * cost : 0)
  })
  const subtotal = lines.reduce((a, b) => a + b, 0)
  const discount = parse(input.discount)
  const paid = parse(input.paid)
  if (discount === null) errors.discount = 'Enter a valid amount'
  else if (discount < 0) errors.discount = 'Discount cannot be negative'
  else if (discount > subtotal) errors.discount = 'Discount cannot be more than the subtotal'
  const total = subtotal - (discount ?? 0)
  if (paid === null) errors.paid = 'Enter a valid amount'
  else if (paid < 0) errors.paid = 'Paid amount cannot be negative'
  else if (paid > total) errors.paid = 'Paid amount cannot be more than the invoice total'
  if (!Number.isSafeInteger(subtotal) || subtotal > MAX_MINOR || lines.some((l) => !Number.isSafeInteger(l) || l > MAX_MINOR)) errors.items = 'Invoice amount is too large'
  if (Object.keys(errors).length) return { ok: false, errors }
  const shares = allocateDiscount(lines, discount ?? 0)
  return {
    ok: true,
    totals: { lines: lines.map(fromMinor), netLines: lines.map((l, i) => fromMinor(l - shares[i])), subtotal: fromMinor(subtotal), discount: fromMinor(discount ?? 0), total: fromMinor(total), paid: fromMinor(paid ?? 0), due: fromMinor(total - (paid ?? 0)) },
  }
}

export type PurchaseStatus = 'received' | 'partially_paid' | 'paid'

/**
 * Settlement of one purchase invoice. `returned` = credit from purchase returns, `paid` = net cash paid
 * (payments out minus refunds in). due = max(0, total - returned - paid); any excess is vendor credit that shows
 * up in the vendor ledger (negative due there), not on the invoice.
 */
export function settle(p: { total: string; returned: string; paid: string }): { due: string; status: PurchaseStatus; excess: string } {
  const total = toMinor(p.total)
  const returned = toMinor(p.returned)
  const paid = toMinor(p.paid)
  const open = total - returned - paid
  const due = Math.max(0, open)
  const status: PurchaseStatus = due === 0 ? 'paid' : paid > 0 ? 'partially_paid' : 'received'
  return { due: fromMinor(due), status, excess: fromMinor(Math.max(0, -open)) }
}

/**
 * Allocate an invoice-level discount (minor units) across lines in proportion to their gross amounts, exactly.
 * Scheme (largest remainder): each line gets floor(discount * line / subtotal); the cents left over go one each to
 * the lines with the largest fractional remainders, ties broken by line order (earlier line first).
 * Guarantees: shares sum to `discount`; 0 <= share <= line for every line (given 0 <= discount <= subtotal).
 * BigInt keeps discount * line exact for any numeric(14,2) value.
 */
export function allocateDiscount(lines: readonly number[], discount: number): number[] {
  const subtotal = lines.reduce((a, b) => a + b, 0)
  if (discount < 0 || discount > subtotal || !Number.isSafeInteger(discount)) throw new Error('discount must be between 0 and the subtotal')
  if (discount === 0 || subtotal === 0) return lines.map(() => 0)
  const D = BigInt(discount)
  const S = BigInt(subtotal)
  const base = lines.map((l) => (D * BigInt(l)) / S)
  const rem = lines.map((l) => (D * BigInt(l)) % S)
  let left = discount - base.reduce((a, b) => a + Number(b), 0)
  const order = lines.map((_, i) => i).sort((a, b) => (rem[b] > rem[a] ? 1 : rem[b] < rem[a] ? -1 : a - b))
  const out = base.map(Number)
  for (const i of order) {
    if (left === 0) break
    out[i] += 1
    left -= 1
  }
  return out
}

/**
 * Split a line's net total across its `qty` units, exactly: every unit gets floor(total / qty) and the leftover
 * cents go one each to the FIRST units in entry order (serial order as typed). Sum == total; all >= 0.
 * This is the unit's net cost (product_units.purchase_price, purchase-return credit, COGS for non-serial stock).
 */
export function splitEvenly(total: number, qty: number): number[] {
  if (!Number.isInteger(qty) || qty < 1) throw new Error('qty must be a positive integer')
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('total must be a non-negative integer')
  const base = Math.floor(total / qty)
  const r = total - base * qty
  return Array.from({ length: qty }, (_, i) => base + (i < r ? 1 : 0))
}

export type DisplayStatus = 'unpaid' | 'partially_paid' | 'paid' | 'returned'

/**
 * What the user sees for an invoice (the stored purchase_status enum is not changed). Derived from net paid against
 * what is still billable (total - returned): fully returned -> 'returned', nothing due -> 'paid', else by paid.
 */
export function displayStatus(p: { total: string; returnedTotal: string; paid: string; due: string }): DisplayStatus {
  const billable = toMinor(p.total) - toMinor(p.returnedTotal)
  if (toMinor(p.returnedTotal) > 0 && billable <= 0) return 'returned'
  if (toMinor(p.due) === 0) return 'paid'
  return toMinor(p.paid) > 0 ? 'partially_paid' : 'unpaid'
}
