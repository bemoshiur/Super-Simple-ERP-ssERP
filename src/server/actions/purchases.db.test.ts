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
  const db = getDb()
  const phone = await createProduct(db, a.cid, a.uid, { name: 'Phone', sku: 'PH-1', trackSerial: true })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const as = (perms: string[], cid = a.cid, uid = a.uid) => (st.session = { uid, cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  const invoice = (serials: string[], extra: object = {}) => ({ vendorId: vendor.id, date: '2026-11-26', items: [{ productId: phone.id, qty: serials.length, unitCost: '100', serials }], ...extra })
  return { a, b, db, schema, phone, vendor, cash, as, invoice }
}

const denied = { ok: false, error: expect.stringMatching(/permission/) }

describe('purchase actions: permissions', () => {
  it('view-only cannot create, pay or return; pickers need the right key', async () => {
    const { db, schema, as, invoice, cash, a } = await seed()
    const act = await import('./purchases')
    as(['purchases.view'])
    expect(await act.createPurchaseAction(invoice(['S1']))).toMatchObject(denied)
    expect(await db.select().from(schema.purchases)).toHaveLength(0)
    await expect(act.searchPurchaseProductsAction('')).rejects.toThrow(/permission/)
    await expect(act.searchPurchaseVendorsAction('')).resolves.toHaveLength(1)

    // create a purchase as a creator, then try to pay/return as view-only
    as(['purchases.create'])
    const created = await act.createPurchaseAction(invoice(['S1', 'S2']))
    expect(created).toMatchObject({ ok: true, data: { invoiceNo: 'PUR-00001' } })
    const id = (created as { data: { id: string } }).data.id
    const { getPurchase } = await import('../purchases/purchases')
    const unitId = (await getPurchase(db, a.cid, null, id)).items[0].units[0].id
    expect(await act.recordVendorPaymentAction(id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject(denied) // create != edit
    expect(await act.createPurchaseReturnAction(id, { unitIds: [unitId], date: '2026-11-26' })).toMatchObject(denied)
    as(['purchases.view'])
    expect(await act.recordVendorPaymentAction(id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject(denied)
    expect(await act.createPurchaseReturnAction(id, { unitIds: [unitId], date: '2026-11-26' })).toMatchObject(denied)
    expect(await db.select().from(schema.payments)).toHaveLength(0)

    as(['purchases.edit'])
    expect(await act.recordVendorPaymentAction(id, { amount: '10', accountId: cash.id, date: '2026-11-26' })).toMatchObject({ ok: true, data: { due: '190.00' } })
    expect(await act.createPurchaseReturnAction(id, { unitIds: [unitId], date: '2026-11-26' })).toMatchObject({ ok: true, data: { returnNo: 'PR-00001' } })

    st.session = null
    expect(await act.createPurchaseAction(invoice(['S9']))).toMatchObject({ ok: false, error: expect.stringMatching(/sign in/) })
  })

  it('company comes from the session only; friendly field errors, no SQL leaks', async () => {
    const { b, db, schema, as, invoice } = await seed()
    const act = await import('./purchases')
    // B's user posting A's vendor/product ids: rejected as not found, nothing written
    as(['purchases.create'], b.cid, b.uid)
    const r = await act.createPurchaseAction(invoice(['X1']))
    expect(r).toMatchObject({ ok: false, fieldErrors: { vendorId: 'Vendor not found' } })
    expect(await db.select().from(schema.purchases)).toHaveLength(0)

    as(['purchases.create'])
    expect(await act.createPurchaseAction(invoice(['D', 'D']))).toMatchObject({ ok: false, error: expect.stringMatching(/Duplicate serials in this invoice: D/), fieldErrors: { 'items.0.serials': expect.any(String) } })
    expect(await act.createPurchaseAction({ vendorId: 'nope', items: [] })).toMatchObject({ ok: false, fieldErrors: { vendorId: expect.any(String), items: expect.any(String) } })
    expect(await act.recordVendorPaymentAction('not-a-uuid', {})).toMatchObject({ ok: false })
    const lying = await act.createPurchaseAction(invoice(['L1'], { expectedTotal: '1.00', total: '1.00' }))
    expect(lying).toMatchObject({ ok: false, fieldErrors: { total: expect.stringMatching(/100\.00/) } })
    const ok = await act.createPurchaseAction(invoice(['L1'], { total: '1.00', subtotal: '1.00', due: '0' }))
    expect(ok.ok).toBe(true)
    expect((await db.select().from(schema.purchases))[0]).toMatchObject({ total: '100.00', due: '100.00' })
  })
})
