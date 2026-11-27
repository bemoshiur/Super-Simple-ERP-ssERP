import { and, asc, count, eq, ilike, inArray } from 'drizzle-orm'
import { logActivity } from '../audit'
import { schema, type Db } from '../db'
import { FieldErrors, NotFoundError, isUniqueViolation } from '../errors'
import { likePattern } from '../pagination'
import { taxonSchema } from './schemas'

export type TaxonKind = 'category' | 'brand'
const LABEL: Record<TaxonKind, string> = { category: 'category', brand: 'brand' }
const UQ: Record<TaxonKind, string> = { category: 'categories_company_name_uq', brand: 'brands_company_name_uq' }

// categories and brands have identical columns; one cast lets the code below stay generic.
const tableOf = (kind: TaxonKind) => (kind === 'category' ? schema.categories : schema.brands) as typeof schema.categories

export type TaxonRow = typeof schema.categories.$inferSelect
export type TaxonStatus = 'active' | 'inactive' | 'all'

const dupMessage = (kind: TaxonKind) => `A ${LABEL[kind]} with this name already exists (it may be deactivated).`

export async function listTaxa(db: Db, companyId: string, kind: TaxonKind, p: { q?: string; status?: TaxonStatus; limit: number; offset: number }) {
  const t = tableOf(kind)
  const where = and(eq(t.companyId, companyId), p.q ? ilike(t.name, likePattern(p.q)) : undefined, p.status === 'inactive' ? eq(t.active, false) : p.status === 'all' ? undefined : eq(t.active, true))
  const [rows, [{ n }]] = await Promise.all([db.select().from(t).where(where).orderBy(asc(t.name)).limit(p.limit).offset(p.offset), db.select({ n: count() }).from(t).where(where)])
  return { rows, total: Number(n) }
}

/** Picker loader: active rows only, hard-capped at 20. */
export async function searchTaxa(db: Db, companyId: string, kind: TaxonKind, q: string, limit = 20) {
  const t = tableOf(kind)
  const rows = await db
    .select({ id: t.id, name: t.name })
    .from(t)
    .where(and(eq(t.companyId, companyId), eq(t.active, true), q ? ilike(t.name, likePattern(q.slice(0, 100))) : undefined))
    .orderBy(asc(t.name))
    .limit(Math.min(Math.max(limit, 1), 20))
  return rows.map((r) => ({ value: r.id, label: r.name }))
}

export async function createTaxon(db: Db, companyId: string, userId: string, kind: TaxonKind, input: unknown) {
  const data = taxonSchema.parse(input)
  const t = tableOf(kind)
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(t).values({ companyId, name: data.name }).returning()
      await logActivity({ companyId, userId, action: `${kind}.create`, entity: kind, entityId: row.id, after: { name: row.name } }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, UQ[kind])) throw new FieldErrors({ name: dupMessage(kind) })
    throw e
  }
}

export async function renameTaxon(db: Db, companyId: string, userId: string, kind: TaxonKind, id: string, input: unknown) {
  const data = taxonSchema.parse(input)
  const t = tableOf(kind)
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(t).where(and(eq(t.id, id), eq(t.companyId, companyId))).for('update')
      if (!before) throw new NotFoundError(LABEL[kind])
      const [row] = await tx.update(t).set({ name: data.name, updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.companyId, companyId))).returning()
      await logActivity({ companyId, userId, action: `${kind}.update`, entity: kind, entityId: id, before: { name: before.name }, after: { name: row.name } }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, UQ[kind])) throw new FieldErrors({ name: dupMessage(kind) })
    throw e
  }
}

/** Soft delete / restore. Rows are never removed because products reference them. */
export async function setTaxonActive(db: Db, companyId: string, userId: string, kind: TaxonKind, id: string, active: boolean) {
  const t = tableOf(kind)
  return db.transaction(async (tx) => {
    const [row] = await tx.update(t).set({ active, updatedAt: new Date() }).where(and(eq(t.id, id), eq(t.companyId, companyId))).returning()
    if (!row) throw new NotFoundError(LABEL[kind])
    await logActivity({ companyId, userId, action: `${kind}.${active ? 'activate' : 'deactivate'}`, entity: kind, entityId: id, after: { active } }, tx)
    return row
  })
}

/** How many active products use each taxon (for the list's "Products" column). */
export async function productCounts(db: Db, companyId: string, kind: TaxonKind, ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const col = kind === 'category' ? schema.products.categoryId : schema.products.brandId
  const rows = await db
    .select({ id: col, n: count() })
    .from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), eq(schema.products.active, true), inArray(col, ids)))
    .groupBy(col)
  return Object.fromEntries(rows.map((r) => [r.id as string, Number(r.n)]))
}
