import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

// Same seam as actions.db.test.ts: real DB, real RBAC check, session injected via authorize().
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

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const db = getDb()
  const cam = await createProduct(db, a.cid, a.uid, { name: 'Cam', sku: 'C-1', trackSerial: true, salePrice: '2800', warrantyMonths: 6 })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  const customer = await createParty(db, a.cid, a.uid, 'customer', { name: 'Rahim' })
  await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', items: [{ productId: cam.id, qty: 3, unitCost: '2000', serials: ['S1', 'S2', 'S3'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const as = (perms: string[], cid = a.cid, uid = a.uid) => (st.session = { uid, cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  const invoice = (serial: string, extra: object = {}) => ({ customerId: customer.id, date: '2026-11-26', items: [{ serial, qty: 1, unitPrice: '2800' }], ...extra })
  return { a, b, db, schema, cam, customer, cash, as, invoice }
}

const denied = { ok: false, error: expect.stringMatching(/permission/) }

describe('sales actions: permissions', () => {
  it('view-only cannot create, collect or return; create cannot collect or return; edit can', async () => {
    const { db, schema, as, invoice, cash, customer } = await seed()
    const act = await import('./sales')
    as(['sales.view'])
    expect(await act.createSaleAction(invoice('S1'))).toMatchObject(denied)
    expect(await act.lookupSaleSerialAction('S1')).toMatchObject(denied)
    await expect(act.searchSaleProductsAction('')).rejects.toThrow(/permission/)
    await expect(act.searchSaleCustomersAction('')).resolves.toHaveLength(1)
    expect(await db.select().from(schema.sales)).toHaveLength(0)

    as(['sales.create'])
    // a seller sees the unit but not its cost
    const look = await act.lookupSaleSerialAction(' S1 ')
    expect(look).toMatchObject({ ok: true, data: { serial: 'S1', productName: 'Cam', salePrice: '2800.00', warrantyMonths: 6 } })
    expect((look as { data: object }).data).not.toHaveProperty('cost')
    expect(await act.lookupSaleSerialAction('NOPE')).toMatchObject({ ok: false, error: 'Serial NOPE is not in stock: it is unknown (no such serial in your stock records).', fieldErrors: { serial: expect.any(String) } })
    const created = await act.createSaleAction(invoice('S1'))
    expect(created).toMatchObject({ ok: true, data: { invoiceNo: 'INV-00001', duplicate: false } })
    expect(await act.lookupSaleSerialAction('S1')).toMatchObject({ ok: false, error: 'Serial S1 is not in stock: it is sold.' })
    const id = (created as { data: { id: string } }).data.id
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, id))
    expect(await act.recordCustomerPaymentAction(id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject(denied)
    expect(await act.collectCustomerDueAction(customer.id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject(denied)
    expect(await act.createSaleReturnAction(id, { items: [{ saleItemId: item.id, qty: 1 }], date: '2026-11-26' })).toMatchObject(denied)
    as(['sales.view'])
    expect(await act.recordCustomerPaymentAction(id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject(denied)
    expect(await db.select().from(schema.payments)).toHaveLength(0)

    as(['sales.edit', 'sales.create'])
    expect((await act.lookupSaleSerialAction('S2')) as { data: object }).toMatchObject({ ok: true, data: { cost: '2000.00' } }) // managers see cost
    expect(await act.recordCustomerPaymentAction(id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject({ ok: true, data: { due: '2790.00' } })
    expect(await act.collectCustomerDueAction(customer.id, { amount: '90', accountId: cash.id, date: '2026-11-26' })).toMatchObject({ ok: true, data: { remainingDue: '2700.00' } })
    expect(await act.createSaleReturnAction(id, { items: [{ saleItemId: item.id, qty: 1 }], date: '2026-11-26' })).toMatchObject({ ok: false, fieldErrors: { refundAccountId: expect.stringMatching(/100\.00/) } })
    expect(await act.createSaleReturnAction(id, { items: [{ saleItemId: item.id, qty: 1 }], date: '2026-11-26', refundAccountId: cash.id })).toMatchObject({ ok: true, data: { returnNo: 'SR-00001', credit: '2800.00', refund: '100.00' } })

    st.session = null
    expect(await act.createSaleAction(invoice('S3'))).toMatchObject({ ok: false, error: expect.stringMatching(/sign in/) })
  })

  it('company comes from the session only; friendly field errors, no SQL leaks; idempotent resubmit', async () => {
    const { b, db, schema, as, invoice, customer } = await seed()
    const act = await import('./sales')
    as(['sales.create'], b.cid, b.uid)
    expect(await act.createSaleAction(invoice('S1'))).toMatchObject({ ok: false, fieldErrors: { customerId: 'Customer not found' } })
    expect(await act.createSaleAction({ ...invoice('S1'), customerId: null, payments: [] })).toMatchObject({ ok: false }) // walk-in with due, and S1 unknown in B
    expect(await act.lookupSaleSerialAction('S1')).toMatchObject({ ok: false, error: expect.stringMatching(/unknown/) })
    expect(await db.select().from(schema.sales)).toHaveLength(0)

    as(['sales.create'])
    expect(await act.createSaleAction({ customerId: 'nope', items: [] })).toMatchObject({ ok: false, fieldErrors: { customerId: expect.any(String), items: expect.any(String) } })
    expect(await act.recordCustomerPaymentAction('not-a-uuid', {})).toMatchObject({ ok: false })
    expect(await act.createSaleAction(invoice('S1', { expectedTotal: '1.00', total: '1.00' }))).toMatchObject({ ok: false, fieldErrors: { total: expect.stringMatching(/2800\.00/) } })
    const key = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const first = await act.createSaleAction(invoice('S1', { total: '1.00', due: '0', idempotencyKey: key }))
    expect(first).toMatchObject({ ok: true, data: { duplicate: false } })
    expect(await act.createSaleAction(invoice('S1', { idempotencyKey: key }))).toMatchObject({ ok: true, data: { id: (first as { data: { id: string } }).data.id, duplicate: true } })
    expect(await db.select().from(schema.sales)).toHaveLength(1)
    expect((await db.select().from(schema.sales))[0]).toMatchObject({ total: '2800.00', due: '2800.00', customerId: customer.id })
  })
})
