import { NextResponse } from 'next/server'
import { createDbHealth } from '@/server/health'
import { migrationsStatus } from '@/server/migrations-status'

// Public liveness probe (allow-listed in src/server/auth/public-paths.ts). Never reveals configuration or errors.
export const dynamic = 'force-dynamic'

// Reuses the app's connection pool; result cached ~5s and shared by concurrent callers.
const dbIsUp = createDbHealth(async () => {
  const { getDb } = await import('@/server/db')
  const { sql } = await import('drizzle-orm')
  await getDb().execute(sql`select 1`)
})

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' }
  if (new URL(request.url).searchParams.get('db') !== '1') return NextResponse.json({ status: 'ok' }, { headers })
  if (!(await dbIsUp())) return NextResponse.json({ status: 'degraded', db: 'down' }, { status: 503, headers })
  // Cached 60s; only 'ok' | 'pending' is reported (never which migrations). Omitted when it cannot be determined.
  const m = await migrationsStatus()
  return NextResponse.json({ status: 'ok', db: 'up', ...(m === 'unknown' ? {} : { migrations: m }) }, { headers })
}
