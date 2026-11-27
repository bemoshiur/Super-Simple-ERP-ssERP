import { and, eq } from 'drizzle-orm'
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

type Co = { cid: string; uid: string }
const NOW = new Date('2026-11-26T06:00:00Z') // shop-local 2026-11-26 (Thursday)
const viewer = (co: Co, perms: string[] = ['reports.view', 'accounts.view']) => ({ adm: false, perms, cid: co.cid })

/**
 * The scenario, through the REAL flows (createPurchase / createSale / createSaleReturn / payments / accounting):
 *  Cash opens at 1000.
 *  11-10 P1: 3 cameras @2000 (S1..S3) = 6000, paid 3000 cash        -> due 3000
 *  11-12 P2: 10 cables @40 = 400, nothing paid                      -> due 400
 *  11-15 INV1 Rahim: S1 @2800 + 2 cables @100, discount 100 = 2900, paid 2900 cash
 *  11-16 INV2 Karim: S2 @2800, paid 1000 bank                       -> due 1800
 *  11-18 return of S1 (restocked): credit = its net 2706.67 (discount share), refunded 2706.67 from cash
 *  11-20 vendor pays 1000 on P1 from bank                           -> P1 paid 4000, due 2000
 *  11-22 expense Rent 500 (cash); 11-23 expense Tea 50 (cash) voided on 11-26
 *  11-24 income "Interest" 120.50 (bank); 11-25 transfer 300 cash -> bank
 *  11-26 Karim pays 800 cash                                        -> INV2 paid 1800, due 1000
 */
async function runScenario(co: Co, opts: { prefix: string }) {
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase, recordVendorPayment } = await import('../purchases/purchases')
  const { createSale, createSaleReturn, collectCustomerDue } = await import('../sales/sales')
  const { createAccount, updateAccount, createTransfer } = await import('../accounting/accounts')
  const { createExpense, createExpenseCategory, createIncome, voidEntry } = await import('../accounting/entries')
  const db = getDb()
  const p = opts.prefix
  const cam = await createProduct(db, co.cid, co.uid, { name: `${p}Camera`, sku: `${p}CAM`, trackSerial: true, warrantyMonths: 12, purchasePrice: '2000', salePrice: '2800' })
  const cable = await createProduct(db, co.cid, co.uid, { name: `${p}Cable`, sku: `${p}CAB`, purchasePrice: '40', salePrice: '100' })
  const vendor = await createParty(db, co.cid, co.uid, 'vendor', { name: `${p}ABC Electronics` })
  const rahim = await createParty(db, co.cid, co.uid, 'customer', { name: `${p}Rahim` })
  const karim = await createParty(db, co.cid, co.uid, 'customer', { name: `${p}Karim` })
  let cash = (await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, co.cid), eq(schema.accounts.name, 'Cash'))))[0]
  let bank = (await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, co.cid), eq(schema.accounts.type, 'bank'))))[0]
  if (!cash) cash = await createAccount(db, co.cid, co.uid, { name: 'Cash', type: 'cash' })
  if (!bank) bank = await createAccount(db, co.cid, co.uid, { name: 'Bank', type: 'bank' })
  await updateAccount(db, co.cid, co.uid, cash.id, { name: 'Cash', type: 'cash', openingBalance: '1000' })

  const p1 = await createPurchase(db, co.cid, co.uid, { vendorId: vendor.id, date: '2026-11-10', items: [{ productId: cam.id, qty: 3, unitCost: '2000', serials: [`${p}S1`, `${p}S2`, `${p}S3`] }], paid: '3000', accountId: cash.id }, await (await import('@/test/seed')).mainCtx(co.cid))
  const p2 = await createPurchase(db, co.cid, co.uid, { vendorId: vendor.id, date: '2026-11-12', items: [{ productId: cable.id, qty: 10, unitCost: '40', serials: [] }] }, await (await import('@/test/seed')).mainCtx(co.cid))
  const inv1 = await createSale(db, co.cid, co.uid, {
    customerId: rahim.id,
    date: '2026-11-15',
    discount: '100',
    items: [{ serial: `${p}S1`, qty: 1, unitPrice: '2800' }, { productId: cable.id, qty: 2, unitPrice: '100' }],
    payments: [{ accountId: cash.id, amount: '2900' }],
  }, await (await import('@/test/seed')).mainCtx(co.cid))
  const inv2 = await createSale(db, co.cid, co.uid, { customerId: karim.id, date: '2026-11-16', items: [{ serial: `${p}S2`, qty: 1, unitPrice: '2800' }], payments: [{ accountId: bank.id, amount: '1000' }] }, await (await import('@/test/seed')).mainCtx(co.cid))
  const [s1Line] = await db.select().from(schema.saleItems).where(and(eq(schema.saleItems.saleId, inv1.id), eq(schema.saleItems.productId, cam.id)))
  const ret = await createSaleReturn(db, co.cid, co.uid, inv1.id, { date: '2026-11-18', items: [{ saleItemId: s1Line.id, qty: 1, restock: 'in_stock' }], refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(co.cid))
  await recordVendorPayment(db, co.cid, co.uid, p1.id, { amount: '1000', accountId: bank.id, date: '2026-11-20' }, await (await import('@/test/seed')).mainCtx(co.cid))
  const findRent = () => db.select().from(schema.expenseCategories).where(and(eq(schema.expenseCategories.companyId, co.cid), eq(schema.expenseCategories.name, 'Rent')))
  if (!(await findRent()).length) await createExpenseCategory(db, co.cid, co.uid, { name: 'Rent' }) // company A has it from the installer seed
  const [rent] = await findRent()
  await createExpense(db, co.cid, co.uid, { categoryId: rent.id, accountId: cash.id, amount: '500', date: '2026-11-22', note: 'November rent' }, await (await import('@/test/seed')).mainCtx(co.cid))
  const teaEntry = await createExpense(db, co.cid, co.uid, { categoryId: null, accountId: cash.id, amount: '50', date: '2026-11-23' }, await (await import('@/test/seed')).mainCtx(co.cid))
  await createIncome(db, co.cid, co.uid, { category: 'Interest', accountId: bank.id, amount: '120.50', date: '2026-11-24' }, await (await import('@/test/seed')).mainCtx(co.cid))
  await createTransfer(db, co.cid, co.uid, { fromAccountId: cash.id, toAccountId: bank.id, amount: '300', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(co.cid))
  await voidEntry(db, co.cid, co.uid, 'expense', teaEntry.id, { reason: 'Entered twice' }, { restrict: null }, NOW)
  await collectCustomerDue(db, co.cid, co.uid, karim.id, { amount: '800', accountId: cash.id, date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(co.cid))
  return { db, schema, cam, cable, vendor, rahim, karim, cash, bank, p1, p2, inv1, inv2, ret, rent, teaEntry }
}

const RANGE = { from: '2026-11-01', to: '2026-11-30' }
const run = async (co: Co, key: string, sp: Record<string, string> = RANGE, perms?: string[]) => {
  const { getDb } = await import('../db')
  const { runReport } = await import('./registry')
  return runReport(getDb(), viewer(co, perms), null, key, sp, { now: NOW })
}
const rowsOf = (r: Awaited<ReturnType<typeof run>>, i = 0) => r.result.tables[i].rows
const totalsOf = (r: Awaited<ReturnType<typeof run>>, i = 0) => r.result.tables[i].totals!

async function twoCompanies() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  return { a, b }
}

describe('accounts: balances come from payments only', () => {
  it('opening + in - out, per account, exact; transfers and voids net correctly', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const { listAccountBalances, totalBalance } = await import('../accounting/accounts')
    const bal = await listAccountBalances(x.db, a.cid, { status: 'all' })
    const cash = bal.find((b) => b.name === 'Cash')!
    const bank = bal.find((b) => b.type === 'bank')!
    // cash: 1000 -3000 +2900 -2706.67 -500 -50 +50 -300 +800
    expect(cash).toMatchObject({ opening: '1000.00', totalIn: '3750.00', totalOut: '6556.67', balance: '-1806.67' })
    // bank: +1000 -1000 +120.50 +300
    expect(bank).toMatchObject({ totalIn: '1420.50', totalOut: '1000.00', balance: '420.50' })
    expect(totalBalance(bal)).toBe('-1386.17')
    // As-of: before anything on 11-17 (cash: 1000 - 3000 + 2900)
    const early = await listAccountBalances(x.db, a.cid, { status: 'all', asOf: '2026-11-17' })
    expect(early.find((b) => b.name === 'Cash')!.balance).toBe('900.00')
  })

  it('income/expense write exactly one payment each; the void writes a reversal and keeps the entry', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const pays = await x.db.select().from(x.schema.payments).where(eq(x.schema.payments.refId, x.teaEntry.id))
    expect(pays).toHaveLength(2)
    const orig = pays.find((p) => !p.reversesPaymentId)!
    const rev = pays.find((p) => p.reversesPaymentId)!
    expect(orig).toMatchObject({ direction: 'out', amount: '50.00', refType: 'expense', date: '2026-11-23' })
    expect(rev).toMatchObject({ direction: 'in', amount: '50.00', refType: 'expense', date: '2026-11-26', reversesPaymentId: orig.id })
    const [entry] = await x.db.select().from(x.schema.expenses).where(eq(x.schema.expenses.id, x.teaEntry.id))
    expect(entry.voidedAt).toBeInstanceOf(Date)
    expect(entry.voidReason).toBe('Entered twice')
    const transfers = await x.db.select().from(x.schema.payments).where(eq(x.schema.payments.refType, 'transfer'))
    expect(transfers).toHaveLength(2)
    expect(transfers[0].refId).toBe(transfers[1].refId)
    expect(transfers.map((p) => p.direction).sort()).toEqual(['in', 'out'])
    // a second void is rejected and writes nothing
    const { voidEntry } = await import('../accounting/entries')
    await expect(voidEntry(x.db, a.cid, a.uid, 'expense', x.teaEntry.id, { reason: 'again' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already voided/)
    expect(await x.db.select().from(x.schema.payments).where(eq(x.schema.payments.refId, x.teaEntry.id))).toHaveLength(2)
  })

  it('transfer guards, account rules and deactivation', async () => {
    const { a, b } = await twoCompanies()
    const { getDb, schema } = await import('../db')
    const { createAccount, createTransfer, setAccountActive, updateAccount, listAccountBalances } = await import('../accounting/accounts')
    const db = getDb()
    const c1 = await createAccount(db, a.cid, a.uid, { name: 'Till', type: 'cash', openingBalance: '100' })
    const c2 = await createAccount(db, a.cid, a.uid, { name: 'bKash 2', type: 'mobile' })
    await expect(createAccount(db, a.cid, a.uid, { name: 'Till', type: 'cash' })).rejects.toMatchObject({ fields: { name: expect.stringMatching(/already exists/) } })
    await expect(createTransfer(db, a.cid, a.uid, { fromAccountId: c1.id, toAccountId: c1.id, amount: '5', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toBeTruthy()
    await expect(createTransfer(db, a.cid, a.uid, { fromAccountId: c1.id, toAccountId: c2.id, amount: '0', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toBeTruthy()
    await expect(createTransfer(db, a.cid, a.uid, { fromAccountId: c1.id, toAccountId: c2.id, amount: '5', date: '2030-01-01' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/cannot be later/)
    // another company's account is "not found"
    const [bAcc] = await db.insert(schema.accounts).values({ companyId: b.cid, type: 'cash', name: 'B Cash' }).returning()
    await expect(createTransfer(db, a.cid, a.uid, { fromAccountId: c1.id, toAccountId: bAcc.id, amount: '5', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { toAccountId: 'Account not found' } })
    await createTransfer(db, a.cid, a.uid, { fromAccountId: c1.id, toAccountId: c2.id, amount: '100', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))
    // c1 is now empty: can be deactivated; c2 holds 100: cannot.
    await expect(setAccountActive(db, a.cid, a.uid, c2.id, false)).rejects.toMatchObject({ message: expect.stringMatching(/still holds 100\.00/) })
    await setAccountActive(db, a.cid, a.uid, c1.id, false)
    const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, c1.id))
    expect(row.active).toBe(false)
    // an inactive account cannot receive new payments
    await expect(createTransfer(db, a.cid, a.uid, { fromAccountId: c2.id, toAccountId: c1.id, amount: '1', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { toAccountId: 'Account not found' } })
    // the edit path ignores `active` entirely
    await updateAccount(db, a.cid, a.uid, c1.id, { name: 'Till', type: 'cash', openingBalance: '100', active: true } as never)
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, c1.id)))[0].active).toBe(false)
    await setAccountActive(db, a.cid, a.uid, c1.id, true)
    expect((await listAccountBalances(db, a.cid, { status: 'active' })).some((x) => x.id === c1.id)).toBe(true)
    // history was written for the account edit
    const hist = await db.select().from(schema.recordHistory).where(eq(schema.recordHistory.entityId, c1.id))
    expect(hist.length).toBe(0) // no tracked field changed in the no-op edit
  })
})

describe('reports against the seeded scenario', () => {
  it('sales report: day, week (Saturday start) and month grouping; returns on their own date', async () => {
    const { a } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const day = await run(a, 'sales')
    expect(rowsOf(day)).toEqual([
      expect.objectContaining({ period: '2026-11-15', invoices: 1, gross: '3000.00', discounts: '100.00', sales: '2900.00', returns: '0.00', net: '2900.00' }),
      expect.objectContaining({ period: '2026-11-16', invoices: 1, gross: '2800.00', sales: '2800.00', net: '2800.00' }),
      expect.objectContaining({ period: '2026-11-18', invoices: 0, sales: '0.00', returns: '2706.67', net: '-2706.67' }),
    ])
    expect(totalsOf(day)).toMatchObject({ invoices: 2, gross: '5800.00', discounts: '100.00', sales: '5700.00', returns: '2706.67', net: '2993.33' })
    const week = await run(a, 'sales', { ...RANGE, group: 'week' })
    expect(rowsOf(week)).toEqual([expect.objectContaining({ period: '2026-11-14 to 2026-11-20', invoices: 2, sales: '5700.00', returns: '2706.67', net: '2993.33' })])
    const month = await run(a, 'sales', { ...RANGE, group: 'month' })
    expect(rowsOf(month)).toEqual([expect.objectContaining({ period: '2026-11', net: '2993.33' })])
    // narrower range: only the return
    const only = await run(a, 'sales', { from: '2026-11-17', to: '2026-11-19' })
    expect(totalsOf(only)).toMatchObject({ sales: '0.00', returns: '2706.67', net: '-2706.67' })
    // customer filter
    const { getDb, schema } = await import('../db')
    const [karim] = await getDb().select().from(schema.customers).where(eq(schema.customers.name, 'Karim'))
    const k = await run(a, 'sales', { ...RANGE, customer: karim.id })
    expect(totalsOf(k)).toMatchObject({ sales: '2800.00', returns: '0.00', net: '2800.00' })
  })

  it('SQL week bucket equals the pure bucketStart for every day of 55 days', async () => {
    const { a } = await twoCompanies()
    const { getDb, schema } = await import('../db')
    const { createSale } = await import('../sales/sales')
    const { createProduct } = await import('../catalog/products')
    const { addDays } = await import('../dates')
    const { bucketStart } = await import('./pure')
    const db = getDb()
    const prod = await createProduct(db, a.cid, a.uid, { name: 'Pen', sku: 'PEN', salePrice: '1' })
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: prod.id, type: 'adjustment', qtyChange: 500 })
    for (let i = 0; i < 55; i++) await createSale(db, a.cid, a.uid, { date: addDays('2026-10-01', i), items: [{ productId: prod.id, qty: 1, unitPrice: '1' }], payments: [{ accountId: (await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid)))[0].id, amount: '1' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    for (const group of ['week', 'month'] as const) {
      const r = await run(a, 'sales', { from: '2026-10-01', to: '2026-11-24', group })
      const expected = new Map<string, number>()
      for (let i = 0; i < 55; i++) {
        const k = bucketStart(addDays('2026-10-01', i), group)
        expected.set(k, (expected.get(k) ?? 0) + 1)
      }
      const { bucketLabel } = await import('./pure')
      expect(rowsOf(r).map((x) => [x.period, x.invoices])).toEqual([...expected].sort().map(([k, n]) => [bucketLabel(k, group), n]))
    }
  })

  it('purchase report, vendor-wise and customer-wise', async () => {
    const { a } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const pur = await run(a, 'purchases')
    expect(rowsOf(pur).map((r) => [r.period, r.sales])).toEqual([['2026-11-10', '6000.00'], ['2026-11-12', '400.00']])
    expect(totalsOf(pur)).toMatchObject({ invoices: 2, sales: '6400.00', returns: '0.00', net: '6400.00' })
    const vend = await run(a, 'vendor-purchases')
    expect(rowsOf(vend)).toEqual([expect.objectContaining({ name: 'ABC Electronics', invoices: 2, total: '6400.00', returns: '0.00', net: '6400.00', paid: '4000.00', due: '2400.00' })])
    const cust = await run(a, 'customer-sales')
    const byName = Object.fromEntries(rowsOf(cust).map((r) => [r.name as string, r]))
    expect(byName.Karim).toMatchObject({ invoices: 1, total: '2800.00', returns: '0.00', net: '2800.00', paid: '1800.00', due: '1000.00' })
    expect(byName.Rahim).toMatchObject({ invoices: 1, total: '2900.00', returns: '2706.67', net: '193.33', due: '0.00' })
    expect(totalsOf(cust)).toMatchObject({ total: '5700.00', returns: '2706.67', net: '2993.33' })
    expect(rowsOf(cust)[0].name).toBe('Karim') // biggest net first
  })

  it('stock report and low-stock: serial counts by status, non-serial at average cost', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    await x.db.update(x.schema.products).set({ lowStockThreshold: 8 }).where(eq(x.schema.products.id, x.cable.id))
    await x.db.update(x.schema.products).set({ lowStockThreshold: 1 }).where(eq(x.schema.products.id, x.cam.id))
    const stock = await run(a, 'stock', {})
    const byName = Object.fromEntries(rowsOf(stock).map((r) => [r.name as string, r]))
    expect(byName.Camera).toMatchObject({ type: 'Serial', onHand: 2, sold: 1, inService: 0, damaged: 0, returned: 0, unitCost: '2000.00', value: '4000.00' })
    expect(byName.Cable).toMatchObject({ type: 'Quantity', onHand: 8, unitCost: '40.00', value: '320.00' })
    expect(totalsOf(stock)).toMatchObject({ onHand: 10, value: '4320.00' })
    const { stockValuation, lowStockCount } = await import('./stock')
    expect(await stockValuation(x.db, a.cid, null)).toBe('4320.00')
    const low = await run(a, 'low-stock', {})
    expect(rowsOf(low)).toEqual([expect.objectContaining({ name: 'Cable', onHand: 8, threshold: 8, shortfall: 0 })])
    expect(await lowStockCount(x.db, a.cid, null)).toBe(1)
    // filters
    const cat = await run(a, 'stock', { product: x.cam.id })
    expect(rowsOf(cat).map((r) => r.name)).toEqual(['Camera'])
  })

  it('product profit: net revenue, restocked cost reversed, profit; matches the P&L gross profit', async () => {
    const { a } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const pp = await run(a, 'product-profit')
    const byName = Object.fromEntries(rowsOf(pp).map((r) => [r.name as string, r]))
    expect(byName.Camera).toMatchObject({ qtySold: 2, qtyReturned: 1, revenue: '5506.67', returns: '2706.67', netRevenue: '2800.00', cost: '4000.00', costReturned: '2000.00', netCost: '2000.00', profit: '800.00', margin: '28.57' })
    expect(byName.Cable).toMatchObject({ qtySold: 2, qtyReturned: 0, revenue: '193.33', netRevenue: '193.33', cost: '80.00', profit: '113.33' })
    expect(totalsOf(pp)).toMatchObject({ netRevenue: '2993.33', netCost: '2080.00', profit: '913.33' })
    const pl = await run(a, 'profit-loss')
    const line = Object.fromEntries(rowsOf(pl).map((r) => [(r.line as string).trim(), r.amount]))
    expect(line['Gross profit']).toBe('913.33')
  })

  it('profit & loss: every line, voided entries excluded, purchases excluded', async () => {
    const { a } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const pl = await run(a, 'profit-loss')
    const line = Object.fromEntries(rowsOf(pl).map((r) => [(r.line as string).trim(), r.amount]))
    expect(line).toMatchObject({
      'Gross sales (invoice lines)': '5800.00',
      'Less: discounts': '-100.00',
      'Net sales': '5700.00',
      'Less: sales returns': '-2706.67',
      Revenue: '2993.33', // the section heading has a null amount; the total row overwrites it
      'Cost of items sold': '4080.00',
      'Less: cost of returned goods restocked': '-2000.00',
      'Cost of goods sold': '2080.00',
      'Gross profit': '913.33',
      Rent: '500.00',
      'Total expenses': '500.00',
      Interest: '120.50',
      'Total other income': '120.50',
      'Net profit': '533.83',
    })
    expect(rowsOf(pl).some((r) => String(r.line).trim() === 'Uncategorized')).toBe(false) // the voided 50.00 expense is gone
    // revenue equals the sales report net
    const sales = await run(a, 'sales')
    expect(line.Revenue).toBe(totalsOf(sales).net)
    // purchases (6400) are nowhere in it; a period with no sales has only expenses/income
    const quiet = await run(a, 'profit-loss', { from: '2026-11-22', to: '2026-11-26' })
    const q = Object.fromEntries(rowsOf(quiet).map((r) => [(r.line as string).trim(), r.amount]))
    expect(q['Net profit']).toBe('-379.50') // -500 rent + 120.50 interest
  })

  it('cash flow: per-account opening/in/out/closing reconcile with the account balances', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const cf = await run(a, 'cash-flow')
    const accs = Object.fromEntries(rowsOf(cf, 0).map((r) => [r.name as string, r]))
    expect(accs.Cash).toMatchObject({ opening: '1000.00', inflow: '3750.00', outflow: '6556.67', closing: '-1806.67' })
    expect(accs.Bank).toMatchObject({ opening: '0.00', inflow: '1420.50', outflow: '1000.00', closing: '420.50' })
    expect(totalsOf(cf, 0)).toMatchObject({ opening: '1000.00', inflow: '5170.50', outflow: '7556.67', closing: '-1386.17' })
    expect(cf.result.notes.join(' ')).toMatch(/Reconciled/)
    const { listAccountBalances, totalBalance } = await import('../accounting/accounts')
    expect(totalsOf(cf, 0).closing).toBe(totalBalance(await listAccountBalances(x.db, a.cid, { status: 'all' })))
    // grouped movements
    const ins = Object.fromEntries(rowsOf(cf, 1).map((r) => [r.label as string, r.amount]))
    const outs = Object.fromEntries(rowsOf(cf, 2).map((r) => [r.label as string, r.amount]))
    expect(ins).toMatchObject({ 'Customer receipts (sales)': '4700.00', 'Other income: Interest': '120.50', 'Transfers in': '300.00', 'Void of expense': '50.00' })
    expect(outs).toMatchObject({ 'Customer refunds (returns)': '2706.67', 'Vendor payments (purchases)': '4000.00', 'Expense: Rent': '500.00', 'Transfers out': '300.00', 'Expense: Uncategorized': '50.00' })
    expect(totalsOf(cf, 1).amount).toBe('5170.50')
    expect(totalsOf(cf, 2).amount).toBe('7556.67')
    // any sub-period also reconciles: opening of the next period = closing of the previous
    const p1 = await run(a, 'cash-flow', { from: '2026-11-01', to: '2026-11-17' })
    const p2 = await run(a, 'cash-flow', { from: '2026-11-18', to: '2026-11-30' })
    expect(totalsOf(p1, 0).closing).toBe(totalsOf(p2, 0).opening)
    expect(p1.result.notes.join(' ')).toMatch(/Reconciled/)
    expect(p2.result.notes.join(' ')).toMatch(/Reconciled/)
    expect(totalsOf(p2, 0).closing).toBe(totalsOf(cf, 0).closing)
    // an empty future period carries the balance forward
    const future = await run(a, 'cash-flow', { from: '2026-12-01', to: '2026-12-31' })
    expect(totalsOf(future, 0)).toMatchObject({ opening: '-1386.17', inflow: '0.00', outflow: '0.00', closing: '-1386.17' })
  })

  it('warranty expiry: windows and non-sold units', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    await x.db.update(x.schema.productUnits).set({ warrantyEnd: '2026-12-10' }).where(eq(x.schema.productUnits.serialNo, 'S2'))
    const w30 = await run(a, 'warranty', { days: '30' })
    expect(rowsOf(w30)).toEqual([expect.objectContaining({ serialNo: 'S2', productName: 'Camera', customerName: 'Karim', invoiceNo: 'INV-00002', warrantyEnd: '2026-12-10', daysLeft: 14, window: 'Within 30 days' })])
    expect(w30.params.days).toBe(30)
    await x.db.update(x.schema.productUnits).set({ warrantyEnd: '2027-01-20' }).where(eq(x.schema.productUnits.serialNo, 'S2'))
    expect(rowsOf(await run(a, 'warranty', { days: '30' }))).toHaveLength(0)
    expect(rowsOf(await run(a, 'warranty', { days: '60' }))).toEqual([expect.objectContaining({ daysLeft: 55, window: 'Within 60 days' })])
    await x.db.update(x.schema.productUnits).set({ warrantyEnd: '2027-02-10' }).where(eq(x.schema.productUnits.serialNo, 'S2'))
    expect(rowsOf(await run(a, 'warranty', { days: '60' }))).toHaveLength(0)
    expect(rowsOf(await run(a, 'warranty', { days: '90' }))).toEqual([expect.objectContaining({ daysLeft: 76, window: 'Within 90 days' })])
    // a unit that is not sold is never listed
    await x.db.update(x.schema.productUnits).set({ status: 'damaged' }).where(eq(x.schema.productUnits.serialNo, 'S2'))
    expect(rowsOf(await run(a, 'warranty', { days: '90' }))).toHaveLength(0)
  })

  it('dues with aging buckets from SQL; vendor open invoices', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const { customerDues, vendorDuesSummary, vendorDueInvoices } = await import('../accounting/dues')
    const cust = await customerDues(x.db, a.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })
    expect(cust.rows).toEqual([expect.objectContaining({ name: 'Karim', invoices: 1, current: '1000.00', d30: '0.00', d60: '0.00', d90: '0.00', total: '1000.00' })])
    // 2026-11-16 invoice: age 10 / 30 / 60 / 90 days -> buckets
    for (const [today, key] of [['2026-12-16', 'd30'], ['2027-01-15', 'd60'], ['2027-02-14', 'd90']] as const) {
      const r = await customerDues(x.db, a.cid, null, { today, limit: 20, offset: 0 })
      expect(r.rows[0]).toMatchObject({ [key]: '1000.00', total: '1000.00' })
      expect(r.totals[key]).toBe('1000.00')
    }
    const { agingBucket } = await import('./pure')
    expect(agingBucket(30)).toBe('30')
    const vend = await vendorDuesSummary(x.db, a.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })
    expect(vend.rows).toEqual([expect.objectContaining({ name: 'ABC Electronics', invoices: 2, total: '2400.00' })])
    const inv = await vendorDueInvoices(x.db, a.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })
    expect(inv.rows.map((r) => [r.invoiceNo, r.due, r.ageDays, r.bucket])).toEqual([['PUR-00001', '2000.00', 16, 'current'], ['PUR-00002', '400.00', 14, 'current']])
    expect(inv.count).toBe(2)
    // the existing payment code settles the due list (no duplicate logic)
    const { recordVendorPayment } = await import('../purchases/purchases')
    await recordVendorPayment(x.db, a.cid, a.uid, x.p2.id, { amount: '400', accountId: x.cash.id, date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect((await vendorDueInvoices(x.db, a.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })).count).toBe(1)
  })

  it('payments history: filters, totals and the CSV rows', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const { listPayments, paymentCsvRows } = await import('../accounting/payments')
    const all = await listPayments(x.db, a.cid, null, { limit: 100, offset: 0 })
    expect(all.total).toBe(12)
    expect(all.totalIn).toBe('5170.50')
    expect(all.totalOut).toBe('7556.67')
    const refunds = await listPayments(x.db, a.cid, null, { refType: 'sale', direction: 'out', limit: 10, offset: 0 })
    expect(refunds.rows).toEqual([expect.objectContaining({ amount: '2706.67', partyName: 'Rahim', refLabel: 'INV-00001', date: '2026-11-18' })])
    const vend = await listPayments(x.db, a.cid, null, { partyType: 'vendor', limit: 10, offset: 0 })
    expect(vend.totalOut).toBe('4000.00')
    expect((await listPayments(x.db, a.cid, null, { partyType: 'none', limit: 100, offset: 0 })).total).toBe(6) // rent, tea, void, income, 2 transfer rows
    expect((await listPayments(x.db, a.cid, null, { accountId: x.bank.id, from: '2026-11-24', to: '2026-11-25', limit: 10, offset: 0 })).rows.map((r) => r.amount).sort()).toEqual(['120.50', '300.00'])
    expect((await listPayments(x.db, a.cid, null, { method: 'void', limit: 10, offset: 0 })).total).toBe(1)
    const page2 = await listPayments(x.db, a.cid, null, { limit: 5, offset: 5 })
    expect(page2.rows).toHaveLength(5)
    expect(page2.total).toBe(12)
    const csv = paymentCsvRows(refunds.rows)
    expect(csv[0]).toMatchObject({ direction: 'Out', amount: '-2706.67', party: 'Rahim', reference: 'INV-00001', type: 'sale' })
  })

  it('income/expense lists, categories and totals exclude voided rows by default', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const { listExpenses, listIncomes, incomeCategorySuggestions, updateExpense } = await import('../accounting/entries')
    const ex = await listExpenses(x.db, a.cid, null, { limit: 20, offset: 0 })
    expect(ex.total).toBe(1)
    expect(ex.sum).toBe('500.00')
    expect(ex.rows[0]).toMatchObject({ category: 'Rent', accountName: 'Cash', note: 'November rent' })
    const all = await listExpenses(x.db, a.cid, null, { status: 'all', limit: 20, offset: 0 })
    expect(all.total).toBe(2)
    expect(all.sum).toBe('500.00')
    expect((await listExpenses(x.db, a.cid, null, { status: 'voided', limit: 20, offset: 0 })).rows[0].voidReason).toBe('Entered twice')
    expect((await listIncomes(x.db, a.cid, null, { limit: 20, offset: 0 })).sum).toBe('120.50')
    expect(await incomeCategorySuggestions(x.db, a.cid)).toEqual(['Interest'])
    await expect(updateExpense(x.db, a.cid, a.uid, x.teaEntry.id, { categoryId: null, note: 'x' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/voided/)
    await updateExpense(x.db, a.cid, a.uid, (await listExpenses(x.db, a.cid, null, { limit: 1, offset: 0 })).rows[0].id, { categoryId: x.rent.id, note: 'Rent Nov' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const hist = await x.db.select().from(x.schema.recordHistory).where(eq(x.schema.recordHistory.entity, 'expense'))
    expect(hist.length).toBeGreaterThanOrEqual(2) // the edit and the void
  })
})

describe('dashboard is net of returns and uses the report functions', () => {
  it('sales today/month, 7-day series, top products, stock value and low stock agree with the reports', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const { salesTotals, salesLast7Days, topProducts, stockValue, lowStockCount } = await import('../dashboard')
    const t = await salesTotals(x.db, a.cid, null, 'Asia/Dhaka', NOW)
    expect(t).toEqual({ today: '0.00', month: '2993.33' }) // net of the 2706.67 return, NOT the gross 5700.00
    const month = await run(a, 'sales', { from: '2026-11-01', to: '2026-11-26' })
    expect(t.month).toBe(totalsOf(month).net)
    const last7 = await salesLast7Days(x.db, a.cid, null, 'Asia/Dhaka', NOW)
    expect(last7).toHaveLength(7)
    expect(last7[0].day).toBe('2026-11-20')
    expect(last7.map((p) => p.total).every((v) => v === '0.00')).toBe(true) // 11-18 is outside the last 7 days
    const top = await topProducts(x.db, a.cid, null, 'Asia/Dhaka', 5, NOW)
    expect(top).toEqual([{ name: 'Camera', revenue: '2800.00', units: 1 }, { name: 'Cable', revenue: '193.33', units: 2 }])
    expect(await stockValue(x.db, a.cid, null)).toBe('4320.00')
    expect(await lowStockCount(x.db, a.cid, null)).toBe(0)
  })
})

describe('cross-company isolation on every report query', () => {
  it('a second company with the same dates changes nothing in company A, and vice versa', async () => {
    const { a, b } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const keys = ['sales', 'purchases', 'stock', 'low-stock', 'product-profit', 'customer-sales', 'vendor-purchases', 'warranty', 'profit-loss', 'cash-flow']
    const sp: Record<string, string> = { ...RANGE, days: '90' }
    const before = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, (await run(a, k, sp)).result])))
    // Company B: same dates, other amounts/names (and same SKUs/serial text are legal across companies).
    await runScenario(b, { prefix: 'B-' })
    const { getDb, schema } = await import('../db')
    await getDb().update(schema.productUnits).set({ warrantyEnd: '2026-12-01' }).where(eq(schema.productUnits.companyId, b.cid))
    const after = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, (await run(a, k, sp)).result])))
    expect(after).toEqual(before)
    // B's results contain only B's names and A's figures never leak
    for (const k of keys) {
      const bRes = (await run(b, k, sp)).result
      const text = JSON.stringify(bRes)
      expect(text).not.toMatch(/"(Camera|Cable|Rahim|Karim|ABC Electronics)"/)
    }
    const { listAccountBalances } = await import('../accounting/accounts')
    const { listPayments } = await import('../accounting/payments')
    const { customerDues, vendorDuesSummary, vendorDueInvoices } = await import('../accounting/dues')
    const { listExpenses, listIncomes, listExpenseCategories } = await import('../accounting/entries')
    const db = getDb()
    const balA = await listAccountBalances(db, a.cid, { status: 'all' })
    const balB = await listAccountBalances(db, b.cid, { status: 'all' })
    expect(new Set([...balA, ...balB].map((x) => x.id)).size).toBe(balA.length + balB.length)
    expect((await listPayments(db, a.cid, null, { limit: 200, offset: 0 })).total).toBe(12)
    expect((await listPayments(db, b.cid, null, { limit: 200, offset: 0 })).total).toBe(12)
    expect((await customerDues(db, b.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })).rows.map((r) => r.name)).toEqual(['B-Karim'])
    expect((await vendorDuesSummary(db, b.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })).rows.map((r) => r.name)).toEqual(['B-ABC Electronics'])
    expect((await vendorDueInvoices(db, a.cid, null, { today: '2026-11-26', limit: 20, offset: 0 })).rows.every((r) => !r.vendorName.startsWith('B-'))).toBe(true)
    expect((await listExpenses(db, a.cid, null, { limit: 50, offset: 0 })).sum).toBe('500.00')
    expect((await listIncomes(db, b.cid, null, { limit: 50, offset: 0 })).sum).toBe('120.50')
    expect((await listExpenseCategories(db, a.cid)).map((c) => c.name)).not.toContain('B-')
    // a company id that owns nothing sees nothing
    const ghost = { cid: '00000000-0000-4000-8000-000000000000', uid: a.uid }
    for (const k of keys) {
      const r = await run(ghost, k, sp)
      for (const tbl of r.result.tables) expect(tbl.rows.every((row) => Object.values(row).every((v) => v === null || v === 0 || v === '0.00' || typeof v === 'string' && !/Camera|Cable|Rahim|Karim|ABC/.test(v)))).toBe(true)
    }
  })

  it('by-id mutations are company scoped (account, expense, category)', async () => {
    const { a, b } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const { updateAccount, setAccountActive } = await import('../accounting/accounts')
    const { voidEntry, updateExpense, renameExpenseCategory, createExpense } = await import('../accounting/entries')
    await expect(updateAccount(x.db, b.cid, b.uid, x.cash.id, { name: 'Hacked', type: 'cash' })).rejects.toThrow(/not found/)
    await expect(setAccountActive(x.db, b.cid, b.uid, x.cash.id, true)).rejects.toThrow(/not found/)
    const [rentEntry] = await x.db.select().from(x.schema.expenses).where(eq(x.schema.expenses.categoryId, x.rent.id))
    await expect(voidEntry(x.db, b.cid, b.uid, 'expense', rentEntry.id, { reason: 'x' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toThrow(/not found/)
    await expect(updateExpense(x.db, b.cid, b.uid, rentEntry.id, { categoryId: null }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toThrow(/not found/)
    await expect(renameExpenseCategory(x.db, b.cid, b.uid, x.rent.id, { name: 'X' })).rejects.toThrow(/not found/)
    await expect(createExpense(x.db, b.cid, b.uid, { accountId: x.cash.id, amount: '5', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { accountId: 'Account not found' } })
    await expect(createExpense(x.db, a.cid, a.uid, { accountId: x.cash.id, categoryId: '00000000-0000-4000-8000-000000000001', amount: '5', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { categoryId: 'Category not found' } })
  })
})

describe('fix round 1: totals over every row, void guard, CSV notes', () => {
  it('product-profit and party totals cover ALL rows even when the displayed rows are capped', async () => {
    const { a } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const { getDb } = await import('../db')
    const { runReport } = await import('./registry')
    for (const key of ['product-profit', 'customer-sales', 'vendor-purchases', 'stock']) {
      const full = await runReport(getDb(), viewer(a), null, key, key === 'stock' ? {} : RANGE, { now: NOW })
      const capped = await runReport(getDb(), viewer(a), null, key, key === 'stock' ? {} : RANGE, { now: NOW, limit: 1 })
      expect(capped.result.truncated, key).toBe(key !== 'vendor-purchases')
      expect(capped.result.tables[0].rows.length).toBeLessThanOrEqual(1)
      const f = full.result.tables[0].totals!
      const c = capped.result.tables[0].totals!
      for (const k of Object.keys(f)) if (k !== 'onHand') expect(c[k], `${key}.${k}`).toEqual(f[k])
    }
  })

  it('voiding is refused while the entry account is deactivated', async () => {
    const { a } = await twoCompanies()
    const x = await runScenario(a, { prefix: '' })
    const [rentEntry] = await x.db.select().from(x.schema.expenses).where(eq(x.schema.expenses.categoryId, x.rent.id))
    await x.db.update(x.schema.accounts).set({ active: false }).where(eq(x.schema.accounts.id, x.cash.id))
    const { voidEntry } = await import('../accounting/entries')
    await expect(voidEntry(x.db, a.cid, a.uid, 'expense', rentEntry.id, { reason: 'x' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: expect.stringMatching(/Reactivate it before voiding/) })
    expect(await x.db.select().from(x.schema.payments).where(eq(x.schema.payments.refId, rentEntry.id))).toHaveLength(1)
    await x.db.update(x.schema.accounts).set({ active: true }).where(eq(x.schema.accounts.id, x.cash.id))
    await voidEntry(x.db, a.cid, a.uid, 'expense', rentEntry.id, { reason: 'x' }, await (await import('@/test/seed')).mainCtx(a.cid))
  })

  it('cash-flow CSV carries the reconciliation line and the opening-balance rule is on the page', async () => {
    const { a } = await twoCompanies()
    await runScenario(a, { prefix: '' })
    const { reportToCsv } = await import('./registry')
    const r = await run(a, 'cash-flow')
    const csv = reportToCsv(r.result)
    expect(csv).toContain('Reconciled: the closing balances equal the account balances')
    expect(r.result.notes.join(' ')).toMatch(/Opening balance rule/)
  })

  it('bad payment filter params never throw', async () => {
    const { parsePaymentFilter } = await import('../accounting/payments')
    expect(parsePaymentFilter({ from: '2026-02-30', to: 'x', account: "'; drop table", direction: 'sideways', party: 'alien', ref: 'nope', method: 'a'.repeat(500) })).toEqual({ from: undefined, to: undefined, direction: undefined, accountId: undefined, partyType: undefined, method: 'a'.repeat(50), refType: undefined })
    expect(parsePaymentFilter({ account: '11111111-1111-4111-8111-111111111111', from: '2026-11-01' })).toMatchObject({ accountId: '11111111-1111-4111-8111-111111111111', from: '2026-11-01' })
  })
})
