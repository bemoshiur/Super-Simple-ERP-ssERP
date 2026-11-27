import { and, asc, eq } from 'drizzle-orm'
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

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const db = getDb()
  const phone = await createProduct(db, a.cid, a.uid, { name: 'Phone X', sku: 'PX-1', trackSerial: true, warrantyMonths: 12, purchasePrice: '15000' })
  const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1', purchasePrice: '50' })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'Rahim Traders', openingBalance: '1000' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  // company B
  const phoneB = await createProduct(db, b.cid, b.uid, { name: 'Phone X', sku: 'PX-1', trackSerial: true })
  const vendorB = await createParty(db, b.cid, b.uid, 'vendor', { name: 'B vendor' })
  const [cashB] = await db.insert(schema.accounts).values({ companyId: b.cid, type: 'cash', name: 'Cash' }).returning()
  return { db, schema, a, b, phone, cable, vendor, cash, phoneB, vendorB, cashB }
}

const mod = () => import('./purchases')
const line = (productId: string, qty: number, unitCost: string, serials: string[] = []) => ({ productId, qty, unitCost, serials })

describe('createPurchase', () => {
  it('3 serials + a non-serial line: units, events, stock, payment, due, invoice number', async () => {
    const { db, schema, a, phone, cable, vendor, cash } = await seed()
    const { createPurchase, getPurchase } = await mod()
    const r = await createPurchase(db, a.cid, a.uid, {
      vendorId: vendor.id,
      date: '2026-11-26',
      items: [line(phone.id, 3, '15,000.50', ['IMEI-1', 'IMEI-2', 'IMEI-3']), line(cable.id, 10, '45.25')],
      discount: '0.50',
      paid: '20000',
      accountId: cash.id,
      expectedTotal: '45453.50',
    }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ invoiceNo: 'PUR-00001', total: '45453.50', due: '25453.50' })

    const p = await getPurchase(db, a.cid, null, r.id)
    expect(p).toMatchObject({ subtotal: '45454.00', discount: '0.50', total: '45453.50', paid: '20000.00', due: '25453.50', returnedTotal: '0.00', status: 'partially_paid', vendorName: 'Rahim Traders' })
    const phoneLine = p.items.find((i) => i.productId === phone.id)!
    expect(phoneLine.units.map((u) => [u.serialNo, u.status])).toEqual([
      ['IMEI-1', 'in_stock'],
      ['IMEI-2', 'in_stock'],
      ['IMEI-3', 'in_stock'],
    ])

    const units = await db.select().from(schema.productUnits).where(eq(schema.productUnits.companyId, a.cid))
    expect(units).toHaveLength(3)
    for (const u of units) expect(u).toMatchObject({ productId: phone.id, vendorId: vendor.id, warrantyMonths: 12, status: 'in_stock', purchaseItemId: phoneLine.id })
    // NET unit cost: the 0.50 discount is allocated 0.50 to the phone line (largest remainder), 0.00 to the cable line,
    // then 45001.00 is split over 3 units with the extra cent on the first unit in entry order.
    const bySerial = Object.fromEntries(units.map((u) => [u.serialNo, u.purchasePrice]))
    expect(bySerial).toEqual({ 'IMEI-1': '15000.34', 'IMEI-2': '15000.33', 'IMEI-3': '15000.33' })
    expect(p.items.map((i) => [i.productId === phone.id ? 'phone' : 'cable', i.netTotal]).sort()).toEqual([['cable', '452.50'], ['phone', '45001.00']].sort())
    const events = await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.companyId, a.cid))
    expect(events).toHaveLength(3)
    for (const e of events) expect(e).toMatchObject({ type: 'purchased', fromStatus: null, toStatus: 'in_stock', refTable: 'purchase_items', refId: phoneLine.id, actorUserId: a.uid, price: bySerial[units.find((u) => u.id === e.unitId)!.serialNo] })

    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.companyId, a.cid))
    expect(moves).toEqual([expect.objectContaining({ productId: cable.id, type: 'purchase', qtyChange: 10, refTable: 'purchase_items' })])

    const pays = await db.select().from(schema.payments).where(eq(schema.payments.companyId, a.cid))
    expect(pays).toEqual([expect.objectContaining({ direction: 'out', refType: 'purchase', refId: r.id, partyType: 'vendor', partyId: vendor.id, amount: '20000.00', accountId: cash.id })])
    const log = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.companyId, a.cid), eq(schema.activityLog.action, 'purchase.create')))
    expect(log).toHaveLength(1)

    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(db, a.cid, null, 'vendor', vendor.id)).toMatchObject({ billed: '45453.50', paid: '20000.00', due: '26453.50' })

    // trackSerial guard contract: the product now has stock history
    const { updateProduct } = await import('../catalog/products')
    await expect(updateProduct(db, a.cid, a.uid, phone.id, { name: 'Phone X', sku: 'PX-1', trackSerial: false })).rejects.toMatchObject({ fields: { trackSerial: expect.any(String) } })
  })

  it('never trusts client totals: recomputes, rejects a mismatching expectedTotal', async () => {
    const { db, schema, a, cable, vendor } = await seed()
    const { createPurchase } = await mod()
    const r = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 3, '10.10')], subtotal: '1', total: '1', due: '0', status: 'paid', paid: '0' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const [row] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, r.id))
    expect(row).toMatchObject({ subtotal: '30.30', total: '30.30', due: '30.30', paid: '0.00', status: 'received' })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 3, '10.10')], expectedTotal: '30.00' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { total: expect.stringMatching(/30\.30/) } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '10')], discount: '11' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { discount: expect.any(String) } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '10')], paid: '10.01', accountId: (await db.select().from(schema.accounts))[0].id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { paid: expect.any(String) } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '10')], paid: '5' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { accountId: expect.any(String) } })
    expect(await db.select().from(schema.purchases)).toHaveLength(1)
  })

  it('serial count must equal qty; non-serial lines take no serials', async () => {
    const { db, schema, a, phone, cable, vendor } = await seed()
    const { createPurchase } = await mod()
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 3, '1', ['A', 'B'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.serials': expect.stringMatching(/exactly 3/) } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '1', ['A'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.serials': expect.stringMatching(/does not track/) } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['has space'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.serials': expect.stringMatching(/Invalid serial/) } })
    expect(await db.select().from(schema.productUnits)).toHaveLength(0)
    expect(await db.select().from(schema.purchases)).toHaveLength(0)
    // the failed attempts did not burn invoice numbers
    const r = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['﻿ OK-1​ '])] }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r.invoiceNo).toBe('PUR-00001')
    expect((await db.select().from(schema.productUnits))[0].serialNo).toBe('OK-1')
  })

  it('rejects duplicate serials within the invoice and against existing units, listing them', async () => {
    const { db, schema, a, phone, vendor } = await seed()
    const { createPurchase } = await mod()
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 2, '1', ['D1', 'D1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: expect.stringMatching(/D1/), fields: { 'items.0.serials': expect.stringMatching(/more than once/) } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['X1']), line(phone.id, 1, '1', ['X1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.1.serials': expect.stringMatching(/X1/) } })

    const many = Array.from({ length: 25 }, (_, i) => `S-${String(i).padStart(2, '0')}`)
    await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 25, '1', many)] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const err = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 26, '1', [...many, 'NEW-1'])] }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
    expect(err.fields['items.0.serials']).toMatch(/and 5 more$/)
    expect(err.message).toMatch(/25 serial numbers are already recorded/)
    // case differs: a distinct serial (case-sensitive)
    await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['s-00'])] }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await db.select().from(schema.productUnits)).toHaveLength(26)
  })

  it('race: concurrent invoices with the same serial -> exactly one succeeds', async () => {
    const { createPurchase } = await mod()
    for (let round = 0; round < 3; round++) {
      await resetData()
      const s = await seed()
      const go = async (extra: string) => createPurchase(s.db, s.a.cid, s.a.uid, { vendorId: s.vendor.id, date: '2026-11-26', items: [line(s.phone.id, 2, '1', ['RACE-1', extra])] }, await (await import('@/test/seed')).mainCtx(s.a.cid))
      const res = await Promise.allSettled([go('R-A'), go('R-B'), go('R-C')])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of res.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ name: 'FieldErrors', message: expect.stringMatching(/RACE-1/) })
      expect(await s.db.select().from(s.schema.productUnits).where(eq(s.schema.productUnits.serialNo, 'RACE-1'))).toHaveLength(1)
      expect(await s.db.select().from(s.schema.purchases)).toHaveLength(1)
    }
  })

  it('the unique index is the real guard: a serial committed after the pre-check maps 23505 to a friendly error', async () => {
    const { db, schema, a, phone, vendor } = await seed()
    const { createPurchase } = await mod()
    const pg = (await import('pg')).default
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('begin')
      await holder.query('insert into product_units (company_id, product_id, serial_no, purchase_price) values ($1, $2, $3, 1)', [a.cid, phone.id, 'HOLD-1'])
      // pre-check cannot see the uncommitted row; the insert then waits on the unique index
      const pending = createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 2, '1', ['HOLD-1', 'FREE-1'])] }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
      await waitForLockWait() // the purchase's insert is now blocked on the uncommitted unique key
      await holder.query('commit')
      const err = await pending
      expect(err).toMatchObject({ name: 'FieldErrors', fields: { 'items.0.serials': 'Already recorded: HOLD-1' } })
    } finally {
      await holder.end()
    }
    expect(await db.select().from(schema.purchases)).toHaveLength(0)
    expect((await db.select().from(schema.productUnits)).map((u) => u.serialNo)).toEqual(['HOLD-1'])
  })

  it('cross-company: same serial allowed in both; foreign vendor/product/account ids rejected; reads isolated', async () => {
    const { db, schema, a, b, phone, vendor, cash, phoneB, vendorB, cashB } = await seed()
    const { createPurchase, getPurchase, listPurchases } = await mod()
    const ra = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['SAME-1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const rb = await createPurchase(db, b.cid, b.uid, { vendorId: vendorB.id, date: '2026-11-26', items: [line(phoneB.id, 1, '1', ['SAME-1'])] }, await (await import('@/test/seed')).mainCtx(b.cid))
    expect(rb.invoiceNo).toBe('PUR-00001') // B has no prefix setting: fallback prefix, its own counter
    expect(await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'SAME-1'))).toHaveLength(2)

    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendorB.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['Z1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { vendorId: 'Vendor not found' } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phoneB.id, 1, '1', ['Z1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.productId': 'Product not found' } })
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '5', ['Z1'])], paid: '5', accountId: cashB.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { accountId: 'Account not found' } })

    const { NotFoundError } = await import('../errors')
    await expect(getPurchase(db, b.cid, null, ra.id)).rejects.toBeInstanceOf(NotFoundError)
    expect((await listPurchases(db, b.cid, null, { limit: 20, offset: 0 })).rows.map((r) => r.id)).toEqual([rb.id])
    const { recordVendorPayment, createPurchaseReturn } = await mod()
    await expect(recordVendorPayment(db, b.cid, b.uid, ra.id, { amount: '1', accountId: cashB.id, date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toBeInstanceOf(NotFoundError)
    const unitA = (await getPurchase(db, a.cid, null, ra.id)).items[0].units[0]
    await expect(createPurchaseReturn(db, b.cid, b.uid, rb.id, { unitIds: [unitA.id], date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { unitIds: expect.stringMatching(/not part/) } })
    void cash
  })

  it('inactive vendor / product are rejected', async () => {
    const { db, a, phone, vendor } = await seed()
    const { setProductActive } = await import('../catalog/products')
    const { setPartyActive } = await import('../parties/parties')
    const { createPurchase } = await mod()
    await setProductActive(db, a.cid, a.uid, phone.id, false)
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['Q'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'items.0.productId': expect.stringMatching(/deactivated/) } })
    await setProductActive(db, a.cid, a.uid, phone.id, true)
    await setPartyActive(db, a.cid, a.uid, 'vendor', vendor.id, false)
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '1', ['Q'])] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { vendorId: expect.stringMatching(/deactivated/) } })
  })
})

describe('invoice numbers', () => {
  it('concurrent purchases never share a number, and numbers are gapless', async () => {
    const { db, a, cable, vendor } = await seed()
    const { createPurchase } = await mod()
    const res = await Promise.all(Array.from({ length: 12 }, async () => createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '1')] }, await (await import('@/test/seed')).mainCtx(a.cid))))
    const nos = res.map((r) => r.invoiceNo).sort()
    expect(new Set(nos).size).toBe(12)
    expect(nos).toEqual(Array.from({ length: 12 }, (_, i) => `PUR-${String(i + 1).padStart(5, '0')}`))
  })
  it('uses the company prefix setting', async () => {
    const { db, schema, a, cable, vendor } = await seed()
    await db.update(schema.settings).set({ value: 'BUY/' }).where(and(eq(schema.settings.companyId, a.cid), eq(schema.settings.key, 'invoice_prefix_purchase')))
    const { createPurchase } = await mod()
    expect((await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '1')] }, await (await import('@/test/seed')).mainCtx(a.cid))).invoiceNo).toBe('BUY/00001')
  })
})

describe('vendor payments', () => {
  it('partial payments reduce due; over-payment and zero rejected; concurrent payments cannot overpay', async () => {
    const { db, schema, a, cable, vendor, cash } = await seed()
    const { createPurchase, recordVendorPayment, getPurchase } = await mod()
    const p = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 10, '100')] }, await (await import('@/test/seed')).mainCtx(a.cid))
    await recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '250.50', accountId: cash.id, date: '2026-11-27', method: 'cash' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await getPurchase(db, a.cid, null, p.id)).toMatchObject({ paid: '250.50', due: '749.50', status: 'partially_paid' })
    await expect(recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '749.51', accountId: cash.id, date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { amount: expect.stringMatching(/749\.50/) } })
    await expect(recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '0', accountId: cash.id, date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { amount: expect.any(String) } })

    // two concurrent payments of 500 against 749.50 due: one wins, the other sees the reduced due
    const res = await Promise.allSettled([500, 500].map(async (x) => recordVendorPayment(db, a.cid, a.uid, p.id, { amount: String(x), accountId: cash.id, date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '249.50', accountId: cash.id, date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await getPurchase(db, a.cid, null, p.id)).toMatchObject({ paid: '1000.00', due: '0.00', status: 'paid' })
    await expect(recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '1', accountId: cash.id, date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ message: expect.stringMatching(/nothing due/) })
    const pays = await db.select().from(schema.payments).where(eq(schema.payments.refId, p.id)).orderBy(asc(schema.payments.amount))
    expect(pays.map((x) => x.amount)).toEqual(['249.50', '250.50', '500.00'])
    const hist = await db.select().from(schema.recordHistory).where(eq(schema.recordHistory.entityId, p.id))
    expect(hist).toHaveLength(3)
    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(db, a.cid, null, 'vendor', vendor.id)).toMatchObject({ billed: '1000.00', paid: '1000.00', due: '1000.00' }) // opening 1000 remains
  })
})

describe('purchase returns', () => {
  async function bought() {
    const s = await seed()
    const { createPurchase, getPurchase } = await mod()
    const p = await createPurchase(s.db, s.a.cid, s.a.uid, { vendorId: s.vendor.id, date: '2026-11-26', items: [line(s.phone.id, 3, '1000', ['R1', 'R2', 'R3'])], discount: '100', paid: '2000', accountId: s.cash.id }, await (await import('@/test/seed')).mainCtx(s.a.cid))
    const units = (await getPurchase(s.db, s.a.cid, null, p.id)).items[0].units
    return { ...s, p, units }
  }

  it('reduces due first, unit -> returned_to_vendor with an event, vendor ledger follows', async () => {
    const { db, schema, a, vendor, p, units } = await bought()
    const { createPurchaseReturn, getPurchase } = await mod()
    // total 2900 (3 x 1000 - 100), paid 2000, due 900. Net unit costs: R1 966.67, R2 966.67, R3 966.66.
    expect(units.map((u) => u.purchasePrice)).toEqual(['966.67', '966.67', '966.66'])
    const r = await createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[0].id], date: '2026-11-27', note: 'faulty' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ returnNo: 'PR-00001', credit: '966.67', refund: '0.00', due: '0.00', vendorCredit: '66.67' })
    const after = await getPurchase(db, a.cid, null, p.id)
    expect(after).toMatchObject({ returnedTotal: '966.67', paid: '2000.00', due: '0.00' })
    expect(after.items[0].units.find((u) => u.id === units[0].id)!.status).toBe('returned_to_vendor')
    expect(after.returns[0]).toMatchObject({ returnNo: 'PR-00001', creditTotal: '966.67', items: [expect.objectContaining({ serialNo: 'R1', creditAmount: '966.67' })] })
    const ev = await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.unitId, units[0].id)).orderBy(asc(schema.unitEvents.createdAt))
    expect(ev.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ['purchased', null, 'in_stock'],
      ['returned_to_vendor', 'in_stock', 'returned_to_vendor'],
    ])
    expect(ev[1]).toMatchObject({ refTable: 'purchase_return_items', actorUserId: a.uid, note: 'faulty', price: '966.67' })
    const { getLedger } = await import('../parties/ledger')
    // opening 1000 + billed 2900 - returned 966.67 - paid 2000 = 933.33
    expect(await getLedger(db, a.cid, null, 'vendor', vendor.id)).toMatchObject({ billed: '2900.00', returned: '966.67', paid: '2000.00', due: '933.33' })

    // the same unit cannot be returned twice
    await expect(createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[0].id], date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { unitIds: expect.stringMatching(/R1/) } })
  })

  it('refund only up to the vendor credit created; refund is a payment in; returning every unit credits exactly the total', async () => {
    const { db, schema, a, vendor, cash, p, units } = await bought()
    const { createPurchaseReturn, getPurchase } = await mod()
    // returning R1+R2 (credit 1933.34) against due 900: excess 1033.34 refundable
    await expect(createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[0].id, units[1].id], date: '2026-11-27', refundAmount: '1033.35', refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { refundAmount: expect.stringMatching(/1033\.34/) } })
    await expect(createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[0].id, units[1].id], date: '2026-11-27', refundAmount: '500' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { refundAccountId: expect.any(String) } })
    expect((await getPurchase(db, a.cid, null, p.id)).items[0].units.every((u) => u.status === 'in_stock')).toBe(true)

    const r = await createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[0].id, units[1].id], date: '2026-11-27', refundAmount: '1033.34', refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ credit: '1933.34', refund: '1033.34', due: '0.00', vendorCredit: '0.00' })
    expect(await getPurchase(db, a.cid, null, p.id)).toMatchObject({ returnedTotal: '1933.34', paid: '966.66', due: '0.00' })
    const refunds = await db.select().from(schema.payments).where(and(eq(schema.payments.refId, p.id), eq(schema.payments.direction, 'in')))
    expect(refunds).toEqual([expect.objectContaining({ amount: '1033.34', partyType: 'vendor', partyId: vendor.id, refType: 'purchase', accountId: cash.id })])
    const { getLedger } = await import('../parties/ledger')
    // 1000 + 2900 - 1933.34 - (2000 - 1033.34) = 1000: only the opening balance is left
    expect(await getLedger(db, a.cid, null, 'vendor', vendor.id)).toMatchObject({ returned: '1933.34', paid: '966.66', due: '1000.00' })

    // the last unit credits its net cost; all three returns together credit exactly the invoice total
    const last = await createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[2].id], date: '2026-11-28' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(last).toMatchObject({ returnNo: 'PR-00002', credit: '966.66', vendorCredit: '966.66' })
    const done = await getPurchase(db, a.cid, null, p.id)
    expect(done).toMatchObject({ returnedTotal: '2900.00', total: '2900.00', paid: '966.66', due: '0.00' })
    const { displayStatus } = await import('./totals')
    expect(displayStatus(done)).toBe('returned')
    expect(await getLedger(db, a.cid, null, 'vendor', vendor.id)).toMatchObject({ due: '33.34' }) // 1000 opening - 966.66 still paid in
  })

  it('discount allocation: 2 units @100, discount 100 -> each unit credits 50, both credit exactly the total', async () => {
    const s = await seed()
    const { createPurchase, createPurchaseReturn, getPurchase, listPurchases } = await mod()
    const p = await createPurchase(s.db, s.a.cid, s.a.uid, { vendorId: s.vendor.id, date: '2026-11-26', items: [line(s.phone.id, 2, '100', ['H1', 'H2'])], discount: '100' }, await (await import('@/test/seed')).mainCtx(s.a.cid))
    const units = (await getPurchase(s.db, s.a.cid, null, p.id)).items[0].units
    expect(units.map((u) => u.purchasePrice)).toEqual(['50.00', '50.00'])
    expect(await createPurchaseReturn(s.db, s.a.cid, s.a.uid, p.id, { unitIds: [units[0].id], date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(s.a.cid))).toMatchObject({ credit: '50.00', due: '50.00', vendorCredit: '0.00' })
    expect(await createPurchaseReturn(s.db, s.a.cid, s.a.uid, p.id, { unitIds: [units[1].id], date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(s.a.cid))).toMatchObject({ credit: '50.00', due: '0.00', vendorCredit: '0.00' })
    const after = await getPurchase(s.db, s.a.cid, null, p.id)
    expect(after).toMatchObject({ total: '100.00', returnedTotal: '100.00', paid: '0.00', due: '0.00' })
    // fully returned + unpaid reads "returned", never "paid"; the status filter agrees
    const { displayStatus } = await import('./totals')
    expect(displayStatus(after)).toBe('returned')
    expect((await listPurchases(s.db, s.a.cid, null, { status: 'returned', limit: 20, offset: 0 })).rows.map((r) => r.id)).toEqual([p.id])
    expect((await listPurchases(s.db, s.a.cid, null, { status: 'paid', limit: 20, offset: 0 })).total).toBe(0)
    const { getLedger } = await import('../parties/ledger')
    expect(await getLedger(s.db, s.a.cid, null, 'vendor', s.vendor.id)).toMatchObject({ billed: '100.00', returned: '100.00', paid: '0.00', due: '1000.00' })
  })

  it('a fully discounted invoice gives zero-cost units; returning them credits nothing', async () => {
    const s = await seed()
    const { createPurchase, createPurchaseReturn, getPurchase } = await mod()
    const p = await createPurchase(s.db, s.a.cid, s.a.uid, { vendorId: s.vendor.id, date: '2026-11-26', items: [line(s.phone.id, 1, '10', ['FREE-1']), line(s.cable.id, 2, '5')], discount: '20' }, await (await import('@/test/seed')).mainCtx(s.a.cid))
    const d = await getPurchase(s.db, s.a.cid, null, p.id)
    expect(d.total).toBe('0.00')
    expect(d.items.map((i) => i.netTotal)).toEqual(['0.00', '0.00'])
    const unit = d.items.find((i) => i.trackSerial)!.units[0]
    expect(unit.purchasePrice).toBe('0.00')
    expect(await createPurchaseReturn(s.db, s.a.cid, s.a.uid, p.id, { unitIds: [unit.id], date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(s.a.cid))).toMatchObject({ credit: '0.00', due: '0.00' })
  })

  it('payment and return dates cannot be before the purchase date', async () => {
    const { db, a, cash, p, units } = await bought()
    const { createPurchaseReturn, recordVendorPayment } = await mod()
    await expect(recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '1', accountId: cash.id, date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.stringMatching(/2026-11-26/) } })
    await expect(createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[0].id], date: '2026-11-25' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { date: expect.stringMatching(/before the purchase date/) } })
    await expect(recordVendorPayment(db, a.cid, a.uid, p.id, { amount: '1', accountId: cash.id, date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(a.cid))).resolves.toBeDefined()
  })

  it('an invoice number clash (e.g. a prefix change colliding with an old number) is a friendly error', async () => {
    const { db, schema, a, cable, vendor } = await seed()
    const { createPurchase } = await mod()
    await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '1')] }, await (await import('@/test/seed')).mainCtx(a.cid)) // PUR-00001
    await db.update(schema.docSequences).set({ nextValue: 1 }).where(and(eq(schema.docSequences.companyId, a.cid), eq(schema.docSequences.kind, 'purchase')))
    await expect(createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(cable.id, 1, '1')] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ name: 'FieldErrors', message: expect.stringMatching(/document number/) })
  })

  it('rejects units of another purchase and units not in stock', async () => {
    const { db, schema, a, vendor, phone, p, units } = await bought()
    const { createPurchase, createPurchaseReturn, getPurchase } = await mod()
    const other = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '10', ['OTHER-1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const otherUnit = (await getPurchase(db, a.cid, null, other.id)).items[0].units[0]
    await expect(createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [otherUnit.id], date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { unitIds: expect.stringMatching(/not part/) } })
    // simulate a sale (Task 7 path) through the state machine
    const { transitionUnit } = await import('../serials')
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, serial: 'R2', to: 'sold', price: '1500' }))
    await expect(createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [units[1].id], date: '2026-11-27' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { unitIds: expect.stringMatching(/Not in stock: R2/) } })
    expect(await db.select().from(schema.purchaseReturns)).toHaveLength(0)
  })
})

describe('transitionUnit', () => {
  it('locks, validates, updates and appends one event; invalid transitions change nothing', async () => {
    const { db, schema, a, b, vendor, phone } = await seed()
    const { createPurchase } = await mod()
    await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-26', items: [line(phone.id, 1, '10', ['T-1'])] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const { transitionUnit, UnitTransitionError } = await import('../serials')
    const { NotFoundError } = await import('../errors')
    const r = await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, serial: 'T-1', to: 'in_service', note: 'screen' }))
    expect(r).toMatchObject({ from: 'in_stock', unit: { status: 'in_service' } })
    await expect(db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, serial: 'T-1', to: 'returned_to_vendor' }))).rejects.toBeInstanceOf(UnitTransitionError)
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, unitId: r.unit.id, to: 'damaged' }))
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, unitId: r.unit.id, to: 'returned_to_vendor' }))
    await expect(db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, unitId: r.unit.id, to: 'in_stock' }))).rejects.toBeInstanceOf(UnitTransitionError)
    // other company cannot see the unit
    await expect(db.transaction((tx) => transitionUnit(tx, { companyId: b.cid, userId: b.uid, serial: 'T-1', to: 'sold' }))).rejects.toBeInstanceOf(NotFoundError)
    const ev = await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.unitId, r.unit.id)).orderBy(asc(schema.unitEvents.createdAt))
    expect(ev.map((e) => e.type)).toEqual(['purchased', 'sent_to_service', 'marked_damaged', 'returned_to_vendor'])
    const [u] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.id, r.unit.id))
    expect(u.status).toBe('returned_to_vendor')
  })
})
