import { and, eq } from 'drizzle-orm'
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
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const db = getDb()
  const cam = await createProduct(db, a.cid, a.uid, { name: 'HIK Camera', sku: 'HIK-1', trackSerial: true, warrantyMonths: 12, purchasePrice: '2000', salePrice: '2800' })
  const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1', purchasePrice: '40', salePrice: '100' })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'ABC Electronics' })
  const rahim = await createParty(db, a.cid, a.uid, 'customer', { name: 'Rahim' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const [bank] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.type, 'bank')))
  const buy = async (serials: string[], cost = '2000', date = '2026-11-20') => createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date, items: [{ productId: cam.id, qty: serials.length, unitCost: cost, serials }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const buyCable = async (qty: number, cost: string, date = '2026-11-20') => createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date, items: [{ productId: cable.id, qty, unitCost: cost, serials: [] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  // company B
  const camB = await createProduct(db, b.cid, b.uid, { name: 'HIK Camera', sku: 'HIK-1', trackSerial: true, salePrice: '1' })
  const custB = await createParty(db, b.cid, b.uid, 'customer', { name: 'B cust' })
  const [cashB] = await db.insert(schema.accounts).values({ companyId: b.cid, type: 'cash', name: 'Cash' }).returning()
  return { db, schema, a, b, cam, cable, vendor, rahim, cash, bank, buy, buyCable, camB, custB, cashB }
}

const mod = () => import('./sales')

const scan = (serial: string, unitPrice = '2800') => ({ serial, qty: 1, unitPrice })

describe('createSale: the brief example (ABC Electronics -> HIK123456789 @2000 -> Rahim @2800)', () => {
  it('unit sold with event, warranty, cost snapshot, payment, due, profit, ledger', async () => {
    const { db, schema, a, cam, rahim, cash, buy } = await seed()
    await buy(['HIK123456789'])
    const { createSale, getSale } = await mod()
    const r = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('HIK123456789')], payments: [{ accountId: cash.id, amount: '1800' }], expectedTotal: '2800.00' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ invoiceNo: 'INV-00001', total: '2800.00', paid: '1800.00', due: '1000.00', duplicate: false })

    const [unit] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'HIK123456789'))
    expect(unit).toMatchObject({ status: 'sold', warrantyStart: D, warrantyEnd: '2027-11-26', purchasePrice: '2000.00' })
    expect(unit.soldAt).toBeInstanceOf(Date)
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, r.id))
    expect(item).toMatchObject({ productId: cam.id, qty: 1, unitPrice: '2800.00', unitCostSnapshot: '2000.00', unitId: unit.id, netTotal: '2800.00' })
    const events = await db.select().from(schema.unitEvents).where(and(eq(schema.unitEvents.unitId, unit.id), eq(schema.unitEvents.type, 'sold')))
    expect(events).toEqual([
      expect.objectContaining({ fromStatus: 'in_stock', toStatus: 'sold', price: '2800.00', refTable: 'sale_items', refId: item.id, actorUserId: a.uid, meta: { saleId: r.id, invoiceNo: 'INV-00001', customerId: rahim.id, unitPrice: '2800.00' } }),
    ])
    const inStock = await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.productId, cam.id), eq(schema.productUnits.status, 'in_stock')))
    expect(inStock).toHaveLength(0)
    const pays = await db.select().from(schema.payments).where(eq(schema.payments.refType, 'sale'))
    expect(pays).toEqual([expect.objectContaining({ direction: 'in', refId: r.id, partyType: 'customer', partyId: rahim.id, amount: '1800.00', accountId: cash.id, date: D })])

    const s = await getSale(db, a.cid, null, r.id)
    expect(s).toMatchObject({ subtotal: '2800.00', discount: '0.00', total: '2800.00', paid: '1800.00', due: '1000.00', status: 'partially_paid', customerName: 'Rahim', cost: '2000.00', profit: '800.00' })
    expect(s.items[0]).toMatchObject({ serialNo: 'HIK123456789', unitStatus: 'sold', warrantyEnd: '2027-11-26', profit: '800.00' })
    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(db, a.cid, null, 'customer', rahim.id)).toMatchObject({ billed: '2800.00', returned: '0.00', paid: '1800.00', due: '1000.00', documents: 1 })
    expect(await db.select().from(schema.activityLog).where(eq(schema.activityLog.action, 'sale.create'))).toHaveLength(1)
  })

  it('warranty end clamps to month end; no warranty months -> no end date', async () => {
    const { db, schema, a, buy, cash } = await seed()
    await buy(['W-1'])
    await db.update(schema.productUnits).set({ warrantyMonths: 1 }).where(eq(schema.productUnits.serialNo, 'W-1'))
    const { createSale } = await mod()
    await createSale(db, a.cid, a.uid, { date: '2026-01-31', items: [scan('W-1', '10')], payments: [{ accountId: cash.id, amount: '10' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [w] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'W-1'))
    expect(w).toMatchObject({ warrantyStart: '2026-01-31', warrantyEnd: '2026-02-28' })
    await buy(['W-2'])
    await db.update(schema.productUnits).set({ warrantyMonths: 0 }).where(eq(schema.productUnits.serialNo, 'W-2'))
    await createSale(db, a.cid, a.uid, { date: D, items: [scan('W-2', '10')], payments: [{ accountId: cash.id, amount: '10' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [w2] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'W-2'))
    expect(w2).toMatchObject({ status: 'sold', warrantyStart: D, warrantyEnd: null })
  })
})

describe('createSale: non-serial lines, discount allocation, average cost', () => {
  it('allocates the discount exactly; cost = average net purchase cost; stock movement -qty', async () => {
    const { db, schema, a, cable, rahim, cash, bank, buy, buyCable } = await seed()
    await buy(['HIK-2'])
    await buyCable(10, '45.25')
    await buyCable(5, '50')
    const { createSale, getSale, productAverageCosts, onHandQty } = await mod()
    expect((await productAverageCosts(db, a.cid, [cable.id])).get(cable.id)).toBe('46.83') // 702.50 / 15
    const r = await createSale(db, a.cid, a.uid, {
      customerId: rahim.id,
      date: D,
      items: [scan('HIK-2'), { productId: cable.id, qty: 4, unitPrice: '100' }],
      discount: '0.07',
      payments: [
        { accountId: cash.id, amount: '3000' },
        { accountId: bank.id, amount: '199.93', method: 'bKash TrxID 9X' },
      ],
    }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ total: '3199.93', paid: '3199.93', due: '0.00' })
    const s = await getSale(db, a.cid, null, r.id)
    expect(s.status).toBe('paid')
    // 0.07 over 2800 / 400: floor shares 0.06 / 0.00, the leftover cent goes to the larger remainder (cable)
    expect(s.items.map((i) => [i.serialNo ?? 'cable', i.netTotal, i.unitCost])).toEqual([
      ['HIK-2', '2799.94', '2000.00'],
      ['cable', '399.99', '46.83'],
    ])
    expect(s.profit).toBe('1012.61') // (2799.94 - 2000) + (399.99 - 4 * 46.83)
    const moves = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.productId, cable.id), eq(schema.stockMovements.type, 'sale')))
    expect(moves).toEqual([expect.objectContaining({ qtyChange: -4, refTable: 'sale_items' })])
    expect((await onHandQty(db, a.cid, null, [cable.id])).get(cable.id)).toBe(11)
    const pays = await db.select().from(schema.payments).where(eq(schema.payments.refId, r.id))
    expect(pays.map((p) => [p.amount, p.method]).sort()).toEqual([['199.93', 'bKash TrxID 9X'], ['3000.00', null]])
  })

  it('falls back to products.purchase_price when there is no purchase history', async () => {
    const { db, schema, a, cable, cash } = await seed()
    await db.insert(schema.stockMovements).values({ companyId: a.cid, branchId: await (await import('@/test/seed')).mainBranchId(a.cid), productId: cable.id, type: 'adjustment', qtyChange: 3 })
    const { createSale } = await mod()
    const r = await createSale(db, a.cid, a.uid, { date: D, items: [{ productId: cable.id, qty: 1, unitPrice: '100' }], payments: [{ accountId: cash.id, amount: '100' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, r.id))
    expect(item.unitCostSnapshot).toBe('40.00')
  })
})

describe('createSale: rejections', () => {
  it('unknown / sold / damaged serials, duplicates, serial products by qty, out of stock, walk-in due, totals', async () => {
    const { db, schema, a, cam, cable, rahim, cash, buy, buyCable } = await seed()
    await buy(['S-OK', 'S-SOLD', 'S-DMG'])
    await buyCable(2, '40')
    const { createSale } = await mod()
    await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-SOLD')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await db.update(schema.productUnits).set({ status: 'damaged' }).where(eq(schema.productUnits.serialNo, 'S-DMG'))
    const before = (await db.select().from(schema.sales)).length

    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('NOPE-1')] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: 'Serial NOPE-1 is not in stock: it is unknown (no such serial in your stock records).', fields: { 'items.0.serial': expect.stringMatching(/unknown/) } })
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-SOLD')] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: 'Serial S-SOLD is not in stock: it is sold.' })
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-DMG')] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: 'Serial S-DMG is not in stock: it is damaged.' })
    const two = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-SOLD'), scan('NOPE-2')] }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
    expect(two.message).toMatch(/These serials are not in stock: S-SOLD, NOPE-2/)
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-OK'), scan(' S-OK ')] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.1.serial': expect.stringMatching(/already on this invoice/) } })
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cam.id, qty: 1, unitPrice: '1' }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.productId': expect.stringMatching(/scan its serial/) } })
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 2, unitPrice: '1' }, { productId: cable.id, qty: 1, unitPrice: '1' }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.qty': 'Only 2 of Cable in stock.' } })
    // walk-in must pay in full
    await expect(createSale(db, a.cid, a.uid, { date: D, items: [scan('S-OK')], payments: [{ accountId: cash.id, amount: '100' }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { customerId: expect.stringMatching(/walk-in/i) } })
    // totals are the server's
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-OK')], expectedTotal: '2700' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { total: expect.stringMatching(/2800\.00/) } })
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-OK')], payments: [{ accountId: cash.id, amount: '2800.01' }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { paid: expect.any(String) } })
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('S-OK')], discount: '2800.01' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { discount: expect.any(String) } })
    expect(await db.select().from(schema.sales)).toHaveLength(before)
    expect((await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'S-OK')))[0].status).toBe('in_stock')
    // failed attempts did not burn invoice numbers
    const ok = await createSale(db, a.cid, a.uid, { date: D, items: [scan('S-OK', '0')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(ok.invoiceNo).toBe('INV-00002')
    // a walk-in sale fully paid: no customer, payment without party
    const { getSale } = await mod()
    expect(await getSale(db, a.cid, null, ok.id)).toMatchObject({ customerId: null, total: '0.00', status: 'paid' })
  })
})

describe('concurrency', () => {
  it('double-sell race: the same serial in concurrent sales -> exactly one wins, losers roll back entirely', async () => {
    const { createSale } = await mod()
    for (let round = 0; round < 3; round++) {
      await resetData()
      const s = await seed()
      await s.buy(['RACE-1'])
      const go = async () => createSale(s.db, s.a.cid, s.a.uid, { customerId: s.rahim.id, date: D, items: [scan('RACE-1')], payments: [{ accountId: s.cash.id, amount: '500' }] }, await (await import('@/test/seed')).mainCtx(s.a.cid))
      const res = await Promise.allSettled([go(), go(), go()])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of res.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ name: 'FieldErrors', message: 'Serial RACE-1 is not in stock: it is sold.' })
      expect(await s.db.select().from(s.schema.sales)).toHaveLength(1)
      expect(await s.db.select().from(s.schema.saleItems)).toHaveLength(1)
      expect(await s.db.select().from(s.schema.payments).where(eq(s.schema.payments.refType, 'sale'))).toHaveLength(1)
      expect(await s.db.select().from(s.schema.unitEvents).where(eq(s.schema.unitEvents.type, 'sold'))).toHaveLength(1)
      // the losers' invoice numbers were given back: the next sale continues the sequence
      await s.buy(['NEXT-1'])
      expect((await createSale(s.db, s.a.cid, s.a.uid, { customerId: s.rahim.id, date: D, items: [scan('NEXT-1')] }, await (await import('@/test/seed')).mainCtx(s.a.cid))).invoiceNo).toBe('INV-00002')
    }
  })

  it('deterministic: a unit locked and sold on another connection makes the waiting sale fail with nothing written', async () => {
    const { db, schema, a, rahim, cash, buy } = await seed()
    await buy(['HOLD-1'])
    const { createSale } = await mod()
    const pg = (await import('pg')).default
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      await other.query('begin')
      await other.query(`select id from product_units where company_id = $1 and serial_no = 'HOLD-1' for update`, [a.cid])
      const pending = createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('HOLD-1')], payments: [{ accountId: cash.id, amount: '100' }] }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
      await waitForLockWait() // the sale is now blocked on the unit lock
      await other.query(`update product_units set status = 'sold' where company_id = $1 and serial_no = 'HOLD-1'`, [a.cid])
      await other.query('commit')
      expect(await pending).toMatchObject({ name: 'FieldErrors', fields: { 'items.0.serial': 'Serial HOLD-1 is not in stock: it is sold.' } })
    } finally {
      await other.end()
    }
    expect(await db.select().from(schema.sales)).toHaveLength(0)
    expect(await db.select().from(schema.payments).where(eq(schema.payments.refType, 'sale'))).toHaveLength(0)
    const [seqRow] = await db.select().from(schema.docSequences).where(and(eq(schema.docSequences.companyId, a.cid), eq(schema.docSequences.kind, 'sale')))
    expect(seqRow?.nextValue ?? 1).toBe(1) // INV number not consumed
  })

  it('oversell race: concurrent sales of the last loose unit -> exactly one wins, stock never negative', async () => {
    const { createSale, onHandQty } = await mod()
    for (let round = 0; round < 3; round++) {
      await resetData()
      const s = await seed()
      await s.buyCable(1, '40')
      const go = async () => createSale(s.db, s.a.cid, s.a.uid, { customerId: s.rahim.id, date: D, items: [{ productId: s.cable.id, qty: 1, unitPrice: '100' }] }, await (await import('@/test/seed')).mainCtx(s.a.cid))
      const res = await Promise.allSettled([go(), go(), go(), go()])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of res.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ fields: { 'items.0.qty': 'Cable is out of stock.' } })
      expect((await onHandQty(s.db, s.a.cid, null, [s.cable.id])).get(s.cable.id)).toBe(0)
      expect(await s.db.select().from(s.schema.sales)).toHaveLength(1)
    }
  })

  it('idempotency key: a resubmit (sequential or concurrent) returns the same invoice, writes nothing twice', async () => {
    const { db, schema, a, rahim, cash, cable, buy, buyCable } = await seed()
    await buy(['IDEM-1'])
    await buyCable(5, '40')
    const { createSale } = await mod()
    const key = '6f1c2b0e-8a7d-4f5e-9c3b-2a1d0e9f8c7b'
    const input = { customerId: rahim.id, date: D, items: [scan('IDEM-1')], payments: [{ accountId: cash.id, amount: '2800' }], idempotencyKey: key }
    const first = await createSale(db, a.cid, a.uid, input, await (await import('@/test/seed')).mainCtx(a.cid))
    const again = await createSale(db, a.cid, a.uid, input, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(again).toMatchObject({ id: first.id, invoiceNo: first.invoiceNo, duplicate: true })
    // concurrent double-submit of one attempt (serial line: the loser fails on the unit lock and gets the winner back)
    await buy(['IDEM-2'])
    const key2 = '7a2d3c1f-9b8e-4a6f-8d4c-3b2e1f0a9d8c'
    const both = await Promise.all([0, 1].map(async () => createSale(db, a.cid, a.uid, { ...input, items: [scan('IDEM-2')], idempotencyKey: key2 }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(both[0].id).toBe(both[1].id)
    expect(both.filter((x) => x.duplicate)).toHaveLength(1)
    // concurrent double-submit with loose stock only (the second waits on the product lock, then finds the key)
    const key3 = '8b3e4d2a-0c9f-4b7a-9e5d-4c3f2a1b0e9d'
    const three = await Promise.all([0, 1, 2].map(async () => createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 2, unitPrice: '100' }], idempotencyKey: key3 }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(new Set(three.map((x) => x.id)).size).toBe(1)
    expect(await db.select().from(schema.sales)).toHaveLength(3)
    expect(await db.select().from(schema.payments).where(eq(schema.payments.refType, 'sale'))).toHaveLength(2)
  })
})

describe('cross-company isolation', () => {
  it("cannot sell company A's serial from company B; foreign customer/account ids rejected; reads and writes isolated", async () => {
    const { db, schema, a, b, rahim, cash, buy, camB, custB, cashB } = await seed()
    await buy(['X-1'])
    const { createSale, getSale, listSales, recordCustomerPayment, createSaleReturn, lookupSerialForSale } = await mod()
    await expect(createSale(db, b.cid, b.uid, { customerId: custB.id, date: D, items: [scan('X-1', '1')] }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ message: expect.stringMatching(/X-1 is not in stock: it is unknown/) })
    expect(await lookupSerialForSale(db, b.cid, null, 'X-1')).toMatchObject({ ok: false })
    await expect(createSale(db, b.cid, b.uid, { customerId: rahim.id, date: D, items: [{ productId: camB.id, qty: 1, unitPrice: '1' }] }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { customerId: 'Customer not found' } })
    // B owns the same serial text: its own unit, its own sale
    await db.insert(schema.productUnits).values({ companyId: b.cid, branchId: await (await import('@/test/seed')).mainBranchId(b.cid), productId: camB.id, serialNo: 'X-1', purchasePrice: '1' })
    await expect(createSale(db, b.cid, b.uid, { customerId: custB.id, date: D, items: [scan('X-1', '1')], payments: [{ accountId: cash.id, amount: '1' }] }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { 'payments.0.accountId': 'Account not found' } })
    const sb = await createSale(db, b.cid, b.uid, { customerId: custB.id, date: D, items: [scan('X-1', '1')], payments: [{ accountId: cashB.id, amount: '1' }] }, await (await import('@/test/seed')).mainCtx(b.cid))
    expect(sb.invoiceNo).toBe('INV-00001')
    expect((await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.companyId, a.cid), eq(schema.productUnits.serialNo, 'X-1'))))[0].status).toBe('in_stock')

    const sa = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('X-1')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(getSale(db, b.cid, null, sa.id)).rejects.toMatchObject({ name: 'NotFoundError' })
    expect((await listSales(db, b.cid, null, { limit: 50, offset: 0 })).rows.map((r) => r.id)).toEqual([sb.id])
    await expect(recordCustomerPayment(db, b.cid, b.uid, sa.id, { amount: '1', accountId: cashB.id, date: D }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ name: 'NotFoundError' })
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, sa.id))
    await expect(createSaleReturn(db, b.cid, b.uid, sa.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(recordCustomerPayment(db, a.cid, a.uid, sa.id, { amount: '1', accountId: cashB.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { accountId: 'Account not found' } })
  })
  it("serial search in the invoice list only matches the company's own units (raw join carries the company predicate)", async () => {
    const { db, schema, a, b, rahim, buy, camB } = await seed()
    await buy(['OWN-1'])
    const { createSale, listSales } = await mod()
    const sa = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('OWN-1')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect((await listSales(db, a.cid, null, { q: 'OWN-1', limit: 50, offset: 0 })).rows.map((r) => r.id)).toEqual([sa.id])
    // Corrupt data on purpose: A's sale line points at a unit of company B. Searching B's serial from A must find nothing.
    const [foreign] = await db.insert(schema.productUnits).values({ companyId: b.cid, branchId: await (await import('@/test/seed')).mainBranchId(b.cid), productId: camB.id, serialNo: 'ONLY-IN-B', purchasePrice: '1' }).returning()
    await db.update(schema.saleItems).set({ unitId: foreign.id }).where(eq(schema.saleItems.saleId, sa.id))
    expect((await listSales(db, a.cid, null, { q: 'ONLY-IN-B', limit: 50, offset: 0 })).rows).toEqual([])
  })
})

describe('customer payments and due collection', () => {
  it('partial payment reduces due; over-payment, zero and early dates rejected; concurrent payments cannot overpay', async () => {
    const { db, schema, a, rahim, cash, buy } = await seed()
    await buy(['P-1'])
    const { createSale, recordCustomerPayment, getSale } = await mod()
    const s = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('P-1', '1000')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(s.due).toBe('1000.00')
    expect(await recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '400', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ paid: '400.00', due: '600.00' })
    expect((await getSale(db, a.cid, null, s.id)).status).toBe('partially_paid')
    await expect(recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '600.01', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/600\.00/) } })
    await expect(recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '0', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { amount: expect.any(String) } })
    await expect(recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '1', accountId: cash.id, date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.stringMatching(/before the sale date/) } })
    const res = await Promise.allSettled([0, 1, 2].map(async () => recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '400', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const after = await getSale(db, a.cid, null, s.id)
    expect(after).toMatchObject({ paid: '800.00', due: '200.00' })
    expect(await db.select().from(schema.recordHistory).where(eq(schema.recordHistory.entityId, s.id))).toHaveLength(2)
    await recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '200', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '1', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: 'This invoice has nothing due.' })
    expect((await getSale(db, a.cid, null, s.id)).status).toBe('paid')
  })

  it('customer-level collection applies the amount to the oldest invoices first', async () => {
    const { db, schema, a, rahim, cash, buy } = await seed()
    await buy(['C-1', 'C-2', 'C-3'])
    const { createSale, collectCustomerDue, getSale } = await mod()
    const s2 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: '2026-11-22', items: [scan('C-2', '300')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const s1 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: '2026-11-21', items: [scan('C-1', '100')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const s3 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: '2026-11-25', items: [scan('C-3', '500')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    // only invoices dated on/before the payment date are eligible
    await expect(collectCustomerDue(db, a.cid, a.uid, rahim.id, { amount: '401', accountId: cash.id, date: '2026-11-22' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/400\.00/) } })
    const r = await collectCustomerDue(db, a.cid, a.uid, rahim.id, { amount: '250', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r.allocations.map((x) => [x.invoiceNo, x.amount, x.due])).toEqual([
      ['INV-00002', '100.00', '0.00'],
      ['INV-00001', '150.00', '150.00'],
    ])
    expect(r.remainingDue).toBe('650.00')
    expect((await getSale(db, a.cid, null, s1.id)).status).toBe('paid')
    expect((await getSale(db, a.cid, null, s2.id)).status).toBe('partially_paid')
    expect((await getSale(db, a.cid, null, s3.id)).due).toBe('500.00')
    expect(await db.select().from(schema.payments).where(and(eq(schema.payments.partyId, rahim.id), eq(schema.payments.direction, 'in')))).toHaveLength(2)
    await expect(collectCustomerDue(db, a.cid, a.uid, rahim.id, { amount: '650.01', accountId: cash.id, date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { amount: expect.any(String) } })
    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(db, a.cid, null, 'customer', rahim.id)).toMatchObject({ billed: '900.00', paid: '250.00', due: '650.00' })
  })
})

describe('customer returns', () => {
  it('serial return: due reduced first, rest refunded (payment out), unit back in stock, warranty cleared, ledger exact', async () => {
    const { db, schema, a, rahim, cash, buy } = await seed()
    await buy(['HIK123456789'])
    const { createSale, createSaleReturn, getSale } = await mod()
    const s = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('HIK123456789')], payments: [{ accountId: cash.id, amount: '1800' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s.id))
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { refundAccountId: expect.stringMatching(/1800\.00/) } })
    const r = await createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, note: 'changed mind', refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ returnNo: 'SR-00001', credit: '2800.00', refund: '1800.00', due: '0.00' })
    const [unit] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'HIK123456789'))
    expect(unit).toMatchObject({ status: 'in_stock', soldAt: null, warrantyStart: null, warrantyEnd: null })
    const [ev] = await db.select().from(schema.unitEvents).where(and(eq(schema.unitEvents.unitId, unit.id), eq(schema.unitEvents.type, 'sale_returned')))
    expect(ev).toMatchObject({ fromStatus: 'sold', toStatus: 'in_stock', refTable: 'sale_return_items', price: '2800.00', note: 'changed mind', meta: expect.objectContaining({ returnNo: 'SR-00001', saleId: s.id }) })
    const refund = await db.select().from(schema.payments).where(and(eq(schema.payments.refId, s.id), eq(schema.payments.direction, 'out')))
    expect(refund).toEqual([expect.objectContaining({ amount: '1800.00', partyType: 'customer', partyId: rahim.id, refType: 'sale', accountId: cash.id })])
    const sale = await getSale(db, a.cid, null, s.id)
    expect(sale).toMatchObject({ returnedTotal: '2800.00', paid: '0.00', due: '0.00', status: 'returned', profit: '0.00' })
    expect(sale.returns[0]).toMatchObject({ creditTotal: '2800.00', refundTotal: '1800.00' })
    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(db, a.cid, null, 'customer', rahim.id)).toMatchObject({ billed: '2800.00', returned: '2800.00', paid: '0.00', due: '0.00' })
    // cannot return twice; can be sold again; the old invoice can then not return it
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.qty': 'Already returned.' } })
    const s2 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('HIK123456789', '2500')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(s2.invoiceNo).toBe('INV-00002')
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.qty': 'Already returned.' } })
    // return on the new invoice with due outstanding: credit only reduces the due, no refund, damaged
    const [item2] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s2.id))
    const r2 = await createSaleReturn(db, a.cid, a.uid, s2.id, { items: [{ saleItemId: item2.id, qty: 1, restock: 'damaged' }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r2).toMatchObject({ credit: '2500.00', refund: '0.00', due: '0.00' })
    expect((await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'HIK123456789')))[0].status).toBe('damaged')
    expect(await getLedger(db, a.cid, null, 'customer', rahim.id)).toMatchObject({ billed: '5300.00', returned: '5300.00', paid: '0.00', due: '0.00' })
  })

  it('non-serial partial returns with discount: credits split exactly, stock restored, over-return rejected', async () => {
    const { db, schema, a, rahim, cash, cable, buyCable } = await seed()
    await buyCable(5, '40')
    const { createSale, createSaleReturn, getSale, onHandQty } = await mod()
    const s = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 3, unitPrice: '100' }], discount: '0.01', payments: [{ accountId: cash.id, amount: '299.99' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s.id))
    expect(item.netTotal).toBe('299.99')
    const r1 = await createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r1).toMatchObject({ credit: '100.00', refund: '100.00' })
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 3 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.qty': 'At most 2 can be returned.' } })
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1, restock: 'damaged' }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.restock': expect.any(String) } })
    const r2 = await createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 2 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r2).toMatchObject({ credit: '199.99', refund: '199.99', due: '0.00' })
    const sale = await getSale(db, a.cid, null, s.id)
    expect(sale).toMatchObject({ returnedTotal: '299.99', paid: '0.00', status: 'returned' })
    expect((await onHandQty(db, a.cid, null, [cable.id])).get(cable.id)).toBe(5)
    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.type, 'sale_return'))
    expect(moves.map((m) => m.qtyChange).sort()).toEqual([1, 2])
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: '2026-11-01' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.any(String) } })
  })

  it('rejects items of another invoice and units that are no longer sold', async () => {
    const { db, schema, a, rahim, cash, buy } = await seed()
    await buy(['R-1', 'R-2'])
    const { createSale, createSaleReturn } = await mod()
    const s1 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('R-1')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const s2 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('R-2')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [i2] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s2.id))
    await expect(createSaleReturn(db, a.cid, a.uid, s1.id, { items: [{ saleItemId: i2.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { items: expect.stringMatching(/not part of this invoice/) } })
    await db.update(schema.productUnits).set({ status: 'in_service' }).where(eq(schema.productUnits.serialNo, 'R-2'))
    await expect(createSaleReturn(db, a.cid, a.uid, s2.id, { items: [{ saleItemId: i2.id, qty: 1 }], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.qty': expect.stringMatching(/R-2 is in service, not sold/) } })
    expect(await db.select().from(schema.saleReturns)).toHaveLength(0)
  })
})

describe('lists', () => {
  it('search by invoice, customer and serial; status filter; totals row', async () => {
    const { db, a, rahim, cash, buy } = await seed()
    await buy(['L-1', 'L-2'])
    const { createSale, listSales, listSaleReturns, createSaleReturn, listCustomerUnits, listCustomerPayments } = await mod()
    const s1 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('L-1', '100')], payments: [{ accountId: cash.id, amount: '40' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await createSale(db, a.cid, a.uid, { date: D, items: [scan('L-2', '50')], payments: [{ accountId: cash.id, amount: '50' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const all = await listSales(db, a.cid, null, { limit: 20, offset: 0 })
    expect(all.total).toBe(2)
    expect(all.sums).toEqual({ total: '150.00', returned: '0.00', paid: '90.00', due: '60.00' })
    expect((await listSales(db, a.cid, null, { q: 'L-1', limit: 20, offset: 0 })).rows.map((r) => r.id)).toEqual([s1.id])
    expect((await listSales(db, a.cid, null, { q: 'rahim', limit: 20, offset: 0 })).rows.map((r) => r.id)).toEqual([s1.id])
    expect((await listSales(db, a.cid, null, { q: 'INV-00002', limit: 20, offset: 0 })).rows[0].customerName).toBeNull()
    expect((await listSales(db, a.cid, null, { status: 'partially_paid', limit: 20, offset: 0 })).rows.map((r) => r.id)).toEqual([s1.id])
    expect((await listSales(db, a.cid, null, { status: 'paid', limit: 20, offset: 0 })).total).toBe(1)
    expect((await listSales(db, a.cid, null, { from: '2026-11-27', limit: 20, offset: 0 })).total).toBe(0)
    const { getSale } = await mod()
    const item = (await getSale(db, a.cid, null, s1.id)).items[0]
    await createSaleReturn(db, a.cid, a.uid, s1.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect((await listSales(db, a.cid, null, { status: 'returned', limit: 20, offset: 0 })).rows.map((r) => r.id)).toEqual([s1.id])
    const rets = await listSaleReturns(db, a.cid, null, { q: 'rahim', limit: 20, offset: 0 })
    expect(rets.rows).toEqual([expect.objectContaining({ returnNo: 'SR-00001', invoiceNo: 'INV-00001', creditTotal: '100.00', refundTotal: '40.00', units: 1 })])
    expect(rets.sums).toEqual({ credit: '100.00', refund: '40.00' })
    // returned: still listed (history) but flagged as no longer with this customer
    expect((await listCustomerUnits(db, a.cid, null, rahim.id)).rows).toEqual([expect.objectContaining({ serialNo: 'L-1', status: 'in_stock', current: false })])
    expect((await listCustomerPayments(db, a.cid, null, rahim.id)).map((p) => [p.direction, p.amount]).sort()).toEqual([['in', '40.00'], ['out', '40.00']])
  })
})

describe('fix round 1', () => {
  it('idempotency: same key + same payload -> existing; same key + different payload -> friendly error; keys are per company', async () => {
    const { db, schema, a, b, rahim, cash, buy, camB, custB, cashB } = await seed()
    await buy(['K-1', 'K-2'])
    const { createSale } = await mod()
    const key = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9'
    const input = { customerId: rahim.id, date: D, items: [scan('K-1')], payments: [{ accountId: cash.id, amount: '2800' }], idempotencyKey: key }
    const first = await createSale(db, a.cid, a.uid, input, await (await import('@/test/seed')).mainCtx(a.cid))
    // formatting differences do not change the payload ("2,800" == "2800.00")
    expect(await createSale(db, a.cid, a.uid, { ...input, items: [scan(' K-1 ', '2,800')], payments: [{ accountId: cash.id, amount: '2800.00' }] }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ id: first.id, duplicate: true })
    const changed = await createSale(db, a.cid, a.uid, { ...input, items: [scan('K-1'), scan('K-2')] }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
    expect(changed).toMatchObject({ name: 'FieldErrors', message: `This form was already saved as ${first.invoiceNo}; reload the page to start a new sale.` })
    await expect(createSale(db, a.cid, a.uid, { ...input, payments: [] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { _: expect.stringMatching(/already saved as INV-00001/) } })
    expect((await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'K-2')))[0].status).toBe('in_stock')
    // the same key in another company is independent
    await db.insert(schema.productUnits).values({ companyId: b.cid, branchId: await (await import('@/test/seed')).mainBranchId(b.cid), productId: camB.id, serialNo: 'K-1', purchasePrice: '1' })
    const sb = await createSale(db, b.cid, b.uid, { customerId: custB.id, date: D, items: [scan('K-1', '5')], payments: [{ accountId: cashB.id, amount: '5' }], idempotencyKey: key }, await (await import('@/test/seed')).mainCtx(b.cid))
    expect(sb).toMatchObject({ invoiceNo: 'INV-00001', duplicate: false })
    expect(await db.select().from(schema.sales)).toHaveLength(2)
  })

  it('idempotency: concurrent same-key submits (same and different payloads) create exactly one sale', async () => {
    const { db, schema, a, rahim, cable, buyCable } = await seed()
    await buyCable(10, '40')
    const { createSale } = await mod()
    const key = '2c3d4e5f-6071-4829-93a4-b5c6d7e8f9a0'
    const mk = async (qty: number) => createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty, unitPrice: '100' }], idempotencyKey: key }, await (await import('@/test/seed')).mainCtx(a.cid))
    const res = await Promise.allSettled([mk(1), mk(1), mk(2), mk(1)])
    expect(await db.select().from(schema.sales)).toHaveLength(1)
    const [sale] = await db.select().from(schema.sales)
    const ok = res.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>[]
    for (const r of ok) expect(r.value.id).toBe(sale.id)
    for (const r of res.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason.message).toMatch(/already saved as INV-00001/)
    expect(ok.length).toBeGreaterThanOrEqual(1)
  })

  it('a unit that left INV1 by another route and was resold on INV2 cannot be returned through INV1', async () => {
    const { db, schema, a, rahim, cash, buy } = await seed()
    await buy(['LINK-1'])
    const { createSale, createSaleReturn, getSale } = await mod()
    const { transitionUnit } = await import('../serials')
    const s1 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('LINK-1', '1000')], payments: [{ accountId: cash.id, amount: '1000' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [i1] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s1.id))
    expect((await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'LINK-1')))[0].saleItemId).toBe(i1.id)
    // out of band: sold -> damaged -> in_stock (no customer return recorded), then resold on INV2
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, serial: 'LINK-1', to: 'damaged' }))
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, serial: 'LINK-1', to: 'in_stock' }))
    const s2 = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [scan('LINK-1', '900')], payments: [{ accountId: cash.id, amount: '900' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [i2] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s2.id))
    await expect(createSaleReturn(db, a.cid, a.uid, s1.id, { items: [{ saleItemId: i1.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.qty': 'Unit LINK-1 is no longer sold on this invoice: it cannot be returned here.' } })
    const [u] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'LINK-1'))
    expect(u).toMatchObject({ status: 'sold', saleItemId: i2.id })
    expect(await getSale(db, a.cid, null, s1.id)).toMatchObject({ returnedTotal: '0.00', paid: '1000.00' })
    expect(await getSale(db, a.cid, null, s2.id)).toMatchObject({ returnedTotal: '0.00', paid: '900.00' })
    expect(await db.select().from(schema.saleReturns)).toHaveLength(0)
    // the real return path works through INV2 and clears the link
    expect(await createSaleReturn(db, a.cid, a.uid, s2.id, { items: [{ saleItemId: i2.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ credit: '900.00', refund: '900.00' })
    expect((await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'LINK-1')))[0]).toMatchObject({ status: 'in_stock', saleItemId: null })
  })

  it('transitionLockedUnits refuses stale snapshots: the UPDATE must touch every unit in an allowed status', async () => {
    const { db, schema, a, buy } = await seed()
    await buy(['STALE-1'])
    const { lockUnitsForUpdate, transitionLockedUnits } = await import('../serials')
    const [unit0] = await db.select().from(schema.productUnits)
    const [snap] = await db.transaction((tx) => lockUnitsForUpdate(tx, a.cid, [unit0.id]))
    await db.update(schema.productUnits).set({ status: 'damaged' }).where(eq(schema.productUnits.id, snap.id))
    await expect(db.transaction((tx) => transitionLockedUnits(tx, { companyId: a.cid, userId: a.uid, to: 'sold', allowedFrom: ['in_stock'], items: [{ unit: snap }] }))).rejects.toThrow(/expected 1 units to change, changed 0/)
    expect(await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.type, 'sold'))).toHaveLength(0)
  })

  it('deterministic oversell: a sale waits on the product lock, then re-reads stock and fails', async () => {
    const { db, schema, a, rahim, cable, buyCable } = await seed()
    await buyCable(1, '40')
    const { createSale } = await mod()
    const pg = (await import('pg')).default
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await other.connect()
    try {
      await other.query('begin')
      await other.query('select id from products where id = $1 for update', [cable.id])
      await other.query(`insert into stock_movements (company_id, branch_id, product_id, type, qty_change) values ($1, (select id from branches where company_id = $1 and is_default), $2, 'adjustment', -1)`, [a.cid, cable.id])
      const pending = createSale(db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ productId: cable.id, qty: 1, unitPrice: '100' }] }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
      await waitForLockWait()
      await other.query('commit')
      expect(await pending).toMatchObject({ name: 'FieldErrors', fields: { 'items.0.qty': 'Cable is out of stock.' } })
    } finally {
      await other.end()
    }
    expect(await db.select().from(schema.sales)).toHaveLength(0)
  })

  it('dates may be at most one day ahead of today in the app time zone', async () => {
    const { db, a, rahim, cash, buy } = await seed()
    await buy(['DT-1', 'DT-2'])
    const { createSale, recordCustomerPayment, collectCustomerDue, createSaleReturn, getSale } = await mod()
    const { addDays, localDate } = await import('../dates')
    const { appTimezone } = await import('../dashboard')
    const tomorrow = addDays(localDate(appTimezone()), 1)
    const later = addDays(tomorrow, 1)
    await expect(createSale(db, a.cid, a.uid, { customerId: rahim.id, date: later, items: [scan('DT-1')] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: `Date cannot be later than ${tomorrow}.` } })
    const s = await createSale(db, a.cid, a.uid, { customerId: rahim.id, date: tomorrow, items: [scan('DT-1')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(recordCustomerPayment(db, a.cid, a.uid, s.id, { amount: '1', accountId: cash.id, date: later }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.any(String) } })
    await expect(collectCustomerDue(db, a.cid, a.uid, rahim.id, { amount: '1', accountId: cash.id, date: later }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.any(String) } })
    const item = (await getSale(db, a.cid, null, s.id)).items[0]
    await expect(createSaleReturn(db, a.cid, a.uid, s.id, { items: [{ saleItemId: item.id, qty: 1 }], date: later }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.any(String) } })
  })
})
