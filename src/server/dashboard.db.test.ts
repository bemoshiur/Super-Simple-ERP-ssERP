import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})
beforeEach(async () => {
  await resetData()
})

const ALL = { sales: true, inventory: true, accounts: true }
const todayDhaka = sql`(now() at time zone 'Asia/Dhaka')::date`

/** One company with a product, a sale today (total 1000, paid 400, due 600) and some non-serial stock. */
async function seedCompany(name: string, opts: { sku: string; invoice: string; total: string; paid: string; due: string; stock: number }) {
  const { getDb, schema } = await import('./db')
  const db = getDb()
  const [company] = await db.insert(schema.companies).values({ name }).returning()
  await db.insert(schema.branches).values({ companyId: company.id, name: 'Main', code: 'MAIN', isDefault: true })
  const [product] = await db.insert(schema.products).values({ companyId: company.id, name: `${name} Phone`, sku: opts.sku, purchasePrice: '100.00', salePrice: opts.total, lowStockThreshold: 5 }).returning()
  await db.insert(schema.stockMovements).values({ companyId: company.id, branchId: await (await import('@/test/seed')).mainBranchId(company.id), productId: product.id, type: 'purchase', qtyChange: opts.stock })
  const [sale] = await db.insert(schema.sales).values({ companyId: company.id, invoiceNo: opts.invoice, date: sql`${todayDhaka}` as unknown as string, subtotal: opts.total, total: opts.total, paid: opts.paid, due: opts.due }).returning()
  await db.insert(schema.saleItems).values({ companyId: company.id, saleId: sale.id, productId: product.id, qty: 1, unitPrice: opts.total, netTotal: opts.total })
  return company
}

describe('dashboard queries', () => {
  it('returns zeros / empty lists on an empty database', async () => {
    const { loadDashboard, emptyDashboard } = await import('./dashboard')
    const { getDb, schema } = await import('./db')
    const [c] = await getDb().insert(schema.companies).values({ name: 'Empty Co' }).returning()
    const { data, failed } = await loadDashboard(c.id, null, ALL)
    expect(failed).toEqual([])
    expect(data.salesToday).toBe('0.00')
    expect(data.last7).toHaveLength(7)
    expect(data.last7.every((p) => p.total === '0.00')).toBe(true)
    expect({ ...data, last7: [] }).toEqual({ ...emptyDashboard(), last7: [] })
  })

  it('aggregates a small seed exactly', async () => {
    const { loadDashboard } = await import('./dashboard')
    const co = await seedCompany('Alpha', { sku: 'A-1', invoice: 'INV-1', total: '1000.00', paid: '400.00', due: '600.00', stock: 2 })
    const { data, failed } = await loadDashboard(co.id, null, ALL)
    expect(failed).toEqual([])
    expect(data.salesToday).toBe('1000.00')
    expect(data.salesMonth).toBe('1000.00')
    expect(data.customerDue).toBe('600.00')
    expect(data.vendorDue).toBe('0.00')
    expect(data.stockValue).toBe('200.00') // 2 on hand x 100.00 cost
    expect(data.lowStock).toBe(1) // 2 <= threshold 5
    expect(data.last7.at(-1)?.total).toBe('1000.00')
    expect(data.top).toEqual([{ name: 'Alpha Phone', revenue: '1000.00', units: 1 }])
  })

  it('scope gating skips groups the viewer may not see', async () => {
    const { loadDashboard } = await import('./dashboard')
    const co = await seedCompany('Alpha', { sku: 'A-1', invoice: 'INV-1', total: '1000.00', paid: '0.00', due: '1000.00', stock: 1 })
    const { data } = await loadDashboard(co.id, null, { sales: false, inventory: false, accounts: true })
    expect(data.salesToday).toBe('0.00')
    expect(data.stockValue).toBe('0.00')
    expect(data.customerDue).toBe('1000.00')
  })
})

describe('net of returns', () => {
  it('sales today/month, the 7-day series and top products subtract returns (by return date)', async () => {
    const { loadDashboard } = await import('./dashboard')
    const { getDb, schema } = await import('./db')
    const db = getDb()
    const co = await seedCompany('Alpha', { sku: 'A-1', invoice: 'INV-1', total: '1000.00', paid: '1000.00', due: '0.00', stock: 2 })
    const [sale] = await db.select().from(schema.sales)
    const [item] = await db.select().from(schema.saleItems)
    // A 400.00 return dated today, plus a fully returned older sale must not inflate anything.
    const [ret] = await db.insert(schema.saleReturns).values({ companyId: co.id, returnNo: 'SR-1', saleId: sale.id, date: sql`${todayDhaka}` as unknown as string, creditTotal: '400.00', refundTotal: '400.00' }).returning()
    await db.insert(schema.saleReturnItems).values({ companyId: co.id, saleReturnId: ret.id, saleItemId: item.id, productId: item.productId, qty: 1, refundAmount: '400.00' })
    const { data } = await loadDashboard(co.id, null, ALL)
    expect(data.salesToday).toBe('600.00')
    expect(data.salesMonth).toBe('600.00')
    expect(data.last7.at(-1)?.total).toBe('600.00')
    expect(data.top).toEqual([{ name: 'Alpha Phone', revenue: '600.00', units: 0 }])
  })
})

describe('company isolation', () => {
  it('each company only sees its own figures', async () => {
    const { loadDashboard, salesTotals, dues, stockValue, topProducts } = await import('./dashboard')
    const { getDb } = await import('./db')
    const a = await seedCompany('Alpha', { sku: 'SAME', invoice: 'INV-1', total: '1000.00', paid: '400.00', due: '600.00', stock: 2 })
    const b = await seedCompany('Beta', { sku: 'SAME', invoice: 'INV-1', total: '250.50', paid: '250.50', due: '0.00', stock: 10 })

    const [da, db_] = await Promise.all([loadDashboard(a.id, null, ALL), loadDashboard(b.id, null, ALL)])
    expect(da.data.salesToday).toBe('1000.00')
    expect(da.data.customerDue).toBe('600.00')
    expect(da.data.stockValue).toBe('200.00')
    expect(da.data.top.map((p) => p.name)).toEqual(['Alpha Phone'])
    expect(db_.data.salesToday).toBe('250.50')
    expect(db_.data.customerDue).toBe('0.00')
    expect(db_.data.stockValue).toBe('1000.00')
    expect(db_.data.top.map((p) => p.name)).toEqual(['Beta Phone'])
    // Without profit visibility the stock value is not computed (the page hides the KPI); low-stock still is.
    const noCost = await loadDashboard(a.id, null, { ...ALL, stockValue: false })
    expect(noCost.data.stockValue).toBe('0.00')
    expect(noCost.failed).toEqual([])

    const db = getDb()
    expect((await salesTotals(db, a.id, null)).today).toBe('1000.00')
    expect((await salesTotals(db, b.id, null)).today).toBe('250.50')
    expect((await dues(db, b.id, null)).customer).toBe('0.00')
    expect(await stockValue(db, a.id, null)).toBe('200.00')
    expect((await topProducts(db, b.id, null)).map((p) => p.revenue)).toEqual(['250.50'])

    // A company id that owns nothing sees nothing.
    const { data } = await loadDashboard('00000000-0000-4000-8000-000000000000', null, ALL)
    expect(data.salesToday).toBe('0.00')
    expect(data.top).toEqual([])
  })
})
