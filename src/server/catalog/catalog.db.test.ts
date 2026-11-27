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

const seedTwoCompanies = async () => (await import('@/test/seed')).seedTwoCompanies()

describe('products', () => {
  it('create / read / update / search / soft delete happy path', async () => {
    const { getDb, schema } = await import('../db')
    const { createProduct, getProduct, listProducts, setProductActive, updateProduct } = await import('./products')
    const db = getDb()
    const { a } = await seedTwoCompanies()
    const p = await createProduct(db, a.cid, a.uid, { name: 'Galaxy A15', sku: 'gal-1', purchasePrice: '18,500', salePrice: '21500.50', trackSerial: true, warrantyMonths: '12', lowStockThreshold: 3 })
    expect(p).toMatchObject({ sku: 'GAL-1', purchasePrice: '18500.00', salePrice: '21500.50', trackSerial: true, warrantyMonths: 12, active: true })
    expect((await getProduct(db, a.cid, p.id)).name).toBe('Galaxy A15')

    const u = await updateProduct(db, a.cid, a.uid, p.id, { name: 'Galaxy A15 5G', sku: 'GAL-1', purchasePrice: '18500', salePrice: '21500.50', trackSerial: true, warrantyMonths: 12, lowStockThreshold: 3 })
    expect(u.name).toBe('Galaxy A15 5G')

    expect((await listProducts(db, a.cid, { q: 'a15 5g', limit: 20, offset: 0 })).total).toBe(1)
    expect((await listProducts(db, a.cid, { q: 'gal-1', limit: 20, offset: 0 })).total).toBe(1)
    expect((await listProducts(db, a.cid, { q: '%', limit: 20, offset: 0 })).total).toBe(0) // wildcard is literal

    await setProductActive(db, a.cid, a.uid, p.id, false)
    expect((await listProducts(db, a.cid, { limit: 20, offset: 0 })).total).toBe(0)
    expect((await listProducts(db, a.cid, { status: 'inactive', limit: 20, offset: 0 })).total).toBe(1)
    expect((await listProducts(db, a.cid, { status: 'all', limit: 20, offset: 0 })).total).toBe(1)
    // soft delete keeps the row
    expect((await db.select().from(schema.products).where(eq(schema.products.id, p.id))).length).toBe(1)
    await setProductActive(db, a.cid, a.uid, p.id, true)
    expect((await listProducts(db, a.cid, { limit: 20, offset: 0 })).total).toBe(1)

    const acts = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.companyId, a.cid), eq(schema.activityLog.entity, 'product')))
    expect(acts.map((r) => r.action).sort()).toEqual(['product.activate', 'product.create', 'product.deactivate', 'product.update'])
  })

  it('maps a duplicate SKU to a field error, per company only', async () => {
    const { getDb } = await import('../db')
    const { createProduct, updateProduct } = await import('./products')
    const { FieldErrors } = await import('../errors')
    const db = getDb()
    const { a, b } = await seedTwoCompanies()
    await createProduct(db, a.cid, a.uid, { name: 'One', sku: 'DUP-1' })
    await expect(createProduct(db, a.cid, a.uid, { name: 'Two', sku: 'dup-1' })).rejects.toMatchObject({ fields: { sku: expect.stringMatching(/already used/) } })
    await expect(createProduct(db, a.cid, a.uid, { name: 'Two', sku: 'DUP-1' })).rejects.toBeInstanceOf(FieldErrors)
    // the other company may reuse the SKU
    await expect(createProduct(db, b.cid, b.uid, { name: 'Two', sku: 'DUP-1' })).resolves.toBeTruthy()
    // editing onto an existing SKU is also mapped
    const p2 = await createProduct(db, a.cid, a.uid, { name: 'Three', sku: 'T-3' })
    await expect(updateProduct(db, a.cid, a.uid, p2.id, { name: 'Three', sku: 'DUP-1' })).rejects.toBeInstanceOf(FieldErrors)
  })

  it('company B cannot read, update, deactivate or attach company A rows', async () => {
    const { getDb, schema } = await import('../db')
    const { createProduct, getProduct, setProductActive, updateProduct, listProducts } = await import('./products')
    const { createTaxon } = await import('./taxonomy')
    const { NotFoundError, FieldErrors } = await import('../errors')
    const db = getDb()
    const { a, b } = await seedTwoCompanies()
    const p = await createProduct(db, a.cid, a.uid, { name: 'Secret', sku: 'S-1', salePrice: '10' })
    const cat = await createTaxon(db, a.cid, a.uid, 'category', { name: 'A-only' })

    await expect(getProduct(db, b.cid, p.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(updateProduct(db, b.cid, b.uid, p.id, { name: 'Hacked', sku: 'S-1' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(setProductActive(db, b.cid, b.uid, p.id, false)).rejects.toBeInstanceOf(NotFoundError)
    expect((await listProducts(db, b.cid, { status: 'all', limit: 20, offset: 0 })).total).toBe(0)
    // B cannot point its own product at A's category
    await expect(createProduct(db, b.cid, b.uid, { name: 'X', sku: 'X-1', categoryId: cat.id })).rejects.toBeInstanceOf(FieldErrors)

    const [row] = await db.select().from(schema.products).where(eq(schema.products.id, p.id))
    expect(row).toMatchObject({ name: 'Secret', active: true })
  })

  it('writes record_history when a price changes, not for other edits', async () => {
    const { getDb, schema } = await import('../db')
    const { createProduct, updateProduct } = await import('./products')
    const db = getDb()
    const { a } = await seedTwoCompanies()
    const p = await createProduct(db, a.cid, a.uid, { name: 'P', sku: 'P-1', purchasePrice: '100', salePrice: '150' })
    const hist = () => db.select().from(schema.recordHistory).where(and(eq(schema.recordHistory.companyId, a.cid), eq(schema.recordHistory.entityId, p.id)))
    await updateProduct(db, a.cid, a.uid, p.id, { name: 'P renamed', sku: 'P-1', purchasePrice: '100.00', salePrice: '150' })
    expect(await hist()).toHaveLength(0)
    await updateProduct(db, a.cid, a.uid, p.id, { name: 'P renamed', sku: 'P-1', purchasePrice: '100', salePrice: '175.25' })
    const rows = await hist()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity: 'product', changedBy: a.uid, diff: { salePrice: { from: '150.00', to: '175.25' } } })
    expect(Object.keys(rows[0].diff as object)).toEqual(['salePrice'])
  })

  it('blocks changing serial tracking once there is stock history', async () => {
    const { getDb, schema } = await import('../db')
    const { createProduct, updateProduct } = await import('./products')
    const db = getDb()
    const { a } = await seedTwoCompanies()
    const p = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'C-1' })
    await updateProduct(db, a.cid, a.uid, p.id, { name: 'Cable', sku: 'C-1', trackSerial: true }) // fine: no history yet
    await updateProduct(db, a.cid, a.uid, p.id, { name: 'Cable', sku: 'C-1', trackSerial: false })
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: p.id, type: 'adjustment', qtyChange: 5 })
    await expect(updateProduct(db, a.cid, a.uid, p.id, { name: 'Cable', sku: 'C-1', trackSerial: true })).rejects.toMatchObject({ fields: { trackSerial: expect.any(String) } })
  })

  it('suggests the next free SKU', async () => {
    const { getDb } = await import('../db')
    const { createProduct, suggestSku } = await import('./products')
    const db = getDb()
    const { a, b } = await seedTwoCompanies()
    expect(await suggestSku(db, a.cid, 'Charger 20W')).toBe('C2-0001')
    await createProduct(db, a.cid, a.uid, { name: 'x', sku: 'C2-0001' })
    await createProduct(db, a.cid, a.uid, { name: 'y', sku: 'C2-0004' })
    expect(await suggestSku(db, a.cid, 'Charger 20W')).toBe('C2-0005')
    expect(await suggestSku(db, b.cid, 'Charger 20W')).toBe('C2-0001') // other company unaffected
  })
})

describe('categories and brands', () => {
  it.each(['category', 'brand'] as const)('%s: CRUD, duplicate name, isolation, soft delete, picker cap', async (kind) => {
    const { getDb } = await import('../db')
    const { createTaxon, listTaxa, renameTaxon, searchTaxa, setTaxonActive } = await import('./taxonomy')
    const { NotFoundError, FieldErrors } = await import('../errors')
    const db = getDb()
    const { a, b } = await seedTwoCompanies()
    const row = await createTaxon(db, a.cid, a.uid, kind, { name: ' Phones ' })
    expect(row.name).toBe('Phones')
    await expect(createTaxon(db, a.cid, a.uid, kind, { name: 'Phones' })).rejects.toBeInstanceOf(FieldErrors)
    await expect(createTaxon(db, b.cid, b.uid, kind, { name: 'Phones' })).resolves.toBeTruthy()
    await expect(renameTaxon(db, b.cid, b.uid, kind, row.id, { name: 'Hacked' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(setTaxonActive(db, b.cid, b.uid, kind, row.id, false)).rejects.toBeInstanceOf(NotFoundError)
    expect((await renameTaxon(db, a.cid, a.uid, kind, row.id, { name: 'Mobiles' })).name).toBe('Mobiles')

    for (let i = 0; i < 25; i++) await createTaxon(db, a.cid, a.uid, kind, { name: `Item ${String(i).padStart(2, '0')}` })
    expect(await searchTaxa(db, a.cid, kind, '')).toHaveLength(20)
    expect(await searchTaxa(db, a.cid, kind, 'mobil')).toEqual([{ value: row.id, label: 'Mobiles' }])
    expect(await searchTaxa(db, b.cid, kind, 'mobil')).toEqual([])

    await setTaxonActive(db, a.cid, a.uid, kind, row.id, false)
    expect((await listTaxa(db, a.cid, kind, { limit: 100, offset: 0 })).rows.some((r) => r.id === row.id)).toBe(false)
    expect((await listTaxa(db, a.cid, kind, { status: 'inactive', limit: 100, offset: 0 })).total).toBe(1)
    expect(await searchTaxa(db, a.cid, kind, 'mobil')).toEqual([]) // deactivated hidden from pickers
  })
})
