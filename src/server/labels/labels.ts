/**
 * Which units to print labels for (reads only, company-scoped). The query selects serial, product name and SKU and
 * nothing else: purchase cost never leaves the database for a label.
 * Branches (Task 14): a purchase / explicit unit ids follow the detail restriction (scope.restrict); "in stock" lists the
 * filtered branch's units (scope.filter).
 */
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { branchCond, type BranchScope } from '../branch'
import { schema, type Db } from '../db'
import { NotFoundError } from '../errors'
import { MAX_LABELS, type LabelParams } from './pure'

export type LabelUnit = { id: string; serialNo: string; productName: string; sku: string }
export type LabelSelection = {
  labels: LabelUnit[]
  /** Units matching the selection (may exceed labels.length: capped at MAX_LABELS). */
  total: number
  truncated: boolean
  /** Human description of what was selected, e.g. "Purchase PUR-00001". */
  title: string
}

const cols = () => ({ id: schema.productUnits.id, serialNo: schema.productUnits.serialNo, productName: schema.products.name, sku: schema.products.sku })

export async function loadLabelUnits(db: Db, companyId: string, scope: Pick<BranchScope, 'filter' | 'restrict'>, p: LabelParams): Promise<LabelSelection> {
  const u = schema.productUnits
  const pr = schema.products
  if (p.source === 'purchase') {
    if (!p.valid) throw new NotFoundError('Purchase')
    const [purchase] = await db.select({ id: schema.purchases.id, invoiceNo: schema.purchases.invoiceNo }).from(schema.purchases).where(and(eq(schema.purchases.id, p.purchaseId), eq(schema.purchases.companyId, companyId), branchCond(schema.purchases.branchId, scope.restrict)))
    if (!purchase) throw new NotFoundError('Purchase')
    const where = and(eq(u.companyId, companyId), eq(schema.purchaseItems.purchaseId, purchase.id))
    const base = () => db.select(cols()).from(u).innerJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, u.purchaseItemId), eq(schema.purchaseItems.companyId, companyId))).innerJoin(pr, and(eq(pr.id, u.productId), eq(pr.companyId, companyId))).where(where)
    const [rows, [{ n }]] = await Promise.all([base().orderBy(asc(pr.name), asc(u.serialNo)).limit(MAX_LABELS), db.select({ n: count() }).from(u).innerJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, u.purchaseItemId), eq(schema.purchaseItems.companyId, companyId))).where(where)])
    return { labels: rows, total: Number(n), truncated: Number(n) > rows.length, title: `Purchase ${purchase.invoiceNo}` }
  }
  if (p.source === 'ids') {
    const where = and(eq(u.companyId, companyId), branchCond(u.branchId, scope.restrict), inArray(u.id, p.ids.length ? p.ids : ['00000000-0000-0000-0000-000000000000']))
    const rows = await db.select(cols()).from(u).innerJoin(pr, and(eq(pr.id, u.productId), eq(pr.companyId, companyId))).where(where).orderBy(asc(pr.name), asc(u.serialNo)).limit(MAX_LABELS)
    return { labels: rows, total: rows.length, truncated: p.tooMany, title: 'Selected units' }
  }
  // in stock, optionally one product by SKU (exact, this company only)
  let productId: string | null = null
  let title = 'Units in stock'
  if (p.sku) {
    const [prod] = await db.select({ id: pr.id, name: pr.name }).from(pr).where(and(eq(pr.companyId, companyId), eq(pr.sku, p.sku)))
    if (!prod) return { labels: [], total: 0, truncated: false, title: `No product with SKU "${p.sku}"` }
    productId = prod.id
    title = `In stock: ${prod.name}`
  }
  const where = and(eq(u.companyId, companyId), branchCond(u.branchId, scope.filter), eq(u.status, 'in_stock'), productId ? eq(u.productId, productId) : undefined)
  const [rows, [{ n }]] = await Promise.all([
    db.select(cols()).from(u).innerJoin(pr, and(eq(pr.id, u.productId), eq(pr.companyId, companyId))).where(where).orderBy(asc(pr.name), asc(u.serialNo)).limit(MAX_LABELS),
    db.select({ n: count() }).from(u).where(where),
  ])
  return { labels: rows, total: Number(n), truncated: Number(n) > rows.length, title }
}
