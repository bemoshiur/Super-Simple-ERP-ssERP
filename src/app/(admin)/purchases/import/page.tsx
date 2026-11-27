import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { appTimezone } from '@/server/dashboard'
import { localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { MAX_IMPORT_ROWS } from '@/server/purchases/importCsv'
import { listActiveAccounts } from '@/server/purchases/purchases'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import ImportForm from './ImportForm'

/** Server actions of this page (the import / purchase save) may take a while for thousands of serials: allow up to 60 s on serverless hosts. */
export const maxDuration = 60

export const metadata: Metadata = { title: 'Import serials' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'purchases.create')) return (<><PageBreadcrumb title="Import serials" subtitle="Purchases" /><NoAccess /></>)
  const accounts = await listActiveAccounts(getDb(), session.cid)
  return (
    <>
      <PageBreadcrumb title="Import serials (CSV)" subtitle="Purchases" />
      <ImportForm accounts={accounts} today={localDate(appTimezone())} maxRows={MAX_IMPORT_ROWS} canPrintLabels={can(session, 'serials.view')} />
    </>
  )
}
