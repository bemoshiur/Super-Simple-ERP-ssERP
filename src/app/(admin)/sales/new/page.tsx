import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { appTimezone } from '@/server/dashboard'
import { localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { listActiveAccounts } from '@/server/purchases/purchases'
import { can } from '@/server/rbac'
import { PROFIT_PERMISSIONS } from '@/server/sales/sales'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import SaleForm from './SaleForm'

export const metadata: Metadata = { title: 'New sale' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'sales.create')) return (<><PageBreadcrumb title="New sale" subtitle="Sales" /><NoAccess /></>)
  const accounts = await listActiveAccounts(getDb(), session.cid)
  return (
    <>
      <PageBreadcrumb title="New sale" subtitle="Sales" />
      <SaleForm accounts={accounts} today={localDate(appTimezone())} showProfit={PROFIT_PERMISSIONS.some((k) => can(session, k))} />
    </>
  )
}
