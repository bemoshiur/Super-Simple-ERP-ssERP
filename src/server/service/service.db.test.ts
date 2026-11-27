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

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const { createSale } = await import('../sales/sales')
  const svc = await import('./tickets')
  const lookup = await import('../lookup/lookup')
  const db = getDb()
  const cam = await createProduct(db, a.cid, a.uid, { name: 'HIK Camera', sku: 'HIK-1', trackSerial: true, warrantyMonths: 12, purchasePrice: '2000', salePrice: '2800' })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'ABC Electronics' })
  const rahim = await createParty(db, a.cid, a.uid, 'customer', { name: 'Rahim' })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const buy = async (serials: string[]) => createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', items: [{ productId: cam.id, qty: serials.length, unitCost: '2000', serials }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const sell = async (serial: string, customerId: string | null = rahim.id) => createSale(db, a.cid, a.uid, { customerId, date: D, items: [{ serial, qty: 1, unitPrice: '2800' }], payments: [{ accountId: cash.id, amount: '2800' }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const unit = async (serial: string) => (await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.serialNo, serial), eq(schema.productUnits.companyId, a.cid))))[0]
  const events = (unitId: string) => db.select().from(schema.unitEvents).where(eq(schema.unitEvents.unitId, unitId)).orderBy(schema.unitEvents.createdAt)
  return { db, schema, a, b, cam, rahim, cash, buy, sell, unit, events, svc, lookup }
}

describe('open a service ticket', () => {
  it('creates an open ticket, moves sold -> in_service, writes the event, keeps the sale link and warranty', async () => {
    const { db, schema, a, buy, sell, unit, events, svc, rahim } = await seed()
    await buy(['S-1'])
    const sale = await sell('S-1')
    const before = await unit('S-1')
    const r = await svc.openServiceTicket(db, a.cid, a.uid, before.id, { issue: 'No image output', notes: 'customer says it fell' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ ticketNo: 'SVC-00001', underWarranty: true })

    const after = await unit('S-1')
    expect(after).toMatchObject({ status: 'in_service', warrantyEnd: '2027-11-26', saleItemId: before.saleItemId })
    expect(after.saleItemId).toBeTruthy() // the pointer survives the service stay

    const [tk] = await db.select().from(schema.serviceTickets)
    expect(tk).toMatchObject({ id: r.id, status: 'open', issue: 'No image output', notes: 'customer says it fell', customerId: rahim.id, saleId: sale.id, underWarranty: true, openedBy: a.uid, unitId: before.id, closedAt: null })

    const ev = (await events(before.id)).filter((e) => e.type === 'sent_to_service')
    expect(ev).toEqual([expect.objectContaining({ fromStatus: 'sold', toStatus: 'in_service', refTable: 'service_tickets', refId: r.id, actorUserId: a.uid, note: 'No image output', meta: expect.objectContaining({ ticketNo: 'SVC-00001', underWarranty: true }) })])
    expect(await db.select().from(schema.activityLog).where(eq(schema.activityLog.action, 'service.open'))).toHaveLength(1)
  })

  it('records an out-of-warranty ticket as such (shop-local date)', async () => {
    const { db, a, schema, buy, sell, unit, svc } = await seed()
    await buy(['S-2'])
    await sell('S-2')
    const u = await unit('S-2')
    await db.update(schema.productUnits).set({ warrantyEnd: '2020-01-01' }).where(eq(schema.productUnits.id, u.id))
    expect(await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: 'Dead' }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ underWarranty: false })
  })

  it('walk-in sale: ticket has no customer', async () => {
    const { db, a, schema, buy, sell, unit, svc } = await seed()
    await buy(['S-3'])
    await sell('S-3', null)
    await svc.openServiceTicket(db, a.cid, a.uid, (await unit('S-3')).id, { issue: 'Dead' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect((await db.select().from(schema.serviceTickets))[0]).toMatchObject({ customerId: null })
  })

  it('rejects unsold, already-in-service, damaged and foreign units with friendly messages (nothing written)', async () => {
    const { db, a, b, schema, buy, sell, unit, svc } = await seed()
    await buy(['S-4', 'S-5'])
    const stock = await unit('S-4')
    await expect(svc.openServiceTicket(db, a.cid, a.uid, stock.id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/has not been sold/)
    await sell('S-5')
    const sold = await unit('S-5')
    await svc.openServiceTicket(db, a.cid, a.uid, sold.id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(svc.openServiceTicket(db, a.cid, a.uid, sold.id, { issue: 'Again' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already in service \(ticket SVC-00001\)/)
    await expect(svc.openServiceTicket(db, b.cid, b.uid, sold.id, { issue: 'Mine' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toThrow(/Serial not found/)
    await expect(svc.openServiceTicket(db, a.cid, a.uid, sold.id, { issue: '' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { issue: expect.any(String) } })
    await db.update(schema.productUnits).set({ status: 'damaged' }).where(eq(schema.productUnits.id, stock.id))
    await expect(svc.openServiceTicket(db, a.cid, a.uid, stock.id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/damaged and cannot be sent/)
    expect(await db.select().from(schema.serviceTickets)).toHaveLength(1)
    // failed attempts do not burn ticket numbers
    await buy(['S-6'])
    await sell('S-6')
    expect(await svc.openServiceTicket(db, a.cid, a.uid, (await unit('S-6')).id, { issue: 'x y z' }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ ticketNo: 'SVC-00002' })
  })

  it('concurrent double open: exactly one ticket, one in_service event', async () => {
    const { db, schema, a, buy, sell, unit, svc, events } = await seed()
    await buy(['S-7'])
    await sell('S-7')
    const u = await unit('S-7')
    const res = await Promise.allSettled([1, 2, 3, 4].map(async (i) => svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: `Issue ${i}` }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of res.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect(String(r.reason.message)).toMatch(/already in service|open service ticket/)
    expect(await db.select().from(schema.serviceTickets)).toHaveLength(1)
    expect((await events(u.id)).filter((e) => e.type === 'sent_to_service')).toHaveLength(1)
  })

  it('the database itself refuses a second active ticket for a unit', async () => {
    const { db, schema, a, buy, sell, unit, svc } = await seed()
    await buy(['S-8'])
    await sell('S-8')
    const u = await unit('S-8')
    await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: 'First' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(db.insert(schema.serviceTickets).values({ companyId: a.cid, unitId: u.id, issue: 'Sneaky', status: 'in_progress' })).rejects.toThrow()
  })
})

describe('update and close', () => {
  it('open -> in_progress -> closed with each outcome moves the unit and writes events with the ticket id', async () => {
    const { db, schema, a, buy, sell, unit, svc, events } = await seed()
    await buy(['C-1', 'C-2', 'C-3', 'C-4'])
    const outcomes = [
      ['C-1', 'repaired', 'resolved', 'sold', 'returned_from_service'],
      ['C-2', 'rejected', 'rejected', 'sold', 'returned_from_service'],
      ['C-3', 'replaced', 'closed', 'in_stock', 'returned_from_service'],
      ['C-4', 'unrepairable', 'closed', 'damaged', 'marked_damaged'],
    ] as const
    for (const [serial, outcome, ticketStatus, unitStatus, evType] of outcomes) {
      await sell(serial)
      const u = await unit(serial)
      const tk = await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: `Issue ${serial}` }, await (await import('@/test/seed')).mainCtx(a.cid))
      expect(await svc.updateServiceTicket(db, a.cid, a.uid, tk.id, { status: 'in_progress', notes: 'diagnosing' }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ status: 'in_progress' })
      expect((await unit(serial)).status).toBe('in_service')
      const closed = await svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome, resolution: `Done: ${outcome}` }, await (await import('@/test/seed')).mainCtx(a.cid))
      expect(closed).toMatchObject({ status: ticketStatus, outcome, unitStatus })
      const after = await unit(serial)
      expect(after.status).toBe(unitStatus)
      const [row] = await db.select().from(schema.serviceTickets).where(eq(schema.serviceTickets.id, tk.id))
      expect(row).toMatchObject({ status: ticketStatus, outcome, resolution: `Done: ${outcome}`, notes: 'diagnosing', closedBy: a.uid })
      expect(row.closedAt).toBeInstanceOf(Date)
      const last = (await events(u.id)).at(-1)
      expect(last).toMatchObject({ type: evType, fromStatus: 'in_service', toStatus: unitStatus, refTable: 'service_tickets', refId: tk.id, actorUserId: a.uid, note: `Done: ${outcome}` })
      if (unitStatus === 'sold') expect(after.warrantyEnd).toBe('2027-11-26')
      else expect(after).toMatchObject({ soldAt: null, warrantyStart: null, warrantyEnd: null, saleItemId: null })
      if (unitStatus === 'sold') expect(after.saleItemId).toBe(u.saleItemId)
    }
    expect(await db.select().from(schema.activityLog).where(eq(schema.activityLog.action, 'service.close'))).toHaveLength(4)
  })

  it('finished tickets cannot be changed or closed again; invalid input is rejected', async () => {
    const { db, a, buy, sell, unit, svc } = await seed()
    await buy(['F-1'])
    await sell('F-1')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, (await unit('F-1')).id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'repaired', resolution: '' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { resolution: expect.any(String) } })
    await expect(svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'magic', resolution: 'abc' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { outcome: expect.any(String) } })
    await expect(svc.updateServiceTicket(db, a.cid, a.uid, tk.id, {}, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow()
    await svc.updateServiceTicket(db, a.cid, a.uid, tk.id, { status: 'in_progress' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(svc.updateServiceTicket(db, a.cid, a.uid, tk.id, { status: 'in_progress' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already in progress/)
    await svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'repaired', resolution: 'Fixed' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'repaired', resolution: 'Fixed again' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already resolved/)
    await expect(svc.updateServiceTicket(db, a.cid, a.uid, tk.id, { notes: 'late note' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already resolved/)
  })

  it('concurrent close: exactly one wins; one return event', async () => {
    const { db, a, buy, sell, unit, svc, events } = await seed()
    await buy(['F-2'])
    await sell('F-2')
    const u = await unit('F-2')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const res = await Promise.allSettled([svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'repaired', resolution: 'Fixed' }, await (await import('@/test/seed')).mainCtx(a.cid)), svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'unrepairable', resolution: 'Dead' }, await (await import('@/test/seed')).mainCtx(a.cid)), svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'replaced', resolution: 'Swap' }, await (await import('@/test/seed')).mainCtx(a.cid))])
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await events(u.id)).filter((e) => e.fromStatus === 'in_service')).toHaveLength(1)
  })

  it('company isolation: another company cannot see, update or close a ticket', async () => {
    const { db, a, b, buy, sell, unit, svc } = await seed()
    await buy(['I-1'])
    await sell('I-1')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, (await unit('I-1')).id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await expect(svc.updateServiceTicket(db, b.cid, b.uid, tk.id, { status: 'in_progress' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toThrow(/not found/i)
    await expect(svc.closeServiceTicket(db, b.cid, b.uid, tk.id, { outcome: 'repaired', resolution: 'Fixed' }, await (await import('@/test/seed')).mainCtx(b.cid))).rejects.toThrow(/not found/i)
    expect((await svc.listServiceTickets(db, b.cid, null, { limit: 20, offset: 0 })).total).toBe(0)
    expect((await svc.listServiceTickets(db, a.cid, null, { limit: 20, offset: 0 })).total).toBe(1)
  })
})

describe('the sale link survives service: a return through the original invoice still works', () => {
  it('sold -> in_service -> sold keeps sale_item_id; the original invoice can then be returned; in service it cannot', async () => {
    const { db, schema, a, buy, sell, unit, svc, cash } = await seed()
    await buy(['L-1'])
    const sale = await sell('L-1')
    const u = await unit('L-1')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const { createSaleReturn } = await import('../sales/sales')
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, sale.id))
    // while in service the customer cannot return it through the invoice
    await expect(createSaleReturn(db, a.cid, a.uid, sale.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/L-1|sold|invoice/i)
    expect((await unit('L-1')).status).toBe('in_service')
    await svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'repaired', resolution: 'New board' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await unit('L-1')).toMatchObject({ status: 'sold', saleItemId: item.id })
    const ret = await createSaleReturn(db, a.cid, a.uid, sale.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(ret).toMatchObject({ credit: '2800.00' })
    expect(await unit('L-1')).toMatchObject({ status: 'in_stock', saleItemId: null, warrantyEnd: null })
  })

  it('resale after a replaced outcome starts a fresh warranty and link', async () => {
    const { db, a, buy, sell, unit, svc } = await seed()
    await buy(['L-2'])
    await sell('L-2')
    const u = await unit('L-2')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: 'Broken' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'replaced', resolution: 'Swapped with new unit' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const s2 = await sell('L-2')
    const after = await unit('L-2')
    expect(after.status).toBe('sold')
    expect(after.saleItemId).toBeTruthy()
    expect(after.saleItemId).not.toBe(u.saleItemId)
    void s2
  })
})

describe('unit detail shows the service history; ticket list filters and search', () => {
  it('detail has tickets, flags and the service timeline with ticket links', async () => {
    const { db, a, buy, sell, unit, svc, lookup } = await seed()
    await buy(['H-1'])
    await sell('H-1')
    const u = await unit('H-1')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, u.id, { issue: 'Flicker' }, await (await import('@/test/seed')).mainCtx(a.cid))
    let d = await lookup.getUnitDetail(db, a.cid, null, { id: u.id }, { withCost: false, today: '2026-11-26' })
    expect(d).toMatchObject({ activeTicketId: tk.id, flags: { inService: true, serviceTickets: 1 } })
    expect(d.tickets[0]).toMatchObject({ ticketNo: 'SVC-00001', status: 'open', underWarranty: true, openedByName: 'A' })
    expect(d.timeline.at(-1)).toMatchObject({ type: 'sent_to_service', doc: { kind: 'service_ticket', label: 'SVC-00001' } })
    await svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'repaired', resolution: 'Done' }, await (await import('@/test/seed')).mainCtx(a.cid))
    d = await lookup.getUnitDetail(db, a.cid, null, { id: u.id }, { withCost: false, today: '2026-11-26' })
    expect(d.activeTicketId).toBeNull()
    expect(d.tickets[0]).toMatchObject({ status: 'resolved', outcome: 'repaired', closedByName: 'A' })
    expect(d.timeline.map((e) => e.type)).toEqual(['purchased', 'sold', 'sent_to_service', 'returned_from_service'])
    expect(d.currentSale?.customerName).toBe('Rahim')
  })

  it('list: status filter, search by serial / customer / ticket no, pagination, counts; customer panel', async () => {
    const { db, a, buy, sell, unit, svc, lookup, rahim } = await seed()
    await buy(['T-1', 'T-2', 'T-3'])
    const ids: string[] = []
    for (const s of ['T-1', 'T-2', 'T-3']) {
      await sell(s, s === 'T-3' ? null : rahim.id)
      ids.push((await svc.openServiceTicket(db, a.cid, a.uid, (await unit(s)).id, { issue: `Issue of ${s}` }, await (await import('@/test/seed')).mainCtx(a.cid))).id)
    }
    await svc.updateServiceTicket(db, a.cid, a.uid, ids[1], { status: 'in_progress' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await svc.closeServiceTicket(db, a.cid, a.uid, ids[2], { outcome: 'repaired', resolution: 'Done' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const list = (f: object) => svc.listServiceTickets(db, a.cid, null, { limit: 20, offset: 0, ...f })
    expect((await list({})).total).toBe(3)
    expect((await list({})).counts).toEqual({ open: 1, in_progress: 1, resolved: 1 })
    expect((await list({ status: 'active' })).rows.map((r) => r.serialNo).sort()).toEqual(['T-1', 'T-2'])
    expect((await list({ status: 'resolved' })).rows.map((r) => r.serialNo)).toEqual(['T-3'])
    expect((await list({ status: 'bogus' })).total).toBe(3)
    expect((await list({ q: 'T-2' })).rows.map((r) => r.serialNo)).toEqual(['T-2'])
    expect((await list({ q: 'rahim' })).total).toBe(2)
    expect((await list({ q: 'SVC-00003' })).rows.map((r) => r.serialNo)).toEqual(['T-3'])
    expect((await list({ q: '%' })).total).toBe(0)
    const p1 = await list({ limit: 2, offset: 0 })
    const p2 = await list({ limit: 2, offset: 2 })
    expect([p1.rows.length, p2.rows.length, p1.total]).toEqual([2, 1, 3])
    expect(p1.rows.map((r) => r.status)).not.toContain('resolved') // active tickets come first

    const panel = await lookup.getCustomerWarrantyPanel(db, a.cid, null, rahim.id, { today: '2026-11-26' })
    expect(panel.units.map((u) => [u.serialNo, u.status, u.info.state]).sort()).toEqual([['T-1', 'in_service', 'active'], ['T-2', 'in_service', 'active']])
    expect(panel.tickets.map((x) => x.serialNo).sort()).toEqual(['T-1', 'T-2'])
  })
})

describe('in-stock units never carry a sale pointer or warranty', () => {
  it('damaged -> in_stock -> resale ends with a fresh pointer; a mixed-flow scan finds no stale stock rows', async () => {
    const { db, schema, a, buy, sell, unit, svc, cash } = await seed()
    await buy(['M-1', 'M-2', 'M-3', 'M-4', 'M-5'])
    const { transitionUnit } = await import('../serials')
    const { createSaleReturn } = await import('../sales/sales')

    // M-1: unrepairable (damaged) -> restocked by hand -> resold
    await sell('M-1')
    const m1 = await unit('M-1')
    const tk = await svc.openServiceTicket(db, a.cid, a.uid, m1.id, { issue: 'Dead' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await svc.closeServiceTicket(db, a.cid, a.uid, tk.id, { outcome: 'unrepairable', resolution: 'Beyond repair' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await unit('M-1')).toMatchObject({ status: 'damaged', saleItemId: null, warrantyEnd: null, soldAt: null })
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, unitId: m1.id, to: 'in_stock' }))
    expect(await unit('M-1')).toMatchObject({ status: 'in_stock', saleItemId: null, warrantyStart: null, warrantyEnd: null, soldAt: null })
    await sell('M-1')
    const again = await unit('M-1')
    expect(again.status).toBe('sold')
    expect(again.saleItemId).toBeTruthy()
    expect(again.saleItemId).not.toBe(m1.saleItemId)

    // M-2: sold -> damaged (plain transition keeps the link) -> in_stock clears it
    await sell('M-2')
    const m2 = await unit('M-2')
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, unitId: m2.id, to: 'damaged' }))
    await db.transaction((tx) => transitionUnit(tx, { companyId: a.cid, userId: a.uid, unitId: m2.id, to: 'in_stock' }))
    expect(await unit('M-2')).toMatchObject({ status: 'in_stock', saleItemId: null, warrantyEnd: null, soldAt: null })

    // M-3: replaced; M-4: customer return; M-5: stays in stock
    await sell('M-3')
    const t3 = await svc.openServiceTicket(db, a.cid, a.uid, (await unit('M-3')).id, { issue: 'Dead' }, await (await import('@/test/seed')).mainCtx(a.cid))
    await svc.closeServiceTicket(db, a.cid, a.uid, t3.id, { outcome: 'replaced', resolution: 'Swapped' }, await (await import('@/test/seed')).mainCtx(a.cid))
    const s4 = await sell('M-4')
    const [item] = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, s4.id))
    await createSaleReturn(db, a.cid, a.uid, s4.id, { items: [{ saleItemId: item.id, qty: 1 }], date: D, refundAccountId: cash.id }, await (await import('@/test/seed')).mainCtx(a.cid))

    const all = await db.select().from(schema.productUnits)
    const stale = all.filter((u) => u.status === 'in_stock' && (u.saleItemId || u.soldAt || u.warrantyStart || u.warrantyEnd))
    expect(stale).toEqual([])
    // and every unit that points at a sale line is sold or in service
    expect(all.filter((u) => u.saleItemId && u.status !== 'sold' && u.status !== 'in_service')).toEqual([])
  })
})
