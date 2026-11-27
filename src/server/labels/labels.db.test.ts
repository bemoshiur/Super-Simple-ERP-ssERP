import { eq } from 'drizzle-orm'
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

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const db = getDb()
  const phone = await createProduct(db, a.cid, a.uid, { name: 'Phone X', sku: 'PX-1', trackSerial: true, purchasePrice: '15000' })
  const cam = await createProduct(db, a.cid, a.uid, { name: 'Camera', sku: 'CAM-1', trackSerial: true })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  const p1 = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', items: [{ productId: phone.id, qty: 2, unitCost: '15000', serials: ['P-1', 'P-2'] }, { productId: cam.id, qty: 1, unitCost: '2000', serials: ['C-1'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const p2 = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-21', items: [{ productId: cam.id, qty: 1, unitCost: '2000', serials: ['C-2'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const productB = await createProduct(db, b.cid, b.uid, { name: 'B thing', sku: 'PX-1', trackSerial: true })
  const vendorB = await createParty(db, b.cid, b.uid, 'vendor', { name: 'BV' })
  const pb = await createPurchase(db, b.cid, b.uid, { vendorId: vendorB.id, date: '2026-11-20', items: [{ productId: productB.id, qty: 1, unitCost: '9', serials: ['B-1'] }] }, await (await import('@/test/seed')).mainCtx(b.cid))
  const units = await db.select().from(schema.productUnits)
  return { db, schema, a, b, phone, cam, p1, p2, pb, units, idOf: (sn: string) => units.find((u) => u.serialNo === sn)!.id }
}
const mod = () => import('./labels')
const pure = () => import('./pure')

describe('loadLabelUnits', () => {
  it('by purchase: only that invoice, product name + SKU + serial, and no cost field exists on the result', async () => {
    const { db, a, p1 } = await seed()
    const { loadLabelUnits } = await mod()
    const { parseLabelParams } = await pure()
    const r = await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ purchase: p1.id }))
    expect(r).toMatchObject({ total: 3, truncated: false, title: 'Purchase PUR-00001' })
    expect(r.labels.map((l) => [l.productName, l.sku, l.serialNo])).toEqual([['Camera', 'CAM-1', 'C-1'], ['Phone X', 'PX-1', 'P-1'], ['Phone X', 'PX-1', 'P-2']])
    for (const l of r.labels) expect(Object.keys(l).sort()).toEqual(['id', 'productName', 'serialNo', 'sku'])
    expect(JSON.stringify(r)).not.toMatch(/15000|2000|price|cost/i)
  })

  it('by ids: company-scoped (another company\'s unit id yields nothing); by stock: in_stock only, optional SKU', async () => {
    const { db, schema, a, b, idOf, units } = await seed()
    const { loadLabelUnits } = await mod()
    const { parseLabelParams } = await pure()
    const bUnit = units.find((u) => u.companyId === b.cid)!.id
    const r = await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ ids: `${idOf('C-2')},${bUnit}` }))
    expect(r.labels.map((l) => l.serialNo)).toEqual(['C-2'])
    expect(await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ ids: bUnit }))).toMatchObject({ labels: [], total: 0 })

    await db.update(schema.productUnits).set({ status: 'sold' }).where(eq(schema.productUnits.id, idOf('P-2')))
    const stock = await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({}))
    expect(stock.labels.map((l) => l.serialNo)).toEqual(['C-1', 'C-2', 'P-1']) // sold P-2 excluded, B's unit excluded
    const bySku = await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ sku: 'CAM-1' }))
    expect(bySku.labels.map((l) => l.serialNo)).toEqual(['C-1', 'C-2'])
    // "PX-1" exists in both companies: each sees only its own
    expect((await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ sku: 'PX-1' }))).labels.map((l) => l.serialNo)).toEqual(['P-1'])
    expect((await loadLabelUnits(db, b.cid, { filter: null, restrict: null }, parseLabelParams({ sku: 'PX-1' }))).labels.map((l) => l.serialNo)).toEqual(['B-1'])
    expect(await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ sku: 'NOPE' }))).toMatchObject({ labels: [], title: expect.stringMatching(/No product/) })
  })

  it('another company\'s purchase is NotFound; the cap is 500 and says it was applied', async () => {
    const { db, schema, a, b, pb, cam, p1 } = await seed()
    const { loadLabelUnits } = await mod()
    const { parseLabelParams, MAX_LABELS } = await pure()
    await expect(loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ purchase: pb.id }))).rejects.toThrow(/Purchase not found/)
    await expect(loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ purchase: 'garbage' }))).rejects.toThrow(/Purchase not found/) // never falls through to stock labels
    await expect(loadLabelUnits(db, b.cid, { filter: null, restrict: null }, parseLabelParams({ purchase: p1.id }))).rejects.toThrow(/Purchase not found/)
    // 505 more units in stock for A
    const { createPurchase } = await import('../purchases/purchases')
    const vendorId = (await db.select().from(schema.vendors).where(eq(schema.vendors.companyId, a.cid)))[0].id
    const serials = Array.from({ length: 505 }, (_, i) => `BULK-${String(i).padStart(4, '0')}`)
    const big = await createPurchase(db, a.cid, a.uid, { vendorId, date: '2026-11-22', items: [{ productId: cam.id, qty: serials.length, unitCost: '1', serials }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const r = await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({ purchase: big.id }))
    expect(r.labels).toHaveLength(MAX_LABELS)
    expect(r).toMatchObject({ total: 505, truncated: true })
    const stock = await loadLabelUnits(db, a.cid, { filter: null, restrict: null }, parseLabelParams({}))
    expect(stock.labels).toHaveLength(MAX_LABELS)
    expect(stock.truncated).toBe(true)
  })
})
