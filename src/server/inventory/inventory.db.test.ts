import { and, asc, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'
import { waitForLockWait } from '@/test/locks'

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

const D = '2026-11-26'

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct, updateProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const db = getDb()
  const cam = await createProduct(db, a.cid, a.uid, { name: 'HIK Camera', sku: 'HIK-1', trackSerial: true, warrantyMonths: 12, purchasePrice: '2000', salePrice: '2800', lowStockThreshold: 1 })
  const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1', purchasePrice: '40', salePrice: '100', lowStockThreshold: 5 })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'ABC Electronics' })
  const rahim = await createParty(db, a.cid, a.uid, 'customer', { name: 'Rahim' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const buy = async (serials: string[], cost = '2000', date = '2026-11-20') => createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date, items: [{ productId: cam.id, qty: serials.length, unitCost: cost, serials }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const buyCable = async (qty: number, cost: string, opts: { discount?: string; date?: string } = {}) =>
    createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: opts.date ?? '2026-11-20', discount: opts.discount, items: [{ productId: cable.id, qty, unitCost: cost, serials: [] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const camB = await createProduct(db, b.cid, b.uid, { name: 'B Camera', sku: 'HIK-1', trackSerial: true })
  const cableB = await createProduct(db, b.cid, b.uid, { name: 'B Cable', sku: 'CB-1' })
  return { db, schema, a, b, cam, cable, vendor, rahim, cash, buy, buyCable, camB, cableB, updateProduct }
}
const onHand = async (productId: string, cid: string) => {
  const { getDb } = await import('../db')
  const { onHandQty } = await import('../sales/sales')
  return (await onHandQty(getDb(), cid, null, [productId])).get(productId) ?? 0
}

describe('/stock rows and summary', () => {
  it('counts serial units by status after purchase, sale, return, service and damage; non-serial = movements; filters; pagination', async () => {
    const { db, schema, a, cam, cable, rahim, cash, buy, buyCable } = await seed()
    await buy(['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6'])
    await buyCable(10, '40')
    const { createSale, createSaleReturn } = await import('../sales/sales')
    const { createPurchaseReturn, getPurchase } = await import('../purchases/purchases')
    const { openServiceTicket } = await import('../service/tickets')
    const { adjustStock } = await import('./adjustments')
    const sale = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ serial: 'C-1', qty: 1, unitPrice: '2800' }, { serial: 'C-2', qty: 1, unitPrice: '2800' }, { serial: 'C-3', qty: 1, unitPrice: '2800' }, { productId: cable.id, qty: 3, unitPrice: '100' }], payments: [{ accountId: cash.id, amount: '8700' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    // customer returns C-3 to stock
    const items = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, sale.id)).orderBy(asc(schema.saleItems.lineNo))
    await createSaleReturn(db, a.cid, a.uid, sale.id, { items: [{ saleItemId: items[2].id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    // C-2 to service
    const c2 = (await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'C-2')))[0]
    await openServiceTicket(db, a.cid, a.uid, c2.id, { issue: 'No power' }, await (await import('@/test/seed')).mainCtx(a.cid))
    // C-4 returned to vendor, C-5 damaged by adjustment
    const pur = (await db.select().from(schema.purchases).where(eq(schema.purchases.companyId, a.cid)).orderBy(asc(schema.purchases.invoiceNo)))[0]
    const p = await getPurchase(db, a.cid, null, pur.id)
    await createPurchaseReturn(db, a.cid, a.uid, pur.id, { unitIds: [p.items[0].units.find((u) => u.serialNo === 'C-4')!.id], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    await adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'C-5', reason: 'damage', note: 'Dropped' }, await (await import('@/test/seed')).mainCtx(a.cid))

    const { stockRows, stockSummary, countStockRows } = await import('../reports/stock')
    const { rows } = await stockRows({ db, companyId: a.cid, branch: null, limit: 50 }, {})
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    // in stock: C-3 (returned by customer), C-6 -> 2; sold: C-1; in service: C-2; damaged: C-5; returned to vendor: C-4
    expect(byName['HIK Camera']).toMatchObject({ trackSerial: true, onHand: 2, sold: 1, inService: 1, damaged: 1, returned: 1, unitCost: '2000.00', value: '4000.00', low: false })
    expect(byName.Cable).toMatchObject({ trackSerial: false, onHand: 7, unitCost: '40.00', value: '280.00', low: false })
    expect(await stockSummary(db, a.cid, null, {})).toEqual({ products: 2, units: 9, value: '4280.00', lowCount: 0 })

    // filters
    expect((await stockRows({ db, companyId: a.cid, branch: null, limit: 50 }, { tracking: 'serial' })).rows.map((r) => r.name)).toEqual(['HIK Camera'])
    expect((await stockRows({ db, companyId: a.cid, branch: null, limit: 50 }, { tracking: 'plain' })).rows.map((r) => r.name)).toEqual(['Cable'])
    expect((await stockRows({ db, companyId: a.cid, branch: null, limit: 50 }, { q: 'cb-' })).rows.map((r) => r.name)).toEqual(['Cable'])
    expect((await stockRows({ db, companyId: a.cid, branch: null, limit: 50 }, { q: '100%' })).rows).toEqual([])
    await db.update(schema.products).set({ lowStockThreshold: 7 }).where(eq(schema.products.id, cable.id))
    const low = await stockRows({ db, companyId: a.cid, branch: null, limit: 50 }, { lowOnly: true })
    expect(low.rows.map((r) => [r.name, r.low])).toEqual([['Cable', true]])
    expect(await stockSummary(db, a.cid, null, { lowOnly: true })).toEqual({ products: 1, units: 7, value: '280.00', lowCount: 1 })
    expect((await stockSummary(db, a.cid, null, {})).lowCount).toBe(1)
    // pagination
    const p1 = await stockRows({ db, companyId: a.cid, branch: null, limit: 1 }, { offset: 0 })
    const p2 = await stockRows({ db, companyId: a.cid, branch: null, limit: 1 }, { offset: 1 })
    expect([p1.rows[0].name, p1.truncated, p2.rows[0].name, p2.truncated]).toEqual(['Cable', true, 'HIK Camera', false])
    expect(await countStockRows(db, a.cid, null, {})).toBe(2)
  })

  it('is company-scoped: company B sees only its own products', async () => {
    const { db, a, b, buy } = await seed()
    await buy(['X-1'])
    const { stockRows, stockSummary } = await import('../reports/stock')
    const rowsB = (await stockRows({ db, companyId: b.cid, branch: null, limit: 50 }, {})).rows
    expect(rowsB.map((r) => r.name).sort()).toEqual(['B Cable', 'B Camera'])
    expect(rowsB.every((r) => r.onHand === 0)).toBe(true)
    expect((await stockSummary(db, b.cid, null, {})).value).toBe('0.00')
    expect((await stockSummary(db, a.cid, null, {})).value).toBe('2000.00')
  })
})

describe('product detail reads', () => {
  it('profile, price history from record_history, units with vendor/customer, stock card running balance, purchases and sales; other company -> not found', async () => {
    const { db, a, b, cam, cable, rahim, cash, buy, buyCable, updateProduct } = await seed()
    await updateProduct(db, a.cid, a.uid, cable.id, { name: 'Cable', sku: 'CB-1', purchasePrice: '45', salePrice: '110' })
    await buy(['U-1', 'U-2'])
    await buyCable(10, '40')
    const { createSale } = await import('../sales/sales')
    await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ serial: 'U-1', qty: 1, unitPrice: '2800' }, { productId: cable.id, qty: 4, unitPrice: '110' }], payments: [{ accountId: cash.id, amount: '3240' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const { adjustStock } = await import('./adjustments')
    await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-2', reason: 'damage', note: 'Cut' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await buyCable(5, '40', { date: '2026-11-21' })

    const pd = await import('./product')
    const prof = await pd.getProductProfile(db, a.cid, cable.id)
    expect(prof).toMatchObject({ name: 'Cable', purchasePrice: '45.00', salePrice: '110.00' })
    await expect(pd.getProductProfile(db, b.cid, cable.id)).rejects.toThrow(/Product/)

    const ph = await pd.priceHistory(db, a.cid, cable.id)
    expect(ph).toHaveLength(1)
    expect(ph[0]).toMatchObject({ byName: 'A', changes: [{ field: 'purchasePrice', from: '40.00', to: '45.00' }, { field: 'salePrice', from: '100.00', to: '110.00' }] })
    expect(await pd.priceHistory(db, b.cid, cable.id)).toEqual([])

    const units = await pd.listProductUnits(db, a.cid, null, cam.id, { limit: 10, offset: 0, withCost: true })
    expect(units.total).toBe(2)
    expect(units.byStatus).toEqual({ in_stock: 1, sold: 1 })
    const u1 = units.rows.find((u) => u.serialNo === 'U-1')!
    expect(u1).toMatchObject({ status: 'sold', vendorName: 'ABC Electronics', customerName: 'Rahim', saleInvoiceNo: 'INV-00001', purchaseInvoiceNo: 'PUR-00001', purchasePrice: '2000.00' })
    expect(u1.warrantyEnd).toBe('2027-11-26')
    expect(units.rows.find((u) => u.serialNo === 'U-2')).toMatchObject({ status: 'in_stock', customerName: null })
    const noCost = await pd.listProductUnits(db, a.cid, null, cam.id, { status: 'in_stock', limit: 10, offset: 0, withCost: false })
    expect(noCost.rows.map((r) => [r.serialNo, r.purchasePrice])).toEqual([['U-2', null]])
    expect((await pd.listProductUnits(db, b.cid, null, cam.id, { limit: 10, offset: 0, withCost: true })).total).toBe(0)

    const card = await pd.stockCard(db, a.cid, null, cable.id, { limit: 10, offset: 0 })
    expect(card.total).toBe(4)
    // newest first; balance computed over the whole history
    expect(card.rows.map((r) => [r.type, r.qtyChange, r.balance, r.doc?.kind])).toEqual([
      ['purchase', 5, 9, 'purchase'],
      ['adjustment', -2, 4, 'adjustment'],
      ['sale', -4, 6, 'sale'],
      ['purchase', 10, 10, 'purchase'],
    ])
    expect(card.rows[1].note).toBe('Damage: Cut')
    expect(card.rows[2].doc).toMatchObject({ kind: 'sale', label: 'INV-00001' })
    expect(pd.stockCardHref(card.rows[2].doc, { purchases: true, sales: false })).toBeNull()
    expect(pd.stockCardHref(card.rows[3].doc, { purchases: true, sales: false })).toMatch(/^\/purchases\//)
    // page 2 keeps the true balance
    const page2 = await pd.stockCard(db, a.cid, null, cable.id, { limit: 2, offset: 2 })
    expect(page2.rows.map((r) => r.balance)).toEqual([6, 10])
    const { runningBalance } = await import('./pure')
    expect(runningBalance([10, -4, -2, 5].map((q) => ({ qtyChange: q }))).map((r) => r.balance)).toEqual([10, 6, 4, 9])
    expect(await pd.stockCard(db, b.cid, null, cable.id, { limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 })

    const purchases = await pd.listProductPurchases(db, a.cid, null, cable.id, { limit: 10, offset: 0 })
    expect(purchases.total).toBe(2)
    expect(purchases.rows.map((r) => [r.invoiceNo, r.qty, r.net])).toEqual([['PUR-00003', 5, '200.00'], ['PUR-00002', 10, '400.00']])
    const sales = await pd.listProductSales(db, a.cid, null, cable.id, { limit: 10, offset: 0 })
    expect(sales.rows.map((r) => [r.invoiceNo, r.qty, r.customerName])).toEqual([['INV-00001', 4, 'Rahim']])
    expect((await pd.listProductSales(db, b.cid, null, cable.id, { limit: 10, offset: 0 })).total).toBe(0)
    expect(await pd.productStock(db, b.cid, null, cable.id)).toBeNull()
  })
})

describe('non-serial purchase return', () => {
  it('returns qty at the exact discount-allocated net cost; all qty credits the line net total; ledger and stock card', async () => {
    const { db, schema, a, cable, vendor, buyCable } = await seed()
    // 3 x 100 with a 1.00 discount -> line net 299.00 -> unit shares 99.67, 99.67, 99.66
    const pur = await buyCable(3, '100', { discount: '1' })
    const { createPurchaseReturn, getPurchase } = await import('../purchases/purchases')
    const p0 = await getPurchase(db, a.cid, null, pur.id)
    const lineId = p0.items[0].id
    expect(p0.items[0].netTotal).toBe('299.00')
    const r1 = await createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: lineId, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r1).toMatchObject({ returnNo: 'PR-00001', credit: '99.67', due: '199.33' })
    expect(await onHand(cable.id, a.cid)).toBe(2)
    const r2 = await createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: lineId, qty: 2 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r2.credit).toBe('199.33') // 99.67 + 99.66
    const p = await getPurchase(db, a.cid, null, pur.id)
    expect(p).toMatchObject({ total: '299.00', returnedTotal: '299.00', due: '0.00' })
    expect(p.items[0].returnedQty).toBe(3)
    expect(p.returns.flatMap((r) => r.items.map((x) => [x.qty, x.creditAmount, x.serialNo]))).toEqual([[1, '99.67', null], [2, '199.33', null]])
    expect(await onHand(cable.id, a.cid)).toBe(0)
    const moves = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.companyId, a.cid), eq(schema.stockMovements.type, 'purchase_return')))
    expect(moves.map((m) => m.qtyChange).sort((x, y) => x - y)).toEqual([-2, -1])
    expect(moves.every((m) => m.refTable === 'purchase_return_items')).toBe(true)
    // over-return rejected
    await expect(createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: lineId, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'lines.0.qty': expect.stringMatching(/already returned/) } })
    // vendor ledger: billed 299 - returned 299 -> due 0
    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(db, a.cid, null, 'vendor', vendor.id)).toMatchObject({ billed: '299.00', returned: '299.00', due: '0.00' })
    // average cost after the full return falls back (no qty left): purchase price fallback
    const { productAverageCosts } = await import('../sales/sales')
    expect((await productAverageCosts(db, a.cid, [cable.id])).get(cable.id)).toBe('40.00')
    // the stock card shows the purchase return linked to the purchase
    const { stockCard } = await import('./product')
    const card = await stockCard(db, a.cid, null, cable.id, { limit: 10, offset: 0 })
    expect(card.rows[0]).toMatchObject({ type: 'purchase_return', balance: 0, doc: { kind: 'purchase_return', id: pur.id } })
  })

  it('cannot return stock already sold; serial products must use units; mixed serial + loose return', async () => {
    const { db, a, cam, cable, vendor, rahim, cash } = await seed()
    const { createPurchase, createPurchaseReturn, getPurchase } = await import('../purchases/purchases')
    const pur = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', items: [{ productId: cam.id, qty: 2, unitCost: '1000', serials: ['M-1', 'M-2'] }, { productId: cable.id, qty: 4, unitCost: '50', serials: [] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const p = await getPurchase(db, a.cid, null, pur.id)
    const camLine = p.items.find((i) => i.productId === cam.id)!
    const cableLine = p.items.find((i) => i.productId === cable.id)!
    const { createSale } = await import('../sales/sales')
    await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 3, unitPrice: '100' }], payments: [{ accountId: cash.id, amount: '300' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: cableLine.id, qty: 2 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'lines.0.qty': 'Only 1 of Cable in stock: units already sold cannot be returned.' } })
    await expect(createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: camLine.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'lines.0.qty': expect.stringMatching(/serial-tracked/) } })
    const r = await createPurchaseReturn(db, a.cid, a.uid, pur.id, { unitIds: [camLine.units[0].id], lines: [{ purchaseItemId: cableLine.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r.credit).toBe('1050.00')
    expect(await onHand(cable.id, a.cid)).toBe(0)
    const after = await getPurchase(db, a.cid, null, pur.id)
    expect(after.returnedTotal).toBe('1050.00')
    expect(after.items.find((i) => i.productId === cam.id)!.units.find((u) => u.id === camLine.units[0].id)!.status).toBe('returned_to_vendor')
    // a line that is not on this purchase is rejected
    await expect(createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: '00000000-0000-4000-8000-000000000000', qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { lines: expect.stringMatching(/not part of this purchase/) } })
  })

  it('return vs a concurrent sale of the last units: exactly consistent, on-hand never negative', async () => {
    const { db, a, cable, rahim, cash, buyCable } = await seed()
    const { createPurchaseReturn, getPurchase } = await import('../purchases/purchases')
    const { createSale } = await import('../sales/sales')
    for (let round = 0; round < 3; round++) {
      const pur = await buyCable(2, '50')
      const line = (await getPurchase(db, a.cid, null, pur.id)).items[0]
      const have = await onHand(cable.id, a.cid)
      // sell everything we have except nothing: race a return of 2 against a sale of `have`
      const results = await Promise.allSettled([
        createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: line.id, qty: 2 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid)),
        createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: have, unitPrice: '100' }], payments: [{ accountId: cash.id, amount: String(100 * have) }] }, await (await import('@/test/seed')).mainCtx(a.cid)),
      ])
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const left = await onHand(cable.id, a.cid)
      expect(left).toBeGreaterThanOrEqual(0)
      // both cannot succeed (2 + have > have); if one wins, the other was refused with nothing written
      expect(ok).toBe(1)
      expect(left).toBe(0)
    }
  })

  it('deterministic: a return waiting on the product lock re-checks stock after a sale commits', async () => {
    const { db, a, cable, buyCable } = await seed()
    const pur = await buyCable(1, '50')
    const { createPurchaseReturn, getPurchase } = await import('../purchases/purchases')
    const line = (await getPurchase(db, a.cid, null, pur.id)).items[0]
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      await other.query('begin')
      await other.query('select id from products where id = $1 for update', [cable.id])
      await other.query(`insert into stock_movements (company_id, branch_id, product_id, type, qty_change) values ($1, (select id from branches where company_id = $1 and is_default), $2, 'sale', -1)`, [a.cid, cable.id])
      const pending = createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: line.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
      await waitForLockWait()
      await other.query('commit')
      const err = await pending
      expect(err).toMatchObject({ fields: { 'lines.0.qty': expect.stringMatching(/out of stock/) } })
    } finally {
      await other.end()
    }
    expect(await onHand(cable.id, a.cid)).toBe(0)
    expect((await getPurchase(db, a.cid, null, pur.id)).returns).toHaveLength(0)
  })
})

describe('stock adjustments', () => {
  it('non-serial: reason rules, negative guard, valued at average cost, history + activity; idempotent key', async () => {
    const { db, schema, a, cable, buyCable } = await seed()
    await buyCable(5, '40')
    const { adjustStock, listAdjustments } = await import('./adjustments')
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-6', reason: 'count_correction' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { qtyChange: 'Only 5 of Cable in stock: you can reduce by at most 5.' } })
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '2', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { qtyChange: expect.stringMatching(/only reduce/) } })
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-1', reason: 'found' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { qtyChange: expect.stringMatching(/only be added/) } })
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '0', reason: 'other' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { qtyChange: expect.any(String) } })
    const r = await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-5', reason: 'loss', note: 'Stolen', idempotencyKey: 'key-loss-0001' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ qtyChange: -5, onHand: 0, duplicate: false })
    const again = await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-5', reason: 'loss', note: 'Stolen', idempotencyKey: 'key-loss-0001' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(again).toMatchObject({ id: r.id, duplicate: true, onHand: 0 })
    expect(await onHand(cable.id, a.cid)).toBe(0)
    const adj = await listAdjustments(db, a.cid, null, cable.id)
    expect(adj).toHaveLength(1)
    expect(adj[0]).toMatchObject({ qtyChange: -5, reason: 'loss', note: 'Stolen', unitCost: '40.00', value: '-200.00', byName: 'A' })
    const hist = await db.select().from(schema.recordHistory).where(and(eq(schema.recordHistory.entity, 'product'), eq(schema.recordHistory.entityId, cable.id)))
    expect(hist.map((h) => h.diff)).toContainEqual({ onHand: { from: 5, to: 0 } })
    const act = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.companyId, a.cid), eq(schema.activityLog.action, 'stock.adjust')))
    expect(act).toHaveLength(1)
  })

  it('serial: in-stock unit -> damaged (damage or loss) with a unit event; sold unit refused; other company not found', async () => {
    const { db, schema, a, b, cam, cable, buy, rahim, cash } = await seed()
    await buy(['S-1', 'S-2', 'S-3'])
    const { adjustStock } = await import('./adjustments')
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cam.id, qtyChange: '-1', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { productId: expect.stringMatching(/serial-tracked/) } })
    const r = await adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'S-1', reason: 'loss', note: 'Missing after move' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ qtyChange: -1, onHand: 2 })
    const [s1] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'S-1'))
    expect(s1.status).toBe('damaged')
    const ev = await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.unitId, s1.id)).orderBy(asc(schema.unitEvents.createdAt))
    expect(ev.at(-1)).toMatchObject({ type: 'marked_damaged', fromStatus: 'in_stock', toStatus: 'damaged', refTable: 'stock_adjustments', refId: r.id, note: 'Lost: Missing after move', meta: { reason: 'loss', adjustmentId: r.id } })
    const [row] = await db.select().from(schema.stockAdjustments).where(eq(schema.stockAdjustments.id, r.id))
    expect(row).toMatchObject({ unitId: s1.id, qtyChange: -1, reason: 'loss', unitCost: '2000.00', value: '-2000.00' })
    // already damaged / sold units are refused
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'S-1', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/damaged and cannot be changed/)
    const { createSale } = await import('../sales/sales')
    await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ serial: 'S-2', qty: 1, unitPrice: '2800' }], payments: [{ accountId: cash.id, amount: '2800' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'S-2', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/sold and cannot be changed/)
    // serial of another product, other company
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cable.id, serial: 'S-3', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { serial: expect.stringMatching(/not a unit of this product/) } })
    await expect(adjustStock(db, b.cid, b.uid, { kind: 'unit', productId: cam.id, serial: 'S-3', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { serial: expect.any(String) } })
    await expect(adjustStock(db, b.cid, b.uid, { kind: 'qty', productId: cable.id, qtyChange: '1', reason: 'found' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { productId: 'Product not found' } })
  })

  it('concurrent reductions never take on-hand below zero; concurrent double submit with one key adjusts once', async () => {
    const { db, a, cable, buyCable } = await seed()
    await buyCable(3, '40')
    const { adjustStock } = await import('./adjustments')
    const res = await Promise.allSettled([0, 1, 2, 3].map(async () => adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-1', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    expect(await onHand(cable.id, a.cid)).toBe(0)
    await buyCable(2, '40')
    const same = await Promise.all([0, 1, 2].map(async () => adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-2', reason: 'loss', idempotencyKey: 'dbl-submit-01' }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(new Set(same.map((r) => r.id)).size).toBe(1)
    expect(same.filter((r) => !r.duplicate)).toHaveLength(1)
    expect(await onHand(cable.id, a.cid)).toBe(0)
  })

  it('concurrent adjustment vs sale of the last unit: exactly one wins', async () => {
    const { db, a, cable, rahim, cash, buyCable } = await seed()
    const { adjustStock } = await import('./adjustments')
    const { createSale } = await import('../sales/sales')
    for (let i = 0; i < 3; i++) {
      await buyCable(1, '40')
      const res = await Promise.allSettled([
        adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-1', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid)),
        createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 1, unitPrice: '100' }], payments: [{ accountId: cash.id, amount: '100' }] }, await (await import('@/test/seed')).mainCtx(a.cid)),
      ])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(await onHand(cable.id, a.cid)).toBe(0)
    }
  })
})

describe('stock-take', () => {
  it('sheet, quantity + serial diff (missing / unexpected), apply in one transaction, stale count refused', async () => {
    const { db, a, b, cam, cable, buy, buyCable, camB } = await seed()
    await buy(['T-1', 'T-2', 'T-3'])
    await buyCable(10, '40')
    const { loadCountSheet, computeCountDiff } = await import('./count')
    const sheet = await loadCountSheet(db, a.cid, null, {})
    expect(sheet.rows.map((r) => [r.name, r.trackSerial, r.system])).toEqual([['Cable', false, 10], ['HIK Camera', true, 3]])
    expect(Object.keys(sheet.rows[0])).not.toContain('unitCost')
    // a serial of company B and of another status
    const { createPurchase } = await import('../purchases/purchases')
    const { createParty } = await import('../parties/parties')
    const vB = await createParty(db, b.cid, b.uid, 'vendor', { name: 'VB' })
    await createPurchase(db, b.cid, b.uid, { vendorId: vB.id, date: '2026-11-20', items: [{ productId: camB.id, qty: 1, unitCost: '1', serials: ['B-ONLY'] }] }, await (await import('@/test/seed')).mainCtx(b.cid))
    const { adjustStock, applyStockCount } = await import('./adjustments')
    await adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'T-3', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const diff = await computeCountDiff(db, a.cid, null, { lines: [{ productId: cable.id, counted: '8' }], serialProductIds: [cam.id], scanned: 'T-1\nT-1\nT-3, B-ONLY ; NEW-9' })
    expect(diff.rows).toEqual([{ productId: cable.id, name: 'Cable', sku: 'CB-1', system: 10, counted: 8, diff: -2 }])
    expect(diff.missing.map((m) => m.serialNo)).toEqual(['T-2'])
    expect(diff.unexpected.map((u) => [u.serialNo, u.reason])).toEqual([['T-3', 'not_in_stock'], ['B-ONLY', 'unknown'], ['NEW-9', 'unknown']])
    expect(diff.duplicates).toEqual(['T-1'])
    expect(diff.totals).toMatchObject({ counted: 1, short: 1, missing: 1, unexpected: 3 })
    // other company's product ids are refused
    await expect(computeCountDiff(db, b.cid, null, { lines: [{ productId: cable.id, counted: '1' }] })).rejects.toMatchObject({ fields: { lines: expect.stringMatching(/not found/) } })
    // stale: system changed since the count
    await expect(applyStockCount(db, a.cid, a.uid, { lines: [{ productId: cable.id, counted: '8', system: 9 }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { lines: expect.stringMatching(/Stock changed since the count/) } })
    expect(await onHand(cable.id, a.cid)).toBe(10)
    // serial products cannot be applied by qty
    await expect(applyStockCount(db, a.cid, a.uid, { lines: [{ productId: cam.id, counted: '1', system: 2 }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { lines: expect.stringMatching(/Serial products/) } })
    const r = await applyStockCount(db, a.cid, a.uid, { lines: [{ productId: cable.id, counted: '8', system: 10 }], note: 'Year-end count', idempotencyKey: 'count-key-001' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r.applied).toMatchObject([{ productId: cable.id, from: 10, to: 8, qtyChange: -2 }])
    expect(await onHand(cable.id, a.cid)).toBe(8)
    const again = await applyStockCount(db, a.cid, a.uid, { lines: [{ productId: cable.id, counted: '8', system: 10 }], idempotencyKey: 'count-key-001' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(again.duplicate).toBe(true)
    expect(await onHand(cable.id, a.cid)).toBe(8)
    // serial units are never changed by a count
    const { stockRows } = await import('../reports/stock')
    expect((await stockRows({ db, companyId: a.cid, branch: null, limit: 10 }, { productId: cam.id })).rows[0].onHand).toBe(2)
  })
})

describe('fix round 1: stock adjustments in the P&L', () => {
  const P = { from: '2026-11-01', to: '2026-11-30' }
  it('reviewer scenario: buy 10 (net 950), sell 4, return 3 to vendor, adjust -1 damaged -> COGS 380 + adjustment 95; gross profit moves by exactly 95; cash flow unaffected', async () => {
    const { db, a, cable, rahim, cash, buyCable } = await seed()
    const pur = await buyCable(10, '100', { discount: '50' })
    const { createSale } = await import('../sales/sales')
    await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 4, unitPrice: '150' }], payments: [{ accountId: cash.id, amount: '600' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const { createPurchaseReturn, getPurchase } = await import('../purchases/purchases')
    const line = (await getPurchase(db, a.cid, null, pur.id)).items[0]
    expect((await createPurchaseReturn(db, a.cid, a.uid, pur.id, { lines: [{ purchaseItemId: line.id, qty: 3 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).credit).toBe('285.00')
    const { loadProfitLoss } = await import('../reports/profit')
    const { loadCashFlow } = await import('../reports/cashflow')
    const before = await loadProfitLoss(db, a.cid, null, P)
    const cashBefore = await loadCashFlow(db, a.cid, null, P)
    expect(before).toMatchObject({ revenue: '600.00', cogs: '380.00', netCogs: '380.00', stockAdjustments: '0.00', totalCost: '380.00', grossProfit: '220.00' })
    const { adjustStock } = await import('./adjustments')
    const adj = await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-1', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(adj.onHand).toBe(2)
    const after = await loadProfitLoss(db, a.cid, null, P)
    expect(after).toMatchObject({ revenue: '600.00', cogs: '380.00', netCogs: '380.00', stockAdjustments: '95.00', totalCost: '475.00', grossProfit: '125.00', netProfit: '125.00' })
    expect(Number(before.grossProfit) - Number(after.grossProfit)).toBe(95)
    expect(await loadCashFlow(db, a.cid, null, P)).toEqual(cashBefore)
    // the report shows the separate line (and the CSV is built from the same rows)
    const { profitLossReport } = await import('../reports/profit')
    const rep = await profitLossReport({ db, companyId: a.cid, branch: null, today: '2026-11-27', canSeeProfit: true, limit: 1000 }, { ...P, group: 'day', days: 30 })
    const lines = Object.fromEntries(rep.tables[0].rows.map((r) => [String(r.line).trim(), r.amount]))
    expect(lines['Stock adjustments (write-offs net of found)']).toBe('95.00')
    expect(lines['Cost of goods sold']).toBe('380.00')
    expect(lines['Total cost of goods']).toBe('475.00')
    expect(lines['Gross profit']).toBe('125.00')
    // found stock (+2 at average 95) is a negative cost
    await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '2', reason: 'found' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await loadProfitLoss(db, a.cid, null, P)).toMatchObject({ stockAdjustments: '-95.00', grossProfit: '315.00' })
  })

  it('period boundary by local date (Asia/Dhaka): first and last local day', async () => {
    const { db, schema, a, cable, buyCable } = await seed()
    await buyCable(10, '10')
    const { adjustStock } = await import('./adjustments')
    const r1 = await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-1', reason: 'loss' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const r2 = await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: '-2', reason: 'loss' }, await (await import('@/test/seed')).mainCtx(a.cid))
    // 2026-10-31T18:00Z = 2026-11-01 00:00 in Dhaka (first local day of November); 2026-11-30T17:59:59Z = 23:59:59 on the last day
    await db.update(schema.stockAdjustments).set({ createdAt: new Date('2026-10-31T18:00:00Z') }).where(eq(schema.stockAdjustments.id, r1.id))
    await db.update(schema.stockAdjustments).set({ createdAt: new Date('2026-11-30T17:59:59Z') }).where(eq(schema.stockAdjustments.id, r2.id))
    const { loadProfitLoss } = await import('../reports/profit')
    expect((await loadProfitLoss(db, a.cid, null, P, 'Asia/Dhaka')).stockAdjustments).toBe('30.00')
    expect((await loadProfitLoss(db, a.cid, null, { from: '2026-10-01', to: '2026-10-31' }, 'Asia/Dhaka')).stockAdjustments).toBe('0.00')
    expect((await loadProfitLoss(db, a.cid, null, { from: '2026-12-01', to: '2026-12-31' }, 'Asia/Dhaka')).stockAdjustments).toBe('0.00')
    expect((await loadProfitLoss(db, a.cid, null, { from: '2026-11-01', to: '2026-11-01' }, 'Asia/Dhaka')).stockAdjustments).toBe('10.00')
    expect((await loadProfitLoss(db, a.cid, null, { from: '2026-11-30', to: '2026-11-30' }, 'Asia/Dhaka')).stockAdjustments).toBe('20.00')
    // in UTC the first one falls on 2026-10-31
    expect((await loadProfitLoss(db, a.cid, null, P, 'UTC')).stockAdjustments).toBe('20.00')
    // company-scoped
    const { b } = await (async () => ({ b: (await db.select().from(schema.companies).where(eq(schema.companies.name, 'B Co')))[0] }))()
    expect((await loadProfitLoss(db, b.id, null, P)).stockAdjustments).toBe('0.00')
  })

  it('serial: a damaged/lost unit carries its net cost into the P&L; a damaged CUSTOMER return stays in COGS only (no double count)', async () => {
    const { db, schema, a, cam, rahim, cash, buy } = await seed()
    await buy(['P-1', 'P-2'], '1000')
    const { adjustStock } = await import('./adjustments')
    const r = await adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'P-1', reason: 'loss' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [row] = await db.select().from(schema.stockAdjustments).where(eq(schema.stockAdjustments.id, r.id))
    expect(row.value).toBe('-1000.00')
    const { createSale, createSaleReturn } = await import('../sales/sales')
    const sale = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ serial: 'P-2', qty: 1, unitPrice: '1500' }], payments: [{ accountId: cash.id, amount: '1500' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, sale.id))
    await createSaleReturn(db, a.cid, a.uid, sale.id, { items: [{ saleItemId: item.id, qty: 1, restock: 'damaged' }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    const { loadProfitLoss } = await import('../reports/profit')
    const pl = await loadProfitLoss(db, a.cid, null, P)
    // revenue 1500 - 1500 returned = 0; COGS 1000 stays (damaged return not restocked); adjustment only the lost unit
    expect(pl).toMatchObject({ revenue: '0.00', cogs: '1000.00', cogsRestocked: '0.00', netCogs: '1000.00', stockAdjustments: '1000.00', grossProfit: '-2000.00' })
    // the damaged returned unit cannot be written off again
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: cam.id, serial: 'P-2', reason: 'damage' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/damaged and cannot be changed/)
    expect((await loadProfitLoss(db, a.cid, null, P)).stockAdjustments).toBe('1000.00')
  })
})

describe('fix round 1: partial count apply, movement clock, FK', () => {
  it('onlyUnchanged applies the unchanged lines in one transaction and reports the moved ones', async () => {
    const { db, a, cable, rahim, cash, buyCable } = await seed()
    const { createProduct } = await import('../catalog/products')
    const mouse = await createProduct(db, a.cid, a.uid, { name: 'Mouse', sku: 'MS-1', purchasePrice: '10' })
    await buyCable(10, '40')
    const { createPurchase } = await import('../purchases/purchases')
    const [v] = await db.select().from((await import('../db')).schema.vendors)
    await createPurchase(db, a.cid, a.uid, { vendorId: v.id, date: '2026-11-20', items: [{ productId: mouse.id, qty: 5, unitCost: '10', serials: [] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    // counter saw cable 10 and mouse 5; then a cable sale happens
    const { createSale } = await import('../sales/sales')
    await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 1, unitPrice: '100' }], payments: [{ accountId: cash.id, amount: '100' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const { applyStockCount } = await import('./adjustments')
    const input = { lines: [{ productId: cable.id, counted: '8', system: 10 }, { productId: mouse.id, counted: '4', system: 5 }] }
    await expect(applyStockCount(db, a.cid, a.uid, input, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { lines: expect.stringMatching(/Cable \(was 10, now 9\)/) } })
    expect(await onHand(mouse.id, a.cid)).toBe(5)
    const r = await applyStockCount(db, a.cid, a.uid, { ...input, onlyUnchanged: true }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r.applied).toMatchObject([{ productId: mouse.id, from: 5, to: 4, qtyChange: -1 }])
    expect(r.skipped).toEqual([{ productId: cable.id, name: 'Cable', expected: 10, now: 9 }])
    expect(await onHand(mouse.id, a.cid)).toBe(4)
    expect(await onHand(cable.id, a.cid)).toBe(9)
  })

  it('stock_movements written in one transaction order by clock time; stock_adjustments.unit_id FK is ON DELETE RESTRICT', async () => {
    const { db, schema, a, cable } = await seed()
    const ids = await db.transaction(async (tx) => {
      const [m1] = await tx.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: cable.id, type: 'adjustment', qtyChange: 1 }).returning()
      const [m2] = await tx.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: cable.id, type: 'adjustment', qtyChange: 2 }).returning()
      return [m1, m2]
    })
    expect(ids[1].createdAt.getTime()).toBeGreaterThanOrEqual(ids[0].createdAt.getTime())
    const { rowsOf } = await import('../db')
    const { sql } = await import('drizzle-orm')
    const [t] = rowsOf<{ a: string; b: string }>(await db.execute(sql`select (select created_at from stock_movements where id = ${ids[0].id})::text as a, (select created_at from stock_movements where id = ${ids[1].id})::text as b`))
    expect(t.b > t.a).toBe(true) // strictly later within the same transaction (now() would make them equal)
    const fk = rowsOf<{ d: string }>(await db.execute(sql`select confdeltype::text as d from pg_constraint where conname = 'stock_adjustments_unit_id_product_units_id_fk'`))
    expect(fk).toEqual([{ d: 'r' }])
  })
})
