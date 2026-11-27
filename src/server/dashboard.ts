/**
 * Dashboard aggregates. Every query is company-scoped (companyId comes from the session, never the client), does its
 * summing in SQL (numeric, exact) and only returns decimal strings; totals are combined with the money helpers.
 * On an empty database everything is "0.00" / 0 / [] (COALESCE).
 *
 * The sales numbers REUSE the report functions so the dashboard and /reports can never disagree:
 *  - sales today / this month / last 7 days = NET of returns (invoices by invoice date minus returns by return date,
 *    reports/sales.ts salesSeries), "today" being the shop's local calendar day (APP_TIMEZONE, default Asia/Dhaka);
 *  - top products = net revenue per product over the last 30 local days (reports/profit.ts productProfitRows, revenue only);
 *  - stock value = serial units at their net cost + quantity products at average cost (reports/stock.ts stockValuation);
 *  - low stock = the same predicate as the low-stock report;
 *  - dues = sum(sales.due) / sum(purchases.due) on non-draft, non-cancelled documents (party opening balances not included).
 * Branches (Task 14): every number takes the viewer's BranchFilter (one branch, or null = all branches).
 */
import { sql } from 'drizzle-orm'
import { andBranch, type BranchFilter } from './branch'
import { addDays, appTimezone, localDate } from './dates'
import { getDb, rowsOf, schema, type Db } from './db'
import { safeLog } from './errors'
import { fromMinor, sum, toMinor } from './money'
import { productProfitRows } from './reports/profit'
import { salesSeries } from './reports/sales'
import { lowStockCount, stockValuation } from './reports/stock'

export { DEFAULT_TIMEZONE, appTimezone } from './dates'
export { lowStockCount }

const { sales, purchases } = schema
const DOC_OK = sql`('draft','cancelled')` // statuses excluded from totals

const money = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '0.00'
  return fromMinor(toMinor(String(v)))
}

export type SalesPoint = { day: string; total: string }
export type TopProduct = { name: string; revenue: string; units: number }

/** Net sales (after returns) for the shop's today and for the calendar month to date. */
export async function salesTotals(db: Db, companyId: string, branch: BranchFilter, tz = appTimezone(), now: Date = new Date()) {
  const today = localDate(tz, now)
  const monthStart = `${today.slice(0, 7)}-01`
  const rows = await salesSeries(db, companyId, branch, { from: monthStart, to: today, group: 'day' })
  return { today: sum(rows.filter((r) => r.bucket === today).map((r) => r.net)), month: sum(rows.map((r) => r.net)) }
}

/** Stock value at net cost: serial units at their own cost + non-serial on-hand x average cost. */
export const stockValue = (db: Db, companyId: string, branch: BranchFilter): Promise<string> => stockValuation(db, companyId, branch)

export async function dues(db: Db, companyId: string, branch: BranchFilter) {
  const [c, v] = await Promise.all([
    db.execute(sql`select coalesce(sum(${sales.due}), 0)::text as v from ${sales} where ${sales.companyId} = ${companyId}${andBranch(sales.branchId, branch)} and ${sales.status} not in ${DOC_OK}`),
    db.execute(sql`select coalesce(sum(${purchases.due}), 0)::text as v from ${purchases} where ${purchases.companyId} = ${companyId}${andBranch(purchases.branchId, branch)} and ${purchases.status} not in ${DOC_OK}`),
  ])
  return { customer: money(rowsOf<{ v: string }>(c)[0]?.v), vendor: money(rowsOf<{ v: string }>(v)[0]?.v) }
}

/** Last 7 local days (oldest first), zero-filled, net of returns. */
export async function salesLast7Days(db: Db, companyId: string, branch: BranchFilter, tz = appTimezone(), now: Date = new Date()): Promise<SalesPoint[]> {
  const today = localDate(tz, now)
  const from = addDays(today, -6)
  const rows = await salesSeries(db, companyId, branch, { from, to: today, group: 'day' })
  const byDay = new Map(rows.map((r) => [r.bucket, r.net]))
  return Array.from({ length: 7 }, (_, i) => {
    const day = addDays(from, i)
    return { day, total: byDay.get(day) ?? '0.00' }
  })
}

/** Top products by NET revenue (after returns) over the last 30 local days (today and the 29 days before it). */
export async function topProducts(db: Db, companyId: string, branch: BranchFilter, tz = appTimezone(), limit = 5, now: Date = new Date()): Promise<TopProduct[]> {
  const today = localDate(tz, now)
  const { rows } = await productProfitRows(db, companyId, branch, { from: addDays(today, -29), to: today, limit, order: 'revenue' })
  return rows.map((r) => ({ name: r.name, revenue: r.netRevenue, units: r.qtySold - r.qtyReturned }))
}

export type DashboardData = {
  salesToday: string
  salesMonth: string
  stockValue: string
  customerDue: string
  vendorDue: string
  lowStock: number
  last7: SalesPoint[]
  top: TopProduct[]
}

/** Which widget groups the viewer may see (gates both the queries and the UI). */
/** stockValue: the cost-based stock value KPI, only for profit-visibility holders (canSeeProfit); omitted = shown with inventory. */
export type DashboardScope = { sales: boolean; inventory: boolean; accounts: boolean; stockValue?: boolean }

export const emptyDashboard = (): DashboardData => ({ salesToday: '0.00', salesMonth: '0.00', stockValue: '0.00', customerDue: '0.00', vendorDue: '0.00', lowStock: 0, last7: [], top: [] })

/** Loads only what `scope` allows. Failures per group are collected, not thrown: the page degrades to zeros + a notice. */
export async function loadDashboard(companyId: string, branch: BranchFilter, scope: DashboardScope): Promise<{ data: DashboardData; failed: string[] }> {
  const db = getDb()
  const tz = appTimezone()
  const data = emptyDashboard()
  const failed: string[] = []
  const run = async (name: string, enabled: boolean, fn: () => Promise<void>) => {
    if (!enabled) return
    try {
      await fn()
    } catch (e) {
      safeLog(`[dashboard] ${name} failed`, e)
      failed.push(name)
    }
  }
  await Promise.all([
    run('sales', scope.sales, async () => {
      const [t, l7, top] = await Promise.all([salesTotals(db, companyId, branch, tz), salesLast7Days(db, companyId, branch, tz), topProducts(db, companyId, branch, tz)])
      data.salesToday = t.today
      data.salesMonth = t.month
      data.last7 = l7
      data.top = top
    }),
    run('inventory', scope.inventory, async () => {
      const [sv, low] = await Promise.all([scope.stockValue === false ? Promise.resolve('0.00') : stockValue(db, companyId, branch), lowStockCount(db, companyId, branch)])
      data.stockValue = sv
      data.lowStock = low
    }),
    run('accounts', scope.accounts, async () => {
      const d = await dues(db, companyId, branch)
      data.customerDue = d.customer
      data.vendorDue = d.vendor
    }),
  ])
  return { data, failed }
}
