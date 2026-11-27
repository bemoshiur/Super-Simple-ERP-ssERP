/**
 * Due lists with aging. Age = today - invoice date in whole days (SQL date arithmetic; `today` is the shop-local date passed in).
 * Buckets (pure twin: reports/pure.ts agingBucket): current 0-29 days (also future-dated), 30-59, 60-89, 90+.
 * Only invoice dues (sales.due / purchases.due on non-draft, non-cancelled documents) are listed; party opening balances are not
 * invoices and have no age, so they stay on the party ledger page.
 * Branches (Task 14): invoices of one branch (the one that made them), or all branches for a null filter.
 */
import { sql } from 'drizzle-orm'
import { andBranch, type BranchFilter } from '../branch'
import { schema, rowsOf, type Db } from '../db'
import { fromMinor, toMinor } from '../money'
import { likePattern } from '../pagination'

export type AgingRow = { partyId: string | null; name: string; phone: string | null; invoices: number; current: string; d30: string; d60: string; d90: string; total: string }
export type VendorDueInvoice = { purchaseId: string; invoiceNo: string; vendorId: string; vendorName: string; date: string; ageDays: number; bucket: 'current' | '30' | '60' | '90+'; due: string }

const m = (v: unknown) => fromMinor(toMinor(String(v ?? '0')))

export type AgingTotals = { invoices: number; current: string; d30: string; d60: string; d90: string; total: string }

type Sums = { n: number; invoices: number; c0: string; c30: string; c60: string; c90: string; total: string }

/** Customers owing money, with aging buckets, oldest/largest first. Walk-in (null customer) appears as one row if it ever has a due. */
export async function customerDues(db: Db, companyId: string, branch: BranchFilter, p: { today: string; q?: string; limit: number; offset: number }) {
  const s = schema.sales
  const search = p.q ? sql`and (c.name ilike ${likePattern(p.q)} or c.phone ilike ${likePattern(p.q)})` : sql``
  const base = sql`
    from ${s} left join ${schema.customers} c on c.id = ${s.customerId} and c.company_id = ${companyId}
    where ${s.companyId} = ${companyId}${andBranch(s.branchId, branch)} and ${s.due} > 0 and ${s.status} not in ('draft','cancelled') ${search}`
  return agingQuery(db, base, sql`${s.customerId}`, sql`c.name, c.phone`, sql`${s.due}`, sql`${s.date}`, p, 'Walk-in')
}

export async function vendorDuesSummary(db: Db, companyId: string, branch: BranchFilter, p: { today: string; q?: string; limit: number; offset: number }) {
  const s = schema.purchases
  const search = p.q ? sql`and (c.name ilike ${likePattern(p.q)} or c.phone ilike ${likePattern(p.q)})` : sql``
  const base = sql`
    from ${s} left join ${schema.vendors} c on c.id = ${s.vendorId} and c.company_id = ${companyId}
    where ${s.companyId} = ${companyId}${andBranch(s.branchId, branch)} and ${s.due} > 0 and ${s.status} not in ('draft','cancelled') ${search}`
  return agingQuery(db, base, sql`${s.vendorId}`, sql`c.name, c.phone`, sql`${s.due}`, sql`${s.date}`, p, 'Unknown vendor')
}

async function agingQuery(db: Db, base: ReturnType<typeof sql>, partyCol: ReturnType<typeof sql>, nameCols: ReturnType<typeof sql>, dueCol: ReturnType<typeof sql>, dateCol: ReturnType<typeof sql>, p: { today: string; limit: number; offset: number }, fallbackName: string) {
  const age = sql`(${p.today}::date - ${dateCol}::date)`
  const rows = rowsOf<{ party_id: string | null; name: string | null; phone: string | null; invoices: number; c0: string; c30: string; c60: string; c90: string; total: string }>(
    await db.execute(sql`
      select ${partyCol} as party_id, ${nameCols}, count(*)::int as invoices,
        coalesce(sum(${dueCol}) filter (where ${age} < 30), 0)::text as c0,
        coalesce(sum(${dueCol}) filter (where ${age} >= 30 and ${age} < 60), 0)::text as c30,
        coalesce(sum(${dueCol}) filter (where ${age} >= 60 and ${age} < 90), 0)::text as c60,
        coalesce(sum(${dueCol}) filter (where ${age} >= 90), 0)::text as c90,
        sum(${dueCol})::text as total
      ${base}
      group by ${partyCol}, ${nameCols}
      order by sum(${dueCol}) desc, c.name
      limit ${p.limit} offset ${p.offset}`),
  )
  const [t] = rowsOf<Sums>(
    await db.execute(sql`
      select count(distinct coalesce(${partyCol}::text, 'walkin'))::int as n, count(*)::int as invoices,
        coalesce(sum(${dueCol}) filter (where ${age} < 30), 0)::text as c0,
        coalesce(sum(${dueCol}) filter (where ${age} >= 30 and ${age} < 60), 0)::text as c30,
        coalesce(sum(${dueCol}) filter (where ${age} >= 60 and ${age} < 90), 0)::text as c60,
        coalesce(sum(${dueCol}) filter (where ${age} >= 90), 0)::text as c90,
        coalesce(sum(${dueCol}), 0)::text as total
      ${base}`),
  )
  const out: AgingRow[] = rows.map((r) => ({ partyId: r.party_id, name: r.name ?? fallbackName, phone: r.phone, invoices: Number(r.invoices), current: m(r.c0), d30: m(r.c30), d60: m(r.c60), d90: m(r.c90), total: m(r.total) }))
  const totals: AgingTotals = { invoices: Number(t?.invoices ?? 0), current: m(t?.c0), d30: m(t?.c30), d60: m(t?.c60), d90: m(t?.c90), total: m(t?.total) }
  return { rows: out, count: Number(t?.n ?? 0), totals }
}

/** Open vendor invoices (oldest first) with age: the unit a vendor payment is made against (recordVendorPayment is per invoice). */
export async function vendorDueInvoices(db: Db, companyId: string, branch: BranchFilter, p: { today: string; q?: string; limit: number; offset: number }) {
  const s = schema.purchases
  const search = p.q ? sql`and (v.name ilike ${likePattern(p.q)} or ${s.invoiceNo} ilike ${likePattern(p.q)})` : sql``
  const where = sql`${s.companyId} = ${companyId}${andBranch(s.branchId, branch)} and ${s.due} > 0 and ${s.status} not in ('draft','cancelled') ${search}`
  const rows = rowsOf<{ id: string; invoice_no: string; vendor_id: string; vendor_name: string; date: string; age: number; due: string }>(
    await db.execute(sql`
      select ${s.id} as id, ${s.invoiceNo} as invoice_no, ${s.vendorId} as vendor_id, v.name as vendor_name, ${s.date}::text as date, (${p.today}::date - ${s.date}::date)::int as age, ${s.due}::text as due
      from ${s} join ${schema.vendors} v on v.id = ${s.vendorId} and v.company_id = ${companyId}
      where ${where}
      order by ${s.date}, ${s.createdAt}, ${s.id}
      limit ${p.limit} offset ${p.offset}`),
  )
  const [n] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ${s} join ${schema.vendors} v on v.id = ${s.vendorId} and v.company_id = ${companyId} where ${where}`))
  const out: VendorDueInvoice[] = rows.map((r) => {
    const age = Number(r.age)
    return { purchaseId: r.id, invoiceNo: r.invoice_no, vendorId: r.vendor_id, vendorName: r.vendor_name, date: r.date, ageDays: age, bucket: age >= 90 ? '90+' : age >= 60 ? '60' : age >= 30 ? '30' : 'current', due: m(r.due) }
  })
  return { rows: out, count: Number(n?.n ?? 0) }
}
