/**
 * Node-runtime only: this module uses `ws`, `pg` and connection pools.
 * Never import it from edge middleware/proxy code.
 *
 * Two drivers behind one `Db` type (see ./driver.ts for the selection rules):
 *  - neon: @neondatabase/serverless Pool over WebSockets (recommended; real transactions).
 *  - pg:   node-postgres Pool (plain Postgres: self-hosted, Docker, local, tests).
 * Transactions, pg_advisory_xact_lock and SELECT ... FOR UPDATE work on both.
 */
import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import ws from 'ws'
import { safeLog } from '../errors'
import { selectDriver, type DbDriver } from './driver'
import * as schema from './schema'

// Node has no global WebSocket in all runtimes; the Neon Pool needs one for real transactions.
neonConfig.webSocketConstructor = ws

/** Driver-agnostic drizzle database (also the shape of a transaction handle's query methods). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

type Handle = { driver: DbDriver; url: string; db: Db; end: () => Promise<void>; migrate: (folder: string) => Promise<void> }

function createHandle(url: string): Handle {
  const driver = selectDriver(url)
  if (driver === 'neon') {
    const pool = new NeonPool({ connectionString: url })
    pool.on('error', (e: Error) => safeLog('[db] idle pool error', e))
    const db = drizzleNeon(pool, { schema })
    return {
      driver,
      url,
      db,
      end: () => pool.end(),
      migrate: async (folder) => {
        const { migrate } = await import('drizzle-orm/neon-serverless/migrator')
        await migrate(db, { migrationsFolder: folder })
      },
    }
  }
  const pool = new pg.Pool({ connectionString: url })
  pool.on('error', (e: Error) => safeLog('[db] idle pool error', e))
  const db = drizzlePg(pool, { schema })
  return {
    driver,
    url,
    db,
    end: () => pool.end(),
    migrate: async (folder) => {
      const { migrate } = await import('drizzle-orm/node-postgres/migrator')
      await migrate(db, { migrationsFolder: folder })
    },
  }
}

const globalForDb = globalThis as unknown as { __sserpDb?: Handle }

function handle(): Handle {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  // Re-create if DATABASE_URL changed (tests / scripts that switch databases within one process).
  if (!globalForDb.__sserpDb || globalForDb.__sserpDb.url !== url) globalForDb.__sserpDb = createHandle(url)
  return globalForDb.__sserpDb
}

/** Singleton per process (survives Next.js dev HMR via globalThis). */
export function getDb(): Db {
  return handle().db
}

/** Which driver the current DATABASE_URL resolves to. */
export function currentDriver(): DbDriver {
  return selectDriver(process.env.DATABASE_URL)
}

/** Apply the committed drizzle migrations with the migrator that matches the active driver. */
export async function applyMigrations(folder: string): Promise<void> {
  await handle().migrate(folder)
}

/** Close the singleton pool (scripts and tests; the web server never needs this). */
export async function closeDb(): Promise<void> {
  const h = globalForDb.__sserpDb
  globalForDb.__sserpDb = undefined
  await h?.end()
}

/** Live check with a throwaway pool of the right driver (`select 1`). Throws on failure. */
export async function pingDatabase(url: string, timeoutMs = 8000): Promise<void> {
  const pool: { query: (q: string) => Promise<unknown>; on: (ev: 'error', fn: () => void) => unknown; end: () => Promise<void> } =
    selectDriver(url) === 'neon' ? new NeonPool({ connectionString: url, connectionTimeoutMillis: timeoutMs }) : new pg.Pool({ connectionString: url, connectionTimeoutMillis: timeoutMs })
  pool.on('error', () => {})
  try {
    await pool.query('select 1')
  } finally {
    await pool.end().catch(() => {})
  }
}

export { schema }
export { rowsOf, selectDriver } from './driver'
export type { DbDriver } from './driver'
