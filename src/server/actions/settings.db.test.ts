import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

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

const valid = {
  companyName: 'My Shop',
  companyAddress: 'Road 1\nDhaka',
  companyPhone: '01700000000',
  companyEmail: 'shop@example.test',
  currencySymbol: 'Tk',
  invoiceFooter: 'Thank you!',
  logoUrl: 'https://cdn.example.test/logo.png',
  prefixSale: 'inv2-',
  prefixPurchase: 'PUR-',
  prefixSaleReturn: 'SR-',
  prefixPurchaseReturn: 'PR-',
  prefixService: 'SVC-',
}

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const as = (perms: string[], adm = false) => (st.session = { uid: a.uid, cid: a.cid, bid: null, role: 'x', adm, sv: 0, perms })
  return { a, b, db: getDb(), schema, as }
}

describe('settings', () => {
  it('salesman and view-only cannot save', async () => {
    const { as, db, schema, a } = await seed()
    const act = await import('./settings')
    as(['sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create'])
    expect(await act.updateSettingsAction(valid)).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    as(['settings.view'])
    expect(await act.updateSettingsAction(valid)).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    expect((await db.select().from(schema.companies).where(eq(schema.companies.id, a.cid)))[0].name).toBe('A Co')
  })

  it('writes the keys printed invoices and document numbers read; logs before/after and history', async () => {
    const { as, db, schema, a, b } = await seed()
    const { getCompanyProfile } = await import('../company')
    const { nextDocNumber } = await import('../docnumbers')
    const act = await import('./settings')
    // one sale number under the old prefix
    expect(await db.transaction((tx) => nextDocNumber(tx, a.cid, 'sale'))).toBe('INV-00001')
    as(['settings.view', 'settings.edit'])
    expect(await act.updateSettingsAction(valid)).toEqual({ ok: true, data: undefined })
    expect(await getCompanyProfile(db, a.cid)).toEqual({ name: 'My Shop', address: 'Road 1\nDhaka', phone: '01700000000', email: 'shop@example.test', footer: 'Thank you!', logoUrl: 'https://cdn.example.test/logo.png', currencySymbol: 'Tk' })
    // new prefix applies to new numbers only; the counter keeps going
    expect(await db.transaction((tx) => nextDocNumber(tx, a.cid, 'sale'))).toBe('INV2-00002')
    // company B untouched
    expect((await getCompanyProfile(db, b.cid)).name).toBe('B Co')

    const [h] = await db.select().from(schema.recordHistory).where(and(eq(schema.recordHistory.entity, 'settings'), eq(schema.recordHistory.entityId, a.cid)))
    expect(h.diff).toMatchObject({ companyName: { from: 'A Co', to: 'My Shop' }, prefixSale: { from: 'INV-', to: 'INV2-' }, logoUrl: { from: null, to: 'https://cdn.example.test/logo.png' } })
    const [log] = await db.select().from(schema.activityLog).where(eq(schema.activityLog.action, 'settings.update'))
    expect(log).toMatchObject({ companyId: a.cid, userId: a.uid, before: expect.objectContaining({ currencySymbol: '৳' }), after: expect.objectContaining({ currencySymbol: 'Tk' }) })

    // saving the same values again writes nothing
    await act.updateSettingsAction(valid)
    expect(await db.select().from(schema.recordHistory).where(eq(schema.recordHistory.entity, 'settings'))).toHaveLength(1)
    // clearing optional fields removes them; the profile falls back to the branch / nothing
    await act.updateSettingsAction({ ...valid, companyAddress: '', logoUrl: '' })
    expect(await getCompanyProfile(db, a.cid)).toMatchObject({ address: null, logoUrl: null })
  })

  it('rejects bad prefixes, logo schemes and symbols with field errors', async () => {
    const { as } = await seed()
    const act = await import('./settings')
    as(['settings.edit'])
    for (const [field, value] of [
      ['prefixSale', 'IN V'],
      ['prefixSale', 'INV1'],
      ['prefixPurchase', 'TOOLONGPREFIX'],
      ['logoUrl', 'javascript:alert(1)'],
      ['logoUrl', 'http://insecure.test/logo.png'],
      ['currencySymbol', 'TAKAAA'],
      ['currencySymbol', ''],
      ['companyName', ''],
    ] as const) {
      expect(await act.updateSettingsAction({ ...valid, [field]: value })).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } })
    }
  })
})
