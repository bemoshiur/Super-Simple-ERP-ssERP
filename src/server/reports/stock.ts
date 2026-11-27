/**
 * Stock valuation and low-stock.
 *  - serial products: counts by unit status (SQL), value = sum of in-stock units' purchase_price (their exact NET cost,
 *    discount share included);
 *  - non-serial products: on hand = sum(stock_movements.qty_change), value = on hand x average net cost (the Task 7
 *    productAverageCosts() function: purchase net totals less purchase returns, half-up, falling back to products.purchase_price).
 * Stock is "as of now" (there is no historical snapshot table).
 * Branches (Task 14): every query takes a BranchFilter: serial units by product_units.branch_id (where the unit is now),
 * quantities by stock_movements.branch_id. Average cost stays company-wide (a product attribute), so per-branch values add up
 * exactly to the all-branches value. The low-stock threshold applies to each branch's own on-hand (or the total for All).
 */
import { sql } from 'drizzle-orm'
import { andBranch, type BranchFilter } from '../branch'
import { schema, rowsOf } from '../db'
import { fromMinor, toMinor } from '../money'
import { likePattern } from '../pagination'
import { productAverageCosts } from '../sales/sales'
import type { ReportContext, ReportParams, ReportResult, Reader } from './types'

const { products, productUnits, stockMovements, categories, brands } = schema
const m = (v: unknown): string => fromMinor(toMinor(String(v ?? '0')))
const chunk = <T>(a: T[], n = 500): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

/** On-hand quantity of the row of `products` in scope: serial = in-stock unit count, otherwise movements sum. One definition for the dashboard and the reports. */
export const onHandSql = (companyId: string, branch: BranchFilter) => sql`(case when ${products.trackSerial}
  then (select count(*) from ${productUnits} where ${productUnits.companyId} = ${companyId}${andBranch(productUnits.branchId, branch)} and ${productUnits.productId} = ${products.id} and ${productUnits.status} = 'in_stock')
  else coalesce((select sum(${stockMovements.qtyChange}) from ${stockMovements} where ${stockMovements.companyId} = ${companyId}${andBranch(stockMovements.branchId, branch)} and ${stockMovements.productId} = ${products.id}), 0) end)`

/** Active products with a threshold > 0 whose on-hand is at or below it. */
export const lowStockPredicate = (companyId: string, branch: BranchFilter) => sql`${products.companyId} = ${companyId} and ${products.active} = true and ${products.lowStockThreshold} > 0 and ${onHandSql(companyId, branch)} <= ${products.lowStockThreshold}`

export async function lowStockCount(db: Reader, companyId: string, branch: BranchFilter): Promise<number> {
  const res = await db.execute(sql`select count(*)::int as n from ${products} where ${lowStockPredicate(companyId, branch)}`)
  return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0)
}

/**
 * Filters shared by the stock report, the /stock page and its summary cards. Every query below is built from ONE
 * FROM/WHERE fragment (stockFrom), so the table, its row count, the units total and the valuation always agree.
 */
export type StockFilter = {
  productId?: string
  categoryId?: string
  brandId?: string
  /** Name or SKU contains (LIKE wildcards escaped). */
  q?: string
  /** Only products at or below their low-stock threshold (lowStockPredicate: active, threshold > 0). */
  lowOnly?: boolean
  tracking?: 'serial' | 'plain'
}

/**
 * products + category/brand names + per-product unit counts by status (serial) and movements sum (non-serial).
 * Inactive products are listed only while they still hold stock. Exposes `u.*` (serial) and `mv.on_hand` (non-serial).
 */
const stockFrom = (c: string, branch: BranchFilter, f: StockFilter) => sql`
    from ${products}
    left join ${categories} on ${categories.id} = ${products.categoryId} and ${categories.companyId} = ${c}
    left join ${brands} on ${brands.id} = ${products.brandId} and ${brands.companyId} = ${c}
    left join lateral (
      select count(*) filter (where ${productUnits.status} = 'in_stock') as in_stock, count(*) filter (where ${productUnits.status} = 'sold') as sold,
        count(*) filter (where ${productUnits.status} = 'in_service') as in_service, count(*) filter (where ${productUnits.status} = 'damaged') as damaged,
        count(*) filter (where ${productUnits.status} = 'returned_to_vendor') as returned, sum(${productUnits.purchasePrice}) filter (where ${productUnits.status} = 'in_stock') as value
      from ${productUnits} where ${productUnits.companyId} = ${c}${andBranch(productUnits.branchId, branch)} and ${productUnits.productId} = ${products.id}
    ) u on ${products.trackSerial}
    left join lateral (select sum(${stockMovements.qtyChange}) as on_hand from ${stockMovements} where ${stockMovements.companyId} = ${c}${andBranch(stockMovements.branchId, branch)} and ${stockMovements.productId} = ${products.id}) mv on not ${products.trackSerial}
    where ${products.companyId} = ${c}
      and (${products.active} = true or coalesce(u.in_stock, 0) > 0 or coalesce(mv.on_hand, 0) <> 0)
      ${f.productId ? sql`and ${products.id} = ${f.productId}` : sql``}
      ${f.categoryId ? sql`and ${products.categoryId} = ${f.categoryId}` : sql``}
      ${f.brandId ? sql`and ${products.brandId} = ${f.brandId}` : sql``}
      ${f.q ? sql`and (${products.name} ilike ${likePattern(f.q)} or ${products.sku} ilike ${likePattern(f.q)})` : sql``}
      ${f.tracking === 'serial' ? sql`and ${products.trackSerial}` : f.tracking === 'plain' ? sql`and not ${products.trackSerial}` : sql``}
      ${f.lowOnly ? sql`and ${lowStockPredicate(c, branch)}` : sql``}`

/** Total stock value at net cost (serial: sum of in-stock unit costs; non-serial: on hand x average cost), exact. All products unless filtered. */
export async function stockValuation(db: Reader, companyId: string, branch: BranchFilter, f: StockFilter = {}): Promise<string> {
  const serial = rowsOf<{ v: string }>(await db.execute(sql`select coalesce(sum(u.value), 0)::text as v ${stockFrom(companyId, branch, f)} and ${products.trackSerial}`))[0]?.v
  const plain = rowsOf<{ id: string; qty: string }>(await db.execute(sql`select ${products.id} as id, mv.on_hand::text as qty ${stockFrom(companyId, branch, f)} and not ${products.trackSerial} and mv.on_hand > 0`))
  let total = toMinor(m(serial))
  for (const part of chunk(plain)) {
    const avg = await productAverageCosts(db, companyId, part.map((r) => r.id))
    for (const r of part) total += toMinor(avg.get(r.id) ?? '0') * Number(r.qty)
  }
  return fromMinor(total)
}

export type StockRow = {
  id: string
  name: string
  sku: string
  category: string | null
  categoryId: string | null
  brand: string | null
  trackSerial: boolean
  active: boolean
  threshold: number
  /** At or below the low-stock threshold (lowStockPredicate). */
  low: boolean
  /** Serial: units in stock. Non-serial: sum of stock movements. */
  onHand: number
  sold: number
  inService: number
  damaged: number
  returned: number
  /** Net cost per unit (serial: in-stock value / count; non-serial: average cost). Cost data: profit-visibility only. */
  unitCost: string
  value: string
}

/**
 * One page of stock rows (ordered by name). Fetches limit+1 rows to report truncation. Costs come from the units' net
 * purchase prices (serial) and productAverageCosts (non-serial): callers strip unitCost/value for viewers without
 * profit visibility.
 */
export async function stockRows(ctx: Pick<ReportContext, 'db' | 'companyId' | 'branch' | 'limit'>, p: StockFilter & { offset?: number }): Promise<{ rows: StockRow[]; truncated: boolean }> {
  const c = ctx.companyId
  const br = ctx.branch
  const res = await ctx.db.execute(sql`
    select ${products.id} as id, ${products.name} as name, ${products.sku} as sku, ${categories.name} as category, ${products.categoryId} as category_id, ${brands.name} as brand,
      ${products.trackSerial} as track_serial, ${products.active} as active, ${products.lowStockThreshold} as threshold, (${lowStockPredicate(c, br)}) as low,
      coalesce(u.in_stock, 0)::int as in_stock, coalesce(u.sold, 0)::int as sold, coalesce(u.in_service, 0)::int as in_service, coalesce(u.damaged, 0)::int as damaged, coalesce(u.returned, 0)::int as returned,
      coalesce(u.value, 0)::text as serial_value, coalesce(mv.on_hand, 0)::int as on_hand
    ${stockFrom(c, br, p)}
    order by ${products.name}, ${products.id}
    limit ${ctx.limit + 1} offset ${Math.max(0, Math.trunc(p.offset ?? 0))}`)
  const all = rowsOf<{ id: string; name: string; sku: string; category: string | null; category_id: string | null; brand: string | null; track_serial: boolean; active: boolean; threshold: number; low: boolean; in_stock: number; sold: number; in_service: number; damaged: number; returned: number; serial_value: string; on_hand: number }>(res)
  const truncated = all.length > ctx.limit
  const page = all.slice(0, ctx.limit)
  const plainIds = page.filter((r) => !r.track_serial && r.on_hand > 0).map((r) => r.id)
  const avg = new Map<string, string>()
  for (const part of chunk(plainIds)) for (const [k, v] of await productAverageCosts(ctx.db, c, part)) avg.set(k, v)
  const rows = page.map((r): StockRow => {
    const base = { id: r.id, name: r.name, sku: r.sku, category: r.category, categoryId: r.category_id, brand: r.brand, active: r.active, threshold: Number(r.threshold), low: r.low === true }
    if (r.track_serial) {
      const value = m(r.serial_value)
      const unit = r.in_stock > 0 ? fromMinor(Math.round(toMinor(value) / r.in_stock)) : '0.00'
      return { ...base, trackSerial: true, onHand: r.in_stock, sold: r.sold, inService: r.in_service, damaged: r.damaged, returned: r.returned, unitCost: unit, value }
    }
    const unit = avg.get(r.id) ?? '0.00'
    return { ...base, trackSerial: false, onHand: r.on_hand, sold: 0, inService: 0, damaged: 0, returned: 0, unitCost: r.on_hand > 0 ? unit : '0.00', value: fromMinor(toMinor(unit) * Math.max(r.on_hand, 0)) }
  })
  return { rows, truncated }
}

/** Number of products matching the filter (for pagination). */
export async function countStockRows(db: Reader, companyId: string, branch: BranchFilter, f: StockFilter): Promise<number> {
  return Number(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n ${stockFrom(companyId, branch, f)}`))[0]?.n ?? 0)
}

export type StockSummary = { products: number; units: number; value: string; lowCount: number }

/** Summary cards for /stock over the same filter: products listed, units on hand, value at net cost, low-stock count. */
export async function stockSummary(db: Reader, companyId: string, branch: BranchFilter, f: StockFilter): Promise<StockSummary> {
  const [agg] = rowsOf<{ n: number; units: number }>(
    await db.execute(sql`select count(*)::int as n, coalesce(sum(case when ${products.trackSerial} then coalesce(u.in_stock, 0) else greatest(coalesce(mv.on_hand, 0), 0) end), 0)::int as units ${stockFrom(companyId, branch, f)}`),
  )
  const low = f.lowOnly ? Number(agg?.n ?? 0) : await countStockRows(db, companyId, branch, { ...f, lowOnly: true })
  return { products: Number(agg?.n ?? 0), units: Number(agg?.units ?? 0), value: await stockValuation(db, companyId, branch, f), lowCount: low }
}

export async function stockReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const { rows, truncated } = await stockRows(ctx, p)
  // When the rows are capped the totals still cover every product: value by SQL, quantity left blank (mixed units).
  const qty = truncated ? null : rows.reduce((a, r) => a + r.onHand, 0)
  const value = truncated ? await stockValuation(ctx.db, ctx.companyId, ctx.branch, p) : fromMinor(rows.reduce((a, r) => a + toMinor(r.value), 0))
  return {
    key: 'stock',
    title: 'Stock report',
    truncated,
    notes: [
      'Stock as of now. Serial products: counts by unit status; value = sum of in-stock units at their net purchase cost. Quantity products: on hand = stock movements; value = on hand x average net cost (purchases less purchase returns).',
      'Average cost per unit for serial products is the in-stock value divided by the in-stock count.',
    ],
    tables: [
      {
        columns: [
          { key: 'name', label: 'Product', kind: 'text' },
          { key: 'sku', label: 'SKU', kind: 'text' },
          { key: 'category', label: 'Category', kind: 'text' },
          { key: 'type', label: 'Tracking', kind: 'text' },
          { key: 'onHand', label: 'On hand', kind: 'int' },
          { key: 'sold', label: 'Sold', kind: 'int' },
          { key: 'inService', label: 'In service', kind: 'int' },
          { key: 'damaged', label: 'Damaged', kind: 'int' },
          { key: 'returned', label: 'Returned to vendor', kind: 'int' },
          { key: 'unitCost', label: 'Avg unit cost', kind: 'money', sensitive: true },
          { key: 'value', label: 'Stock value', kind: 'money', sensitive: true },
        ],
        rows: rows.map((r) => ({ name: r.name, sku: r.sku, category: r.category, type: r.trackSerial ? 'Serial' : 'Quantity', onHand: r.onHand, sold: r.trackSerial ? r.sold : null, inService: r.trackSerial ? r.inService : null, damaged: r.trackSerial ? r.damaged : null, returned: r.trackSerial ? r.returned : null, unitCost: r.unitCost, value: r.value, _href: `/products/${r.id}` })),
        totals: { name: 'Total', sku: null, category: null, type: null, onHand: qty, sold: null, inService: null, damaged: null, returned: null, unitCost: null, value },
      },
    ],
  }
}

export async function lowStockReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const c = ctx.companyId
  const br = ctx.branch
  const res = await ctx.db.execute(sql`
    select ${products.id} as id, ${products.name} as name, ${products.sku} as sku, ${categories.name} as category, ${products.trackSerial} as track_serial,
      ${onHandSql(c, br)}::int as on_hand, ${products.lowStockThreshold} as threshold
    from ${products} left join ${categories} on ${categories.id} = ${products.categoryId} and ${categories.companyId} = ${c}
    where ${lowStockPredicate(c, br)}
      ${p.categoryId ? sql`and ${products.categoryId} = ${p.categoryId}` : sql``}
      ${p.productId ? sql`and ${products.id} = ${p.productId}` : sql``}
    order by (${products.lowStockThreshold} - ${onHandSql(c, br)}) desc, ${products.name}
    limit ${ctx.limit + 1}`)
  const all = rowsOf<{ id: string; name: string; sku: string; category: string | null; track_serial: boolean; on_hand: number; threshold: number }>(res)
  return {
    key: 'low-stock',
    title: 'Low-stock alerts',
    truncated: all.length > ctx.limit,
    notes: ['Active products whose on-hand quantity (serial products: units in stock) is at or below their low-stock threshold. Products with a threshold of 0 are not monitored.'],
    tables: [
      {
        columns: [
          { key: 'name', label: 'Product', kind: 'text' },
          { key: 'sku', label: 'SKU', kind: 'text' },
          { key: 'category', label: 'Category', kind: 'text' },
          { key: 'type', label: 'Tracking', kind: 'text' },
          { key: 'onHand', label: 'On hand', kind: 'int' },
          { key: 'threshold', label: 'Threshold', kind: 'int' },
          { key: 'shortfall', label: 'Short by', kind: 'int' },
        ],
        rows: all.slice(0, ctx.limit).map((r) => ({ name: r.name, sku: r.sku, category: r.category, type: r.track_serial ? 'Serial' : 'Quantity', onHand: Number(r.on_hand), threshold: Number(r.threshold), shortfall: Math.max(Number(r.threshold) - Number(r.on_hand), 0), _href: `/products/${r.id}` })),
      },
    ],
  }
}
