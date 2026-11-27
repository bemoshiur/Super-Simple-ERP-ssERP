import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { safeLog } from '@/server/errors'
import { ForbiddenError, can } from '@/server/rbac'
import { csvResponse, exportLimits, tooLargeResponse } from '@/server/reports/csvResponse'
import { reportByKey, reportFileName, reportToCsv, runReport } from '@/server/reports/registry'

export const dynamic = 'force-dynamic'

/** CSV export of a report. Re-authorises on every request (reports.view); companyId comes from the session only. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const session = await getSession()
  if (!session) return new Response('Please sign in.', { status: 401 })
  if (!can(session, 'reports.view')) return new Response('You do not have permission to export reports.', { status: 403 })
  const { key } = await ctx.params
  const def = reportByKey(key)
  if (!def) return new Response('Unknown report.', { status: 404 })
  const sp: Record<string, string> = Object.fromEntries(new URL(req.url).searchParams)
  try {
    // Same branch scope as the report page (restricted users: their branch; never a URL value).
    const { params, result } = await runReport(getDb(), session, (await branchScope(session)).filter, key, sp, { limit: exportLimits.reports })
    if (result.truncated) return tooLargeResponse('report', exportLimits.reports)
    return csvResponse(reportToCsv(result), reportFileName(key, params, def.filters.includes('range')))
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response('You do not have permission to export this report.', { status: 403 })
    safeLog('[reports csv] failed', e)
    return new Response('Could not build the export.', { status: 500 })
  }
}
