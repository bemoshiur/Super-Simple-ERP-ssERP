import { PAYMENT_CSV_COLUMNS, listPayments, parsePaymentFilter, paymentCsvRows } from '@/server/accounting/payments'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { safeLog } from '@/server/errors'
import { can } from '@/server/rbac'
import { toCsv } from '@/server/reports/csv'
import { csvResponse, exportLimits, tooLargeResponse } from '@/server/reports/csvResponse'

export const dynamic = 'force-dynamic'

/** CSV export of the payments history with the same filters as the page (accounts.view). */
export async function GET(req: Request) {
  const session = await getSession()
  if (!session) return new Response('Please sign in.', { status: 401 })
  if (!can(session, 'accounts.view')) return new Response('You do not have permission to export payments.', { status: 403 })
  const sp: Record<string, string> = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const cap = exportLimits.payments
    const { rows } = await listPayments(getDb(), session.cid, (await branchScope(session)).filter, { ...parsePaymentFilter(sp), limit: cap + 1, offset: 0 })
    if (rows.length > cap) return tooLargeResponse('payments export', cap)
    return csvResponse(toCsv([...PAYMENT_CSV_COLUMNS], paymentCsvRows(rows)), 'payments.csv')
  } catch (e) {
    safeLog('[payments csv] failed', e)
    return new Response('Could not build the export.', { status: 500 })
  }
}
