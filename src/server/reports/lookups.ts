import { and, asc, eq, ilike, or } from 'drizzle-orm'
import { schema, type Db } from '../db'
import { likePattern } from '../pagination'

/** Product picker for report filters (any product, active or not, because history may involve retired ones). Company scoped, max 20. */
export async function searchProductsForReport(db: Db, companyId: string, q: string) {
  const p = schema.products
  const term = q.trim().slice(0, 100)
  const rows = await db
    .select({ id: p.id, name: p.name, sku: p.sku })
    .from(p)
    .where(and(eq(p.companyId, companyId), term ? or(ilike(p.name, likePattern(term)), ilike(p.sku, likePattern(term))) : undefined))
    .orderBy(asc(p.name))
    .limit(20)
  return rows.map((r) => ({ value: r.id, label: r.name, description: r.sku }))
}
