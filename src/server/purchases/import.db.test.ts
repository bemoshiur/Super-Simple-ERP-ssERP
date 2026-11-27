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

const enc = (s: string) => new TextEncoder().encode(s)
const utf16le = (s: string) => {
  const out = new Uint8Array(2 + s.length * 2)
  out[0] = 0xff
  out[1] = 0xfe
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff
    out[3 + i * 2] = s.charCodeAt(i) >> 8
  }
  return out
}

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const db = getDb()
  const phone = await createProduct(db, a.cid, a.uid, { name: 'Phone X', sku: 'PX-1', trackSerial: true, warrantyMonths: 12 })
  const cam = await createProduct(db, a.cid, a.uid, { name: 'HIK Camera', sku: 'CAM-1', trackSerial: true, warrantyMonths: 6 })
  const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1' })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'ABC Electronics' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  // company B owns the SKU "ONLY-B", and also has the serial "SHARED-1" that A is free to use
  const onlyB = await createProduct(db, b.cid, b.uid, { name: 'B only', sku: 'ONLY-B', trackSerial: true })
  const vendorB = await createParty(db, b.cid, b.uid, 'vendor', { name: 'B vendor' })
  const { createPurchase } = await import('./purchases')
  await createPurchase(db, b.cid, b.uid, { vendorId: vendorB.id, date: '2026-11-20', items: [{ productId: onlyB.id, qty: 1, unitCost: '10', serials: ['SHARED-1'] }] }, await (await import('@/test/seed')).mainCtx(b.cid))
  const fields = (extra: object = {}) => ({ vendorId: vendor.id, date: '2026-11-26', ...extra })
  return { db, schema, a, b, phone, cam, cable, vendor, cash, onlyB, vendorB, fields }
}

const mod = () => import('./import')
const HEAD = 'serial,product_sku,unit_cost,warranty_months,note'

describe('importSerialPurchase', () => {
  it('imports a file as ONE purchase: grouped lines, exact totals, net unit costs, events, payment, activity', async () => {
    const { db, schema, a, vendor, cash, fields } = await seed()
    const { importSerialPurchase } = await mod()
    const csv = [HEAD, 'P1,PX-1,"15,000.50",,', 'P2,PX-1,15000.50,24,box damaged', 'P3,PX-1,15000.50,,', 'C1,CAM-1,2000,,', 'C2,CAM-1,2100,0,'].join('\r\n')
    const r = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields({ discount: '100', paid: '30000', accountId: cash.id, idempotencyKey: crypto.randomUUID() }) }, await (await import('@/test/seed')).mainCtx(a.cid))
    // subtotal 3 x 15000.50 + 2000 + 2100 = 49,101.50 ; minus 100 = 49,001.50
    expect(r).toMatchObject({ invoiceNo: 'PUR-00001', total: '49001.50', due: '19001.50', units: 5, lines: 3, duplicate: false })

    const [pu] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, r.id))
    expect(pu).toMatchObject({ vendorId: vendor.id, subtotal: '49101.50', discount: '100.00', total: '49001.50', paid: '30000.00', due: '19001.50', status: 'partially_paid', createdBy: a.uid })
    const items = await db.select().from(schema.purchaseItems).where(eq(schema.purchaseItems.purchaseId, r.id))
    expect(items.map((i) => [i.qty, i.unitCost]).sort()).toEqual([[1, '2000.00'], [1, '2100.00'], [3, '15000.50']])
    // the line nets add up to the invoice total exactly (discount allocated by createPurchase)
    expect(items.reduce((x, i) => x + Math.round(Number(i.netTotal) * 100), 0)).toBe(4900150)

    const units = await db.select().from(schema.productUnits).where(eq(schema.productUnits.companyId, a.cid))
    expect(units).toHaveLength(5)
    expect(units.every((u) => u.status === 'in_stock' && u.vendorId === vendor.id)).toBe(true)
    const by = Object.fromEntries(units.map((u) => [u.serialNo, u]))
    expect(by.P1.warrantyMonths).toBe(12) // product default
    expect(by.P2.warrantyMonths).toBe(24) // file override
    expect(by.C1.warrantyMonths).toBe(6)
    expect(by.C2.warrantyMonths).toBe(0) // explicit 0 means "no warranty", not "use default"
    expect(units.reduce((x, u) => x + Math.round(Number(u.purchasePrice) * 100), 0)).toBe(4900150)

    const events = await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.companyId, a.cid))
    expect(events).toHaveLength(5)
    expect(events.every((e) => e.type === 'purchased' && e.actorUserId === a.uid)).toBe(true)
    expect((events.find((e) => e.unitId === by.P2.id)!.meta as { note?: string }).note).toBe('box damaged')
    expect((events.find((e) => e.unitId === by.P1.id)!.meta as { note?: string }).note).toBeUndefined()

    const pays = await db.select().from(schema.payments).where(eq(schema.payments.companyId, a.cid))
    expect(pays).toMatchObject([{ direction: 'out', amount: '30000.00', refType: 'purchase', refId: r.id, partyId: vendor.id }])
    const [log] = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.companyId, a.cid), eq(schema.activityLog.action, 'purchase.create')))
    expect(log.after).toMatchObject({ units: 5, lines: 3, source: 'import' })
  })

  it('a file with ONE bad row among good ones is rejected entirely: nothing written, invoice number not consumed', async () => {
    const { db, schema, a, fields } = await seed()
    const { importSerialPurchase } = await mod()
    const { FieldErrors } = await import('../errors')
    const csv = [HEAD, 'G1,PX-1,100,,', 'G2,PX-1,100,,', 'BAD,NOPE,100,,', 'G3,CAM-1,100,,'].join('\n')
    const err = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
    expect(err).toBeInstanceOf(FieldErrors)
    expect(err.message).toMatch(/1 of 4 rows have problems, so nothing was imported/)
    for (const tbl of [schema.purchases, schema.purchaseItems, schema.productUnits, schema.payments]) expect(await db.select().from(tbl).where(eq(tbl.companyId, a.cid))).toHaveLength(0)
    // fixing the file works and gets PUR-00001 (the failed attempt did not burn a number)
    const ok = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv.replace('BAD,NOPE', 'BAD,PX-1')), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(ok.invoiceNo).toBe('PUR-00001')
  })

  it('a serial that appears in another company is free; another company\'s SKU is unknown', async () => {
    const { db, schema, a, b, vendorB, fields } = await seed()
    const { importSerialPurchase, previewSerialImport } = await mod()
    const mixed = await previewSerialImport(db, a.cid, { bytes: enc(`${HEAD}\nSHARED-1,PX-1,10,,\nB1,ONLY-B,10,,`), ...fields() })
    expect([...mixed.rows].sort((x, y) => x.line - y.line).map((r) => r.errors.map((e) => e.code))).toEqual([[], ['sku_unknown']])
    await expect(importSerialPurchase(db, a.cid, a.uid, { bytes: enc(`${HEAD}\nB1,ONLY-B,10,,`), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/nothing was imported/)
    const ok = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc(`${HEAD}\nSHARED-1,PX-1,10,,`), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(ok.units).toBe(1)
    expect(await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'SHARED-1'))).toHaveLength(2) // one per company
    // and the other way round: B cannot use A's vendor
    await expect(importSerialPurchase(db, b.cid, b.uid, { bytes: enc(`${HEAD}\nZ1,ONLY-B,10,,`), ...fields() }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toMatchObject({ fields: { vendorId: 'Vendor not found' } })
    await expect(importSerialPurchase(db, b.cid, b.uid, { bytes: enc(`${HEAD}\nZ1,PX-1,10,,`), vendorId: vendorB.id, date: '2026-11-26' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toThrow(/nothing was imported/)
  })

  it('idempotency: the same key + file returns the first invoice; a different file with that key is refused', async () => {
    const { db, schema, a, fields } = await seed()
    const { importSerialPurchase } = await mod()
    const key = crypto.randomUUID()
    const csv = `${HEAD}\nK1,PX-1,10,,\nK2,PX-1,10,,`
    const first = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields({ idempotencyKey: key }) }, await (await import('@/test/seed')).mainCtx(a.cid))
    const again = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields({ idempotencyKey: key }) }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(again).toMatchObject({ id: first.id, invoiceNo: first.invoiceNo, duplicate: true })
    expect(await db.select().from(schema.purchases).where(eq(schema.purchases.companyId, a.cid))).toHaveLength(1)
    expect(await db.select().from(schema.productUnits).where(eq(schema.productUnits.productId, (await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'K1')))[0].productId))).toHaveLength(2)
    await expect(importSerialPurchase(db, a.cid, a.uid, { bytes: enc(`${csv}\nK3,PX-1,10,,`), ...fields({ idempotencyKey: key }) }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already saved as PUR-00001/)
    // concurrent double submit: exactly one invoice
    const k2 = crypto.randomUUID()
    const csv2 = `${HEAD}\nR1,CAM-1,5,,\nR2,CAM-1,5,,`
    const results = await Promise.allSettled([1, 2, 3].map(async () => importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv2), ...fields({ idempotencyKey: k2 }) }, await (await import('@/test/seed')).mainCtx(a.cid))))
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof importSerialPurchase>>> => r.status === 'fulfilled')
    expect(ok.length).toBeGreaterThanOrEqual(1)
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1)
    expect(await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'R1'))).toHaveLength(1)
  })

  it('reads UTF-16 LE (Excel "Unicode Text") and semicolon files, with Bengali notes', async () => {
    const { db, schema, a, fields } = await seed()
    const { importSerialPurchase } = await mod()
    const r = await importSerialPurchase(db, a.cid, a.uid, { bytes: utf16le('serial\tproduct_sku\tunit_cost\tnote\r\nU1\tPX-1\t10\tনতুন বক্স\r\nU2\tPX-1\t10\t\r\n'), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r.units).toBe(2)
    const r2 = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc('serial;product_sku;unit_cost\nS1;CAM-1;1,5\n'), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid)).catch((e) => e)
    expect(r2.message).toMatch(/nothing was imported/) // "1,5" is not a valid amount: no silent decimal-comma guess
    const ok = await importSerialPurchase(db, a.cid, a.uid, { bytes: enc('serial;product_sku;unit_cost\nS1;CAM-1;"12,50,000"\n'), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(ok.total).toBe('1250000.00')
    const e = await db.select().from(schema.unitEvents).where(eq(schema.unitEvents.companyId, a.cid))
    expect(e.some((x) => (x.meta as { note?: string }).note === 'নতুন বক্স')).toBe(true)
  })

  it('invoice-level rules still apply: discount over subtotal, paid without an account, unknown vendor, inactive product', async () => {
    const { db, a, fields, phone } = await seed()
    const { importSerialPurchase } = await mod()
    const csv = `${HEAD}\nV1,PX-1,100,,`
    await expect(importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields({ discount: '101' }) }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow()
    await expect(importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields({ paid: '50' }) }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { accountId: expect.any(String) } })
    await expect(importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields({ vendorId: crypto.randomUUID() }) }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { vendorId: 'Vendor not found' } })
    const { setProductActive } = await import('../catalog/products')
    await setProductActive(db, a.cid, a.uid, phone.id, false)
    await expect(importSerialPurchase(db, a.cid, a.uid, { bytes: enc(csv), ...fields() }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/nothing was imported/)
  })
})

describe('previewSerialImport (dry run)', () => {
  it('classifies every problem, writes nothing, and offers an injection-safe error CSV', async () => {
    const { db, schema, a, fields } = await seed()
    const { previewSerialImport } = await mod()
    const { createPurchase } = await import('./purchases')
    // an existing unit in A
    const prods = await db.select().from(schema.products).where(eq(schema.products.companyId, a.cid))
    const px = prods.find((p) => p.sku === 'PX-1')!
    await createPurchase(db, a.cid, a.uid, { vendorId: fields().vendorId, date: '2026-11-20', items: [{ productId: px.id, qty: 1, unitCost: '1', serials: ['EXISTING'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    const before = await db.select().from(schema.purchases)
    const csv = [HEAD, 'OK1,PX-1,"12,50,000",,', 'OK2,CAM-1,100,12,', 'OK3,PX-1,12,5,000,n,x', 'DUP,PX-1,1,,', 'DUP,PX-1,1,,', 'EXISTING,PX-1,1,,', '=EVIL(),NOPE,abc,,', 'CABLE1,CB-1,1,,', 'bad serial,PX-1,1,,'].join('\n')
    const p = await previewSerialImport(db, a.cid, { bytes: enc(csv), ...fields() })
    expect(p.canImport).toBe(false)
    expect(p.fileErrors).toEqual([])
    expect(p.rows.filter((r) => r.errors.length === 0).map((r) => r.serial)).toEqual(['OK1', 'OK2', 'DUP'])
    expect(p.summary).toMatchObject({ rows: 9, valid: 3, invalid: 6, duplicatesInFile: 1, alreadyExist: 1, unknownSku: 1, notSerial: 1 })
    const codes = Object.fromEntries(p.rows.map((r) => [r.serial + r.line, r.errors.map((e) => e.code)]))
    expect(codes['OK34']).toEqual(['too_many_columns']) // unquoted lakh amount
    expect(codes['EXISTING7']).toEqual(['exists'])
    expect(codes['=EVIL()8']).toEqual(['sku_unknown', 'cost_invalid'])
    expect(p.errorCsv.startsWith('﻿row,serial,')).toBe(true)
    expect(p.errorCsv).toContain("'=EVIL()")
    expect(p.errorCsv.split('\r\n').filter(Boolean)).toHaveLength(7) // header + 6 problem rows
    expect(await db.select().from(schema.purchases)).toEqual(before)
    expect(await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, 'OK1'))).toHaveLength(0)
  })

  it('a clean file can be imported; totals and header errors are reported before the user clicks Import', async () => {
    const { db, a, fields, cash } = await seed()
    const { previewSerialImport } = await mod()
    const csv = `${HEAD}\nA1,PX-1,1000,,\nA2,PX-1,1000,,\nA3,CAM-1,500.50,,`
    const ok = await previewSerialImport(db, a.cid, { bytes: enc(csv), ...fields({ discount: '10', paid: '1000', accountId: cash.id }) })
    expect(ok).toMatchObject({ canImport: true, lines: 2, totals: { subtotal: '2500.50', total: '2490.50', paid: '1000.00', due: '1490.50' }, encoding: 'utf-8', delimiter: ',' })
    expect(ok.errorCsv).toBe('')
    const noAcc = await previewSerialImport(db, a.cid, { bytes: enc(csv), ...fields({ paid: '1000' }) })
    expect(noAcc.canImport).toBe(false)
    expect(noAcc.headerErrors.accountId).toBeTruthy()
    const badVendor = await previewSerialImport(db, a.cid, { bytes: enc(csv), ...fields({ vendorId: crypto.randomUUID() }) })
    expect(badVendor.headerErrors.vendorId).toBe('Vendor not found')
    const overDiscount = await previewSerialImport(db, a.cid, { bytes: enc(csv), ...fields({ discount: '99999' }) })
    expect(overDiscount.headerErrors.discount).toMatch(/more than the subtotal/)
    const file = await previewSerialImport(db, a.cid, { bytes: enc('nonsense'), ...fields() })
    expect(file).toMatchObject({ canImport: false, rows: [] })
    expect(file.fileErrors[0]).toMatch(/Missing/)
  })
})
