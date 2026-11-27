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

const input = (email = 'admin@example.test') => ({ companyName: 'Acme Traders', adminName: 'Ada Admin', adminEmail: email, adminPassword: 'correct horse battery' })

describe('seedBase', () => {
  it('seeds system roles, exactly one admin, defaults and the installed flag', async () => {
    const { getDb, schema } = await import('./db')
    const { seedBase, isInstalled } = await import('./install')
    expect(await isInstalled()).toBe('no')
    const { companyId, adminUserId } = await seedBase(input())
    const db = getDb()

    const roles = await db.select().from(schema.roles).where(eq(schema.roles.companyId, companyId))
    expect(roles.map((r) => r.name).sort()).toEqual(['admin', 'manager', 'salesman'])
    expect(roles.every((r) => r.isSystem)).toBe(true)

    const users = await db.select().from(schema.users)
    expect(users).toHaveLength(1)
    expect(users[0].id).toBe(adminUserId)
    expect(users[0].roleId).toBe(roles.find((r) => r.name === 'admin')!.id)

    const flag = await db.select().from(schema.settings).where(and(eq(schema.settings.key, 'installed'), eq(schema.settings.value, 'true')))
    expect(flag).toHaveLength(1)
    expect(await isInstalled()).toBe('yes')

    expect((await db.select().from(schema.branches)).map((b) => b.name)).toEqual(['Main'])
    expect((await db.select().from(schema.accounts)).length).toBeGreaterThanOrEqual(3)
    expect((await db.select().from(schema.activityLog)).some((r) => r.action === 'install')).toBe(true)
  })

  it('refuses a second seed with AlreadyInstalledError and leaves data untouched', async () => {
    const { getDb, schema } = await import('./db')
    const { seedBase, AlreadyInstalledError } = await import('./install')
    await seedBase(input())
    await expect(seedBase(input('second@example.test'))).rejects.toBeInstanceOf(AlreadyInstalledError)
    expect(await getDb().select().from(schema.users)).toHaveLength(1)
  })

  it('concurrent double-seed leaves exactly one admin', async () => {
    const { getDb, schema } = await import('./db')
    const { seedBase, AlreadyInstalledError } = await import('./install')
    const results = await Promise.allSettled([seedBase(input('a@example.test')), seedBase(input('b@example.test'))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(AlreadyInstalledError)
    expect(await getDb().select().from(schema.users)).toHaveLength(1)
    expect(await getDb().select().from(schema.companies)).toHaveLength(1)
  })

  it('migrations are re-runnable', async () => {
    const { runMigrations } = await import('./install')
    const r = await runMigrations()
    expect(r.total).toBeGreaterThan(0)
  })
})
