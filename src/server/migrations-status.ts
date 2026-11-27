/**
 * Lightweight "are there migrations this code expects but the database has not applied?" check.
 *
 * Compares drizzle/meta/_journal.json (the migrations shipped with this build) with the rows drizzle's migrator wrote to
 * drizzle.__drizzle_migrations (one row per applied migration; created_at = the journal entry's `when`). Cached for 60s,
 * single-flight, and it never throws: any failure answers 'unknown'. Used by /api/health?db=1 and the admin banner.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { safeLog } from './errors'

export type MigrationsStatus = 'ok' | 'pending' | 'unknown'
export type JournalInfo = { count: number; lastWhen: number; lastTag: string }
export type AppliedInfo = { count: number; lastCreatedAt: number | null }
export type MigrationReaders = { journal: () => Promise<JournalInfo>; applied: () => Promise<AppliedInfo> }

/** Pure decision: pending when the database is behind the journal by count or by the newest migration's timestamp. */
export function compareMigrations(journal: JournalInfo, applied: AppliedInfo): Exclude<MigrationsStatus, 'unknown'> {
  if (journal.count === 0) return 'ok'
  if (applied.lastCreatedAt === null || applied.count < journal.count || applied.lastCreatedAt < journal.lastWhen) return 'pending'
  return 'ok'
}

export function createMigrationsStatus(readers: MigrationReaders, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 60_000
  const now = opts.now ?? Date.now
  let cached: { status: MigrationsStatus; at: number } | null = null
  let inflight: Promise<MigrationsStatus> | null = null

  return async function migrationsStatus(): Promise<MigrationsStatus> {
    if (cached && now() - cached.at < ttlMs) return cached.status
    if (inflight) return inflight
    inflight = (async (): Promise<MigrationsStatus> => {
      try {
        const [journal, applied] = await Promise.all([readers.journal(), readers.applied()])
        return compareMigrations(journal, applied)
      } catch (e) {
        safeLog('[migrations] status check failed', e, 'warn')
        return 'unknown'
      }
    })()
      .then((status) => {
        cached = { status, at: now() }
        return status
      })
      .catch(() => 'unknown' as const)
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

/** Read drizzle/meta/_journal.json from the migrations folder (SSERP_MIGRATIONS_DIR or ./drizzle). */
export async function readJournal(folder = process.env.SSERP_MIGRATIONS_DIR ?? path.join(process.cwd(), 'drizzle')): Promise<JournalInfo> {
  const journal = JSON.parse(await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: { when: number; tag: string }[] }
  const last = journal.entries.at(-1)
  return { count: journal.entries.length, lastWhen: last?.when ?? 0, lastTag: last?.tag ?? '' }
}

/** Count and newest created_at of drizzle's applied-migrations table (missing table = nothing applied). */
export async function readApplied(): Promise<AppliedInfo> {
  const { getDb, rowsOf } = await import('./db')
  const { sql } = await import('drizzle-orm')
  const db = getDb()
  const exists = rowsOf<{ t: string | null }>(await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`))
  if (!exists[0]?.t) return { count: 0, lastCreatedAt: null }
  const [row] = rowsOf<{ n: string | number; last: string | number | null }>(
    await db.execute(sql`select count(*) as n, max(created_at) as last from drizzle.__drizzle_migrations`),
  )
  return { count: Number(row?.n ?? 0), lastCreatedAt: row?.last === null || row?.last === undefined ? null : Number(row.last) }
}

const g = globalThis as unknown as { __sserpMigrationsStatus?: () => Promise<MigrationsStatus> }

/** App-wide cached checker (one per process). */
export function migrationsStatus(): Promise<MigrationsStatus> {
  g.__sserpMigrationsStatus ??= createMigrationsStatus({ journal: () => readJournal(), applied: readApplied })
  return g.__sserpMigrationsStatus()
}
