/**
 * Helpers for *.db.test.ts. DATABASE_URL (from scripts/test-db.sh) points at an admin database on a throwaway
 * Postgres; each test file gets its own freshly created, fully migrated database and drops it afterwards.
 * Tests call `resetData()` in beforeEach so they never depend on order.
 */
import { randomBytes } from 'node:crypto'
import pg from 'pg'

export type TestDb = { url: string; name: string; teardown: () => Promise<void> }

function withDatabase(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

export async function setupTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_URL
  if (!adminUrl) throw new Error('DATABASE_URL is not set; run integration tests with `npm run test:db`.')
  const name = `sserp_t_${randomBytes(5).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`create database ${name}`)
  } finally {
    await admin.end()
  }
  const url = withDatabase(adminUrl, name)
  process.env.DATABASE_URL = url
  process.env.AUTH_SECRET ||= 'test-secret-test-secret-test-secret-0123456789'
  const { runMigrations } = await import('../server/install')
  await runMigrations()
  return {
    url,
    name,
    teardown: async () => {
      const { closeDb } = await import('../server/db')
      await closeDb()
      const a = new pg.Client({ connectionString: adminUrl })
      await a.connect()
      try {
        await a.query(`drop database if exists ${name} with (force)`)
      } finally {
        await a.end()
      }
    },
  }
}

/** Empty every application table (keeps the migration bookkeeping) and clear in-process install caches. */
export async function resetData(): Promise<void> {
  const { getDb } = await import('../server/db')
  const { sql } = await import('drizzle-orm')
  const { rowsOf } = await import('../server/db')
  const db = getDb()
  const res = await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)
  const names = rowsOf<{ tablename: string }>(res).map((r) => `"${r.tablename}"`)
  if (names.length) await db.execute(sql.raw(`truncate table ${names.join(', ')} restart identity cascade`))
  ;(globalThis as { __sserpInstalled?: boolean }).__sserpInstalled = undefined
}
