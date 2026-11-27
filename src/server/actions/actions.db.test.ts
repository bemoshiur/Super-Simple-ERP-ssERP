import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

// Inject the session through the one seam the actions use (authorize). Real DB, real RBAC check.
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
  const { a } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const db = getDb()
  const product = await createProduct(db, a.cid, a.uid, { name: 'P', sku: 'P-1' })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  const customer = await createParty(db, a.cid, a.uid, 'customer', { name: 'C' })
  const as = (perms: string[]) => (st.session = { uid: a.uid, cid: a.cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  return { a, db, product, vendor, customer, as }
}

describe('permission enforcement at the action layer', () => {
  it('edit-only user cannot deactivate, but can reactivate', async () => {
    const { db, product, vendor, customer, as } = await seed()
    const { schema } = await import('../db')
    const cat = await import('./catalog')
    const par = await import('./parties')
    as(['products.view', 'products.edit', 'vendors.edit', 'customers.edit'])
    for (const r of [await cat.deactivateProductAction(product.id), await par.deactivatePartyAction('vendor', vendor.id), await par.deactivatePartyAction('customer', customer.id), await cat.setTaxonActiveAction('category', product.id, false)]) {
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    }
    expect((await db.select().from(schema.products).where(eq(schema.products.id, product.id)))[0].active).toBe(true)
    expect((await db.select().from(schema.vendors).where(eq(schema.vendors.id, vendor.id)))[0].active).toBe(true)
    // delete permission deactivates; edit permission restores
    as(['products.delete', 'vendors.delete'])
    expect((await cat.deactivateProductAction(product.id)).ok).toBe(true)
    expect((await par.deactivatePartyAction('vendor', vendor.id)).ok).toBe(true)
    as(['products.edit', 'vendors.edit'])
    expect((await cat.activateProductAction(product.id)).ok).toBe(true)
    expect((await par.activatePartyAction('vendor', vendor.id)).ok).toBe(true)
    as(['products.delete'])
    expect((await cat.activateProductAction(product.id)).ok).toBe(false)
  })

  it('view-only user cannot create, edit or delete; loaders work only with view', async () => {
    const { product, vendor, as } = await seed()
    const cat = await import('./catalog')
    const par = await import('./parties')
    as(['products.view', 'vendors.view', 'customers.view'])
    const denied = async (p: Promise<{ ok: boolean }>) => expect(await p).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    await denied(cat.createProductAction({ name: 'N', sku: 'N-1' }))
    await denied(cat.updateProductAction(product.id, { name: 'N', sku: 'P-1' }))
    await denied(cat.deactivateProductAction(product.id))
    await denied(cat.createTaxonAction('brand', { name: 'B' }))
    await denied(cat.renameTaxonAction('brand', product.id, { name: 'B' }))
    await denied(par.createPartyAction('vendor', { name: 'X' }))
    await denied(par.updatePartyAction('vendor', vendor.id, { name: 'X' }))
    await denied(par.deactivatePartyAction('vendor', vendor.id))
    await denied(cat.suggestSkuAction('abc'))
    await expect(cat.searchCategoriesAction('')).resolves.toEqual([])
    await expect(par.searchVendorsAction('')).resolves.toHaveLength(1)

    as([]) // no view permission at all
    await expect(cat.searchCategoriesAction('')).rejects.toThrow(/permission/)
    await expect(cat.searchBrandsAction('')).rejects.toThrow(/permission/)
    await expect(par.searchVendorsAction('')).rejects.toThrow(/permission/)
    await expect(par.searchCustomersAction('')).rejects.toThrow(/permission/)
    st.session = null
    await expect(par.searchVendorsAction('')).rejects.toThrow(/sign in/)
  })

  it('a wrong party kind returns an error and does not touch the DB', async () => {
    const { db, as } = await seed()
    const { schema } = await import('../db')
    const par = await import('./parties')
    as(['vendors.create', 'customers.create', 'vendors.view'])
    const bad = 'supplier' as never
    expect(await par.createPartyAction(bad, { name: 'Ghost' })).toMatchObject({ ok: false })
    expect(await par.updatePartyAction(bad, '00000000-0000-4000-8000-000000000000', { name: 'x' })).toMatchObject({ ok: false })
    expect(await par.deactivatePartyAction(bad, '00000000-0000-4000-8000-000000000000')).toMatchObject({ ok: false })
    await expect(par.searchVendorsAction('')).resolves.toBeDefined()
    expect((await db.select().from(schema.vendors)).map((v) => v.name)).toEqual(['V'])
    expect((await db.select().from(schema.customers)).map((v) => v.name)).toEqual(['C'])
  })

  it('an update payload carrying `active` never changes it', async () => {
    const { db, product, vendor, customer, as } = await seed()
    const { schema } = await import('../db')
    const cat = await import('./catalog')
    const par = await import('./parties')
    as(['products.edit', 'vendors.edit', 'customers.edit'])
    expect((await cat.updateProductAction(product.id, { name: 'P2', sku: 'P-1', active: false })).ok).toBe(true)
    expect((await par.updatePartyAction('vendor', vendor.id, { name: 'V2', active: false })).ok).toBe(true)
    expect((await par.updatePartyAction('customer', customer.id, { name: 'C2', active: false })).ok).toBe(true)
    expect(await db.select({ n: schema.products.name, a: schema.products.active }).from(schema.products)).toEqual([{ n: 'P2', a: true }])
    expect((await db.select().from(schema.vendors))[0]).toMatchObject({ name: 'V2', active: true })
    expect((await db.select().from(schema.customers))[0]).toMatchObject({ name: 'C2', active: true })
    // and a create payload cannot create an inactive row either
    as(['products.create'])
    const r = await cat.createProductAction({ name: 'N', sku: 'N-1', active: false })
    expect(r.ok).toBe(true)
    expect((await db.select().from(schema.products).where(eq(schema.products.sku, 'N-1')))[0].active).toBe(true)
  })
})

describe('taxon names are case-insensitive unique per company', () => {
  it.each(['category', 'brand'] as const)('%s', async (kind) => {
    const { a, db } = await seed()
    const { createTaxon } = await import('../catalog/taxonomy')
    await createTaxon(db, a.cid, a.uid, kind, { name: 'Phones' })
    await expect(createTaxon(db, a.cid, a.uid, kind, { name: 'PHONES' })).rejects.toMatchObject({ fields: { name: expect.stringMatching(/already exists/) } })
  })
})

describe('product purchase price without profit visibility (Task 15)', () => {
  it('an update from a user without profit visibility keeps the stored purchase price; create stores the default 0', async () => {
    const { a, db, as } = await seed()
    const { schema } = await import('../db')
    const cat = await import('./catalog')
    const { createProduct } = await import('../catalog/products')
    const p = await createProduct(db, a.cid, a.uid, { name: 'Cam', sku: 'CAM-1', purchasePrice: '2000', salePrice: '2800' })
    as(['products.view', 'products.edit', 'products.create'])
    const res = await cat.updateProductAction(p.id, { name: 'Cam renamed', sku: 'CAM-1', purchasePrice: '1', salePrice: '2900' })
    expect(res.ok).toBe(true)
    const [after] = await db.select().from(schema.products).where(eq(schema.products.id, p.id))
    expect(after).toMatchObject({ name: 'Cam renamed', purchasePrice: '2000.00', salePrice: '2900.00' })
    const created = await cat.createProductAction({ name: 'Dvr', sku: 'DVR-1', purchasePrice: '999', salePrice: '10' })
    const [c] = await db.select().from(schema.products).where(eq(schema.products.id, (created as { data: { id: string } }).data.id))
    expect(c.purchasePrice).toBe('0.00')
    // with profit visibility the value is applied
    as(['products.view', 'products.edit', 'reports.view'])
    expect((await cat.updateProductAction(p.id, { name: 'Cam renamed', sku: 'CAM-1', purchasePrice: '2100', salePrice: '2900' })).ok).toBe(true)
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id)))[0].purchasePrice).toBe('2100.00')
  })
})
