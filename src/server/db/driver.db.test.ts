import { eq, sql } from 'drizzle-orm'
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

describe('node-postgres driver', () => {
  it('is selected for the local test database and exposes rowsOf-compatible results', async () => {
    const { currentDriver, getDb, rowsOf } = await import('../db')
    expect(currentDriver()).toBe('pg')
    const res = await getDb().execute(sql`select 1::int as n`)
    expect(rowsOf<{ n: number }>(res)).toEqual([{ n: 1 }])
  })

  it('transactions commit and roll back', async () => {
    const { getDb, schema } = await import('../db')
    const db = getDb()
    await db.transaction(async (tx) => {
      await tx.insert(schema.companies).values({ name: 'Committed' })
    })
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.companies).values({ name: 'RolledBack' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const names = (await db.select({ n: schema.companies.name }).from(schema.companies)).map((r) => r.n)
    expect(names).toEqual(['Committed'])
  })

  it('pg_advisory_xact_lock serialises concurrent transactions', async () => {
    const { getDb } = await import('../db')
    const db = getDb()
    const order: string[] = []
    let entered = 0
    const run = (label: string) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('driver-test'))`)
        order.push(`${label}:start`)
        // The first holder stays inside until the other transaction is provably blocked on the lock (no fixed sleep).
        if (entered++ === 0) await waitForLockWait()
        order.push(`${label}:end`)
      })
    await Promise.all([run('a'), run('b')])
    // Whichever got the lock first must finish before the other starts.
    expect(order[0].split(':')[0]).toBe(order[1].split(':')[0])
    expect(order[2].split(':')[0]).toBe(order[3].split(':')[0])
  })

  it('SELECT ... FOR UPDATE blocks a second locker until commit', async () => {
    const { getDb, schema } = await import('../db')
    const db = getDb()
    const [c] = await db.insert(schema.companies).values({ name: 'Lock me' }).returning()
    const events: string[] = []
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const first = db.transaction(async (tx) => {
      await tx.select().from(schema.companies).where(eq(schema.companies.id, c.id)).for('update')
      events.push('first:locked')
      locked()
      await waitForLockWait() // until the second locker is blocked on this row
      events.push('first:commit')
    })
    await isLocked
    const second = db.transaction(async (tx) => {
      await tx.select().from(schema.companies).where(eq(schema.companies.id, c.id)).for('update')
      events.push('second:locked')
    })
    await Promise.all([first, second])
    expect(events).toEqual(['first:locked', 'first:commit', 'second:locked'])
  })
})
