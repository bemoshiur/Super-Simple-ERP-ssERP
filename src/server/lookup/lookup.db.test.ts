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

const D = '2026-11-26'
const TODAY = '2026-11-26'

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const { createSale } = await import('../sales/sales')
  const lookup = await import('./lookup')
  const db = getDb()
  const cam = await createProduct(db, a.cid, a.uid, { name: 'HIK Camera', sku: 'HIK-1', trackSerial: true, warrantyMonths: 12, purchasePrice: '2000', salePrice: '2800' })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'ABC Electronics' })
  const rahim = await createParty(db, a.cid, a.uid, 'customer', { name: 'Rahim' })
  const karim = await createParty(db, a.cid, a.uid, 'customer', { name: 'Karim' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const buy = async (serials: string[], cost = '2000', date = '2026-11-20', pid = cam.id) => createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date, items: [{ productId: pid, qty: serials.length, unitCost: cost, serials }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const sell = async (serial: string, customerId: string | null, price = '2800', pay = '2800', extra: object = {}) =>
    createSale(db, a.cid, a.uid, { customerId, date: D, items: [{ serial, qty: 1, unitPrice: price }], payments: pay === '0' ? [] : [{ accountId: cash.id, amount: pay }], ...extra }, await (await import('@/test/seed')).mainCtx(a.cid))
  const unitId = async (serial: string, cid = a.cid) => (await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.serialNo, serial), eq(schema.productUnits.companyId, cid))))[0].id
  return { db, schema, a, b, cam, vendor, rahim, karim, cash, buy, sell, unitId, lookup }
}

describe('unit detail: the brief example (ABC Electronics -> HIK123456789 @2000 -> Rahim @2800)', () => {
  it('shows all 8 facts plus warranty, profit and a full timeline', async () => {
    const { db, a, buy, sell, unitId, lookup, vendor, rahim, cam } = await seed()
    const p = await buy(['HIK123456789'])
    const s = await sell('HIK123456789', rahim.id, '2800', '1800')
    const id = await unitId('HIK123456789')
    const d = await lookup.getUnitDetail(db, a.cid, null, { id }, { withCost: true, today: TODAY })

    // 1 vendor (link target), 2 serial, 3 purchase cost, 4 sold to, 5 sale price, 6 purchase invoice, 7 sale invoice, 8 dates
    expect(d.vendor).toEqual({ id: vendor.id, name: 'ABC Electronics' })
    expect(d.unit).toMatchObject({ serialNo: 'HIK123456789', status: 'sold', locationLabel: 'With customer (Rahim)' })
    expect(d.cost).toBe('2000.00')
    expect(d.currentSale).toMatchObject({ customerId: rahim.id, customerName: 'Rahim', salePrice: '2800.00', netRevenue: '2800.00', invoiceNo: 'INV-00001', saleId: s.id, date: D, profit: '800.00', returned: false, current: true })
    expect(d.purchase).toMatchObject({ id: p.id, invoiceNo: p.invoiceNo, date: '2026-11-20' })
    expect(d.product).toMatchObject({ id: cam.id, name: 'HIK Camera', sku: 'HIK-1' })
    expect(d.warranty).toMatchObject({ start: D, end: '2027-11-26', months: 12, state: 'active', days: 365, label: '365 days remaining' })
    expect(d.flags).toMatchObject({ returnedByCustomer: 0, serviceTickets: 0, inService: false, underWarrantyNow: true })

    expect(d.timeline.map((e) => [e.type, e.price, e.doc?.label, e.actorName])).toEqual([
      ['purchased', '2000.00', p.invoiceNo, 'A'],
      ['sold', '2800.00', 'INV-00001', 'A'],
    ])
    expect(d.timeline[1].doc).toMatchObject({ kind: 'sale', href: `/sales/${s.id}` })
    expect(d.timeline[0].doc).toMatchObject({ kind: 'purchase', href: `/purchases/${p.id}` })
    expect((await lookup.getUnitDetail(db, a.cid, null, { serial: 'HIK123456789' }, { withCost: true, today: TODAY, order: 'desc' })).timeline.map((e) => e.type)).toEqual(['sold', 'purchased'])
  })

  it('hides cost and profit (and the purchase price on events) without the profit permission', async () => {
    const { db, a, buy, sell, unitId, lookup, rahim } = await seed()
    await buy(['HIK-X'])
    await sell('HIK-X', rahim.id)
    const d = await lookup.getUnitDetail(db, a.cid, null, { id: await unitId('HIK-X') }, { withCost: false, today: TODAY })
    expect(d.cost).toBeNull()
    expect(d.currentSale?.profit).toBeNull()
    expect(d.sales.every((l) => l.profit === null)).toBe(true)
    expect(d.timeline.find((e) => e.type === 'purchased')?.price).toBeNull()
    expect(d.currentSale?.salePrice).toBe('2800.00') // the sale price itself is fine to show
    // nothing in the payload carries the cost figure
    expect(JSON.stringify(d)).not.toContain('2000.00')
    // and the permission rule is the Task 7 one
    expect(lookup.canSeeProfit({ adm: false, perms: ['serials.view', 'sales.create'] })).toBe(false)
    expect(lookup.canSeeProfit({ adm: false, perms: ['sales.edit'] })).toBe(true)
    expect(lookup.canSeeProfit({ adm: false, perms: ['reports.view'] })).toBe(true)
    expect(lookup.canSeeProfit({ adm: true, perms: [] })).toBe(true)
    expect(lookup.canSeeProfit(null)).toBe(false)
  })

  it('net revenue and profit use the discount-allocated figures; walk-in is a null customer', async () => {
    const { db, a, buy, sell, unitId, lookup } = await seed()
    await buy(['W-1', 'W-2'], '2000')
    await sell('W-1', null, '2800', '2800')
    // a discounted invoice: 100 off over two units
    const { createSale } = await import('../sales/sales')
    const { schema } = await import('../db')
    const [cash] = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, a.cid))
    await createSale(db, a.cid, a.uid, { date: D, items: [{ serial: 'W-2', qty: 1, unitPrice: '2800' }], discount: '100', payments: [{ accountId: cash.id, amount: '2700' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const w1 = await lookup.getUnitDetail(db, a.cid, null, { id: await unitId('W-1') }, { withCost: true, today: TODAY })
    expect(w1.currentSale).toMatchObject({ customerId: null, customerName: null })
    expect(w1.unit.locationLabel).toBe('With customer (Walk-in customer)')
    const w2 = await lookup.getUnitDetail(db, a.cid, null, { id: await unitId('W-2') }, { withCost: true, today: TODAY })
    expect(w2.currentSale).toMatchObject({ salePrice: '2800.00', netRevenue: '2700.00', profit: '700.00' })
  })

  it('unknown / foreign ids are not found', async () => {
    const { db, a, b, buy, unitId, lookup } = await seed()
    await buy(['A-ONLY'])
    const id = await unitId('A-ONLY')
    await expect(lookup.getUnitDetail(db, b.cid, null, { id }, { withCost: true })).rejects.toThrow(/not found/i)
    await expect(lookup.getUnitDetail(db, a.cid, null, { id: '00000000-0000-4000-8000-000000000000' }, { withCost: true })).rejects.toThrow(/not found/i)
    await expect(lookup.getUnitDetail(db, b.cid, null, { serial: 'A-ONLY' }, { withCost: true })).rejects.toThrow(/not found/i)
  })
})

describe('unit history across sale -> return -> resale', () => {
  it('shows both invoices, the return, and the current customer', async () => {
    const { db, a, buy, sell, unitId, lookup, rahim, karim, cash } = await seed()
    await buy(['R-1'])
    const s1 = await sell('R-1', rahim.id, '2800', '2800')
    const { createSaleReturn } = await import('../sales/sales')
    const { schema } = await import('../db')
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s1.id))
    const ret = await createSaleReturn(db, a.cid, a.uid, s1.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    const id = await unitId('R-1')

    let d = await lookup.getUnitDetail(db, a.cid, null, { id }, { withCost: true, today: TODAY })
    expect(d.unit.status).toBe('in_stock')
    expect(d.currentSale).toBeNull()
    expect(d.warranty).toBeNull()
    expect(d.flags.returnedByCustomer).toBe(1)
    expect(d.sales).toEqual([expect.objectContaining({ invoiceNo: 'INV-00001', returned: true, current: false, profit: '0.00' })])

    const s2 = await sell('R-1', karim.id, '2600', '2600')
    d = await lookup.getUnitDetail(db, a.cid, null, { id }, { withCost: true, today: TODAY })
    expect(d.unit.status).toBe('sold')
    expect(d.currentSale).toMatchObject({ customerName: 'Karim', invoiceNo: 'INV-00002', saleId: s2.id, salePrice: '2600.00', profit: '600.00' })
    expect(d.sales.map((l) => [l.invoiceNo, l.customerName, l.returned, l.current, l.profit])).toEqual([
      ['INV-00002', 'Karim', false, true, '600.00'],
      ['INV-00001', 'Rahim', true, false, '0.00'],
    ])
    expect(d.flags.returnedByCustomer).toBe(1)
    expect(d.timeline.map((e) => e.type)).toEqual(['purchased', 'sold', 'sale_returned', 'sold'])
    expect(d.timeline.map((e) => e.doc?.label)).toEqual([expect.stringMatching(/^PUR-/), 'INV-00001', `${ret.returnNo} (INV-00001)`, 'INV-00002'])
    expect(d.timeline[2]).toMatchObject({ statusChange: 'sold → in stock', price: '2800.00' })
    expect(d.timeline[3].doc).toMatchObject({ href: `/sales/${s2.id}` })
  })

  it('a unit returned to the vendor shows the purchase return', async () => {
    const { db, a, buy, unitId, lookup } = await seed()
    const p = await buy(['V-1', 'V-2'])
    const { createPurchaseReturn } = await import('../purchases/purchases')
    const r = await createPurchaseReturn(db, a.cid, a.uid, p.id, { unitIds: [await unitId('V-1')], date: D }, await (await import('@/test/seed')).mainCtx(a.cid))
    const d = await lookup.getUnitDetail(db, a.cid, null, { id: await unitId('V-1') }, { withCost: true, today: TODAY })
    expect(d.unit.status).toBe('returned_to_vendor')
    expect(d.flags.returnedToVendor).toBe(true)
    expect(d.timeline.at(-1)).toMatchObject({ type: 'returned_to_vendor', price: '2000.00', doc: { kind: 'purchase_return', href: `/purchases/${p.id}`, label: `${r.returnNo} (${p.invoiceNo})` } })
    const hidden = await lookup.getUnitDetail(db, a.cid, null, { id: await unitId('V-1') }, { withCost: false, today: TODAY })
    expect(hidden.timeline.at(-1)?.price).toBeNull()
  })
})

describe('timeline order inside one transaction', () => {
  it('events written in the same transaction still order by when they were written', async () => {
    const { db, a, unitId, lookup, rahim } = await seed()
    await db.transaction(async (tx) => {
      const { createSale } = await import('../sales/sales')
      const { createPurchase } = await import('../purchases/purchases')
      const { schema } = await import('../db')
      const [vendor] = await tx.select().from(schema.vendors).limit(1)
      const [cam] = await tx.select().from(schema.products).limit(1)
      const [cash] = await tx.select().from(schema.accounts).limit(1)
      await createPurchase(tx as unknown as typeof db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', items: [{ productId: cam.id, qty: 1, unitCost: '2000', serials: ['ONE-TX'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
      await createSale(tx as unknown as typeof db, a.cid, a.uid, { customerId: rahim.id, date: D, items: [{ serial: 'ONE-TX', qty: 1, unitPrice: '2800' }], payments: [{ accountId: cash.id, amount: '2800' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    })
    const d = await lookup.getUnitDetail(db, a.cid, null, { id: await unitId('ONE-TX') }, { withCost: true, today: TODAY })
    expect(d.timeline.map((e) => e.type)).toEqual(['purchased', 'sold'])
  })
})

describe('serial with a literal % in the URL segment', () => {
  it('resolves as-is first', async () => {
    const { db, a, buy, unitId, lookup } = await seed()
    await buy(['PCT%1', 'A B'.replace(' ', '%20')])
    expect(await lookup.findUnitIdBySerial(db, a.cid, 'PCT%1')).toBe(await unitId('PCT%1'))
    expect(await lookup.findUnitIdBySerial(db, a.cid, 'A%20B')).toBe(await unitId('A%20B')) // exact as-is wins over decoding
  })
})

describe('searchSerials', () => {
  it('exact match goes straight to the unit; partial lists; none is none', async () => {
    const { db, a, buy, unitId, lookup } = await seed()
    await buy(['HIK123456789', 'HIK123400000', 'ABC-0001'])
    const exact = await lookup.searchSerials(db, a.cid, null, '  HIK123456789\n')
    expect(exact).toMatchObject({ match: 'exact', redirectUnitId: await unitId('HIK123456789'), query: 'HIK123456789' })
    const part = await lookup.searchSerials(db, a.cid, null, 'HIK1234')
    expect(part).toMatchObject({ match: 'partial', redirectUnitId: null, truncated: false })
    expect(part.matches.map((m) => m.serialNo)).toEqual(['HIK123400000', 'HIK123456789'])
    expect(part.matches[0]).toMatchObject({ productName: 'HIK Camera', status: 'in_stock' })
    const single = await lookup.searchSerials(db, a.cid, null, 'abc-0')
    expect(single).toMatchObject({ match: 'partial', redirectUnitId: await unitId('ABC-0001') }) // one partial hit -> go to it
    expect(await lookup.searchSerials(db, a.cid, null, 'nothing')).toMatchObject({ match: 'none', matches: [], redirectUnitId: null })
    expect(await lookup.searchSerials(db, a.cid, null, '   ')).toMatchObject({ match: 'empty' })
    expect(await lookup.searchSerials(db, a.cid, null, undefined)).toMatchObject({ match: 'empty' })
    // scanner noise
    expect(await lookup.searchSerials(db, a.cid, null, '﻿HIK123456789​')).toMatchObject({ match: 'exact' })
  })

  it('case-sensitive exact first, then case-insensitive exact, then partial', async () => {
    const { db, a, buy, unitId, lookup } = await seed()
    await buy(['abc1', 'ABC1', 'xyz9'])
    // both case variants exist: an exact-case query hits only its own
    expect(await lookup.searchSerials(db, a.cid, null, 'abc1')).toMatchObject({ match: 'exact', redirectUnitId: await unitId('abc1') })
    expect(await lookup.searchSerials(db, a.cid, null, 'ABC1')).toMatchObject({ match: 'exact', redirectUnitId: await unitId('ABC1') })
    // different case, one candidate: ci fallback redirects
    expect(await lookup.searchSerials(db, a.cid, null, 'XYZ9')).toMatchObject({ match: 'exact_ci', redirectUnitId: await unitId('xyz9') })
    // different case, two candidates: list, no redirect
    const two = await lookup.searchSerials(db, a.cid, null, 'Abc1')
    expect(two).toMatchObject({ match: 'exact_ci', redirectUnitId: null })
    expect(two.matches.map((m) => m.serialNo).sort()).toEqual(['ABC1', 'abc1'])
    expect(await lookup.findUnitIdBySerial(db, a.cid, 'XYZ9')).toBe(await unitId('xyz9'))
    expect(await lookup.findUnitIdBySerial(db, a.cid, 'Abc1')).toBeNull()
    expect(await lookup.findUnitIdBySerial(db, a.cid, 'xyz')).toBeNull() // partial never resolves a URL segment
  })

  it('escapes LIKE wildcards and caps partial results at 20', async () => {
    const { db, a, buy, lookup } = await seed()
    await buy(['PCT%1', 'UND_1', 'PCTX1', 'UNDX1', 'BS\\1'])
    expect((await lookup.searchSerials(db, a.cid, null, 'PCT%')).matches.map((m) => m.serialNo)).toEqual(['PCT%1'])
    expect((await lookup.searchSerials(db, a.cid, null, 'UND_')).matches.map((m) => m.serialNo)).toEqual(['UND_1'])
    expect((await lookup.searchSerials(db, a.cid, null, '%')).matches.map((m) => m.serialNo)).toEqual(['PCT%1'])
    expect((await lookup.searchSerials(db, a.cid, null, '_')).matches.map((m) => m.serialNo)).toEqual(['UND_1'])
    expect((await lookup.searchSerials(db, a.cid, null, '\\')).matches.map((m) => m.serialNo)).toEqual(['BS\\1'])
    const many = Array.from({ length: 25 }, (_, i) => `BULK-${String(i).padStart(3, '0')}`)
    await buy(many)
    const r = await lookup.searchSerials(db, a.cid, null, 'BULK-')
    expect(r.matches).toHaveLength(20)
    expect(r.truncated).toBe(true)
    expect(r.matches[0].serialNo).toBe('BULK-000')
  })

  it('never crosses companies; the same serial in two companies resolves to its own', async () => {
    const { db, schema, a, b, buy, unitId, lookup, camB } = await (async () => {
      const s = await seed()
      const { createProduct } = await import('../catalog/products')
      const camB = await createProduct(s.db, s.b.cid, s.b.uid, { name: 'B Camera', sku: 'B-1', trackSerial: true, salePrice: '1' })
      return { ...s, camB }
    })()
    const { createParty } = await import('../parties/parties')
    const { createPurchase } = await import('../purchases/purchases')
    await buy(['SHARED-1', 'ONLY-A-1'])
    const vb = await createParty(db, b.cid, b.uid, 'vendor', { name: 'B vendor' })
    await createPurchase(db, b.cid, b.uid, { vendorId: vb.id, date: '2026-11-20', items: [{ productId: camB.id, qty: 1, unitCost: '5', serials: ['SHARED-1'] }] }, await (await import('@/test/seed')).mainCtx(b.cid))

    expect(await lookup.searchSerials(db, b.cid, null, 'ONLY-A-1')).toMatchObject({ match: 'none', matches: [] })
    expect(await lookup.searchSerials(db, b.cid, null, 'ONLY-A')).toMatchObject({ match: 'none' })
    expect(await lookup.searchSerials(db, b.cid, null, 'only-a-1')).toMatchObject({ match: 'none' })
    const ra = await lookup.searchSerials(db, a.cid, null, 'SHARED-1')
    const rb = await lookup.searchSerials(db, b.cid, null, 'SHARED-1')
    expect(ra.redirectUnitId).toBe(await unitId('SHARED-1', a.cid))
    expect(rb.redirectUnitId).toBe(await unitId('SHARED-1', b.cid))
    expect(ra.redirectUnitId).not.toBe(rb.redirectUnitId)
    expect(ra.matches[0].productName).toBe('HIK Camera')
    expect(rb.matches[0].productName).toBe('B Camera')
    expect((await lookup.getUnitDetail(db, b.cid, null, { serial: 'SHARED-1' }, { withCost: true })).product.name).toBe('B Camera')
    void schema
  })
})

describe('listWarrantyExpiring', () => {
  it('lists sold units ending within N days (inclusive), soonest first, with the customer', async () => {
    const { db, schema, a, b, buy, sell, lookup, rahim, karim } = await seed()
    await buy(['E-1', 'E-2', 'E-3', 'E-4', 'E-5', 'E-6'])
    for (const [s, c] of [['E-1', rahim.id], ['E-2', karim.id], ['E-3', rahim.id], ['E-4', null], ['E-5', rahim.id]] as const) await sell(s, c, '100', '100')
    const setEnd = (serial: string, end: string | null) => db.update(schema.productUnits).set({ warrantyEnd: end }).where(eq(schema.productUnits.serialNo, serial))
    await setEnd('E-1', '2026-12-26') // today + 30
    await setEnd('E-2', '2026-11-26') // today
    await setEnd('E-3', '2026-12-27') // today + 31: outside 30
    await setEnd('E-4', '2026-11-25') // already expired
    await setEnd('E-5', null) // no warranty
    const rows = await lookup.listWarrantyExpiring(db, a.cid, null, 30, { today: TODAY })
    expect(rows.map((r) => [r.serialNo, r.daysLeft, r.customerName, r.invoiceNo])).toEqual([
      ['E-2', 0, 'Karim', 'INV-00002'],
      ['E-1', 30, 'Rahim', 'INV-00001'],
    ])
    expect(rows[1]).toMatchObject({ warrantyEnd: '2026-12-26', productName: 'HIK Camera', customerId: rahim.id })
    expect((await lookup.listWarrantyExpiring(db, a.cid, null, 31, { today: TODAY })).map((r) => r.serialNo)).toEqual(['E-2', 'E-1', 'E-3'])
    expect((await lookup.listWarrantyExpiring(db, a.cid, null, 0, { today: TODAY })).map((r) => r.serialNo)).toEqual(['E-2'])
    expect(await lookup.listWarrantyExpiring(db, b.cid, null, 3650, { today: TODAY })).toEqual([])
    // in stock units are never listed
    expect((await lookup.listWarrantyExpiring(db, a.cid, null, 3650, { today: TODAY })).map((r) => r.serialNo)).not.toContain('E-6')
    // garbage days are clamped, not an error
    expect(await lookup.listWarrantyExpiring(db, a.cid, null, Number.NaN, { today: TODAY })).toHaveLength(1)
    expect((await lookup.listWarrantyExpiring(db, a.cid, null, -5, { today: TODAY })).length).toBe(1)
  })
})
