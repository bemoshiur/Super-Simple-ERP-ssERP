/**
 * Pure sales money math on integer minor units (never floats). Shared by the POS form (live totals) and the server
 * (single source of truth: client-sent totals are never stored). Discount allocation and per-unit splitting reuse the
 * purchase helpers, so purchase cost and sale revenue use exactly the same rounding rules.
 */
import { fromMinor, toMinor } from '../money'
import { allocateDiscount, splitEvenly } from '../purchases/totals'
import { MAX_MINOR } from '../validation'

export { allocateDiscount, splitEvenly }

export type SaleTotalsInput = {
  items: { qty: number | string; unitPrice: string | number }[]
  discount?: string | number | null
  /** Payment amounts taken now (one per payment row). */
  payments?: (string | number | null | undefined)[]
}

export type SaleTotals = {
  /** Gross line totals (qty * unit price). */
  lines: string[]
  /** Line revenue after the allocated invoice discount; sums exactly to `total`. */
  netLines: string[]
  subtotal: string
  discount: string
  total: string
  paid: string
  due: string
}
export type SaleTotalsResult = { ok: true; totals: SaleTotals } | { ok: false; errors: Record<string, string> }

const parse = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 0
  try {
    return toMinor(typeof v === 'string' ? v.trim() : v)
  } catch {
    return null
  }
}

/** subtotal = sum(qty * price); total = subtotal - discount; paid = sum(payments); due = total - paid. */
export function computeSaleTotals(input: SaleTotalsInput): SaleTotalsResult {
  const errors: Record<string, string> = {}
  const lines: number[] = []
  input.items.forEach((it, i) => {
    const qty = typeof it.qty === 'number' ? it.qty : /^\d{1,9}$/.test(String(it.qty).trim()) ? Number(String(it.qty).trim()) : NaN
    const price = parse(it.unitPrice)
    if (!Number.isInteger(qty) || qty < 1) errors[`items.${i}.qty`] = 'Quantity must be a whole number of at least 1'
    if (price === null) errors[`items.${i}.unitPrice`] = 'Enter a valid price'
    else if (price < 0) errors[`items.${i}.unitPrice`] = 'Price cannot be negative'
    lines.push(Number.isInteger(qty) && price !== null ? qty * price : 0)
  })
  const subtotal = lines.reduce((a, b) => a + b, 0)
  const discount = parse(input.discount)
  if (discount === null) errors.discount = 'Enter a valid amount'
  else if (discount < 0) errors.discount = 'Discount cannot be negative'
  else if (discount > subtotal) errors.discount = 'Discount cannot be more than the subtotal'
  const total = subtotal - (discount ?? 0)
  let paid = 0
  ;(input.payments ?? []).forEach((v, i) => {
    const a = parse(v)
    if (a === null) errors[`payments.${i}.amount`] = 'Enter a valid amount'
    else if (a <= 0) errors[`payments.${i}.amount`] = 'Enter an amount greater than zero'
    else paid += a
  })
  if (paid > total && !errors.discount) errors.paid = 'Payments cannot be more than the invoice total'
  if (!Number.isSafeInteger(subtotal) || subtotal > MAX_MINOR || lines.some((l) => !Number.isSafeInteger(l) || l > MAX_MINOR)) errors.items = 'Invoice amount is too large'
  if (Object.keys(errors).length) return { ok: false, errors }
  const shares = allocateDiscount(lines, discount ?? 0)
  return {
    ok: true,
    totals: {
      lines: lines.map(fromMinor),
      netLines: lines.map((l, i) => fromMinor(l - shares[i])),
      subtotal: fromMinor(subtotal),
      discount: fromMinor(discount ?? 0),
      total: fromMinor(total),
      paid: fromMinor(paid),
      due: fromMinor(total - paid),
    },
  }
}

export type StoredSaleStatus = 'completed' | 'partially_paid' | 'paid' | 'returned'

/**
 * Settlement of one sale invoice. `returned` = credit from customer returns, `paid` = net cash received (payments in
 * minus refunds out). due = max(0, total - returned - paid). Stored status: fully returned -> 'returned', nothing due ->
 * 'paid', some paid -> 'partially_paid', else 'completed' (= unpaid). The UI shows displayStatus() from purchases/totals.
 */
export function settleSale(p: { total: string; returned: string; paid: string }): { due: string; status: StoredSaleStatus; excess: string } {
  const total = toMinor(p.total)
  const returned = toMinor(p.returned)
  const paid = toMinor(p.paid)
  const open = total - returned - paid
  const due = Math.max(0, open)
  const status: StoredSaleStatus = returned > 0 && total - returned <= 0 ? 'returned' : due === 0 ? 'paid' : paid > 0 ? 'partially_paid' : 'completed'
  return { due: fromMinor(due), status, excess: fromMinor(Math.max(0, -open)) }
}

/**
 * Average unit cost (minor units) for a NON-serial product: total net purchase cost / total quantity, rounded half up
 * to the minor unit. Inputs are already net of returns. Falls back to `fallback` (products.purchase_price) when there
 * is no usable purchase history (qty <= 0 or a negative cost). BigInt keeps the rounding exact for any size.
 */
export function averageUnitCost(netCostMinor: number, qty: number, fallbackMinor: number): number {
  if (!Number.isSafeInteger(netCostMinor) || !Number.isSafeInteger(qty) || qty <= 0 || netCostMinor < 0) return fallbackMinor
  const n = BigInt(netCostMinor)
  const q = BigInt(qty)
  const two = BigInt(2)
  return Number((two * n + q) / (two * q))
}

/**
 * Credit for returning `k` units of a sale line whose net revenue is `lineNetMinor` over `qty` units, when `already`
 * units were returned before. The line is split exactly with splitEvenly() and returns consume the shares in order, so
 * returning every unit (in any number of steps) credits exactly the line's net total.
 */
export function returnCredit(lineNetMinor: number, qty: number, already: number, k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new Error('return quantity must be at least 1')
  if (!Number.isInteger(already) || already < 0 || already + k > qty) throw new Error('cannot return more than was sold')
  return splitEvenly(lineNetMinor, qty)
    .slice(already, already + k)
    .reduce((a, b) => a + b, 0)
}

/**
 * Apply a customer payment to unpaid invoices oldest first (the caller passes them already in oldest-first order).
 * Returns the non-zero allocations; throws when the amount exceeds the total due.
 */
export function allocateOldestFirst(invoices: readonly { id: string; dueMinor: number }[], amountMinor: number): { id: string; amountMinor: number }[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('amount must be positive')
  const totalDue = invoices.reduce((a, x) => a + Math.max(0, x.dueMinor), 0)
  if (amountMinor > totalDue) throw new Error('amount is more than the total due')
  const out: { id: string; amountMinor: number }[] = []
  let left = amountMinor
  for (const inv of invoices) {
    if (left === 0) break
    const take = Math.min(left, Math.max(0, inv.dueMinor))
    if (take > 0) {
      out.push({ id: inv.id, amountMinor: take })
      left -= take
    }
  }
  return out
}

/** Profit of a line in minor units: net revenue - qty * unit cost snapshot. */
export function lineProfit(netTotal: string, qty: number, unitCost: string): number {
  return toMinor(netTotal) - toMinor(unitCost) * qty
}
