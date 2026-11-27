import { and, eq, notInArray, sql } from 'drizzle-orm'
import { andBranch, type BranchFilter } from '../branch'
import { schema, rowsOf, type Db } from '../db'
import { fromMinor, toMinor } from '../money'
import type { PartyKind } from './parties'

export type Ledger = {
  /** Opening balance as entered (positive = they owe us for customers / we owe them for vendors). */
  opening: string
  /** Total invoiced: purchases (vendor) or sales (customer), excluding drafts and cancelled documents. */
  billed: string
  /** Credit from returns (vendor: purchase returns; customer: sale returns). */
  returned: string
  /** Net settled via payments. Vendor: paid out minus refunds received back. Customer: received minus refunds paid out. */
  paid: string
  /** opening + billed - returned - paid. Positive: outstanding. Negative: advance/credit balance. */
  due: string
  documents: number
}

/** Pure ledger arithmetic on exact minor units. Inputs are numeric strings (or null from SQL). */
export function computeLedger(p: { opening: string | null; billed: string | null; returned?: string | null; paid: string | null; documents?: number }): Ledger {
  const opening = toMinor(p.opening ?? '0')
  const billed = toMinor(p.billed ?? '0')
  const returned = toMinor(p.returned ?? '0')
  const paid = toMinor(p.paid ?? '0')
  return { opening: fromMinor(opening), billed: fromMinor(billed), returned: fromMinor(returned), paid: fromMinor(paid), due: fromMinor(opening + billed - returned - paid), documents: p.documents ?? 0 }
}

const INACTIVE_DOCS = ['draft', 'cancelled'] as const

/**
 * Ledger summary for one party, computed with SQL aggregation and scoped by company_id.
 * Payments count when they name the party directly OR reference one of the party's documents, so a row is never counted twice.
 * Vendor: billed = purchase totals, returned = purchases.returned_total (purchase-return credit), paid = payments out
 * minus refunds in (direction 'in'). So due = opening + billed - returned - (out - in); a negative due is vendor credit.
 * Customer: billed = sale totals, returned = sales.returned_total (customer-return credit), paid = payments in minus
 * refunds out (direction 'out'). So due = opening + billed - returned - (in - out).
 * Caller must have verified the party belongs to `companyId` (getParty) before calling.
 *
 * Branches (Task 14): with a branch, documents of that branch; payments that reference one of them, or name the party
 * without a document and were recorded at that branch. The party's opening balance belongs to the company's default
 * (Main) branch, so the per-branch ledgers add up to the all-branches ledger.
 */
export async function getLedger(db: Db, companyId: string, branch: BranchFilter, kind: PartyKind, partyId: string): Promise<Ledger> {
  const pay = schema.payments
  const withOpening = branch
    ? rowsOf<{ d: boolean }>(await db.execute(sql`select ${schema.branches.isDefault} as d from ${schema.branches} where ${schema.branches.id} = ${branch} and ${schema.branches.companyId} = ${companyId}`))[0]?.d === true
    : true
  if (kind === 'vendor') {
    const pu = schema.purchases
    const [bill] = await db
      .select({ total: sql<string>`coalesce(sum(${pu.total}), 0)::text`, returned: sql<string>`coalesce(sum(${pu.returnedTotal}), 0)::text`, n: sql<number>`count(*)::int` })
      .from(pu)
      .where(and(eq(pu.companyId, companyId), branch ? eq(pu.branchId, branch) : undefined, eq(pu.vendorId, partyId), notInArray(pu.status, [...INACTIVE_DOCS])))
    const [paid] = await db
      .select({ total: sql<string>`coalesce(sum(case when ${pay.direction} = 'out' then ${pay.amount} else -${pay.amount} end), 0)::text` })
      .from(pay)
      .where(
        and(
          eq(pay.companyId, companyId),
          branch
            ? sql`(${pay.refType} = 'purchase' and ${pay.refId} in (select ${pu.id} from ${pu} where ${pu.companyId} = ${companyId} and ${pu.vendorId} = ${partyId}${andBranch(pu.branchId, branch)})
                or ${pay.partyType} = 'vendor' and ${pay.partyId} = ${partyId} and ${pay.refType} <> 'purchase'${andBranch(pay.branchId, branch)})`
            : sql`(${pay.partyType} = 'vendor' and ${pay.partyId} = ${partyId} or ${pay.refType} = 'purchase' and ${pay.refId} in (select ${pu.id} from ${pu} where ${pu.companyId} = ${companyId} and ${pu.vendorId} = ${partyId}))`,
        ),
      )
    const [v] = await db.select({ ob: schema.vendors.openingBalance }).from(schema.vendors).where(and(eq(schema.vendors.id, partyId), eq(schema.vendors.companyId, companyId)))
    return computeLedger({ opening: withOpening ? (v?.ob ?? '0') : '0', billed: bill.total, returned: bill.returned, paid: paid.total, documents: bill.n })
  }
  const sa = schema.sales
  const [bill] = await db
    .select({ total: sql<string>`coalesce(sum(${sa.total}), 0)::text`, returned: sql<string>`coalesce(sum(${sa.returnedTotal}), 0)::text`, n: sql<number>`count(*)::int` })
    .from(sa)
    .where(and(eq(sa.companyId, companyId), branch ? eq(sa.branchId, branch) : undefined, eq(sa.customerId, partyId), notInArray(sa.status, [...INACTIVE_DOCS])))
  const [paid] = await db
    .select({ total: sql<string>`coalesce(sum(case when ${pay.direction} = 'in' then ${pay.amount} else -${pay.amount} end), 0)::text` })
    .from(pay)
    .where(
      and(
        eq(pay.companyId, companyId),
        branch
          ? sql`(${pay.refType} = 'sale' and ${pay.refId} in (select ${sa.id} from ${sa} where ${sa.companyId} = ${companyId} and ${sa.customerId} = ${partyId}${andBranch(sa.branchId, branch)})
              or ${pay.partyType} = 'customer' and ${pay.partyId} = ${partyId} and ${pay.refType} <> 'sale'${andBranch(pay.branchId, branch)})`
          : sql`(${pay.partyType} = 'customer' and ${pay.partyId} = ${partyId} or ${pay.refType} = 'sale' and ${pay.refId} in (select ${sa.id} from ${sa} where ${sa.companyId} = ${companyId} and ${sa.customerId} = ${partyId}))`,
      ),
    )
  const [c] = await db.select({ ob: schema.customers.openingBalance }).from(schema.customers).where(and(eq(schema.customers.id, partyId), eq(schema.customers.companyId, companyId)))
  return computeLedger({ opening: withOpening ? (c?.ob ?? '0') : '0', billed: bill.total, returned: bill.returned, paid: paid.total, documents: bill.n })
}

