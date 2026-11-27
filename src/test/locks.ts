/**
 * Barrier for concurrency tests (no fixed sleeps): resolve as soon as another backend in this database is waiting on a
 * lock (row/transaction/advisory locks all report wait_event_type = 'Lock'), or fail after `timeoutMs`.
 *
 * Polls from its own short-lived connection by default: pg_stat_activity is snapshotted once per transaction, so a
 * client that is inside a transaction would never see the change.
 */
import pg from 'pg'

type Queryable = { query: (q: string) => Promise<{ rows: { n: number }[] }> }

export async function waitForLockWait(client?: Queryable, timeoutMs = 10_000): Promise<void> {
  const own = client ? null : new pg.Client({ connectionString: process.env.DATABASE_URL })
  if (own) await own.connect()
  const c: Queryable = client ?? (own as unknown as Queryable)
  try {
    const until = Date.now() + timeoutMs
    for (;;) {
      const { rows } = await c.query(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      )
      if (rows[0].n > 0) return
      if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for another backend to block on a lock`)
      await new Promise((r) => setTimeout(r, 10))
    }
  } finally {
    await own?.end()
  }
}
