'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getRecordHistory, historyPermission } from '../activity/activity'
import { historyRows, type DiffRow } from '../activity/diff'
import { appTimezone, formatLocalDateTime } from '../dates'
import { getDb, schema } from '../db'
import { seesCompanyWide } from '../branch'
import { NotFoundError, PolicyError } from '../errors'
import { canSeeProfit } from '../lookup/lookup'
import { guardedBranch, type ActionResult } from './guard'

/** Branch-owned records: a user restricted to one branch only reads the history of its own branch's documents. */
const BRANCH_OWNED = { sale: schema.sales, purchase: schema.purchases, expense: schema.expenses, income: schema.incomes } as const

export type HistoryItem = { id: string; at: string; by: string; rows: DiffRow[] }

/**
 * History drawer loader. The permission is the one that shows the record itself (e.g. vendors.view for a vendor);
 * entities without a mapping are refused before anything is read. Company-scoped by the session.
 */
export async function getRecordHistoryAction(entity: string, id: string): Promise<ActionResult<HistoryItem[]>> {
  const perm = typeof entity === 'string' ? historyPermission(entity) : null
  if (!perm) return { ok: false, error: 'History is not available for this record.' }
  return guardedBranch(perm, async (s, b) => {
    const recordId = z.string().min(1).max(64).parse(id)
    const db = getDb()
    // Shared (company-wide) records' history spans every branch: in a multi-branch company it needs branches.all.
    if (!Object.hasOwn(BRANCH_OWNED, entity) && !seesCompanyWide(b)) throw new PolicyError('This history covers every branch; it needs the "All branches" permission.')
    if (b.restrict && Object.hasOwn(BRANCH_OWNED, entity)) {
      const t = BRANCH_OWNED[entity as keyof typeof BRANCH_OWNED]
      const ok = z.uuid().safeParse(recordId).success ? await db.select({ id: t.id }).from(t).where(and(eq(t.id, recordId), eq(t.companyId, s.cid), eq(t.branchId, b.restrict))) : []
      if (!ok.length) throw new NotFoundError('Record')
    }
    const rows = await getRecordHistory(db, s.cid, entity, recordId)
    const tz = appTimezone()
    // Product history carries per-branch on-hand changes (adjustments): hidden from users restricted to one branch.
    // The list purchase price is cost information: hidden without profit visibility (same rule as /products and /stock).
    const hide = new Set<string>()
    if (entity === 'product' && b.restrict && b.multi) hide.add('onHand')
    if (entity === 'product' && !canSeeProfit(s)) hide.add('purchasePrice')
    const clean = (diff: unknown) => (hide.size && diff && typeof diff === 'object' ? Object.fromEntries(Object.entries(diff).filter(([k]) => !hide.has(k))) : diff)
    return rows.map((r) => ({ id: r.id, at: formatLocalDateTime(r.createdAt, tz), by: r.changedByName ?? 'System', rows: historyRows(clean(r.diff)) })).filter((r) => r.rows.length > 0)
  })
}
