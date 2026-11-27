import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

const st = vi.hoisted(() => ({ session: null as null | { uid: string; cid: string; bid: null; role: string; adm: boolean; sv: number; perms: string[] } }))
vi.mock('../auth/current', async () => {
  const { requirePermission } = await import('../rbac')
  return { authorize: async (key: never) => requirePermission(st.session, key), getSession: async () => st.session }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})
beforeEach(async () => {
  await resetData()
  st.session = null
})

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const { logActivity } = await import('../audit')
  const db = getDb()
  await db.delete(schema.activityLog) // drop the install row: tests below count exactly
  const at = (iso: string) => ({ createdAt: new Date(iso) })
  await db.insert(schema.activityLog).values([
    { companyId: a.cid, userId: a.uid, action: 'product.create', entity: 'product', entityId: 'p1', after: { name: 'Phone' }, ip: '10.0.0.1', ...at('2026-11-20T18:30:00Z') }, // 2026-11-21 00:30 Dhaka
    { companyId: a.cid, userId: a.uid, action: 'vendor.update', entity: 'vendor', entityId: 'v1', ...at('2026-11-20T17:30:00Z') }, // 2026-11-20 23:30 Dhaka
    { companyId: b.cid, userId: b.uid, action: 'product.create', entity: 'product', entityId: 'p9', ...at('2026-11-21T05:00:00Z') },
  ])
  await logActivity({ companyId: b.cid, userId: b.uid, action: 'secret.thing', entity: 'customer', entityId: 'c9' })
  return { a, b, db, schema }
}

describe('activity log', () => {
  it('lists only the company, with user / entity / tz date filters and search', async () => {
    const { a, b, db } = await seed()
    const { listActivity, activityFilterOptions } = await import('../activity/activity')
    const base = { tz: 'Asia/Dhaka', limit: 50, offset: 0 }
    const all = await listActivity(db, a.cid, base)
    expect(all.total).toBe(2)
    expect(all.rows.map((r) => r.entityId)).toEqual(['p1', 'v1'])
    expect(all.rows[0]).toMatchObject({ userName: 'A', ip: '10.0.0.1' })
    expect((await listActivity(db, a.cid, { ...base, entity: 'vendor' })).rows.map((r) => r.entityId)).toEqual(['v1'])
    expect((await listActivity(db, a.cid, { ...base, userId: b.uid })).total).toBe(0)
    // shop-local dates: 00:30 on the 21st in Dhaka is still the 20th in UTC
    expect((await listActivity(db, a.cid, { ...base, from: '2026-11-21', to: '2026-11-21' })).rows.map((r) => r.entityId)).toEqual(['p1'])
    expect((await listActivity(db, a.cid, { ...base, from: '2026-11-20', to: '2026-11-20' })).rows.map((r) => r.entityId)).toEqual(['v1'])
    expect((await listActivity(db, a.cid, { ...base, q: 'vendor' })).total).toBe(1)
    expect((await listActivity(db, a.cid, { ...base, q: '100%_' })).total).toBe(0)
    expect((await listActivity(db, a.cid, { ...base, action: 'product.' })).total).toBe(1)
    const opts = await activityFilterOptions(db, a.cid)
    expect(opts.users.map((u) => u.name)).toEqual(['A'])
    expect(opts.entities).toEqual(['product', 'vendor'])
  })

  it('history drawer: needs the record view permission, unknown entity refused, other company invisible', async () => {
    const { a, b, db, schema } = await seed()
    const { createParty, updateParty } = await import('../parties/parties')
    const v = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
    await updateParty(db, a.cid, a.uid, 'vendor', v.id, { name: 'V2', phone: '01711-234567' })
    await db.insert(schema.recordHistory).values({ companyId: b.cid, entity: 'vendor', entityId: v.id, changedBy: b.uid, diff: { name: { from: 'leak', to: 'leak2' } } })
    const act = await import('./activity')
    st.session = { uid: a.uid, cid: a.cid, bid: null, role: 'x', adm: false, sv: 0, perms: ['customers.view'] }
    expect(await act.getRecordHistoryAction('vendor', v.id)).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    expect(await act.getRecordHistoryAction('user', a.uid)).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) })
    expect(await act.getRecordHistoryAction('__proto__', v.id)).toMatchObject({ ok: false })
    st.session.perms = ['vendors.view']
    const r = await act.getRecordHistoryAction('vendor', v.id)
    expect(r.ok).toBe(true)
    const items = (r as { data: { by: string; rows: { key: string; before: string; after: string }[] }[] }).data
    expect(items).toHaveLength(1)
    expect(items[0].by).toBe('A')
    expect(items[0].rows).toEqual(expect.arrayContaining([{ key: 'Name', before: 'V', after: 'V2', changed: true }]))
    expect(JSON.stringify(items)).not.toContain('leak')
  })
})
