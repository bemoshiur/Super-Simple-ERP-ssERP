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
  const { createSale } = await import('../sales/sales')
  const db = getDb()
  const cam = await createProduct(db, a.cid, a.uid, { name: 'Cam', sku: 'C-1', trackSerial: true, salePrice: '2800', warrantyMonths: 6 })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  const customer = await createParty(db, a.cid, a.uid, 'customer', { name: 'Rahim' })
  await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', items: [{ productId: cam.id, qty: 3, unitCost: '2000', serials: ['S1', 'S2', 'S3'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  await createSale(db, a.cid, a.uid, { customerId: customer.id, date: '2026-11-26', items: [{ serial: 'S1', qty: 1, unitPrice: '2800' }], payments: [{ accountId: cash.id, amount: '2800' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const as = (perms: string[], cid = a.cid, uid = a.uid) => (st.session = { uid, cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  const unit = async (serial: string) => (await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, serial)))[0]
  return { a, b, db, schema, as, unit }
}

const denied = { ok: false, error: expect.stringMatching(/permission/) }

describe('service ticket actions: permissions', () => {
  it('view cannot open; create can open but not update or close; edit can update and close', async () => {
    const { db, schema, as, unit } = await seed()
    const act = await import('./serials')
    const s1 = await unit('S1')

    as(['serials.view'])
    expect(await act.openServiceTicketAction(s1.id, { issue: 'Broken screen' })).toMatchObject(denied)
    expect(await db.select().from(schema.serviceTickets)).toHaveLength(0)
    expect((await unit('S1')).status).toBe('sold')

    as(['serials.view', 'serials.create']) // the default salesman role
    const opened = await act.openServiceTicketAction(s1.id, { issue: 'Broken screen', notes: 'dropped' })
    expect(opened).toMatchObject({ ok: true, data: { ticketNo: 'SVC-00001', underWarranty: true } })
    const id = (opened as { data: { id: string } }).data.id
    expect((await unit('S1')).status).toBe('in_service')
    expect(await act.updateServiceTicketAction(id, { status: 'in_progress' })).toMatchObject(denied)
    expect(await act.closeServiceTicketAction(id, { outcome: 'repaired', resolution: 'Fixed' })).toMatchObject(denied)
    expect((await db.select().from(schema.serviceTickets))[0].status).toBe('open')

    as(['serials.view', 'serials.edit'])
    expect(await act.openServiceTicketAction((await unit('S2')).id, { issue: 'Broken screen' })).toMatchObject(denied) // edit alone cannot open
    expect(await act.updateServiceTicketAction(id, { status: 'in_progress' })).toMatchObject({ ok: true, data: { status: 'in_progress' } })
    expect(await act.closeServiceTicketAction(id, { outcome: 'repaired', resolution: 'Fixed' })).toMatchObject({ ok: true, data: { status: 'resolved', unitStatus: 'sold' } })
    expect((await unit('S1')).status).toBe('sold')

    st.session = null
    expect(await act.openServiceTicketAction(s1.id, { issue: 'Broken again' })).toMatchObject({ ok: false, error: expect.stringMatching(/sign in/) })
  })

  it('friendly errors, no SQL leaks; another company\'s ids are "not found"; bad ids are rejected', async () => {
    const { b, db, schema, as, unit } = await seed()
    const act = await import('./serials')
    const s1 = await unit('S1')
    as(['serials.create', 'serials.edit'], b.cid, b.uid)
    expect(await act.openServiceTicketAction(s1.id, { issue: 'Mine now' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
    expect(await act.openServiceTicketAction('nope', { issue: 'Broken' })).toMatchObject({ ok: false })
    as(['serials.create', 'serials.edit'])
    const stock = await unit('S2')
    expect(await act.openServiceTicketAction(stock.id, { issue: 'Broken' })).toMatchObject({ ok: false, error: expect.stringMatching(/has not been sold/) })
    expect(await act.openServiceTicketAction(s1.id, { issue: 'x' })).toMatchObject({ ok: false, fieldErrors: { issue: expect.any(String) } })
    const ok = await act.openServiceTicketAction(s1.id, { issue: 'Broken' })
    expect(ok).toMatchObject({ ok: true })
    expect(await act.openServiceTicketAction(s1.id, { issue: 'Broken twice' })).toMatchObject({ ok: false, error: expect.stringMatching(/already in service/) })
    as(['serials.create', 'serials.edit'], b.cid, b.uid)
    const id = (ok as { data: { id: string } }).data.id
    expect(await act.closeServiceTicketAction(id, { outcome: 'repaired', resolution: 'Fixed' })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
    expect(await act.updateServiceTicketAction('not-a-uuid', { status: 'in_progress' })).toMatchObject({ ok: false })
    expect((await db.select().from(schema.serviceTickets))[0].status).toBe('open')
  })
})
