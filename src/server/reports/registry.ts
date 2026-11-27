/**
 * Report registry: one table drives the hub page, the report page, the CSV route and the permission checks, so every report is
 * authorised and company-scoped the same way. The caller passes the SESSION (companyId never comes from the client) and the
 * branch filter from branchScope(session) (Task 14: one branch, or null for all branches; never a raw URL value).
 */
import { z } from 'zod'
import type { BranchFilter } from '../branch'
import { appTimezone, localDate } from '../dates'
import type { Db } from '../db'
import { canSeeProfit } from '../lookup/lookup'
import { ForbiddenError, can, type Permission, type PermissionSubject } from '../rbac'
import { cashFlowReport } from './cashflow'
import { CSV_BOM, csvCell, toCsv, toCsvLines, type CsvColumn } from './csv'
import { productProfitReport, profitLossReport } from './profit'
import { parseGroup, parseRange, parseWarrantyDays } from './pure'
import { customerSalesReport, purchaseReport, salesReport, vendorPurchasesReport } from './sales'
import { lowStockReport, stockReport } from './stock'
import { SCREEN_ROW_CAP, type ReportContext, type ReportParams, type ReportResult } from './types'
import { warrantyReport } from './warranty'

export type FilterKey = 'range' | 'group' | 'customer' | 'vendor' | 'product' | 'category' | 'days'
export type ReportDef = {
  key: string
  title: string
  description: string
  icon: string
  filters: FilterKey[]
  /** Whole report is cost/profit: only for PROFIT_PERMISSIONS holders. */
  profitOnly?: boolean
  /** Extra permissions on top of reports.view: the report exposes data owned by another module (accounts, payments). */
  requires?: Permission[]
  run: (ctx: ReportContext, p: ReportParams) => Promise<ReportResult>
}

export const REPORTS: readonly ReportDef[] = [
  { key: 'sales', title: 'Sales report', description: 'Daily, weekly or monthly sales net of returns.', icon: 'receipt', filters: ['range', 'group', 'customer'], run: salesReport },
  { key: 'purchases', title: 'Purchase report', description: 'Daily, weekly or monthly purchases net of returns.', icon: 'shopping-cart', filters: ['range', 'group', 'vendor'], run: purchaseReport },
  { key: 'stock', title: 'Stock report', description: 'Serial counts by status, quantity on hand and valuation at cost.', icon: 'package', filters: ['category', 'product'], run: stockReport },
  { key: 'low-stock', title: 'Low-stock alerts', description: 'Products at or below their low-stock threshold.', icon: 'triangle-alert', filters: ['category', 'product'], run: lowStockReport },
  { key: 'product-profit', title: 'Product-wise profit', description: 'Revenue, cost and profit per product, net of returns.', icon: 'trending-up', filters: ['range', 'product', 'category', 'customer'], profitOnly: true, run: productProfitReport },
  { key: 'customer-sales', title: 'Customer-wise sales', description: 'What each customer bought, returned, paid and still owes.', icon: 'users', filters: ['range', 'customer'], run: customerSalesReport },
  { key: 'vendor-purchases', title: 'Vendor-wise purchases', description: 'What you bought from each vendor, returned, paid and still owe.', icon: 'truck', filters: ['range', 'vendor'], run: vendorPurchasesReport },
  { key: 'warranty', title: 'Warranty expiry', description: 'Sold units whose warranty ends in the next 30, 60 or 90 days.', icon: 'shield-check', filters: ['days'], run: warrantyReport },
  { key: 'profit-loss', title: 'Profit & loss', description: 'Revenue, cost of goods sold, expenses and other income for a period.', icon: 'scale', filters: ['range'], profitOnly: true, requires: ['accounts.view'], run: profitLossReport },
  { key: 'cash-flow', title: 'Cash flow', description: 'Opening, inflows, outflows and closing balance per account.', icon: 'banknote', filters: ['range'], requires: ['accounts.view'], run: cashFlowReport },
]

/** May this viewer open the report? reports.view plus the report's own extra permissions. */
export const canOpenReport = (viewer: PermissionSubject, def: ReportDef): boolean => can(viewer, 'reports.view') && (def.requires ?? []).every((k) => can(viewer, k)) && (!def.profitOnly || canSeeProfit(viewer))

export const reportByKey = (key: string): ReportDef | undefined => REPORTS.find((r) => r.key === key)

const uuid = z.uuid()
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Untrusted URL params -> ReportParams. Invalid dates/ids fall back to defaults / are dropped; never throws. */
export function parseReportParams(sp: Record<string, string | string[] | undefined>, today: string): ReportParams {
  const { from, to } = parseRange({ from: one(sp.from), to: one(sp.to) }, today)
  const id = (k: string) => uuid.safeParse(one(sp[k])).data
  return { from, to, group: parseGroup(one(sp.group)), customerId: id('customer'), vendorId: id('vendor'), productId: id('product'), categoryId: id('category'), days: parseWarrantyDays(one(sp.days)) }
}

export type Viewer = NonNullable<PermissionSubject> & { cid: string }

/**
 * Authorise and run a report. reports.view is required for every report; profit-only reports additionally need
 * PROFIT_PERMISSIONS (reports.view already is one, so in practice any reports.view holder; the check stays so the rule lives in one place).
 * Cost/profit columns are removed from the result server-side for viewers who may not see profit.
 */
export async function runReport(db: Db, viewer: Viewer, branch: BranchFilter, key: string, sp: Record<string, string | string[] | undefined>, opts: { limit?: number; now?: Date } = {}): Promise<{ def: ReportDef; params: ReportParams; result: ReportResult }> {
  if (!can(viewer, 'reports.view')) throw new ForbiddenError('reports.view')
  const def = reportByKey(key)
  if (!def) throw new Error(`Unknown report ${key}`)
  const profit = canSeeProfit(viewer)
  if (def.profitOnly && !profit) throw new ForbiddenError('reports.view')
  for (const k of def.requires ?? []) if (!can(viewer, k)) throw new ForbiddenError(k)
  const today = localDate(appTimezone(), opts.now ?? new Date())
  const params = parseReportParams(sp, today)
  const ctx: ReportContext = { db, companyId: viewer.cid, branch, today, canSeeProfit: profit, limit: opts.limit ?? SCREEN_ROW_CAP }
  const result = await def.run(ctx, params)
  return { def, params, result: profit ? result : stripSensitive(result) }
}

export function stripSensitive(r: ReportResult): ReportResult {
  return {
    ...r,
    tables: r.tables.map((t) => {
      const hidden = new Set(t.columns.filter((c) => c.sensitive).map((c) => c.key))
      if (!hidden.size) return t
      const clean = <T extends Record<string, unknown>>(row: T) => Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k))) as T
      return { ...t, columns: t.columns.filter((c) => !hidden.has(c.key)), rows: t.rows.map(clean), totals: t.totals ? clean(t.totals) : undefined }
    }),
  }
}


/** The CSV document of a report: single table = plain CSV; several tables = title row, table, blank row, ... Totals become a last row. */
export function reportToCsv(r: ReportResult): string {
  if (r.tables.length === 1) {
    const t = r.tables[0]
    return withNotes(toCsv(t.columns as CsvColumn[], t.totals ? [...t.rows, t.totals] : t.rows), r)
  }
  const out: string[] = []
  r.tables.forEach((t, i) => {
    if (i > 0) out.push('')
    if (t.title) out.push(toCsvLines([{ key: 't', label: t.title }], []).join(''))
    out.push(...toCsvLines(t.columns as CsvColumn[], t.totals ? [...t.rows, t.totals] : t.rows))
  })
  return withNotes(CSV_BOM + out.join('\r\n') + '\r\n', r)
}

/** Append the report's export notes (reconciliation result etc.) as trailing rows. */
function withNotes(csv: string, r: ReportResult): string {
  if (!r.exportNotes?.length) return csv
  return csv + r.exportNotes.map((n) => csvCell(n)).join('\r\n') + '\r\n'
}

/** `sales_2026-11-01_2026-11-30.csv` style file name (ASCII only). */
export function reportFileName(key: string, p: ReportParams, withRange: boolean): string {
  return `${key}${withRange ? `_${p.from}_${p.to}` : ''}.csv`
}
