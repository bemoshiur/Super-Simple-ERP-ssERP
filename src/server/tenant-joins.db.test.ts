import { eq, sql } from 'drizzle-orm'
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

/**
 * Defence in depth for CONTRIBUTING invariant 1: joins carry their own company predicate. Foreign keys are single-column,
 * so a corrupted (or maliciously crafted) row can point at another company's product/account; a scoped read must then
 * NOT return the other company's joined data.
 */
describe('company predicate on joins', () => {
  it("getPurchase never shows another company's product or account through a cross-tenant reference", async () => {
    const { seedTwoCompanies, mainCtx } = await import('@/test/seed')
    const { a, b } = await seedTwoCompanies()
    const { getDb, schema } = await import('./db')
    const { createProduct } = await import('./catalog/products')
    const { createParty } = await import('./parties/parties')
    const { createPurchase, getPurchase } = await import('./purchases/purchases')
    const db = getDb()
    const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1', purchasePrice: '50' })
    const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'Rahim Traders' })
    const [cash] = await db.select().from(schema.accounts).where(sql`${schema.accounts.companyId} = ${a.cid} and ${schema.accounts.name} = 'Cash'`)
    const secretProduct = await createProduct(db, b.cid, b.uid, { name: 'B-SECRET-PRODUCT', sku: 'BS-1', purchasePrice: '1' })
    const [secretAccount] = await db.insert(schema.accounts).values({ companyId: b.cid, type: 'bank', name: 'B-SECRET-ACCOUNT' }).returning()

    const r = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [{ productId: cable.id, qty: 2, unitCost: '50', serials: [] }], paid: '100', accountId: cash.id, expectedTotal: '100.00' }, await mainCtx(a.cid))
    const before = await getPurchase(db, a.cid, null, r.id)
    expect(before.items.map((i) => i.productName)).toEqual(['Cable'])
    expect(before.payments.map((p) => p.accountName)).toEqual(['Cash'])

    // Corrupt A's rows so they reference B's product and account (allowed by the single-column FKs).
    await db.execute(sql`update purchase_items set product_id = ${secretProduct.id} where purchase_id = ${r.id}`)
    await db.update(schema.payments).set({ accountId: secretAccount.id }).where(eq(schema.payments.refId, r.id))

    const after = await getPurchase(db, a.cid, null, r.id)
    const shown = JSON.stringify(after)
    expect(shown).not.toContain('B-SECRET-PRODUCT')
    expect(shown).not.toContain('B-SECRET-ACCOUNT')
    expect(shown).not.toContain(secretProduct.id)
  })
})
