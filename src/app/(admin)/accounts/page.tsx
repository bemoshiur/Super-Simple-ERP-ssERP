import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { listAccountBalances, totalBalance } from '@/server/accounting/accounts'
import { getSession } from '@/server/auth/current'
import { getDb } from '@/server/db'
import type { RawSearchParams } from '@/server/pagination'
import { appTimezone, localDate } from '@/server/dates'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import AccountList from './AccountList'

export const metadata: Metadata = { title: 'Accounts' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'accounts.view')) return (<><PageBreadcrumb title="Accounts" subtitle="Finance" /><NoAccess /></>)
  const sp = await searchParams
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status
  const status = raw === 'inactive' || raw === 'all' ? raw : 'active'
  const rows = await listAccountBalances(getDb(), session.cid, { status })
  const activeRows = status === 'active' ? rows : await listAccountBalances(getDb(), session.cid, { status: 'active' })
  return (
    <>
      <PageBreadcrumb title="Accounts" subtitle="Finance" />
      <Card>
        <CardBody>
          <AccountList
            rows={rows}
            total={totalBalance(rows)}
            status={status}
            transferTargets={activeRows.map((a) => ({ value: a.id, label: a.name }))}
            today={localDate(appTimezone())}
            can={{ create: can(session, 'accounts.create'), edit: can(session, 'accounts.edit'), delete: can(session, 'accounts.delete') }}
          />
        </CardBody>
      </Card>
    </>
  )
}
