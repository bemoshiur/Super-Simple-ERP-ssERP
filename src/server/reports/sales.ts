/**
 * Sales / purchase / customer-wise / vendor-wise reports. All SQL aggregation, all company-scoped.
 * Definitions (shared with the P&L and the dashboard):
 *   sales        = invoices on non-draft, non-cancelled sales, by sales.date (fully returned sales stay: their return nets them out)
 *   returns      = sale_returns.credit_total by the RETURN's own date (value of goods returned)
 *   net sales    = sales - returns
 * Purchases mirror this with purchase_returns.credit_total.
 * Branches (Task 14): documents by their own branch_id (an invoice by the branch that made it, a return by the branch that
 * took it), so the per-branch series always add up to the all-branches series.
 */
import { sql, type SQL } from 'drizzle-orm'
import { andBranch, type BranchFilter } from '../branch'
import { schema, rowsOf } from '../db'
import { fromMinor, toMinor } from '../money'
import { WEEK_START, bucketLabel, type Group } from './pure'
import type { ReportContext, ReportParams, ReportResult, Reader } from './types'

const m = (v: unknown): string => fromMinor(toMinor(String(v ?? '0')))

/** SQL for the first date of the day/week/month bucket of a DATE column. Twin of pure bucketStart(). */
export function bucketSql(col: SQL, group: Group): SQL {
  if (group === 'day') return sql`${col}`
  if (group === 'month') return sql`date_trunc('month', ${col}::timestamp)::date`
  return sql`(${col} - ((extract(dow from ${col})::int - ${WEEK_START} + 7) % 7))`
}

export type SeriesRow = { bucket: string; invoices: number; gross: string; discounts: string; sales: string; returns: string; net: string }

async function series(db: Reader, kind: 'sales' | 'purchases', companyId: string, branch: BranchFilter, p: { from: string; to: string; group: Group; partyId?: string }): Promise<SeriesRow[]> {
  const doc = kind === 'sales' ? schema.sales : schema.purchases
  const ret = kind === 'sales' ? schema.saleReturns : schema.purchaseReturns
  const docParty = kind === 'sales' ? schema.sales.customerId : schema.purchases.vendorId
  const retParty = kind === 'sales' ? schema.saleReturns.customerId : schema.purchaseReturns.vendorId
  const docB = bucketSql(sql`${doc.date}`, p.group)
  const retB = bucketSql(sql`${ret.date}`, p.group)
  const res = await db.execute(sql`
    with d as (
      select ${docB} as b, count(*)::int as n, sum(${doc.subtotal}) as gross, sum(${doc.discount}) as disc, sum(${doc.total}) as total
      from ${doc}
      where ${doc.companyId} = ${companyId}${andBranch(doc.branchId, branch)} and ${doc.status} not in ('draft','cancelled') and ${doc.date} between ${p.from} and ${p.to}
        ${p.partyId ? sql`and ${docParty} = ${p.partyId}` : sql``}
      group by 1
    ), r as (
      select ${retB} as b, sum(${ret.creditTotal}) as credit
      from ${ret}
      where ${ret.companyId} = ${companyId}${andBranch(ret.branchId, branch)} and ${ret.date} between ${p.from} and ${p.to}
        ${p.partyId ? sql`and ${retParty} = ${p.partyId}` : sql``}
      group by 1
    )
    select to_char(coalesce(d.b, r.b), 'YYYY-MM-DD') as bucket, coalesce(d.n, 0) as n, coalesce(d.gross, 0)::text as gross, coalesce(d.disc, 0)::text as disc,
      coalesce(d.total, 0)::text as total, coalesce(r.credit, 0)::text as credit, (coalesce(d.total, 0) - coalesce(r.credit, 0))::text as net
    from d full join r on d.b = r.b
    order by coalesce(d.b, r.b)`)
  return rowsOf<{ bucket: string; n: number; gross: string; disc: string; total: string; credit: string; net: string }>(res).map((r) => ({ bucket: r.bucket, invoices: Number(r.n), gross: m(r.gross), discounts: m(r.disc), sales: m(r.total), returns: m(r.credit), net: m(r.net) }))
}

/** Sales per day/week/month (net of returns). Also the engine behind the dashboard KPIs and charts. */
export const salesSeries = (db: Reader, companyId: string, branch: BranchFilter, p: { from: string; to: string; group: Group; customerId?: string }) => series(db, 'sales', companyId, branch, { ...p, partyId: p.customerId })
export const purchaseSeries = (db: Reader, companyId: string, branch: BranchFilter, p: { from: string; to: string; group: Group; vendorId?: string }) => series(db, 'purchases', companyId, branch, { ...p, partyId: p.vendorId })

const sumSeries = (rows: SeriesRow[]) => {
  const t = (k: 'gross' | 'discounts' | 'sales' | 'returns' | 'net') => fromMinor(rows.reduce((a, r) => a + toMinor(r[k]), 0))
  return { invoices: rows.reduce((a, r) => a + r.invoices, 0), gross: t('gross'), discounts: t('discounts'), sales: t('sales'), returns: t('returns'), net: t('net') }
}

function seriesReport(key: string, title: string, noun: string, rows: SeriesRow[], p: ReportParams): ReportResult {
  const t = sumSeries(rows)
  return {
    key,
    title,
    from: p.from,
    to: p.to,
    truncated: false,
    notes: [`${noun} are grouped by ${p.group === 'week' ? 'week (Saturday to Friday)' : p.group}. Returns are counted on the date of the return, not the original invoice date. Net = ${noun.toLowerCase()} minus returns.`],
    tables: [
      {
        columns: [
          { key: 'period', label: p.group === 'day' ? 'Date' : p.group === 'week' ? 'Week' : 'Month', kind: 'text' },
          { key: 'invoices', label: 'Invoices', kind: 'int' },
          { key: 'gross', label: 'Gross', kind: 'money' },
          { key: 'discounts', label: 'Discounts', kind: 'money' },
          { key: 'sales', label: noun, kind: 'money' },
          { key: 'returns', label: 'Returns', kind: 'money' },
          { key: 'net', label: `Net ${noun.toLowerCase()}`, kind: 'money' },
        ],
        rows: rows.map((r) => ({ period: bucketLabel(r.bucket, p.group), invoices: r.invoices, gross: r.gross, discounts: r.discounts, sales: r.sales, returns: r.returns, net: r.net })),
        totals: { period: 'Total', invoices: t.invoices, gross: t.gross, discounts: t.discounts, sales: t.sales, returns: t.returns, net: t.net },
      },
    ],
  }
}

export async function salesReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  return seriesReport('sales', 'Sales report', 'Sales', await salesSeries(ctx.db, ctx.companyId, ctx.branch, p), p)
}
export async function purchaseReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  return seriesReport('purchases', 'Purchase report', 'Purchases', await purchaseSeries(ctx.db, ctx.companyId, ctx.branch, p), p)
}

// ------------------------------------------------------------------ party-wise

type PartyTotals = { invoices: number; total: string; returns: string; net: string; paid: string; due: string }
type PartyRow = { id: string | null; name: string; phone: string | null; invoices: number; total: string; returns: string; net: string; paid: string; due: string }

async function partyWise(ctx: ReportContext, kind: 'sales' | 'purchases', p: ReportParams): Promise<{ rows: PartyRow[]; truncated: boolean; totals: PartyTotals }> {
  const doc = kind === 'sales' ? schema.sales : schema.purchases
  const ret = kind === 'sales' ? schema.saleReturns : schema.purchaseReturns
  const docParty = kind === 'sales' ? schema.sales.customerId : schema.purchases.vendorId
  const retParty = kind === 'sales' ? schema.saleReturns.customerId : schema.purchaseReturns.vendorId
  const partyTable = kind === 'sales' ? schema.customers : schema.vendors
  const partyId = kind === 'sales' ? p.customerId : p.vendorId
  const cte = sql`
    with d as (
      select coalesce(${docParty}, '00000000-0000-0000-0000-000000000000'::uuid) as party, count(*)::int as n, sum(${doc.total}) as total, sum(${doc.paid}) as paid, sum(${doc.due}) as due
      from ${doc}
      where ${doc.companyId} = ${ctx.companyId}${andBranch(doc.branchId, ctx.branch)} and ${doc.status} not in ('draft','cancelled') and ${doc.date} between ${p.from} and ${p.to}
        ${partyId ? sql`and ${docParty} = ${partyId}` : sql``}
      group by 1
    ), r as (
      select coalesce(${retParty}, '00000000-0000-0000-0000-000000000000'::uuid) as party, sum(${ret.creditTotal}) as credit
      from ${ret}
      where ${ret.companyId} = ${ctx.companyId}${andBranch(ret.branchId, ctx.branch)} and ${ret.date} between ${p.from} and ${p.to}
        ${partyId ? sql`and ${retParty} = ${partyId}` : sql``}
      group by 1
    ), j as (
      select coalesce(d.party, r.party) as party, coalesce(d.n, 0) as n, coalesce(d.total, 0) as total, coalesce(r.credit, 0) as credit, coalesce(d.paid, 0) as paid, coalesce(d.due, 0) as due
      from d full join r on d.party = r.party
    )`
  const res = await ctx.db.execute(sql`${cte}
    select nullif(j.party, '00000000-0000-0000-0000-000000000000'::uuid) as id, pt.name, pt.phone, j.n, j.total::text as total, j.credit::text as credit, (j.total - j.credit)::text as net, j.paid::text as paid, j.due::text as due
    from j left join ${partyTable} pt on pt.id = j.party and pt.company_id = ${ctx.companyId}
    order by (j.total - j.credit) desc, pt.name
    limit ${ctx.limit + 1}`)
  const all = rowsOf<{ id: string | null; name: string | null; phone: string | null; n: number; total: string; credit: string; net: string; paid: string; due: string }>(res)
  const truncated = all.length > ctx.limit
  // Totals over EVERY party in the period (SQL), not just the rows shown.
  const [t] = rowsOf<{ n: string; total: string; credit: string; paid: string; due: string }>(
    await ctx.db.execute(sql`${cte} select coalesce(sum(j.n), 0)::text as n, coalesce(sum(j.total), 0)::text as total, coalesce(sum(j.credit), 0)::text as credit, coalesce(sum(j.paid), 0)::text as paid, coalesce(sum(j.due), 0)::text as due from j`),
  )
  const total = toMinor(m(t?.total))
  const credit = toMinor(m(t?.credit))
  const totals: PartyTotals = { invoices: Number(t?.n ?? 0), total: fromMinor(total), returns: fromMinor(credit), net: fromMinor(total - credit), paid: m(t?.paid), due: m(t?.due) }
  return {
    truncated,
    totals,
    rows: all.slice(0, ctx.limit).map((r) => ({ id: r.id, name: r.name ?? (kind === 'sales' ? 'Walk-in' : 'Unknown vendor'), phone: r.phone, invoices: Number(r.n), total: m(r.total), returns: m(r.credit), net: m(r.net), paid: m(r.paid), due: m(r.due) })),
  }
}

function partyReport(key: string, title: string, label: string, noun: string, base: string, rows: PartyRow[], truncated: boolean, tt: PartyTotals, p: ReportParams): ReportResult {
  return {
    key,
    title,
    from: p.from,
    to: p.to,
    truncated,
    notes: [`Paid and due are the current settlement of the invoices dated in this period. Returns are counted on the return date. Net = ${noun.toLowerCase()} minus returns.`],
    tables: [
      {
        columns: [
          { key: 'name', label, kind: 'text' },
          { key: 'phone', label: 'Phone', kind: 'text' },
          { key: 'invoices', label: 'Invoices', kind: 'int' },
          { key: 'total', label: noun, kind: 'money' },
          { key: 'returns', label: 'Returns', kind: 'money' },
          { key: 'net', label: 'Net', kind: 'money' },
          { key: 'paid', label: 'Paid', kind: 'money' },
          { key: 'due', label: 'Due', kind: 'money' },
        ],
        rows: rows.map((r) => ({ name: r.name, phone: r.phone, invoices: r.invoices, total: r.total, returns: r.returns, net: r.net, paid: r.paid, due: r.due, _href: r.id ? `${base}/${r.id}` : null })),
        totals: { name: 'Total', phone: null, ...tt },
      },
    ],
  }
}

export async function customerSalesReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const { rows, truncated, totals } = await partyWise(ctx, 'sales', p)
  return partyReport('customer-sales', 'Customer-wise sales', 'Customer', 'Sales', '/customers', rows, truncated, totals, p)
}
export async function vendorPurchasesReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const { rows, truncated, totals } = await partyWise(ctx, 'purchases', p)
  return partyReport('vendor-purchases', 'Vendor-wise purchases', 'Vendor', 'Purchases', '/vendors', rows, truncated, totals, p)
}
