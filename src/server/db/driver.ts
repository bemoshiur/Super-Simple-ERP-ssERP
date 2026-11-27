/**
 * Pure driver-selection and result-shape helpers. No driver imports, so it is unit-testable and cheap to import.
 *
 * Neon is the recommended production database (serverless, pooled, scale-to-zero). Any plain PostgreSQL
 * (self-hosted, Docker, RDS, local) works through node-postgres.
 */
export type DbDriver = 'neon' | 'pg'

/**
 * DB_DRIVER=neon|pg always wins. Otherwise a Neon host (`*.neon.tech`, pooler hosts included) selects the neon
 * serverless driver; everything else (localhost, unix sockets, private hostnames, a custom proxy) uses node-postgres;
 * set DB_DRIVER=neon for a Neon database behind another hostname.
 */
export function selectDriver(url: string | undefined, env: Record<string, string | undefined> = process.env): DbDriver {
  const forced = env.DB_DRIVER?.trim().toLowerCase()
  if (forced) {
    if (forced === 'neon' || forced === 'pg') return forced
    throw new Error(`DB_DRIVER must be "neon" or "pg" (got "${env.DB_DRIVER}").`)
  }
  let host = ''
  try {
    host = new URL((url ?? '').trim()).hostname.toLowerCase()
  } catch {
    return 'pg'
  }
  return host.endsWith('.neon.tech') ? 'neon' : 'pg'
}

/**
 * Rows of a raw `db.execute()` result, whatever the driver returned: node-postgres and neon give a
 * `{ rows }` result object; postgres-js style drivers give the array itself. Keep this the only place
 * that knows about the difference.
 */
export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  const rows = (res as { rows?: unknown } | null | undefined)?.rows
  return Array.isArray(rows) ? (rows as T[]) : []
}
