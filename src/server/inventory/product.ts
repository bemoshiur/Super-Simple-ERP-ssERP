/**
 * Product detail page reads (company-scoped: another company's product id is NotFound everywhere).
 * Cost columns are returned only when the caller passes withCost (PROFIT_PERMISSIONS holders); otherwise they are null,
 * so they never reach a client component.
 * The product itself and its price history are company-level; stock, units, stock card, adjustments and purchase/sale
 * history take a BranchFilter (Task 14).
 */
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { andBranch, branchCond, type BranchFilter } from '../branch'
import { rowsOf, schema, type Db } from '../db'
import { NotFoundError } from '../errors'
import { stockRows, type StockRow } from '../reports/stock'
import type { UnitStatus } from '../serials'

type Reader = Pick<Db, 'select' | 'execute'>

export async function getProductProfile(db: Reader, companyId: string, id: string) {
  const p = schema.products
  const [row] = await db
    .select({ product: p, categoryName: schema.categories.name, brandName: schema.brands.name })
    .from(p)
    .leftJoin(schema.categories, and(eq(schema.categories.id, p.categoryId), eq(schema.categories.companyId, companyId)))
    .leftJoin(schema.brands, and(eq(schema.brands.id, p.brandId), eq(schema.brands.companyId, companyId)))
    .where(and(eq(p.id, id), eq(p.companyId, companyId)))
  if (!row) throw new NotFoundError('Product')
  return { ...row.product, categoryName: row.categoryName, brandName: row.brandName }
}

/** The product's stock line (same definition as /stock and the stock report). Zeros when it has no stock and is inactive. */
export async function productStock(db: Db, companyId: string, branch: BranchFilter, id: string): Promise<StockRow | null> {
  const { rows } = await stockRows({ db, companyId, branch, limit: 1 }, { productId: id })
  return rows[0] ?? null
}

export type PriceChange = { at: Date; byName: string | null; changes: { field: 'purchasePrice' | 'salePrice'; from: string | null; to: string | null }[] }

/** Purchase/sale price changes from record_history (who, when, old -> new), newest first. */
export async function priceHistory(db: Reader, companyId: string, productId: string, limit = 50): Promise<PriceChange[]> {
  const h = schema.recordHistory
  const rows = await db
    .select({ at: h.createdAt, diff: h.diff, byName: schema.users.name })
    .from(h)
    .leftJoin(schema.users, and(eq(schema.users.id, h.changedBy), eq(schema.users.companyId, companyId)))
    .where(and(eq(h.companyId, companyId), eq(h.entity, 'product'), eq(h.entityId, productId), sql`(${h.diff} ? 'purchasePrice' or ${h.diff} ? 'salePrice')`))
    .orderBy(desc(h.createdAt), desc(h.id))
    .limit(limit)
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v))
  return rows.map((r) => {
    const diff = (r.diff ?? {}) as Record<string, { from?: unknown; to?: unknown }>
    const changes = (['purchasePrice', 'salePrice'] as const).filter((k) => diff[k]).map((k) => ({ field: k, from: str(diff[k].from), to: str(diff[k].to) }))
    return { at: r.at, byName: r.byName, changes }
  })
}

// ------------------------------------------------------------------ serial units

export type ProductUnitRow = {
  id: string
  serialNo: string
  status: UnitStatus
  /** Net cost; null unless withCost. */
  purchasePrice: string | null
  vendorId: string | null
  vendorName: string | null
  purchaseId: string | null
  purchaseInvoiceNo: string | null
  saleId: string | null
  saleInvoiceNo: string | null
  customerId: string | null
  customerName: string | null
  warrantyEnd: string | null
  receivedAt: Date
  branchName: string | null
}

/** Units of a serial product with vendor, purchase, current sale/customer and warranty; filter by status, paginated. */
export async function listProductUnits(db: Reader, companyId: string, branch: BranchFilter, productId: string, f: { status?: UnitStatus; limit: number; offset: number; withCost: boolean }) {
  const u = schema.productUnits
  const where = and(eq(u.companyId, companyId), branchCond(u.branchId, branch), eq(u.productId, productId), f.status ? eq(u.status, f.status) : undefined)
  const [rows, [{ n }], counts] = await Promise.all([
    db
      .select({
        id: u.id,
        serialNo: u.serialNo,
        status: u.status,
        purchasePrice: u.purchasePrice,
        vendorId: u.vendorId,
        vendorName: schema.vendors.name,
        purchaseId: schema.purchases.id,
        purchaseInvoiceNo: schema.purchases.invoiceNo,
        saleId: schema.sales.id,
        saleInvoiceNo: schema.sales.invoiceNo,
        customerId: schema.customers.id,
        customerName: schema.customers.name,
        warrantyEnd: u.warrantyEnd,
        receivedAt: u.createdAt,
        branchName: schema.branches.name,
      })
      .from(u)
      .leftJoin(schema.branches, and(eq(schema.branches.id, u.branchId), eq(schema.branches.companyId, companyId)))
      .leftJoin(schema.vendors, and(eq(schema.vendors.id, u.vendorId), eq(schema.vendors.companyId, companyId)))
      .leftJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, u.purchaseItemId), eq(schema.purchaseItems.companyId, companyId)))
      .leftJoin(schema.purchases, and(eq(schema.purchases.id, schema.purchaseItems.purchaseId), eq(schema.purchases.companyId, companyId)))
      // The sale the unit is CURRENTLY on (cleared by a customer return), only while it is sold or in service.
      .leftJoin(schema.saleItems, and(eq(schema.saleItems.id, u.saleItemId), eq(schema.saleItems.companyId, companyId), sql`${u.status} in ('sold', 'in_service')`))
      .leftJoin(schema.sales, and(eq(schema.sales.id, schema.saleItems.saleId), eq(schema.sales.companyId, companyId)))
      .leftJoin(schema.customers, and(eq(schema.customers.id, schema.sales.customerId), eq(schema.customers.companyId, companyId)))
      .where(where)
      .orderBy(desc(u.createdAt), u.serialNo)
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(u).where(where),
    db.select({ status: u.status, n: count() }).from(u).where(and(eq(u.companyId, companyId), branchCond(u.branchId, branch), eq(u.productId, productId))).groupBy(u.status),
  ])
  return {
    rows: rows.map((r): ProductUnitRow => ({ ...r, status: r.status as UnitStatus, purchasePrice: f.withCost ? r.purchasePrice : null })),
    total: Number(n),
    byStatus: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) as Partial<Record<UnitStatus, number>>,
  }
}

// ------------------------------------------------------------------ stock card (non-serial movement ledger)

export type StockCardDoc = { kind: 'purchase' | 'sale' | 'sale_return' | 'purchase_return' | 'adjustment' | 'transfer'; id: string | null; label: string }
export type StockCardRow = { id: string; at: Date; type: string; qtyChange: number; balance: number; note: string | null; byName: string | null; doc: StockCardDoc | null }

/**
 * Movement ledger of a non-serial product, newest first, with the running balance computed in SQL over the WHOLE history
 * (window `sum(qty_change) over (order by created_at, id)`), so every page shows the true balance after each movement.
 */
export async function stockCard(db: Reader, companyId: string, branch: BranchFilter, productId: string, f: { limit: number; offset: number }): Promise<{ rows: StockCardRow[]; total: number }> {
  const m = schema.stockMovements
  const res = await db.execute(sql`
    select x.id, x.created_at as at, x.type, x.qty_change, x.balance::int as balance, x.note, ${schema.users.name} as by_name,
      x.ref_table, pu.id as purchase_id, pu.invoice_no as purchase_no, s.id as sale_id, s.invoice_no as sale_no,
      sr.sale_id as sr_sale_id, sr.return_no as sr_no, pr.purchase_id as pr_purchase_id, pr.return_no as pr_no, sa.reason as adj_reason, st.id as transfer_id, st.transfer_no as transfer_no
    from (
      select ${m.id} as id, ${m.createdAt} as created_at, ${m.type} as type, ${m.qtyChange} as qty_change, ${m.note} as note, ${m.refTable} as ref_table, ${m.refId} as ref_id, ${m.createdBy} as created_by,
        sum(${m.qtyChange}) over (order by ${m.createdAt}, ${m.id} rows between unbounded preceding and current row) as balance
      from ${m} where ${m.companyId} = ${companyId} and ${m.productId} = ${productId}${andBranch(m.branchId, branch)}
    ) x
    left join ${schema.users} on ${schema.users.id} = x.created_by and ${schema.users.companyId} = ${companyId}
    left join ${schema.purchaseItems} pi on x.ref_table = 'purchase_items' and pi.id = x.ref_id and pi.company_id = ${companyId}
    left join ${schema.purchases} pu on pu.id = pi.purchase_id and pu.company_id = ${companyId}
    left join ${schema.saleItems} si on x.ref_table = 'sale_items' and si.id = x.ref_id and si.company_id = ${companyId}
    left join ${schema.sales} s on s.id = si.sale_id and s.company_id = ${companyId}
    left join ${schema.saleReturnItems} sri on x.ref_table = 'sale_return_items' and sri.id = x.ref_id and sri.company_id = ${companyId}
    left join ${schema.saleReturns} sr on sr.id = sri.sale_return_id and sr.company_id = ${companyId}
    left join ${schema.purchaseReturnItems} pri on x.ref_table = 'purchase_return_items' and pri.id = x.ref_id and pri.company_id = ${companyId}
    left join ${schema.purchaseReturns} pr on pr.id = pri.purchase_return_id and pr.company_id = ${companyId}
    left join ${schema.stockAdjustments} sa on x.ref_table = 'stock_adjustments' and sa.id = x.ref_id and sa.company_id = ${companyId}
    left join ${schema.stockTransferItems} sti on x.ref_table = 'stock_transfer_items' and sti.id = x.ref_id and sti.company_id = ${companyId}
    left join ${schema.stockTransfers} st on st.id = sti.transfer_id and st.company_id = ${companyId}
    order by x.created_at desc, x.id desc
    limit ${f.limit} offset ${f.offset}`)
  type Raw = { id: string; at: Date | string; type: string; qty_change: number; balance: number; note: string | null; by_name: string | null; ref_table: string | null; purchase_id: string | null; purchase_no: string | null; sale_id: string | null; sale_no: string | null; sr_sale_id: string | null; sr_no: string | null; pr_purchase_id: string | null; pr_no: string | null; adj_reason: string | null; transfer_id: string | null; transfer_no: string | null }
  const docOf = (r: Raw): StockCardDoc | null => {
    if (r.purchase_no) return { kind: 'purchase', id: r.purchase_id, label: r.purchase_no }
    if (r.sale_no) return { kind: 'sale', id: r.sale_id, label: r.sale_no }
    if (r.sr_no) return { kind: 'sale_return', id: r.sr_sale_id, label: r.sr_no }
    if (r.pr_no) return { kind: 'purchase_return', id: r.pr_purchase_id, label: r.pr_no }
    if (r.adj_reason) return { kind: 'adjustment', id: null, label: 'Adjustment' }
    if (r.transfer_no) return { kind: 'transfer', id: r.transfer_id, label: r.transfer_no }
    return null
  }
  const [{ n }] = await db.select({ n: count() }).from(m).where(and(eq(m.companyId, companyId), branchCond(m.branchId, branch), eq(m.productId, productId)))
  const rows = rowsOf<Raw>(res).map((r): StockCardRow => ({ id: r.id, at: new Date(r.at), type: r.type, qtyChange: Number(r.qty_change), balance: Number(r.balance), note: r.note, byName: r.by_name, doc: docOf(r) }))
  return { rows, total: Number(n) }
}

/** Link for a stock-card document, or null (plain text) when the viewer lacks the target's view permission. */
export function stockCardHref(doc: StockCardDoc | null, a: { purchases: boolean; sales: boolean; transfers?: boolean }): string | null {
  if (!doc?.id) return null
  if (doc.kind === 'transfer') return a.transfers ? `/stock/transfers/${doc.id}` : null
  if (doc.kind === 'purchase' || doc.kind === 'purchase_return') return a.purchases ? `/purchases/${doc.id}` : null
  if (doc.kind === 'sale' || doc.kind === 'sale_return') return a.sales ? `/sales/${doc.id}` : null
  return null
}

// ------------------------------------------------------------------ purchase / sale history

/** Purchase invoices containing this product (one row per invoice), newest first. */
export async function listProductPurchases(db: Reader, companyId: string, branch: BranchFilter, productId: string, f: { limit: number; offset: number }) {
  const pi = schema.purchaseItems
  const pu = schema.purchases
  const where = and(eq(pi.companyId, companyId), eq(pi.productId, productId), branchCond(pu.branchId, branch))
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ id: pu.id, invoiceNo: pu.invoiceNo, date: pu.date, vendorId: pu.vendorId, vendorName: schema.vendors.name, qty: sql<number>`sum(${pi.qty})::int`, net: sql<string>`sum(${pi.netTotal})::text` })
      .from(pi)
      .innerJoin(pu, and(eq(pu.id, pi.purchaseId), eq(pu.companyId, companyId)))
      .innerJoin(schema.vendors, and(eq(schema.vendors.id, pu.vendorId), eq(schema.vendors.companyId, companyId)))
      .where(where)
      .groupBy(pu.id, schema.vendors.name)
      .orderBy(desc(pu.date), desc(pu.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: sql<number>`count(distinct ${pi.purchaseId})::int` }).from(pi).innerJoin(pu, and(eq(pu.id, pi.purchaseId), eq(pu.companyId, companyId))).where(where),
  ])
  return { rows: rows.map((r) => ({ ...r, qty: Number(r.qty) })), total: Number(n) }
}

/** Sale invoices containing this product (one row per invoice), newest first. */
export async function listProductSales(db: Reader, companyId: string, branch: BranchFilter, productId: string, f: { limit: number; offset: number }) {
  const si = schema.saleItems
  const s = schema.sales
  const where = and(eq(si.companyId, companyId), eq(si.productId, productId), branchCond(s.branchId, branch))
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ id: s.id, invoiceNo: s.invoiceNo, date: s.date, customerId: s.customerId, customerName: schema.customers.name, qty: sql<number>`sum(${si.qty})::int`, net: sql<string>`sum(${si.netTotal})::text` })
      .from(si)
      .innerJoin(s, and(eq(s.id, si.saleId), eq(s.companyId, companyId)))
      .leftJoin(schema.customers, and(eq(schema.customers.id, s.customerId), eq(schema.customers.companyId, companyId)))
      .where(where)
      .groupBy(s.id, schema.customers.name)
      .orderBy(desc(s.date), desc(s.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: sql<number>`count(distinct ${si.saleId})::int` }).from(si).innerJoin(s, and(eq(s.id, si.saleId), eq(s.companyId, companyId))).where(where),
  ])
  return { rows: rows.map((r) => ({ ...r, qty: Number(r.qty) })), total: Number(n) }
}
