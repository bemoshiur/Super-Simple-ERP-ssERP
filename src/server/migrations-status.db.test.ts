import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestDb, type TestDb } from '@/test/db-harness'

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})

describe('migrations status against a real database', () => {
  it('ok after migrating; pending once the newest applied row is missing', async () => {
    const { readApplied, readJournal, compareMigrations, createMigrationsStatus } = await import('./migrations-status')
    const { getDb } = await import('./db')
    const journal = await readJournal()
    const applied = await readApplied()
    expect(applied.count).toBe(journal.count)
    expect(compareMigrations(journal, applied)).toBe('ok')

    // Simulate "code newer than schema": the reader sees one migration fewer (inside a rolled-back transaction).
    const db = getDb()
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`)
        const status = createMigrationsStatus({
          journal: async () => journal,
          applied: async () => {
            const r = (await tx.execute(sql`select count(*)::int as n, max(created_at) as last from drizzle.__drizzle_migrations`)) as unknown as { rows: { n: number; last: string }[] }
            return { count: r.rows[0].n, lastCreatedAt: Number(r.rows[0].last) }
          },
        })
        expect(await status()).toBe('pending')
        tx.rollback()
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error && e.message === 'Rollback')) throw e
      })
    expect(compareMigrations(journal, await readApplied())).toBe('ok')
  })
})
