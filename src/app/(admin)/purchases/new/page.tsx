import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { appTimezone } from '@/server/dashboard'
import { localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { listActiveAccounts } from '@/server/purchases/purchases'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import PurchaseForm from './PurchaseForm'

/** Server actions of this page (the import / purchase save) may take a while for thousands of serials: allow up to 60 s on serverless hosts. */
export const maxDuration = 60

export const metadata: Metadata = { title: 'New purchase' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'purchases.create')) return (<><PageBreadcrumb title="New purchase" subtitle="Purchases" /><NoAccess /></>)
  const accounts = await listActiveAccounts(getDb(), session.cid)
  return (
    <>
      <PageBreadcrumb title="New purchase" subtitle="Purchases" />
      <PurchaseForm accounts={accounts} today={localDate(appTimezone())} />
    </>
  )
}
