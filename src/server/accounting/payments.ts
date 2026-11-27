/** Payments history: one company-scoped, filtered query shared by the page (paginated) and the CSV export (capped, ordered). */
import { and, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm'
import type { BranchFilter } from '../branch'
import { schema, rowsOf, type Db } from '../db'
import { fromMinor, toMinor } from '../money'
import { z } from 'zod'
import { likePattern } from '../pagination'
import { isIsoDate } from '../reports/pure'

export const PAYMENT_REF_TYPES = ['sale', 'purchase', 'expense', 'income', 'manual', 'transfer'] as const
export type PaymentRefType = (typeof PAYMENT_REF_TYPES)[number]

export type PaymentFilter = {
  from?: string
  to?: string
  direction?: 'in' | 'out'
  accountId?: string
  /** 'customer' | 'vendor' | 'none' (no party: expenses, incomes, transfers, walk-in sales). */
  partyType?: 'customer' | 'vendor' | 'none'
  method?: string
  refType?: PaymentRefType
  limit: number
  offset: number
}

export type PaymentRow = {
  id: string
  date: string
  direction: 'in' | 'out'
  amount: string
  accountId: string
  accountName: string
  partyType: 'customer' | 'vendor' | null
  partyId: string | null
  partyName: string | null
  refType: PaymentRefType
  refId: string | null
  refLabel: string | null
  refHref: string | null
  method: string | null
  note: string | null
  isReversal: boolean
}

function whereOf(companyId: string, branch: BranchFilter, f: PaymentFilter): SQL {
  const p = schema.payments
  return and(
    eq(p.companyId, companyId),
    branch ? eq(p.branchId, branch) : undefined,
    f.from ? gte(p.date, f.from) : undefined,
    f.to ? lte(p.date, f.to) : undefined,
    f.direction ? eq(p.direction, f.direction) : undefined,
    f.accountId ? eq(p.accountId, f.accountId) : undefined,
    f.partyType === 'none' ? sql`${p.partyType} is null` : f.partyType ? eq(p.partyType, f.partyType) : undefined,
    f.method ? ilike(p.method, likePattern(f.method)) : undefined,
    f.refType ? eq(p.refType, f.refType) : undefined,
  ) as SQL
}

/** Page of payments (newest first) + totals in/out over the WHOLE filtered set. */
export async function listPayments(db: Db, companyId: string, branch: BranchFilter, f: PaymentFilter) {
  const p = schema.payments
  const where = whereOf(companyId, branch, f)
  const res = await db.execute(sql`
    select ${p.id} as id, ${p.date}::text as date, ${p.direction} as direction, ${p.amount}::text as amount, ${p.accountId} as account_id, a.name as account_name,
      ${p.partyType} as party_type, ${p.partyId} as party_id,
      coalesce(c.name, v.name) as party_name,
      ${p.refType} as ref_type, ${p.refId} as ref_id,
      coalesce(s.invoice_no, pu.invoice_no) as ref_invoice, s.id as sale_id, pu.id as purchase_id,
      ${p.method} as method, ${p.note} as note, (${p.reversesPaymentId} is not null) as is_reversal
    from ${p}
    join ${schema.accounts} a on a.id = ${p.accountId} and a.company_id = ${companyId}
    left join ${schema.customers} c on ${p.partyType} = 'customer' and c.id = ${p.partyId} and c.company_id = ${companyId}
    left join ${schema.vendors} v on ${p.partyType} = 'vendor' and v.id = ${p.partyId} and v.company_id = ${companyId}
    left join ${schema.sales} s on ${p.refType} = 'sale' and s.id = ${p.refId} and s.company_id = ${companyId}
    left join ${schema.purchases} pu on ${p.refType} = 'purchase' and pu.id = ${p.refId} and pu.company_id = ${companyId}
    where ${where}
    order by ${p.date} desc, ${p.createdAt} desc, ${p.id} desc
    limit ${f.limit} offset ${f.offset}`)
  const rows = rowsOf<{
    id: string; date: string; direction: 'in' | 'out'; amount: string; account_id: string; account_name: string; party_type: 'customer' | 'vendor' | null; party_id: string | null; party_name: string | null
    ref_type: PaymentRefType; ref_id: string | null; ref_invoice: string | null; sale_id: string | null; purchase_id: string | null; method: string | null; note: string | null; is_reversal: boolean
  }>(res).map(
    (r): PaymentRow => ({
      id: r.id,
      date: r.date,
      direction: r.direction,
      amount: fromMinor(toMinor(r.amount)),
      accountId: r.account_id,
      accountName: r.account_name,
      partyType: r.party_type,
      partyId: r.party_id,
      partyName: r.party_name,
      refType: r.ref_type,
      refId: r.ref_id,
      refLabel: r.ref_invoice,
      refHref: r.sale_id ? `/sales/${r.sale_id}` : r.purchase_id ? `/purchases/${r.purchase_id}` : null,
      method: r.method,
      note: r.note,
      isReversal: r.is_reversal,
    }),
  )
  const [agg] = rowsOf<{ n: number; total_in: string; total_out: string }>(
    await db.execute(sql`select count(*)::int as n, coalesce(sum(${p.amount}) filter (where ${p.direction} = 'in'), 0)::text as total_in, coalesce(sum(${p.amount}) filter (where ${p.direction} = 'out'), 0)::text as total_out from ${p} where ${where}`),
  )
  return { rows, total: Number(agg?.n ?? 0), totalIn: fromMinor(toMinor(agg?.total_in ?? '0')), totalOut: fromMinor(toMinor(agg?.total_out ?? '0')) }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Untrusted URL params -> a validated filter (invalid values are dropped, never thrown). */
export function parsePaymentFilter(sp: Record<string, string | string[] | undefined>): Omit<PaymentFilter, 'limit' | 'offset'> {
  const date = (v: string | undefined) => (isIsoDate(v) ? v : undefined)
  const direction = one(sp.direction)
  const partyType = one(sp.party)
  const refType = one(sp.ref)
  const account = one(sp.account)
  const method = (one(sp.method) ?? '').trim().slice(0, 50)
  return {
    from: date(one(sp.from)),
    to: date(one(sp.to)),
    direction: direction === 'in' || direction === 'out' ? direction : undefined,
    accountId: z.uuid().safeParse(account).data,
    partyType: partyType === 'customer' || partyType === 'vendor' || partyType === 'none' ? partyType : undefined,
    method: method || undefined,
    refType: (PAYMENT_REF_TYPES as readonly string[]).includes(refType ?? '') ? (refType as PaymentRefType) : undefined,
  }
}

export const PAYMENT_CSV_COLUMNS = [
  { key: 'date', label: 'Date', kind: 'date' },
  { key: 'direction', label: 'Direction', kind: 'text' },
  { key: 'account', label: 'Account', kind: 'text' },
  { key: 'party', label: 'Party', kind: 'text' },
  { key: 'type', label: 'Type', kind: 'text' },
  { key: 'reference', label: 'Reference', kind: 'text' },
  { key: 'method', label: 'Method', kind: 'text' },
  { key: 'amount', label: 'Amount', kind: 'money' },
  { key: 'note', label: 'Note', kind: 'text' },
] as const

/** Flat CSV rows for a page of payments. Outflows are negative so a spreadsheet sum is the net movement. */
export function paymentCsvRows(rows: readonly PaymentRow[]) {
  return rows.map((r) => ({
    date: r.date,
    direction: r.direction === 'in' ? 'In' : 'Out',
    account: r.accountName,
    party: r.partyName ?? '',
    type: r.isReversal ? `${r.refType} (void)` : r.refType,
    reference: r.refLabel ?? '',
    method: r.method ?? '',
    amount: r.direction === 'in' ? r.amount : r.amount === '0.00' ? '0.00' : `-${r.amount}`,
    note: r.note ?? '',
  }))
}
