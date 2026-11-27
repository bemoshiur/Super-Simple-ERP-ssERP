/**
 * Pure report calculations (no DB, no clock except where a `today` is passed in). Everything is exact: money moves as integer
 * minor units internally and leaves as numeric strings.
 */
import { addDays, daysBetween } from '../dates'
import { fromMinor, toMinor } from '../money'

// ------------------------------------------------------------------ date ranges and buckets

/** First day of the week for weekly grouping: 0 = Sunday ... 6 = Saturday. Bangladesh's working week starts on Saturday. */
export const WEEK_START = 6

export const GROUPS = ['day', 'week', 'month'] as const
export type Group = (typeof GROUPS)[number]
export const parseGroup = (v: unknown): Group => (GROUPS as readonly string[]).includes(String(v)) ? (v as Group) : 'day'

const ISO = /^\d{4}-\d{2}-\d{2}$/
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !ISO.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31'
}

/** Longest date range a report accepts (keeps a mistyped year from scanning a decade). */
export const MAX_RANGE_DAYS = 3660

/**
 * Parse `?from=&to=`: invalid/missing values default to (first day of this month .. today), reversed ranges are swapped,
 * over-long ranges are clamped to MAX_RANGE_DAYS ending at `to`. `today` is the shop-local date.
 */
export function parseRange(sp: { from?: unknown; to?: unknown }, today: string): { from: string; to: string } {
  let to = isIsoDate(sp.to) ? sp.to : today
  let from = isIsoDate(sp.from) ? sp.from : `${to.slice(0, 7)}-01`
  if (from > to) [from, to] = [to, from]
  if (daysBetween(from, to) > MAX_RANGE_DAYS) from = addDays(to, -MAX_RANGE_DAYS)
  return { from, to }
}

/** First date of the day/week/month bucket containing `date` (YYYY-MM-DD). Weeks start on `weekStart` (default Saturday). */
export function bucketStart(date: string, group: Group, weekStart: number = WEEK_START): string {
  if (group === 'day') return date
  if (group === 'month') return `${date.slice(0, 7)}-01`
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDays(date, -((dow - weekStart + 7) % 7))
}

/** Display label of a bucket: day = the date, week = "start to end", month = "2026-11". */
export function bucketLabel(start: string, group: Group): string {
  if (group === 'day') return start
  if (group === 'month') return start.slice(0, 7)
  return `${start} to ${addDays(start, 6)}`
}

/** Merge several {bucket -> values} series into sorted rows; missing series values are zero. */
export function mergeBuckets<K extends string>(series: Record<K, Map<string, string>>): { bucket: string; values: Record<K, string> }[] {
  const keys = Object.keys(series) as K[]
  const all = new Set<string>()
  for (const k of keys) for (const b of series[k].keys()) all.add(b)
  return [...all].sort().map((bucket) => ({ bucket, values: Object.fromEntries(keys.map((k) => [k, series[k].get(bucket) ?? '0.00'])) as Record<K, string> }))
}

/** Sum of numeric strings, exact. */
export const sumMoney = (vals: readonly (string | null | undefined)[]): string => fromMinor(vals.reduce<number>((a, v) => a + toMinor(v ?? '0'), 0))
export const subMoney = (a: string, b: string): string => fromMinor(toMinor(a) - toMinor(b))

// ------------------------------------------------------------------ aging and warranty windows

export type AgingBucket = 'current' | '30' | '60' | '90+'
/** Days since the invoice date: 0-29 current (future-dated invoices too), 30-59, 60-89, 90+. SQL twin: customerDues(). */
export function agingBucket(ageDays: number): AgingBucket {
  return ageDays >= 90 ? '90+' : ageDays >= 60 ? '60' : ageDays >= 30 ? '30' : 'current'
}

export type WarrantyWindow = 30 | 60 | 90
/** The smallest of 30/60/90 that contains `daysLeft` (null when beyond 90). */
export function warrantyWindow(daysLeft: number): WarrantyWindow | null {
  return daysLeft <= 30 ? 30 : daysLeft <= 60 ? 60 : daysLeft <= 90 ? 90 : null
}
export const parseWarrantyDays = (v: unknown): WarrantyWindow => (v === '60' || v === 60 ? 60 : v === '90' || v === 90 ? 90 : 30)

/** profit / revenue as a percent with 2 decimals, half away from zero ("28.57"), or null when there is no revenue. */
export function marginPercent(profit: string, revenue: string): string | null {
  const p = toMinor(profit)
  const r = toMinor(revenue)
  if (r <= 0) return null
  const bps = Math.round((Math.abs(p) * 10000) / r) // basis points, exact enough: |p|,r are safe integers
  const s = String(bps).padStart(3, '0')
  return `${p < 0 && bps !== 0 ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`
}

// ------------------------------------------------------------------ profit and loss

export type NamedAmount = { name: string; amount: string }
export type ProfitLossInput = {
  /** sum(sales.subtotal): invoice lines at their selling prices, before discounts. */
  grossSales: string
  /** sum(sales.discount). */
  discounts: string
  /** sum(sale_returns.credit_total) for returns dated in the period (value of goods returned). */
  salesReturns: string
  /** sum(qty x unit_cost_snapshot) of items on invoices dated in the period. */
  cogs: string
  /** Cost of returned goods that went BACK INTO STOCK (returns dated in the period). Damaged returns stay in COGS (a write-off). */
  cogsRestocked: string
  /**
   * Net stock-adjustment cost of the period (Task 12): -(sum of stock_adjustments.value), so write-offs (damage, loss,
   * negative count corrections) are a positive cost and found stock a negative one. Optional (defaults to 0).
   */
  stockAdjustments?: string
  /** Non-voided expenses by category. */
  expenses: NamedAmount[]
  /** Non-voided manual incomes by category. */
  otherIncome: NamedAmount[]
}
export type ProfitLoss = {
  grossSales: string
  discounts: string
  /** grossSales - discounts (= sum of sales.total). */
  netSales: string
  salesReturns: string
  /** netSales - salesReturns. */
  revenue: string
  cogs: string
  cogsRestocked: string
  netCogs: string
  /** Stock write-offs net of found stock (positive = cost). */
  stockAdjustments: string
  /** netCogs + stockAdjustments. */
  totalCost: string
  grossProfit: string
  expenses: NamedAmount[]
  totalExpenses: string
  otherIncome: NamedAmount[]
  totalOtherIncome: string
  netProfit: string
}

/**
 * Profit & loss for a period (accrual basis, invoices by invoice date, returns by return date):
 *   revenue      = sales (after discounts) - sales returns
 *   gross profit = revenue - (cost of goods sold - cost of returned goods restocked) - stock adjustments (write-offs net of found)
 *   net profit   = gross profit - operating expenses + other income
 * NOT included: purchases and vendor payments (buying stock is not an expense; its cost reaches P&L through COGS when sold),
 * customer receipts/refunds and transfers (cash movements, not income), voided entries.
 */
export function computeProfitLoss(i: ProfitLossInput): ProfitLoss {
  const gross = toMinor(i.grossSales)
  const disc = toMinor(i.discounts)
  const ret = toMinor(i.salesReturns)
  const net = gross - disc
  const revenue = net - ret
  const cogs = toMinor(i.cogs)
  const restocked = toMinor(i.cogsRestocked)
  const netCogs = cogs - restocked
  const adj = toMinor(i.stockAdjustments ?? '0')
  const grossProfit = revenue - netCogs - adj
  const exp = i.expenses.map((e) => ({ name: e.name, amount: fromMinor(toMinor(e.amount)) }))
  const inc = i.otherIncome.map((e) => ({ name: e.name, amount: fromMinor(toMinor(e.amount)) }))
  const totalExp = exp.reduce((a, e) => a + toMinor(e.amount), 0)
  const totalInc = inc.reduce((a, e) => a + toMinor(e.amount), 0)
  return {
    grossSales: fromMinor(gross),
    discounts: fromMinor(disc),
    netSales: fromMinor(net),
    salesReturns: fromMinor(ret),
    revenue: fromMinor(revenue),
    cogs: fromMinor(cogs),
    cogsRestocked: fromMinor(restocked),
    netCogs: fromMinor(netCogs),
    stockAdjustments: fromMinor(adj),
    totalCost: fromMinor(netCogs + adj),
    grossProfit: fromMinor(grossProfit),
    expenses: exp,
    totalExpenses: fromMinor(totalExp),
    otherIncome: inc,
    totalOtherIncome: fromMinor(totalInc),
    netProfit: fromMinor(grossProfit - totalExp + totalInc),
  }
}

// ------------------------------------------------------------------ cash flow

export type CashAccountInput = {
  id: string
  name: string
  type: string
  /** accounts.opening_balance */
  openingBalance: string
  /** payments dated BEFORE the period */
  beforeIn: string
  beforeOut: string
  /** payments inside the period */
  periodIn: string
  periodOut: string
}
export type CashAccountFlow = { id: string; name: string; type: string; opening: string; inflow: string; outflow: string; closing: string }
export type CashFlowTotals = { opening: string; inflow: string; outflow: string; closing: string }

/**
 * opening (period start) = opening_balance + payments in before - payments out before; closing = opening + in - out.
 * An account's opening_balance counts from the beginning of time (before every payment), so it is part of the first period's opening.
 */
export function computeCashFlow(accounts: readonly CashAccountInput[]): { accounts: CashAccountFlow[]; totals: CashFlowTotals } {
  const rows = accounts.map((a): CashAccountFlow => {
    const opening = toMinor(a.openingBalance) + toMinor(a.beforeIn) - toMinor(a.beforeOut)
    const inflow = toMinor(a.periodIn)
    const outflow = toMinor(a.periodOut)
    return { id: a.id, name: a.name, type: a.type, opening: fromMinor(opening), inflow: fromMinor(inflow), outflow: fromMinor(outflow), closing: fromMinor(opening + inflow - outflow) }
  })
  const t = (k: keyof CashFlowTotals) => fromMinor(rows.reduce((s, r) => s + toMinor(r[k]), 0))
  return { accounts: rows, totals: { opening: t('opening'), inflow: t('inflow'), outflow: t('outflow'), closing: t('closing') } }
}

/** Closing balances must equal the independently computed account balances as of the period end. Returns the mismatches. */
export function reconcileCashFlow(flow: readonly { id: string; closing: string }[], balances: readonly { id: string; balance: string }[]): { ok: boolean; diffs: { id: string; closing: string; balance: string }[] } {
  const bal = new Map(balances.map((b) => [b.id, b.balance]))
  const diffs = flow.filter((f) => toMinor(f.closing) !== toMinor(bal.get(f.id) ?? '0.00')).map((f) => ({ id: f.id, closing: f.closing, balance: bal.get(f.id) ?? '0.00' }))
  const missing = balances.filter((b) => !flow.some((f) => f.id === b.id)).map((b) => ({ id: b.id, closing: '0.00', balance: b.balance }))
  const all = [...diffs, ...missing.filter((m) => toMinor(m.balance) !== 0)]
  return { ok: all.length === 0, diffs: all }
}

export type MovementInput = { direction: 'in' | 'out'; refType: string; isReversal: boolean; category: string | null; amount: string }
export type MovementLine = { direction: 'in' | 'out'; label: string; amount: string }

/** Human label of a cash movement group, e.g. "Sale receipts", "Expense: Rent", "Void of income: Interest". */
export function movementLabel(m: Pick<MovementInput, 'direction' | 'refType' | 'isReversal' | 'category'>): string {
  const cat = m.category ? `: ${m.category}` : ''
  if (m.isReversal) return `Void of ${m.refType}${cat}`
  switch (m.refType) {
    case 'sale':
      return m.direction === 'in' ? 'Customer receipts (sales)' : 'Customer refunds (returns)'
    case 'purchase':
      return m.direction === 'out' ? 'Vendor payments (purchases)' : 'Vendor refunds (purchase returns)'
    case 'expense':
      return `Expense${cat || ': Uncategorized'}`
    case 'income':
      return `Other income${cat || ': Uncategorized'}`
    case 'transfer':
      return m.direction === 'in' ? 'Transfers in' : 'Transfers out'
    default:
      return `Manual ${m.direction === 'in' ? 'receipts' : 'payments'}`
  }
}

/** Group raw movement rows into labelled lines (inflows first, then outflows; largest first within each). Exact sums. */
export function groupMovements(rows: readonly MovementInput[]): { inflows: MovementLine[]; outflows: MovementLine[] } {
  const acc = new Map<string, MovementLine & { minor: number }>()
  for (const r of rows) {
    const label = movementLabel(r)
    const key = `${r.direction}|${label}`
    const cur = acc.get(key) ?? { direction: r.direction, label, amount: '0.00', minor: 0 }
    cur.minor += toMinor(r.amount)
    acc.set(key, cur)
  }
  const lines = [...acc.values()]
  const sort = (d: 'in' | 'out'): MovementLine[] =>
    lines
      .filter((l) => l.direction === d)
      .sort((a, b) => b.minor - a.minor || a.label.localeCompare(b.label))
      .map((l) => ({ direction: l.direction, label: l.label, amount: fromMinor(l.minor) }))
  return { inflows: sort('in'), outflows: sort('out') }
}
