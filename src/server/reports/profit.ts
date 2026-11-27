/**
 * Product-wise profit and the profit & loss statement.
 *
 * Revenue/cost definitions (one place, used by both):
 *  - sold lines: sale_items on non-draft, non-cancelled invoices dated in the period; revenue = net_total (line revenue after its
 *    discount share), cost = qty x unit_cost_snapshot (the unit's / average cost frozen at sale time);
 *  - returns: sale_return_items of returns dated in the period; revenue returned = refund_amount (credit), cost returned =
 *    qty x the line's unit_cost_snapshot, but ONLY for goods that went back into stock (restock = 'in_stock').
 *    Goods returned damaged keep their cost in COGS: that cost is a loss, not recovered stock.
 * Branches (Task 14): sold lines by the invoice's branch, returns by the return's branch, adjustments / expenses / incomes by
 * their own branch, so per-branch figures add up exactly to the all-branches figures.
 */
import { sql } from 'drizzle-orm'
import { andBranch, type BranchFilter } from '../branch'
import { schema, rowsOf } from '../db'
import { appTimezone } from '../dates'
import { fromMinor, toMinor } from '../money'
import { computeProfitLoss, marginPercent, type ProfitLoss } from './pure'
import type { ReportContext, ReportParams, ReportResult, ReportRow, Reader } from './types'

const m = (v: unknown): string => fromMinor(toMinor(String(v ?? '0')))
/** "-12.00" for a deduction line; zero stays "0.00". */
const neg = (v: string): string => (toMinor(v) === 0 ? '0.00' : `-${v}`)
const { sales, saleItems, saleReturns, saleReturnItems, products, categories } = schema

export type ProductProfitRow = {
  productId: string
  name: string
  sku: string
  category: string | null
  qtySold: number
  qtyReturned: number
  revenue: string
  returns: string
  netRevenue: string
  cost: string
  costReturned: string
  netCost: string
  profit: string
}

export type ProductProfitTotals = { qtySold: number; qtyReturned: number; revenue: string; returns: string; netRevenue: string; cost: string; costReturned: string; netCost: string; profit: string }

/** Per-product revenue/cost with returns netted off, SQL-aggregated. `order` 'revenue' sorts by net revenue, 'name' by product name. */
export async function productProfitRows(db: Reader, companyId: string, branch: BranchFilter, p: { from: string; to: string; productId?: string; categoryId?: string; customerId?: string; limit: number; order?: 'revenue' | 'profit' | 'name' }): Promise<{ rows: ProductProfitRow[]; truncated: boolean; totals: ProductProfitTotals }> {
  const cte = sql`
    with s as (
      select ${saleItems.productId} as product_id, sum(${saleItems.qty}) as qty, sum(${saleItems.netTotal}) as revenue, sum(${saleItems.qty} * ${saleItems.unitCostSnapshot}) as cost
      from ${saleItems} join ${sales} on ${sales.id} = ${saleItems.saleId} and ${sales.companyId} = ${companyId}
      where ${saleItems.companyId} = ${companyId}${andBranch(sales.branchId, branch)} and ${sales.status} not in ('draft','cancelled') and ${sales.date} between ${p.from} and ${p.to}
        ${p.customerId ? sql`and ${sales.customerId} = ${p.customerId}` : sql``}
        ${p.productId ? sql`and ${saleItems.productId} = ${p.productId}` : sql``}
      group by 1
    ), r as (
      select ${saleReturnItems.productId} as product_id, sum(${saleReturnItems.qty}) as qty, sum(${saleReturnItems.refundAmount}) as revenue,
        coalesce(sum(${saleReturnItems.qty} * ${saleItems.unitCostSnapshot}) filter (where ${saleReturnItems.restock} = 'in_stock'), 0) as cost
      from ${saleReturnItems}
      join ${saleReturns} on ${saleReturns.id} = ${saleReturnItems.saleReturnId} and ${saleReturns.companyId} = ${companyId}
      join ${saleItems} on ${saleItems.id} = ${saleReturnItems.saleItemId} and ${saleItems.companyId} = ${companyId}
      where ${saleReturnItems.companyId} = ${companyId}${andBranch(saleReturns.branchId, branch)} and ${saleReturns.date} between ${p.from} and ${p.to}
        ${p.customerId ? sql`and ${saleReturns.customerId} = ${p.customerId}` : sql``}
        ${p.productId ? sql`and ${saleReturnItems.productId} = ${p.productId}` : sql``}
      group by 1
    ), j as (
      select coalesce(s.product_id, r.product_id) as product_id, coalesce(s.qty, 0) as qty_sold, coalesce(r.qty, 0) as qty_ret,
        coalesce(s.revenue, 0) as revenue, coalesce(r.revenue, 0) as ret_revenue, coalesce(s.cost, 0) as cost, coalesce(r.cost, 0) as ret_cost
      from s full join r on s.product_id = r.product_id
    )`
  const joined = sql`from j join ${products} on ${products.id} = j.product_id and ${products.companyId} = ${companyId}
    left join ${categories} on ${categories.id} = ${products.categoryId} and ${categories.companyId} = ${companyId}
    ${p.categoryId ? sql`where ${products.categoryId} = ${p.categoryId}` : sql``}`
  const res = await db.execute(sql`${cte}
    select ${products.id} as id, ${products.name} as name, ${products.sku} as sku, ${categories.name} as category,
      j.qty_sold::int as qty_sold, j.qty_ret::int as qty_ret, j.revenue::text as revenue, j.ret_revenue::text as ret_revenue,
      (j.revenue - j.ret_revenue)::text as net_revenue, j.cost::text as cost, j.ret_cost::text as ret_cost, (j.cost - j.ret_cost)::text as net_cost,
      ((j.revenue - j.ret_revenue) - (j.cost - j.ret_cost))::text as profit
    ${joined}
    order by ${p.order === 'name' ? sql`${products.name}` : p.order === 'profit' ? sql`((j.revenue - j.ret_revenue) - (j.cost - j.ret_cost)) desc, ${products.name}` : sql`(j.revenue - j.ret_revenue) desc, ${products.name}`}
    limit ${p.limit + 1}`)
  const all = rowsOf<{ id: string; name: string; sku: string; category: string | null; qty_sold: number; qty_ret: number; revenue: string; ret_revenue: string; net_revenue: string; cost: string; ret_cost: string; net_cost: string; profit: string }>(res)
  // Totals are aggregated in SQL over EVERY matching product, never over the (possibly capped) rows.
  const [t] = rowsOf<Record<string, string>>(
    await db.execute(sql`${cte}
      select coalesce(sum(j.qty_sold), 0)::text as qty_sold, coalesce(sum(j.qty_ret), 0)::text as qty_ret, coalesce(sum(j.revenue), 0)::text as revenue, coalesce(sum(j.ret_revenue), 0)::text as ret_revenue,
        coalesce(sum(j.cost), 0)::text as cost, coalesce(sum(j.ret_cost), 0)::text as ret_cost
      ${joined}`),
  )
  const revenue = toMinor(m(t?.revenue))
  const retRevenue = toMinor(m(t?.ret_revenue))
  const cost = toMinor(m(t?.cost))
  const retCost = toMinor(m(t?.ret_cost))
  const totals: ProductProfitTotals = { qtySold: Number(t?.qty_sold ?? 0), qtyReturned: Number(t?.qty_ret ?? 0), revenue: fromMinor(revenue), returns: fromMinor(retRevenue), netRevenue: fromMinor(revenue - retRevenue), cost: fromMinor(cost), costReturned: fromMinor(retCost), netCost: fromMinor(cost - retCost), profit: fromMinor(revenue - retRevenue - (cost - retCost)) }
  return {
    totals,
    truncated: all.length > p.limit,
    rows: all.slice(0, p.limit).map((r) => ({ productId: r.id, name: r.name, sku: r.sku, category: r.category, qtySold: Number(r.qty_sold), qtyReturned: Number(r.qty_ret), revenue: m(r.revenue), returns: m(r.ret_revenue), netRevenue: m(r.net_revenue), cost: m(r.cost), costReturned: m(r.ret_cost), netCost: m(r.net_cost), profit: m(r.profit) })),
  }
}

export async function productProfitReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const { rows, truncated, totals: tt } = await productProfitRows(ctx.db, ctx.companyId, ctx.branch, { from: p.from, to: p.to, productId: p.productId, categoryId: p.categoryId, customerId: p.customerId, limit: ctx.limit, order: 'profit' })
  return {
    key: 'product-profit',
    title: 'Product-wise profit',
    from: p.from,
    to: p.to,
    truncated,
    notes: [
      'Revenue is the invoice line after its share of the invoice discount. Cost is the cost frozen on the line when it was sold (the unit\'s own cost for serial items, the average cost for quantity items). Returns are counted on the return date; the cost of returned goods is reversed only when they went back into stock (damaged returns stay as a loss).',
    ],
    tables: [
      {
        columns: [
          { key: 'name', label: 'Product', kind: 'text' },
          { key: 'sku', label: 'SKU', kind: 'text' },
          { key: 'category', label: 'Category', kind: 'text' },
          { key: 'qtySold', label: 'Qty sold', kind: 'int' },
          { key: 'qtyReturned', label: 'Qty returned', kind: 'int' },
          { key: 'revenue', label: 'Revenue', kind: 'money' },
          { key: 'returns', label: 'Returns', kind: 'money' },
          { key: 'netRevenue', label: 'Net revenue', kind: 'money' },
          { key: 'cost', label: 'Cost', kind: 'money', sensitive: true },
          { key: 'costReturned', label: 'Cost returned', kind: 'money', sensitive: true },
          { key: 'netCost', label: 'Net cost', kind: 'money', sensitive: true },
          { key: 'profit', label: 'Profit', kind: 'money', sensitive: true },
          { key: 'margin', label: 'Margin %', kind: 'percent', sensitive: true },
        ],
        rows: rows.map((r) => ({ name: r.name, sku: r.sku, category: r.category, qtySold: r.qtySold, qtyReturned: r.qtyReturned, revenue: r.revenue, returns: r.returns, netRevenue: r.netRevenue, cost: r.cost, costReturned: r.costReturned, netCost: r.netCost, profit: r.profit, margin: marginPercent(r.profit, r.netRevenue), _href: `/products?q=${encodeURIComponent(r.sku)}` })),
        totals: { name: 'Total', sku: null, category: null, ...tt, margin: marginPercent(tt.profit, tt.netRevenue) },
      },
    ],
  }
}

// ------------------------------------------------------------------ profit and loss

/** All P&L inputs for a period, SQL-aggregated, then handed to the pure computeProfitLoss(). */
export async function loadProfitLoss(db: Reader, companyId: string, branch: BranchFilter, p: { from: string; to: string }, tz: string = appTimezone()): Promise<ProfitLoss> {
  const { from, to } = p
  const [sa] = rowsOf<{ gross: string; disc: string }>(
    await db.execute(sql`select coalesce(sum(${sales.subtotal}), 0)::text as gross, coalesce(sum(${sales.discount}), 0)::text as disc from ${sales} where ${sales.companyId} = ${companyId}${andBranch(sales.branchId, branch)} and ${sales.status} not in ('draft','cancelled') and ${sales.date} between ${from} and ${to}`),
  )
  const [ret] = rowsOf<{ credit: string }>(await db.execute(sql`select coalesce(sum(${saleReturns.creditTotal}), 0)::text as credit from ${saleReturns} where ${saleReturns.companyId} = ${companyId}${andBranch(saleReturns.branchId, branch)} and ${saleReturns.date} between ${from} and ${to}`))
  const [cogs] = rowsOf<{ cogs: string }>(
    await db.execute(sql`select coalesce(sum(${saleItems.qty} * ${saleItems.unitCostSnapshot}), 0)::text as cogs from ${saleItems} join ${sales} on ${sales.id} = ${saleItems.saleId} and ${sales.companyId} = ${companyId} where ${saleItems.companyId} = ${companyId}${andBranch(sales.branchId, branch)} and ${sales.status} not in ('draft','cancelled') and ${sales.date} between ${from} and ${to}`),
  )
  const [restocked] = rowsOf<{ cost: string }>(
    await db.execute(sql`
      select coalesce(sum(${saleReturnItems.qty} * ${saleItems.unitCostSnapshot}), 0)::text as cost
      from ${saleReturnItems}
      join ${saleReturns} on ${saleReturns.id} = ${saleReturnItems.saleReturnId} and ${saleReturns.companyId} = ${companyId}
      join ${saleItems} on ${saleItems.id} = ${saleReturnItems.saleItemId} and ${saleItems.companyId} = ${companyId}
      where ${saleReturnItems.companyId} = ${companyId}${andBranch(saleReturns.branchId, branch)} and ${saleReturnItems.restock} = 'in_stock' and ${saleReturns.date} between ${from} and ${to}`),
  )
  // Stock adjustments (write-offs net of found) by the LOCAL date (APP_TIMEZONE) of when they were recorded. value is signed
  // (negative = stock removed), so the cost is its negation. Damaged CUSTOMER returns never create an adjustment: their cost
  // simply stays in COGS (not reversed above), and a damaged unit cannot be adjusted again (only in_stock -> damaged), so
  // nothing is counted twice.
  const adjT = schema.stockAdjustments
  const [adj] = rowsOf<{ v: string }>(
    await db.execute(sql`select coalesce(-sum(${adjT.value}), 0)::text as v from ${adjT} where ${adjT.companyId} = ${companyId}${andBranch(adjT.branchId, branch)} and (${adjT.createdAt} at time zone ${tz})::date between ${from} and ${to}`),
  )
  const exp = rowsOf<{ name: string | null; amount: string }>(
    await db.execute(sql`
      select coalesce(${schema.expenseCategories.name}, 'Uncategorized') as name, sum(${schema.expenses.amount})::text as amount
      from ${schema.expenses} left join ${schema.expenseCategories} on ${schema.expenseCategories.id} = ${schema.expenses.categoryId} and ${schema.expenseCategories.companyId} = ${companyId}
      where ${schema.expenses.companyId} = ${companyId}${andBranch(schema.expenses.branchId, branch)} and ${schema.expenses.voidedAt} is null and ${schema.expenses.date} between ${from} and ${to}
      group by 1 order by sum(${schema.expenses.amount}) desc, 1`),
  )
  const inc = rowsOf<{ name: string | null; amount: string }>(
    await db.execute(sql`
      select coalesce(${schema.incomes.category}, 'Uncategorized') as name, sum(${schema.incomes.amount})::text as amount
      from ${schema.incomes}
      where ${schema.incomes.companyId} = ${companyId}${andBranch(schema.incomes.branchId, branch)} and ${schema.incomes.voidedAt} is null and ${schema.incomes.date} between ${from} and ${to}
      group by 1 order by sum(${schema.incomes.amount}) desc, 1`),
  )
  return computeProfitLoss({
    grossSales: m(sa?.gross),
    discounts: m(sa?.disc),
    salesReturns: m(ret?.credit),
    cogs: m(cogs?.cogs),
    cogsRestocked: m(restocked?.cost),
    stockAdjustments: m(adj?.v),
    expenses: exp.map((e) => ({ name: e.name ?? 'Uncategorized', amount: m(e.amount) })),
    otherIncome: inc.map((e) => ({ name: e.name ?? 'Uncategorized', amount: m(e.amount) })),
  })
}

export async function profitLossReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const pl = await loadProfitLoss(ctx.db, ctx.companyId, ctx.branch, p)
  const line = (label: string, amount: string | null, style?: ReportRow['_style']): ReportRow => ({ line: label, amount, ...(style ? { _style: style } : {}) })
  const rows: ReportRow[] = [
    line('Revenue', null, 'heading'),
    line('Gross sales (invoice lines)', pl.grossSales),
    line('Less: discounts', neg(pl.discounts)),
    line('Net sales', pl.netSales, 'sub'),
    line('Less: sales returns', neg(pl.salesReturns)),
    line('Revenue', pl.revenue, 'total'),
    line('Cost of goods sold', null, 'heading'),
    line('Cost of items sold', pl.cogs),
    line('Less: cost of returned goods restocked', neg(pl.cogsRestocked)),
    line('Cost of goods sold', pl.netCogs, 'sub'),
    line('Stock adjustments (write-offs net of found)', pl.stockAdjustments),
    line('Total cost of goods', pl.totalCost, 'sub'),
    line('Gross profit', pl.grossProfit, 'total'),
    line('Operating expenses', null, 'heading'),
    ...pl.expenses.map((e) => line(`  ${e.name}`, e.amount)),
    line('Total expenses', pl.totalExpenses, 'sub'),
    line('Other income', null, 'heading'),
    ...pl.otherIncome.map((e) => line(`  ${e.name}`, e.amount)),
    line('Total other income', pl.totalOtherIncome, 'sub'),
    line('Net profit', pl.netProfit, 'total'),
  ]
  return {
    key: 'profit-loss',
    title: 'Profit & loss',
    from: p.from,
    to: p.to,
    truncated: false,
    notes: [
      'Accrual view: invoices count on their invoice date, returns on their return date. Discounts reduce revenue.',
      'Cost of goods sold uses the cost frozen on each sold line (the unit\'s own purchase cost, or the average cost for quantity items). The cost of returned goods is reversed only when the goods went back into stock; goods returned damaged stay in the cost of goods sold.',
      'Stock adjustments are the net value of manual stock corrections recorded in the period (by local date): damage, loss and negative count corrections are a cost; found stock and positive corrections reduce it. They are valued at net cost (serial: the unit\'s cost; quantity items: the average cost when adjusted).',
      'Purchases are NOT expenses: buying stock is an asset that reaches the P&L as cost of goods sold when it is sold. Vendor payments, customer receipts and refunds, and transfers between accounts are cash movements and are not income or expense.',
      'Operating expenses and other income are the manual entries of the period; voided entries are excluded.',
    ],
    tables: [{ columns: [{ key: 'line', label: 'Line', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'money', sensitive: true }], rows }],
  }
}
