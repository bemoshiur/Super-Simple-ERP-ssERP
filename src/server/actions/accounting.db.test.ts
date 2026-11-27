import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

// Same seam as sales.db.test.ts: real DB, real RBAC check, session injected through the auth module.
const st = vi.hoisted(() => ({ session: null as null | { uid: string; cid: string; bid: null; role: string; adm: boolean; sv: number; perms: string[] } }))
vi.mock('../auth/current', async () => {
  const { requirePermission } = await import('../rbac')
  return { authorize: async (key: never) => requirePermission(st.session, key), getSession: async () => st.session }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})
beforeEach(async () => {
  await resetData()
  st.session = null
})

const denied = { ok: false, error: expect.stringMatching(/permission/) }

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const db = getDb()
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const [bank] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.type, 'bank')))
  const [rent] = await db.select().from(schema.expenseCategories).where(and(eq(schema.expenseCategories.companyId, a.cid), eq(schema.expenseCategories.name, 'Rent')))
  const as = (perms: string[], cid = a.cid, uid = a.uid) => (st.session = { uid, cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  return { a, b, db, schema, cash, bank, rent, as }
}

describe('accounting actions: permissions', () => {
  it('view-only cannot create, edit, void or deactivate anything', async () => {
    const { db, schema, cash, bank, rent, as } = await seed()
    const act = await import('./accounting')
    as(['accounts.view'])
    expect(await act.createAccountAction({ name: 'X', type: 'cash' })).toMatchObject(denied)
    expect(await act.updateAccountAction(cash.id, { name: 'Y', type: 'cash' })).toMatchObject(denied)
    expect(await act.deactivateAccountAction(bank.id)).toMatchObject(denied)
    expect(await act.activateAccountAction(bank.id)).toMatchObject(denied)
    expect(await act.createTransferAction({ fromAccountId: cash.id, toAccountId: bank.id, amount: '5', date: '2026-11-25' })).toMatchObject(denied)
    expect(await act.createExpenseAction({ accountId: cash.id, amount: '5', date: '2026-11-25' })).toMatchObject(denied)
    expect(await act.createIncomeAction({ accountId: cash.id, amount: '5', date: '2026-11-25' })).toMatchObject(denied)
    expect(await act.createExpenseCategoryAction({ name: 'Z' })).toMatchObject(denied)
    expect(await act.renameExpenseCategoryAction(rent.id, { name: 'Z' })).toMatchObject(denied)
    expect(await act.deactivateExpenseCategoryAction(rent.id)).toMatchObject(denied)
    expect(await act.voidExpenseAction(rent.id, { reason: 'x' })).toMatchObject(denied)
    expect(await act.voidIncomeAction(rent.id, { reason: 'x' })).toMatchObject(denied)
    expect(await db.select().from(schema.payments)).toHaveLength(0)
    expect(await db.select().from(schema.expenses)).toHaveLength(0)
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, cash.id)))[0].name).toBe('Cash')
  })

  it('each permission unlocks exactly its own actions; create can add but not edit/void/deactivate', async () => {
    const { db, schema, cash, bank, as } = await seed()
    const act = await import('./accounting')
    as(['accounts.view', 'accounts.create'])
    const acc = await act.createAccountAction({ name: 'Petty cash', type: 'cash', openingBalance: '50' })
    expect(acc).toMatchObject({ ok: true })
    const exp = await act.createExpenseAction({ accountId: cash.id, amount: '5.50', date: '2026-11-25', note: 'tea' })
    expect(exp).toMatchObject({ ok: true })
    expect(await act.createIncomeAction({ accountId: bank.id, amount: '9', date: '2026-11-25', category: 'Misc' })).toMatchObject({ ok: true })
    expect(await act.createTransferAction({ fromAccountId: cash.id, toAccountId: bank.id, amount: '1', date: '2026-11-25' })).toMatchObject({ ok: true })
    const id = (exp as { data: { id: string } }).data.id
    expect(await act.updateExpenseAction(id, { note: 'x' })).toMatchObject(denied)
    expect(await act.voidExpenseAction(id, { reason: 'x' })).toMatchObject(denied)
    expect(await act.deactivateAccountAction(bank.id)).toMatchObject(denied)

    as(['accounts.view', 'accounts.edit'])
    expect(await act.updateExpenseAction(id, { note: 'edited' })).toMatchObject({ ok: true })
    expect(await act.updateAccountAction(cash.id, { name: 'Cash', type: 'cash', openingBalance: '10' })).toMatchObject({ ok: true })
    expect(await act.createExpenseAction({ accountId: cash.id, amount: '5', date: '2026-11-25' })).toMatchObject(denied)
    expect(await act.voidExpenseAction(id, { reason: 'x' })).toMatchObject(denied) // void needs delete, not edit
    expect(await act.deactivateAccountAction(bank.id)).toMatchObject(denied)

    as(['accounts.view', 'accounts.delete'])
    expect(await act.voidExpenseAction(id, { reason: 'duplicate' })).toMatchObject({ ok: true, data: { reversedOn: expect.any(String) } })
    expect(await act.voidExpenseAction(id, { reason: 'duplicate' })).toMatchObject({ ok: false, error: expect.stringMatching(/already voided/) })
    // a bank account that still holds money cannot be deactivated even with the permission
    expect(await act.deactivateAccountAction(bank.id)).toMatchObject({ ok: false, error: expect.stringMatching(/still holds/) })
    const empty = (acc as { data: { id: string } }).data.id
    await db.update(schema.accounts).set({ openingBalance: '0' }).where(eq(schema.accounts.id, empty))
    expect(await act.deactivateAccountAction(empty)).toMatchObject({ ok: true })
    // reactivation is a different permission (edit): delete alone cannot
    expect(await act.activateAccountAction(empty)).toMatchObject(denied)
    as(['accounts.edit'])
    expect(await act.activateAccountAction(empty)).toMatchObject({ ok: true })
    // the generic edit never flips `active`
    expect(await act.deactivateAccountAction(empty)).toMatchObject(denied)
    await act.updateAccountAction(empty, { name: 'Petty cash', type: 'cash', openingBalance: '0', active: false })
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, empty)))[0].active).toBe(true)
  })

  it('unauthenticated and cross-company calls fail cleanly', async () => {
    const { a, b, cash, rent, as } = await seed()
    const act = await import('./accounting')
    expect(await act.createExpenseAction({ accountId: cash.id, amount: '5', date: '2026-11-25' })).toMatchObject({ ok: false, error: expect.stringMatching(/session|sign in/i) })
    as(['accounts.view', 'accounts.create', 'accounts.edit', 'accounts.delete'], b.cid, b.uid)
    expect(await act.updateAccountAction(cash.id, { name: 'Hacked', type: 'cash' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
    expect(await act.deactivateAccountAction(cash.id)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
    expect(await act.renameExpenseCategoryAction(rent.id, { name: 'Hacked' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
    expect(await act.createExpenseAction({ accountId: cash.id, amount: '5', date: '2026-11-25' })).toMatchObject({ ok: false, fieldErrors: { accountId: 'Account not found' } })
    expect(await act.createTransferAction({ fromAccountId: cash.id, toAccountId: cash.id, amount: '5', date: '2026-11-25' })).toMatchObject({ ok: false })
    void a
  })

  it('a bogus payload gets friendly field errors, never SQL', async () => {
    const { cash, as } = await seed()
    const act = await import('./accounting')
    as(['accounts.create'])
    const r = await act.createExpenseAction({ accountId: cash.id, amount: 'abc', date: 'tomorrow' })
    expect(r).toMatchObject({ ok: false, fieldErrors: { amount: expect.any(String), date: expect.any(String) } })
    expect(JSON.stringify(r)).not.toMatch(/select |insert |relation/i)
  })
})

describe('reports: permissions through the registry and the CSV route handlers', () => {
  it('without reports.view there are no reports and no CSV; the default salesman gets nothing', async () => {
    const { a, db, as } = await seed()
    const { runReport } = await import('../reports/registry')
    const { DEFAULT_ROLE_PERMISSIONS } = await import('../rbac')
    const salesman = { adm: false, perms: DEFAULT_ROLE_PERMISSIONS.salesman, cid: a.cid }
    for (const key of ['sales', 'stock', 'product-profit', 'profit-loss', 'cash-flow']) await expect(runReport(db, salesman, null, key, {})).rejects.toThrow(/permission/i)
    await expect(runReport(db, { adm: false, perms: ['sales.edit', 'accounts.view'], cid: a.cid }, null, 'sales', {})).rejects.toThrow()

    const { GET } = await import('../../app/(admin)/reports/[key]/csv/route')
    const call = (key: string, qs = '') => GET(new Request(`http://x/reports/${key}/csv${qs}`), { params: Promise.resolve({ key }) })
    expect((await call('sales')).status).toBe(401) // no session
    as(DEFAULT_ROLE_PERMISSIONS.salesman)
    expect((await call('sales')).status).toBe(403)
    expect((await call('profit-loss')).status).toBe(403)
    as(['accounts.view', 'sales.edit'])
    expect((await call('product-profit')).status).toBe(403)
    as(['reports.view'])
    expect((await call('nope')).status).toBe(404)
    expect((await call('sales')).status).toBe(200)
    // payments CSV is gated by accounts.view
    const pay = await import('../../app/(admin)/payments/csv/route')
    expect((await pay.GET(new Request('http://x/payments/csv'))).status).toBe(403)
    as(['accounts.view'])
    expect((await pay.GET(new Request('http://x/payments/csv'))).status).toBe(200)
    st.session = null
    expect((await pay.GET(new Request('http://x/payments/csv'))).status).toBe(401)
  })

  it('the CSV is UTF-8 with a BOM, keeps Bengali, neutralises formulas and is company scoped', async () => {
    const { a, b, db, schema, as } = await seed()
    const { createParty } = await import('../parties/parties')
    await createParty(db, a.cid, a.uid, 'customer', { name: '=HYPERLINK("http://evil","x")' })
    await createParty(db, a.cid, a.uid, 'customer', { name: 'রহিম, ঢাকা' })
    await createParty(db, b.cid, b.uid, 'customer', { name: 'B-only customer' })
    const { createProduct } = await import('../catalog/products')
    const prod = await createProduct(db, a.cid, a.uid, { name: 'Pen', sku: 'PEN', salePrice: '10' })
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: prod.id, type: 'adjustment', qtyChange: 10 })
    const { createSale } = await import('../sales/sales')
    const [cust] = await db.select().from(schema.customers).where(eq(schema.customers.name, '=HYPERLINK("http://evil","x")'))
    const [cust2] = await db.select().from(schema.customers).where(eq(schema.customers.name, 'রহিম, ঢাকা'))
    for (const c of [cust, cust2]) await createSale(db, a.cid, a.uid, { customerId: c.id, date: '2026-11-20', items: [{ productId: prod.id, qty: 1, unitPrice: '10' }], payments: [{ accountId: (await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid)))[0].id, amount: '10' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    as(['reports.view'])
    const { GET } = await import('../../app/(admin)/reports/[key]/csv/route')
    const res = await GET(new Request('http://x/reports/customer-sales/csv?from=2026-11-01&to=2026-11-30'), { params: Promise.resolve({ key: 'customer-sales' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="customer-sales_2026-11-01_2026-11-30.csv"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // BOM
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('"রহিম, ঢাকা"')
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`) // injection neutralised, quotes escaped
    expect(text).not.toContain('B-only customer')
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(4) // header + 2 customers + total
    // an invalid range falls back instead of failing
    expect((await GET(new Request('http://x/reports/sales/csv?from=garbage&to=2026-13-45'), { params: Promise.resolve({ key: 'sales' }) })).status).toBe(200)
  })

  it('payments CSV honours the page filters and signs outflows', async () => {
    const { a, db, schema, cash, bank, as } = await seed()
    const { createTransfer } = await import('../accounting/accounts')
    await createTransfer(db, a.cid, a.uid, { fromAccountId: cash.id, toAccountId: bank.id, amount: '12.50', date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))
    as(['accounts.view'])
    const pay = await import('../../app/(admin)/payments/csv/route')
    const text = await (await pay.GET(new Request(`http://x/payments/csv?direction=out&ref=transfer&account=${cash.id}`))).text()
    const lines = text.replace(/^﻿/, '').split('\r\n').filter(Boolean)
    expect(lines[0]).toBe('Date,Direction,Account,Party,Type,Reference,Method,Amount,Note')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('Out,Cash')
    expect(lines[1]).toContain(',-12.50,')
    void schema
  })

  it('extra permissions: reports.view alone cannot open cash flow or P&L (page logic, registry and CSV); both permissions see everything', async () => {
    const { a, db, as } = await seed()
    const { runReport, REPORTS, canOpenReport } = await import('../reports/registry')
    const only = { adm: false, perms: ['reports.view'], cid: a.cid }
    const both = { adm: false, perms: ['reports.view', 'accounts.view'], cid: a.cid }
    for (const key of ['cash-flow', 'profit-loss']) {
      await expect(runReport(db, only, null, key, {})).rejects.toThrow(/permission/i)
      await expect(runReport(db, both, null, key, {})).resolves.toBeTruthy()
    }
    for (const key of ['sales', 'purchases', 'stock', 'low-stock', 'product-profit', 'customer-sales', 'vendor-purchases', 'warranty']) await expect(runReport(db, only, null, key, {})).resolves.toBeTruthy()
    expect(REPORTS.filter((r) => canOpenReport(only, r)).map((r) => r.key)).not.toEqual(expect.arrayContaining(['cash-flow']))
    expect(REPORTS.filter((r) => canOpenReport(both, r))).toHaveLength(REPORTS.length)
    const { GET } = await import('../../app/(admin)/reports/[key]/csv/route')
    const call = (key: string) => GET(new Request(`http://x/reports/${key}/csv`), { params: Promise.resolve({ key }) })
    as(['reports.view'])
    expect((await call('cash-flow')).status).toBe(403)
    expect((await call('profit-loss')).status).toBe(403)
    expect((await call('sales')).status).toBe(200)
    as(['reports.view', 'accounts.view'])
    expect((await call('cash-flow')).status).toBe(200)
    expect((await call('profit-loss')).status).toBe(200)
  })

  it('exports over the cap are refused with 413, never cut short', async () => {
    const { a, db, schema, as } = await seed()
    const { createParty } = await import('../parties/parties')
    const { createProduct } = await import('../catalog/products')
    const { createSale } = await import('../sales/sales')
    const prod = await createProduct(db, a.cid, a.uid, { name: 'Pen', sku: 'PEN', salePrice: '10' })
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: prod.id, type: 'adjustment', qtyChange: 50 })
    const cash = (await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid)))[0]
    for (const n of ['C1', 'C2', 'C3']) {
      const c = await createParty(db, a.cid, a.uid, 'customer', { name: n })
      await createSale(db, a.cid, a.uid, { customerId: c.id, date: '2026-11-20', items: [{ productId: prod.id, qty: 1, unitPrice: '10' }], payments: [{ accountId: cash.id, amount: '10' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    }
    const { exportLimits } = await import('../reports/csvResponse')
    const rep = await import('../../app/(admin)/reports/[key]/csv/route')
    const pay = await import('../../app/(admin)/payments/csv/route')
    const call = (qs = '') => rep.GET(new Request(`http://x/reports/customer-sales/csv?from=2026-11-01&to=2026-11-30${qs}`), { params: Promise.resolve({ key: 'customer-sales' }) })
    as(['reports.view', 'accounts.view'])
    const saved = { ...exportLimits }
    try {
      exportLimits.reports = 3
      exportLimits.payments = 3
      expect((await call()).status).toBe(200) // exactly at the cap: complete
      expect((await pay.GET(new Request('http://x/payments/csv'))).status).toBe(200)
      exportLimits.reports = 2
      exportLimits.payments = 2
      const r = await call()
      expect(r.status).toBe(413)
      expect(await r.text()).toMatch(/Narrow the date range/)
      expect(r.headers.get('content-disposition')).toBeNull()
      const p = await pay.GET(new Request('http://x/payments/csv'))
      expect(p.status).toBe(413)
      // narrowing the filters makes it exportable again
      expect((await pay.GET(new Request('http://x/payments/csv?from=2030-01-01'))).status).toBe(200)
    } finally {
      Object.assign(exportLimits, saved)
    }
  })

  it('malformed payment CSV params do not 500', async () => {
    const { as } = await seed()
    as(['accounts.view'])
    const pay = await import('../../app/(admin)/payments/csv/route')
    expect((await pay.GET(new Request("http://x/payments/csv?account=%27%3B--&from=2026-99-99&ref=zzz&direction=x"))).status).toBe(200)
  })
})
