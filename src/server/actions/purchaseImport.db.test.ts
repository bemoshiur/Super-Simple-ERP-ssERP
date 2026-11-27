import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

// Real DB, real RBAC check, session injected via authorize() (same seam as purchases.db.test.ts).
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
  await createProduct(db, a.cid, a.uid, { name: 'Phone', sku: 'PH-1', trackSerial: true })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  const as = (perms: string[], cid = a.cid, uid = a.uid) => (st.session = { uid, cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  const form = (csv: string, extra: Record<string, string> = {}) => {
    const fd = new FormData()
    fd.set('file', new File([csv], 'serials.csv', { type: 'text/csv' }))
    for (const [k, v] of Object.entries({ vendorId: vendor.id, date: '2026-11-26', ...extra })) fd.set(k, v)
    return fd
  }
  return { a, b, db, schema, vendor, as, form }
}

const denied = { ok: false, error: expect.stringMatching(/permission/) }
const CSV = 'serial,product_sku,unit_cost\nS1,PH-1,100\nS2,PH-1,100\n'

describe('purchase import actions: permissions and safety', () => {
  it('needs purchases.create for both the dry run and the import; view/edit/sales rights are not enough', async () => {
    const { db, schema, as, form } = await seed()
    const act = await import('./purchaseImport')
    for (const perms of [[], ['purchases.view'], ['purchases.edit'], ['sales.create', 'serials.view', 'customers.view']]) {
      as(perms)
      expect(await act.previewPurchaseImportAction(form(CSV))).toMatchObject(denied)
      expect(await act.importPurchaseAction(form(CSV))).toMatchObject(denied)
    }
    expect(await db.select().from(schema.purchases)).toHaveLength(0)
    st.session = null
    expect(await act.importPurchaseAction(form(CSV))).toMatchObject({ ok: false, error: expect.stringMatching(/sign in/) })
    // the default salesman role cannot import
    const { DEFAULT_ROLE_PERMISSIONS } = await import('../rbac')
    as([...DEFAULT_ROLE_PERMISSIONS.salesman])
    expect(await act.importPurchaseAction(form(CSV))).toMatchObject(denied)
  })

  it('a creator can preview (no writes) and import; the result links to the invoice; company comes from the session', async () => {
    const { a, b, db, schema, as, form, vendor } = await seed()
    const act = await import('./purchaseImport')
    as(['purchases.create'])
    const p = await act.previewPurchaseImportAction(form(CSV))
    expect(p).toMatchObject({ ok: true, data: { canImport: true, summary: { rows: 2, valid: 2, invalid: 0 }, totals: { total: '200.00' } } })
    expect(await db.select().from(schema.purchases)).toHaveLength(0)
    expect(await db.select().from(schema.productUnits)).toHaveLength(0)
    const key = crypto.randomUUID()
    const r = await act.importPurchaseAction(form(CSV, { idempotencyKey: key }))
    expect(r).toMatchObject({ ok: true, data: { invoiceNo: 'PUR-00001', units: 2, total: '200.00', duplicate: false } })
    const again = await act.importPurchaseAction(form(CSV, { idempotencyKey: key }))
    expect(again).toMatchObject({ ok: true, data: { id: (r as { data: { id: string } }).data.id, duplicate: true, units: 2 } })
    expect(await db.select().from(schema.purchases).where(eq(schema.purchases.companyId, a.cid))).toHaveLength(1)

    // B's user cannot import A's SKU or use A's vendor (vendor-not-found with a valid file is covered in import.db.test.ts)
    as(['purchases.create'], b.cid, b.uid)
    expect(await act.importPurchaseAction(form('serial,product_sku,unit_cost\nS9,PH-1,1\n'))).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was imported/) })
    const bPreview = await act.previewPurchaseImportAction(form('serial,product_sku,unit_cost\nS9,PH-1,1\n', { vendorId: vendor.id }))
    expect(bPreview).toMatchObject({ ok: true, data: { canImport: false, headerErrors: { vendorId: 'Vendor not found' }, summary: { unknownSku: 1 } } })
    expect(await db.select().from(schema.purchases).where(and(eq(schema.purchases.companyId, b.cid)))).toHaveLength(0)
  })

  it('bad uploads give friendly errors, never SQL or stack traces', async () => {
    const { as, form, db, schema } = await seed()
    const act = await import('./purchaseImport')
    as(['purchases.create'])
    const none = new FormData()
    expect(await act.importPurchaseAction(none)).toMatchObject({ ok: false, error: 'Choose a CSV file.' })
    expect(await act.previewPurchaseImportAction(form('not a csv at all'))).toMatchObject({ ok: true, data: { canImport: false, fileErrors: [expect.stringMatching(/Missing/)] } })
    expect(await act.importPurchaseAction(form('serial,product_sku,unit_cost\nA,PH-1,x\n'))).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was imported/) })
    const big = form('x'.repeat(900_000))
    expect(await act.importPurchaseAction(big)).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) })
    expect(await db.select().from(schema.purchases)).toHaveLength(0)
  })
})
