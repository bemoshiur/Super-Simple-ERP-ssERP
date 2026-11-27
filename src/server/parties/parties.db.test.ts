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

describe.each(['vendor', 'customer'] as const)('%s', (kind) => {
  it('create / update / search / soft delete; phone is not unique', async () => {
    const { getDb } = await import('../db')
    const { createParty, getParty, listParties, setPartyActive, updateParty } = await import('./parties')
    const db = getDb()
    const { a } = await seedTwoCompanies()
    const p = await createParty(db, a.cid, a.uid, kind, { name: 'Rahim Traders', phone: '01711-234567', openingBalance: '5,000' })
    const dup = await createParty(db, a.cid, a.uid, kind, { name: 'Karim Store', phone: '01711-234567' })
    expect(dup.id).not.toBe(p.id)
    expect(p.openingBalance).toBe('5000.00')

    await updateParty(db, a.cid, a.uid, kind, p.id, { name: 'Rahim Enterprise', phone: '01711-234567', email: 'R@X.com', openingBalance: '5000' })
    expect((await getParty(db, a.cid, kind, p.id)).email).toBe('r@x.com')
    expect((await listParties(db, a.cid, kind, { q: 'enterprise', limit: 20, offset: 0 })).total).toBe(1)
    expect((await listParties(db, a.cid, kind, { q: '01711', limit: 20, offset: 0 })).total).toBe(2)

    await setPartyActive(db, a.cid, a.uid, kind, p.id, false)
    expect((await listParties(db, a.cid, kind, { limit: 20, offset: 0 })).total).toBe(1)
    expect((await listParties(db, a.cid, kind, { status: 'all', limit: 20, offset: 0 })).total).toBe(2)
    expect((await getParty(db, a.cid, kind, p.id)).active).toBe(false)
  })

  it('company B cannot read, update or delete company A rows; pickers are scoped and capped', async () => {
    const { getDb } = await import('../db')
    const { createParty, getParty, listParties, searchParties, setPartyActive, updateParty } = await import('./parties')
    const { NotFoundError } = await import('../errors')
    const db = getDb()
    const { a, b } = await seedTwoCompanies()
    const p = await createParty(db, a.cid, a.uid, kind, { name: 'Private' })
    await expect(getParty(db, b.cid, kind, p.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(updateParty(db, b.cid, b.uid, kind, p.id, { name: 'Hacked' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(setPartyActive(db, b.cid, b.uid, kind, p.id, false)).rejects.toBeInstanceOf(NotFoundError)
    expect((await listParties(db, b.cid, kind, { status: 'all', limit: 20, offset: 0 })).total).toBe(0)
    expect(await searchParties(db, b.cid, kind, 'priv')).toEqual([])
    expect((await getParty(db, a.cid, kind, p.id)).name).toBe('Private')
    for (let i = 0; i < 25; i++) await createParty(db, a.cid, a.uid, kind, { name: `Party ${i}` })
    expect(await searchParties(db, a.cid, kind, '')).toHaveLength(20)
  })

  it('writes record_history for contact/opening-balance changes only', async () => {
    const { getDb, schema } = await import('../db')
    const { createParty, updateParty } = await import('./parties')
    const db = getDb()
    const { a } = await seedTwoCompanies()
    const p = await createParty(db, a.cid, a.uid, kind, { name: 'N', phone: '01711000000' })
    const hist = () => db.select().from(schema.recordHistory).where(and(eq(schema.recordHistory.companyId, a.cid), eq(schema.recordHistory.entityId, p.id)))
    await updateParty(db, a.cid, a.uid, kind, p.id, { name: 'N', phone: '01711000000', notes: 'only notes changed' })
    expect(await hist()).toHaveLength(0)
    await updateParty(db, a.cid, a.uid, kind, p.id, { name: 'N2', phone: '01811000000', email: 'n@x.com', address: 'Dhaka', openingBalance: '250.5' })
    const rows = await hist()
    expect(rows).toHaveLength(1)
    expect(rows[0].entity).toBe(kind)
    expect(rows[0].diff).toEqual({
      name: { from: 'N', to: 'N2' },
      phone: { from: '01711000000', to: '01811000000' },
      email: { from: null, to: 'n@x.com' },
      address: { from: null, to: 'Dhaka' },
      openingBalance: { from: '0.00', to: '250.50' },
    })
  })
})

describe('ledger summary', () => {
  async function seedLedger(kind: 'vendor' | 'customer') {
    const { getDb, schema } = await import('../db')
    const { createParty } = await import('./parties')
    const db = getDb()
    const { a, b } = await seedTwoCompanies()
    const [acct] = await db.insert(schema.accounts).values({ companyId: a.cid, type: 'cash', name: 'Test till' }).returning()
    const [acctB] = await db.insert(schema.accounts).values({ companyId: b.cid, type: 'cash', name: 'Test till' }).returning()
    const party = await createParty(db, a.cid, a.uid, kind, { name: 'P', openingBalance: '1000' })
    const other = await createParty(db, a.cid, a.uid, kind, { name: 'Other' })
    const partyB = await createParty(db, b.cid, b.uid, kind, { name: 'PB', openingBalance: '77' })
    return { db, schema, a, b, acct, acctB, party, other, partyB }
  }

  it('vendor: opening + purchases - payments, excluding drafts/cancelled, other vendors and other companies', async () => {
    const { db, schema, a, b, acct, acctB, party, other, partyB } = await seedLedger('vendor')
    const { getLedger } = await import('./ledger')
    const mk = (cid: string, vendorId: string, no: string, total: string, status: 'received' | 'draft' | 'cancelled' | 'paid' = 'received') =>
      db.insert(schema.purchases).values({ companyId: cid, invoiceNo: no, vendorId, date: '2026-11-01', total, subtotal: total, status }).returning()
    const [p1] = await mk(a.cid, party.id, 'P-1', '2500.50')
    await mk(a.cid, party.id, 'P-2', '499.50', 'paid')
    await mk(a.cid, party.id, 'P-3', '9999', 'draft')
    await mk(a.cid, party.id, 'P-4', '8888', 'cancelled')
    await mk(a.cid, other.id, 'P-5', '7777')
    await mk(b.cid, partyB.id, 'P-1', '123')
    const pay = (cid: string, accountId: string, o: Partial<typeof schema.payments.$inferInsert>) => db.insert(schema.payments).values({ companyId: cid, accountId, direction: 'out', refType: 'manual', amount: '1', date: '2026-11-02', ...o })
    await pay(a.cid, acct.id, { partyType: 'vendor', partyId: party.id, amount: '1000.25' }) // direct on party
    await pay(a.cid, acct.id, { refType: 'purchase', refId: p1.id, amount: '500' }) // via the purchase only
    await pay(a.cid, acct.id, { partyType: 'vendor', partyId: party.id, refType: 'purchase', refId: p1.id, amount: '100' }) // both: counted once
    await pay(a.cid, acct.id, { direction: 'in', partyType: 'vendor', partyId: party.id, amount: '50' }) // refund received back from the vendor: reduces net paid
    await pay(a.cid, acct.id, { partyType: 'vendor', partyId: other.id, amount: '40' })
    await pay(b.cid, acctB.id, { partyType: 'vendor', partyId: party.id, amount: '999' }) // company B row naming A's vendor id
    const l = await getLedger(db, a.cid, null, 'vendor', party.id)
    expect(l).toEqual({ opening: '1000.00', billed: '3000.00', returned: '0.00', paid: '1550.25', due: '2449.75', documents: 2 })
    // company B's view of the same id: nothing leaks (and no opening balance since the id isn't B's)
    expect(await getLedger(db, b.cid, null, 'vendor', party.id)).toMatchObject({ opening: '0.00', billed: '0.00', paid: '999.00' })
  })

  it('customer: opening + sales - receipts', async () => {
    const { db, schema, a, acct, party, other } = await seedLedger('customer')
    const { getLedger } = await import('./ledger')
    const [s1] = await db.insert(schema.sales).values({ companyId: a.cid, invoiceNo: 'S-1', customerId: party.id, date: '2026-11-01', total: '4000', subtotal: '4000' }).returning()
    await db.insert(schema.sales).values({ companyId: a.cid, invoiceNo: 'S-2', customerId: party.id, date: '2026-11-01', total: '1000.75', subtotal: '1000.75', status: 'paid' })
    await db.insert(schema.sales).values({ companyId: a.cid, invoiceNo: 'S-3', customerId: party.id, date: '2026-11-01', total: '555', subtotal: '555', status: 'cancelled' })
    await db.insert(schema.sales).values({ companyId: a.cid, invoiceNo: 'S-4', customerId: other.id, date: '2026-11-01', total: '321', subtotal: '321' })
    await db.insert(schema.payments).values([
      { companyId: a.cid, accountId: acct.id, direction: 'in', partyType: 'customer', partyId: party.id, refType: 'manual', amount: '1500', date: '2026-11-02' },
      { companyId: a.cid, accountId: acct.id, direction: 'in', refType: 'sale', refId: s1.id, amount: '250.25', date: '2026-11-02' },
      { companyId: a.cid, accountId: acct.id, direction: 'out', partyType: 'customer', partyId: party.id, refType: 'manual', amount: '60', date: '2026-11-02' },
    ])
    // Task 7: an 'out' payment to a customer is a refund and reduces what they have paid (1500 + 250.25 - 60).
    expect(await getLedger(db, a.cid, null, 'customer', party.id)).toEqual({ opening: '1000.00', billed: '5000.75', returned: '0.00', paid: '1690.25', due: '4310.50', documents: 2 })
  })

  it('empty tables give opening-only ledger', async () => {
    const { db, a, party } = await seedLedger('customer')
    const { getLedger } = await import('./ledger')
    expect(await getLedger(db, a.cid, null, 'customer', party.id)).toEqual({ opening: '1000.00', billed: '0.00', returned: '0.00', paid: '0.00', due: '1000.00', documents: 0 })
  })
})
