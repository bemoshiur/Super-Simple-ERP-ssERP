import { getSession } from '@/server/auth/current'
import { branchScope, requireWriteBranch } from '@/server/branch'
import { getDb } from '@/server/db'
import { FieldErrors, PolicyError, safeLog } from '@/server/errors'
import { COUNT_CSV_COLUMNS, computeCountDiff, countDiffCsvRows } from '@/server/inventory/count'
import { can } from '@/server/rbac'
import { toCsv } from '@/server/reports/csv'
import { csvResponse, readCapped } from '@/server/reports/csvResponse'

export const dynamic = 'force-dynamic'

const MAX_BODY = 1_000_000

/**
 * Stock-count difference report as CSV. The count sheet is POSTed (application/x-www-form-urlencoded) as a form field `payload` (JSON, same shape as
 * countDiffAction). Re-authorizes (products.edit) and recomputes the diff against the system now; the CSV goes through
 * toCsv (BOM, quoting, formula-injection protection).
 */
export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return new Response('Please sign in.', { status: 401 })
  if (!can(session, 'products.edit')) return new Response('You do not have permission to export stock counts.', { status: 403 })
  // Read the body with a hard cap (content-length is not trusted; chunked bodies have none).
  const body = await readCapped(req, MAX_BODY)
  if (body === null) return new Response('This count is too large to export.', { status: 413 })
  let payload: unknown
  try {
    const raw = new URLSearchParams(body).get('payload')
    if (!raw) return new Response('Missing count data.', { status: 400 })
    payload = JSON.parse(raw)
  } catch {
    return new Response('Invalid count data.', { status: 400 })
  }
  try {
    const diff = await computeCountDiff(getDb(), session.cid, requireWriteBranch(await branchScope(session)), payload)
    return csvResponse(toCsv([...COUNT_CSV_COLUMNS], countDiffCsvRows(diff)), 'stock-count.csv')
  } catch (e) {
    if (e instanceof FieldErrors) return new Response(e.message || 'Invalid count data.', { status: 400 })
    if (e instanceof PolicyError) return new Response(e.message, { status: 400 })
    safeLog('[stock count csv] failed', e)
    return new Response('Could not build the export.', { status: 500 })
  }
}

