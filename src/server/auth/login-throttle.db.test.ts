import { sql } from 'drizzle-orm'
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

describe('DB-backed login throttle', () => {
  it('locks at the limit, is shared across throttle instances, and success resets email+ip only', async () => {
    const { getDb, schema } = await import('../db')
    const { createLoginThrottle, dbThrottleStore } = await import('./login-throttle')
    const errors: unknown[] = []
    const mk = () => createLoginThrottle(() => dbThrottleStore(getDb()), { onError: (e) => errors.push(e) })
    const a = mk()
    const b = mk() // a second "server instance"
    for (let i = 0; i < 4; i++) await a.recordFailure('u@x.test', '1.2.3.4')
    expect(await b.isLimited('u@x.test', '1.2.3.4')).toBe(false)
    await b.recordFailure('u@x.test', '1.2.3.4')
    expect(await a.isLimited('u@x.test', '1.2.3.4')).toBe(true)
    expect(await a.isLimited('u@x.test', '5.6.7.8')).toBe(false)
    const rows = await getDb().select().from(schema.loginAttempts)
    expect(rows.map((r) => [r.kind, r.count]).sort()).toEqual([['email', 5], ['email_ip', 5]])
    expect(JSON.stringify(rows)).not.toContain('u@x.test')
    await a.recordSuccess('u@x.test', '1.2.3.4')
    expect((await getDb().select().from(schema.loginAttempts)).map((r) => r.kind)).toEqual(['email'])
    expect(errors).toEqual([])
  })

  it('concurrent failures are counted atomically', async () => {
    const { getDb, schema } = await import('../db')
    const { createLoginThrottle, dbThrottleStore } = await import('./login-throttle')
    const th = createLoginThrottle(() => dbThrottleStore(getDb()), { onError: (e) => { throw e } })
    await Promise.all(Array.from({ length: 12 }, () => th.recordFailure('race@x.test', 'direct')))
    const [row] = await getDb().select().from(schema.loginAttempts)
    expect(row.count).toBe(12)
    expect(row.lockedUntil).toBeNull() // per-email limit is 20
  })

  it('an expired window starts over and expired locks are lifted', async () => {
    const { getDb, schema } = await import('../db')
    const { createLoginThrottle, dbThrottleStore } = await import('./login-throttle')
    const th = createLoginThrottle(() => dbThrottleStore(getDb()))
    for (let i = 0; i < 5; i++) await th.recordFailure('old@x.test', '1.1.1.1')
    expect(await th.isLimited('old@x.test', '1.1.1.1')).toBe(true)
    await getDb().execute(sql`update ${schema.loginAttempts} set window_start = now() - interval '16 minutes', locked_until = now() - interval '1 minute'`)
    expect(await th.isLimited('old@x.test', '1.1.1.1')).toBe(false)
    await th.recordFailure('old@x.test', '1.1.1.1')
    const rows = await getDb().select().from(schema.loginAttempts)
    expect(rows.every((r) => r.count === 1)).toBe(true)
  })

  it('clearEmailLockout lifts the per-email lock (admin:reset) and leaves other emails alone', async () => {
    const { getDb } = await import('../db')
    const { createLoginThrottle, dbThrottleStore, clearEmailLockout } = await import('./login-throttle')
    const th = createLoginThrottle(() => dbThrottleStore(getDb()), { onError: (e) => { throw e } })
    for (let i = 0; i < 20; i++) await th.recordFailure('Boss@X.test', `10.0.0.${i}`)
    for (let i = 0; i < 20; i++) await th.recordFailure('other@x.test', `10.0.1.${i}`)
    expect(await th.isLimited('boss@x.test', '9.9.9.9')).toBe(true)
    expect(await clearEmailLockout('boss@x.test')).toBe(true)
    expect(await th.isLimited('boss@x.test', '9.9.9.9')).toBe(false)
    expect(await th.isLimited('other@x.test', '9.9.9.9')).toBe(true)
    expect(await clearEmailLockout('boss@x.test')).toBe(false)
  })
})
