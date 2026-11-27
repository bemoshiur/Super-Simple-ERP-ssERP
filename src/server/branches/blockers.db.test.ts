/** branchBlockers(): its raw quantity-stock query joins products with the company predicate (tenancy on every join). */
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

describe('branchBlockers', () => {
  it("names the company's own quantity stock, never another company's product", async () => {
    const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
    const { getDb, schema } = await import('../db')
    const { mainBranchId } = await import('@/test/seed')
    const { branchBlockers } = await import('./branches')
    const db = getDb()
    const mainA = await mainBranchId(a.cid)
    const [own] = await db.insert(schema.products).values({ companyId: a.cid, name: 'Own Cable', sku: 'OWN-CB' }).returning()
    const [foreign] = await db.insert(schema.products).values({ companyId: b.cid, name: 'Secret B Product', sku: 'B-SECRET' }).returning()
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: mainA, productId: own.id, type: 'adjustment', qtyChange: 4 })
    // Corrupt row on purpose: a movement of company A that references company B's product.
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: mainA, productId: foreign.id, type: 'adjustment', qtyChange: 7 })

    const text = (await branchBlockers(db, a.cid, mainA)).join(' | ')
    expect(text).toContain('Own Cable (4)')
    expect(text).not.toContain('Secret B Product')
  })
})
