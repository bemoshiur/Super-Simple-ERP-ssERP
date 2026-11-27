import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { logActivity } from '../audit'
import { schema, type Db } from '../db'
import { FieldErrors, NotFoundError, isUniqueViolation } from '../errors'
import { diffFields, writeHistory } from '../history'
import { likePattern } from '../pagination'
import { PRODUCT_TRACKED, productSchema, type ProductData } from './schemas'
import { nextSku, skuPrefix } from './sku'

const SKU_UQ = 'products_company_sku_uq'
const SKU_DUP = 'This SKU is already used by another product (it may be deactivated).'

export type ProductRow = typeof schema.products.$inferSelect
export type ProductStatus = 'active' | 'inactive' | 'all'

type Tx = Pick<Db, 'select'>

/** category/brand ids must belong to the caller's company: a foreign id is reported like a missing one. */
async function assertRefs(tx: Tx, companyId: string, d: Pick<ProductData, 'categoryId' | 'brandId'>) {
  const errs: Record<string, string> = {}
  if (d.categoryId) {
    const [r] = await tx.select({ id: schema.categories.id }).from(schema.categories).where(and(eq(schema.categories.id, d.categoryId), eq(schema.categories.companyId, companyId)))
    if (!r) errs.categoryId = 'Category not found'
  }
  if (d.brandId) {
    const [r] = await tx.select({ id: schema.brands.id }).from(schema.brands).where(and(eq(schema.brands.id, d.brandId), eq(schema.brands.companyId, companyId)))
    if (!r) errs.brandId = 'Brand not found'
  }
  if (Object.keys(errs).length) throw new FieldErrors(errs)
}

const valuesOf = (d: ProductData | ProductRow) => ({
  name: d.name,
  sku: d.sku,
  categoryId: d.categoryId,
  brandId: d.brandId,
  trackSerial: d.trackSerial,
  warrantyMonths: d.warrantyMonths,
  purchasePrice: d.purchasePrice,
  salePrice: d.salePrice,
  lowStockThreshold: d.lowStockThreshold,
})

export async function createProduct(db: Db, companyId: string, userId: string, input: unknown): Promise<ProductRow> {
  const d = productSchema.parse(input)
  try {
    return await db.transaction(async (tx) => {
      await assertRefs(tx, companyId, d)
      const [row] = await tx.insert(schema.products).values({ companyId, ...valuesOf(d) }).returning()
      await logActivity({ companyId, userId, action: 'product.create', entity: 'product', entityId: row.id, after: valuesOf(d) }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, SKU_UQ)) throw new FieldErrors({ sku: SKU_DUP })
    throw e
  }
}

export async function getProduct(db: Db, companyId: string, id: string): Promise<ProductRow> {
  const [row] = await db.select().from(schema.products).where(and(eq(schema.products.id, id), eq(schema.products.companyId, companyId)))
  if (!row) throw new NotFoundError('Product')
  return row
}

/**
 * keepPurchasePrice: the editor cannot see costs (no profit visibility), so its form had no purchase price field; the stored
 * value is kept as it is (never blanked or overwritten by the client).
 */
export async function updateProduct(db: Db, companyId: string, userId: string, id: string, input: unknown, opts: { keepPurchasePrice?: boolean } = {}): Promise<ProductRow> {
  const parsed = productSchema.parse(input)
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.products).where(and(eq(schema.products.id, id), eq(schema.products.companyId, companyId))).for('update')
      if (!before) throw new NotFoundError('Product')
      const d = opts.keepPurchasePrice ? { ...parsed, purchasePrice: before.purchasePrice } : parsed
      await assertRefs(tx, companyId, d)

      // CONTRACT: this check is only race-free if Tasks 6/7 take `SELECT ... FOR SHARE` on the product row
      // (same transaction) before inserting product_units / stock_movements for it. We hold FOR UPDATE above.
      if (before.trackSerial !== d.trackSerial) {
        const [[u], [m]] = await Promise.all([
          tx.select({ n: count() }).from(schema.productUnits).where(and(eq(schema.productUnits.companyId, companyId), eq(schema.productUnits.productId, id))),
          tx.select({ n: count() }).from(schema.stockMovements).where(and(eq(schema.stockMovements.companyId, companyId), eq(schema.stockMovements.productId, id))),
        ])
        if (Number(u.n) + Number(m.n) > 0) throw new FieldErrors({ trackSerial: 'Serial tracking cannot be changed once the product has stock history.' })
      }

      const [row] = await tx.update(schema.products).set({ ...valuesOf(d), updatedAt: new Date() }).where(and(eq(schema.products.id, id), eq(schema.products.companyId, companyId))).returning()
      await writeHistory(tx, { companyId, userId, entity: 'product', entityId: id, diff: diffFields(before, row, PRODUCT_TRACKED) })
      await logActivity({ companyId, userId, action: 'product.update', entity: 'product', entityId: id, before: valuesOf(before), after: valuesOf(d) }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, SKU_UQ)) throw new FieldErrors({ sku: SKU_DUP })
    throw e
  }
}

/** Soft delete (active=false) and restore. Products are never hard-deleted: sales/purchases reference them. */
export async function setProductActive(db: Db, companyId: string, userId: string, id: string, active: boolean): Promise<ProductRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.products).set({ active, updatedAt: new Date() }).where(and(eq(schema.products.id, id), eq(schema.products.companyId, companyId))).returning()
    if (!row) throw new NotFoundError('Product')
    await logActivity({ companyId, userId, action: active ? 'product.activate' : 'product.deactivate', entity: 'product', entityId: id, after: { active } }, tx)
    return row
  })
}

export type ProductListFilter = { q?: string; categoryId?: string; brandId?: string; status?: ProductStatus; limit: number; offset: number }

export async function listProducts(db: Db, companyId: string, f: ProductListFilter) {
  const p = schema.products
  const where = and(
    eq(p.companyId, companyId),
    f.q ? or(ilike(p.name, likePattern(f.q)), ilike(p.sku, likePattern(f.q))) : undefined,
    f.categoryId ? eq(p.categoryId, f.categoryId) : undefined,
    f.brandId ? eq(p.brandId, f.brandId) : undefined,
    f.status === 'inactive' ? eq(p.active, false) : f.status === 'all' ? undefined : eq(p.active, true),
  )
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: p.id,
        name: p.name,
        sku: p.sku,
        categoryId: p.categoryId,
        categoryName: schema.categories.name,
        brandId: p.brandId,
        brandName: schema.brands.name,
        trackSerial: p.trackSerial,
        warrantyMonths: p.warrantyMonths,
        purchasePrice: p.purchasePrice,
        salePrice: p.salePrice,
        lowStockThreshold: p.lowStockThreshold,
        active: p.active,
      })
      .from(p)
      .leftJoin(schema.categories, and(eq(schema.categories.id, p.categoryId), eq(schema.categories.companyId, companyId)))
      .leftJoin(schema.brands, and(eq(schema.brands.id, p.brandId), eq(schema.brands.companyId, companyId)))
      .where(where)
      .orderBy(asc(p.name), asc(p.sku))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(p).where(where),
  ])
  return { rows, total: Number(n) }
}

/** Suggest an unused SKU like "IPH-0004" from the product name. */
export async function suggestSku(db: Db, companyId: string, name: string): Promise<string> {
  const prefix = skuPrefix(name)
  const rows = await db
    .select({ sku: schema.products.sku })
    .from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), sql`${schema.products.sku} ilike ${prefix + '-%'}`))
    .orderBy(desc(schema.products.sku))
    .limit(500)
  return nextSku(prefix, rows.map((r) => r.sku))
}
