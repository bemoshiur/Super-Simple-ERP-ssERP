import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'
import type { SessionPayload } from './session'

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

const PASSWORD = 'correct horse battery'

async function seedAdmin() {
  const { seedBase } = await import('../install')
  const { companyId, adminUserId } = await seedBase({ companyName: 'Acme', adminName: 'Ada', adminEmail: 'ada@example.test', adminPassword: PASSWORD })
  const { getDb, schema } = await import('../db')
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, adminUserId))
  const claims: SessionPayload = { uid: u.id, cid: companyId, bid: u.branchId ?? null, role: 'admin', adm: true, sv: u.sessionVersion, perms: [] }
  return { companyId, user: u, claims }
}

describe('login credentials', () => {
  it('stored hash verifies the right password only', async () => {
    const { hashPassword, verifyPassword } = await import('./password')
    const { user } = await seedAdmin()
    expect(user.passwordHash).not.toBe(PASSWORD)
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(true)
    expect(await verifyPassword('wrong password', user.passwordHash)).toBe(false)
    expect(await verifyPassword(PASSWORD, await hashPassword(PASSWORD))).toBe(true)
  })
})

describe('loadSessionUser (revocation)', () => {
  it('accepts a fresh session', async () => {
    const { loadSessionUser } = await import('./session-user')
    const { claims } = await seedAdmin()
    const r = await loadSessionUser(claims)
    expect(r?.email).toBe('ada@example.test')
    expect(r?.session).toEqual(claims)
  })

  it('rejects after session_version is bumped (revokeUserSessions)', async () => {
    const { loadSessionUser } = await import('./session-user')
    const { revokeUserSessions } = await import('./revoke')
    const { claims } = await seedAdmin()
    expect(await loadSessionUser(claims)).not.toBeNull()
    await revokeUserSessions(claims.cid, claims.uid)
    expect(await loadSessionUser(claims)).toBeNull()
  })

  it('rejects an inactive user', async () => {
    const { loadSessionUser } = await import('./session-user')
    const { getDb, schema } = await import('../db')
    const { claims } = await seedAdmin()
    await getDb().update(schema.users).set({ active: false }).where(eq(schema.users.id, claims.uid))
    expect(await loadSessionUser(claims)).toBeNull()
  })

  it('rejects unknown users and a mismatched company', async () => {
    const { loadSessionUser } = await import('./session-user')
    const { claims } = await seedAdmin()
    expect(await loadSessionUser({ ...claims, uid: '00000000-0000-4000-8000-000000000000' })).toBeNull()
    expect(await loadSessionUser({ ...claims, cid: '00000000-0000-4000-8000-000000000000' })).toBeNull()
  })

  it('session_version really increments in SQL', async () => {
    const { revokeUserSessions } = await import('./revoke')
    const { getDb, schema } = await import('../db')
    const { claims } = await seedAdmin()
    await revokeUserSessions(claims.cid, claims.uid)
    await revokeUserSessions(claims.cid, claims.uid)
    const [u] = await getDb().select({ sv: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, claims.uid))
    expect(u.sv).toBe(claims.sv + 2)
  })
})
