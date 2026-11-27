import { and, eq, sql } from 'drizzle-orm'
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

const TODAY = '2026-11-26'

async function setup() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const demo = await import('./seed')
  return { a, b, db: getDb(), schema, demo }
}
const addDays = async (n: number) => (await import('../dates')).addDays(TODAY, n)

describe('seedDemo', () => {
  it('creates consistent books: cash flow reconciles, no negative stock or balances, P&L revenue = net sales', async () => {
    const { a, db, schema, demo } = await setup()
    const res = await demo.seedDemo(db, a.cid, a.uid, { today: TODAY })
    expect(res.status).toBe('seeded')
    if (res.status !== 'seeded') return
    expect(res.summary).toMatchObject({ products: 12, vendors: 3, customers: 6, purchases: 4, sales: 7, customerReturns: 1, vendorReturns: 1, serviceTickets: 1, expenses: 6, incomes: 3, transfers: 3 })

    const count = async (tbl: typeof schema.products | typeof schema.vendors | typeof schema.customers | typeof schema.purchases | typeof schema.sales) =>
      Number((await db.select({ n: sql<number>`count(*)` }).from(tbl).where(eq(tbl.companyId, a.cid)))[0].n)
    expect([await count(schema.products), await count(schema.vendors), await count(schema.customers), await count(schema.purchases), await count(schema.sales)]).toEqual([12, 3, 6, 4, 7])

    // cash flow reconciliation, for the whole period and for sub-periods
    const { loadCashFlow } = await import('../reports/cashflow')
    const from = await addDays(-60)
    for (const [f, to] of [[from, TODAY], [from, await addDays(-20)], [await addDays(-19), TODAY]] as const) {
      const cf = await loadCashFlow(db, a.cid, null, { from: f, to })
      expect(cf.recon?.ok).toBe(true)
    }
    // no account is overdrawn
    const { listAccountBalances } = await import('../accounting/accounts')
    const balances = await listAccountBalances(db, a.cid, { status: 'all' })
    expect(balances.length).toBeGreaterThanOrEqual(3)
    for (const x of balances) expect(Number(x.balance), x.name).toBeGreaterThanOrEqual(0)

    // stock: never negative; serial stock == in_stock units; the service unit is not counted
    const { stockRows } = await import('../reports/stock')
    const { rows } = await stockRows({ db, companyId: a.cid, branch: null, limit: 1000 }, {})
    expect(rows).toHaveLength(12)
    for (const r of rows) expect(r.onHand, r.sku).toBeGreaterThanOrEqual(0)
    const inStock = await db.select({ pid: schema.productUnits.productId, n: sql<number>`count(*)` }).from(schema.productUnits).where(and(eq(schema.productUnits.companyId, a.cid), eq(schema.productUnits.status, 'in_stock'))).groupBy(schema.productUnits.productId)
    for (const r of rows.filter((x) => x.trackSerial)) expect(r.onHand).toBe(Number(inStock.find((u) => u.pid === r.id)?.n ?? 0))
    const statuses = Object.fromEntries((await db.select({ s: schema.productUnits.status, n: sql<number>`count(*)` }).from(schema.productUnits).where(eq(schema.productUnits.companyId, a.cid)).groupBy(schema.productUnits.status)).map((x) => [x.s, Number(x.n)]))
    expect(statuses).toMatchObject({ in_service: 1, returned_to_vendor: 1 })
    expect(statuses.sold).toBeGreaterThan(10)

    // P&L: net sales = sum of invoice totals; revenue = net sales - returns; equals the sales report's net
    const { loadProfitLoss } = await import('../reports/profit')
    const pl = await loadProfitLoss(db, a.cid, null, { from, to: TODAY })
    const sales = await db.select().from(schema.sales).where(eq(schema.sales.companyId, a.cid))
    const minor = (v: string) => Math.round(Number(v) * 100)
    expect(minor(pl.netSales)).toBe(sales.reduce((x, s) => x + minor(s.total), 0))
    const returns = await db.select().from(schema.saleReturns).where(eq(schema.saleReturns.companyId, a.cid))
    expect(returns).toHaveLength(1)
    expect(minor(pl.revenue)).toBe(minor(pl.netSales) - returns.reduce((x, r) => x + minor(r.creditTotal), 0))
    expect(minor(pl.salesReturns)).toBe(returns.reduce((x, r) => x + minor(r.creditTotal), 0))
    expect(minor(pl.revenue)).toBeGreaterThan(100_000)
    // expenses and other income appear in the P&L
    expect(JSON.stringify(pl.expenses)).toMatch(/Rent/)
    expect(JSON.stringify(pl.otherIncome)).toMatch(/Bank interest/)

    // customer + vendor dues add up to the invoices' dues
    const { getLedger } = await import('../parties/ledger')
    const custs = await db.select().from(schema.customers).where(eq(schema.customers.companyId, a.cid))
    let ledgerDue = 0
    for (const c of custs) ledgerDue += minor((await getLedger(db, a.cid, null, 'customer', c.id)).due)
    expect(ledgerDue).toBe(sales.reduce((x, s) => x + minor(s.due), 0))
    const vends = await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, a.cid))
    let vdue = 0
    for (const v of vends) vdue += minor((await getLedger(db, a.cid, null, 'vendor', v.id)).due)
    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.companyId, a.cid))
    expect(vdue).toBe(purchases.reduce((x, p) => x + minor(p.due), 0))
    expect(purchases.some((p) => p.discount !== '0.00')).toBe(true) // a discounted purchase
    expect(sales.some((s) => minor(s.due) > 0 && minor(s.paid) > 0)).toBe(true) // partial payments
  })

  it("the brief's example: serial lookup returns every fact (ABC Electronics -> HIK123456789 @2000 -> Rahim @2800)", async () => {
    const { a, db, schema, demo } = await setup()
    await demo.seedDemo(db, a.cid, a.uid, { today: TODAY })
    const { searchSerials, getUnitDetail } = await import('../lookup/lookup')
    const found = await searchSerials(db, a.cid, null, 'HIK123456789')
    expect(found.match).toBe('exact')
    const d = await getUnitDetail(db, a.cid, null, { id: found.redirectUnitId as string }, { withCost: true, today: TODAY })
    expect(d.vendor?.name).toBe('ABC Electronics')
    expect(d.unit).toMatchObject({ serialNo: 'HIK123456789', status: 'sold' })
    expect(d.cost).toBe('2000.00')
    expect(d.currentSale).toMatchObject({ customerName: 'Rahim', salePrice: '2800.00', profit: '800.00', date: await addDays(-28) })
    expect(d.currentSale?.invoiceNo).toMatch(/^INV-/)
    expect(d.purchase).toMatchObject({ date: await addDays(-45) })
    expect(d.purchase?.invoiceNo).toMatch(/^PUR-/)
    expect(d.product).toMatchObject({ name: 'Hikvision 2MP Bullet Camera', sku: 'CAM-HIK-2MP' })
    expect(d.warranty).toMatchObject({ months: 12, state: 'active' })
    expect(d.timeline.map((e) => e.type)).toEqual(['purchased', 'sold'])
    // the demo's service ticket is on a different unit
    expect(d.flags).toMatchObject({ serviceTickets: 0, inService: false })
    const tickets = await db.select().from(schema.serviceTickets).where(eq(schema.serviceTickets.companyId, a.cid))
    expect(tickets).toHaveLength(1)
  })

  it('is idempotent: a second run is a no-op (nothing written, even with the same company)', async () => {
    const { a, db, schema, demo } = await setup()
    await demo.seedDemo(db, a.cid, a.uid, { today: TODAY })
    const snapshot = async () => ({
      units: await db.select({ n: sql<number>`count(*)` }).from(schema.productUnits),
      pay: await db.select({ n: sql<number>`count(*)`, s: sql<string>`sum(amount)` }).from(schema.payments),
      act: await db.select({ n: sql<number>`count(*)` }).from(schema.activityLog),
      seq: await db.select().from(schema.docSequences).where(eq(schema.docSequences.companyId, a.cid)),
    })
    const before = await snapshot()
    const again = await demo.seedDemo(db, a.cid, a.uid, { today: TODAY })
    expect(again).toEqual({ status: 'already_seeded' })
    expect(await snapshot()).toEqual(before)
    const [flag] = await db.select().from(schema.settings).where(and(eq(schema.settings.companyId, a.cid), eq(schema.settings.key, 'demo_seeded')))
    expect(flag.value).toBe(TODAY)
  })

  it('refuses a company that already has data unless forced; force still stops on a SKU clash and writes nothing', async () => {
    const { a, db, schema, demo } = await setup()
    const { createParty } = await import('../parties/parties')
    const { createProduct } = await import('../catalog/products')
    await createParty(db, a.cid, a.uid, 'vendor', { name: 'My real vendor' })
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/already has data \(1 vendors/)
    expect(await db.select().from(schema.products)).toHaveLength(0)

    await createProduct(db, a.cid, a.uid, { name: 'Mine', sku: 'CAM-HIK-2MP' })
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY, force: true })).rejects.toThrow(/SKUs already exist: CAM-HIK-2MP/)
    expect(await db.select().from(schema.products)).toHaveLength(1)
    expect(await db.select().from(schema.purchases)).toHaveLength(0)

    await db.delete(schema.products)
    const ok = await demo.seedDemo(db, a.cid, a.uid, { today: TODAY, force: true })
    expect(ok.status).toBe('seeded')
    expect(await db.select().from(schema.vendors)).toHaveLength(4) // the real one is kept
  })

  it('--force with an existing demo category or brand name is refused cleanly before writing anything', async () => {
    const { a, db, schema, demo } = await setup()
    const { createTaxon } = await import('../catalog/taxonomy')
    await createTaxon(db, a.cid, a.uid, 'category', { name: 'networking' })
    await createTaxon(db, a.cid, a.uid, 'brand', { name: 'Hikvision' })
    const before = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid))
    const err = await demo.seedDemo(db, a.cid, a.uid, { today: TODAY, force: true }).catch((e) => e)
    expect(err).toBeInstanceOf(demo.DemoRefusedError)
    expect(err.message).toMatch(/categories networking and brands Hikvision already exist/)
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid))).toEqual(before)
    expect(await db.select().from(schema.products)).toHaveLength(0)
  })

  it('is all-or-nothing: a failure half way (a clashing category) leaves no trace, not even the opening balances', async () => {
    const { a, db, schema, demo } = await setup()
    const { createTaxon } = await import('../catalog/taxonomy')
    await createTaxon(db, a.cid, a.uid, 'category', { name: 'Networking' }) // clashes late in the catalogue step
    const accountsBefore = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid))
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow()
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid))).toEqual(accountsBefore)
    expect(await db.select().from(schema.products)).toHaveLength(0)
    expect(await db.select().from(schema.categories).where(eq(schema.categories.companyId, a.cid))).toHaveLength(1)
    expect(await db.select().from(schema.settings).where(and(eq(schema.settings.companyId, a.cid), eq(schema.settings.key, 'demo_seeded')))).toHaveLength(0)
  })

  it('is deterministic: two fresh databases get identical invoices, serials and amounts', async () => {
    const { a, db, schema, demo } = await setup()
    const fingerprint = async (cid: string) => {
      const sales = await db.select({ n: schema.sales.invoiceNo, d: schema.sales.date, t: schema.sales.total, p: schema.sales.paid }).from(schema.sales).where(eq(schema.sales.companyId, cid)).orderBy(schema.sales.invoiceNo)
      const units = await db.select({ s: schema.productUnits.serialNo, st: schema.productUnits.status, c: schema.productUnits.purchasePrice }).from(schema.productUnits).where(eq(schema.productUnits.companyId, cid)).orderBy(schema.productUnits.serialNo)
      return JSON.stringify({ sales, units })
    }
    await demo.seedDemo(db, a.cid, a.uid, { today: TODAY })
    const one = await fingerprint(a.cid)
    await resetData()
    const again = await setup()
    await again.demo.seedDemo(again.db, again.a.cid, again.a.uid, { today: TODAY })
    expect(await fingerprint(again.a.cid)).toBe(one)
  })

  it('treats expenses, incomes, transfers, tickets, stock records and a non-zero opening balance as real data', async () => {
    const { a, db, schema, demo } = await setup()
    const { createExpense, createIncome } = await import('../accounting/entries')
    const { updateAccount, createTransfer } = await import('../accounting/accounts')
    const accs = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid))
    const [cash, bank] = [accs.find((x) => x.name === 'Cash')!, accs.find((x) => x.name === 'Bank')!]
    await expect(demo.businessDataCounts(db, a.cid)).resolves.toMatchObject({ expenses: 0, 'accounts with an opening balance': 0 })

    await updateAccount(db, a.cid, a.uid, cash.id, { name: 'Cash', type: 'cash', openingBalance: '500' })
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/1 accounts with an opening balance/)
    await updateAccount(db, a.cid, a.uid, cash.id, { name: 'Cash', type: 'cash', openingBalance: '0' })
    await createIncome(db, a.cid, a.uid, { category: 'Gift', accountId: cash.id, amount: '10', date: TODAY }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/1 incomes/)
    await db.delete(schema.payments)
    await db.delete(schema.incomes)
    await createExpense(db, a.cid, a.uid, { accountId: cash.id, amount: '10', date: TODAY }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/1 expenses/)
    await db.delete(schema.payments)
    await db.delete(schema.expenses)
    await createTransfer(db, a.cid, a.uid, { fromAccountId: cash.id, toAccountId: bank.id, amount: '5', date: TODAY }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/2 payments/)
    expect(await db.select().from(schema.products)).toHaveLength(0)
  })

  it('--force never changes existing records: accounts (opening balances), expenses, payments stay byte-identical', async () => {
    const { a, db, schema, demo } = await setup()
    const { createExpense } = await import('../accounting/entries')
    const { updateAccount } = await import('../accounting/accounts')
    const cash = (await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash'))))[0]
    await updateAccount(db, a.cid, a.uid, cash.id, { name: 'Cash', type: 'cash', openingBalance: '1234.50' })
    const cat = (await db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.companyId, a.cid)))[0]
    await createExpense(db, a.cid, a.uid, { categoryId: cat.id, accountId: cash.id, amount: '77.25', date: '2026-11-01', note: 'real rent' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const snap = async () => JSON.stringify({
      accounts: await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid)).orderBy(schema.accounts.name),
      expenses: await db.select().from(schema.expenses).orderBy(schema.expenses.id),
      payments: await db.select().from(schema.payments).orderBy(schema.payments.id),
      categories: await db.select().from(schema.expenseCategories).orderBy(schema.expenseCategories.id),
    })
    const before = JSON.parse(await snap())
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/already has data/)
    expect(JSON.parse(await snap())).toEqual(before)
    const res = await demo.seedDemo(db, a.cid, a.uid, { today: TODAY, force: true })
    expect(res.status).toBe('seeded')
    const after = JSON.parse(await snap())
    // every pre-existing row is identical (same values, same updated_at); the demo only ADDED rows
    for (const k of ['accounts', 'expenses', 'payments', 'categories'] as const) for (const row of before[k]) expect(after[k].find((r: { id: string }) => r.id === row.id), k).toEqual(row)
    expect(after.accounts.length).toBe(before.accounts.length + 3)
    expect(after.accounts.filter((x: { name: string }) => x.name.startsWith('Demo ')).map((x: { name: string }) => x.name).sort()).toEqual(['Demo Cash', 'Demo Bank', 'Demo bKash'].sort())
    expect(after.accounts.find((x: { name: string }) => x.name === 'Cash').openingBalance).toBe('1234.50')
    // the real company's cash position is untouched; demo money lives in the demo accounts
    const { listAccountBalances } = await import('../accounting/accounts')
    const balances = Object.fromEntries((await listAccountBalances(db, a.cid, { status: 'all' })).map((b) => [b.name, b.balance]))
    expect(balances.Cash).toBe('1157.25')
    expect(Number(balances['Demo Bank'])).toBeGreaterThan(0)
  })

  it('refuses when a demo account name is already taken', async () => {
    const { a, db, schema, demo } = await setup()
    const { createAccount } = await import('../accounting/accounts')
    await createAccount(db, a.cid, a.uid, { name: 'demo cash', type: 'cash' })
    await expect(demo.seedDemo(db, a.cid, a.uid, { today: TODAY })).rejects.toThrow(/account names already exist: Demo Cash/)
    expect(await db.select().from(schema.products)).toHaveLength(0)
  })

  it('never creates users', async () => {
    const { a, db, schema, demo } = await setup()
    const before = await db.select().from(schema.users)
    await demo.seedDemo(db, a.cid, a.uid, { today: TODAY })
    expect(await db.select().from(schema.users)).toHaveLength(before.length)
  })
})
