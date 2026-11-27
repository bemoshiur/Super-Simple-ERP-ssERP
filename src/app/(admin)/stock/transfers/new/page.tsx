import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone, localDate } from '@/server/dates'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, Card, CardBody } from 'react-bootstrap'
import TransferForm from './TransferForm'

export const metadata: Metadata = { title: 'New transfer' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.edit')) return (<><PageBreadcrumb title="New transfer" subtitle="Inventory" /><NoAccess /></>)
  const b = await branchScope(session)
  if (!b.multi)
    return (
      <>
        <PageBreadcrumb title="New transfer" subtitle="Inventory" />
        <Alert variant="info">There is only one branch. Add another under <Link href="/settings/branches">Settings, Branches</Link> to transfer stock.</Alert>
      </>
    )
  // A user without branches.all can only send stock out of its own branch (source locked); the server checks it again.
  return (
    <>
      <PageBreadcrumb title="New transfer" subtitle="Inventory" />
      <Card>
        <CardBody>
          <TransferForm branches={b.branches.map((x) => ({ id: x.id, name: x.name, code: x.code }))} defaultFrom={b.restrict ?? b.active ?? b.home} restrictedTo={b.restrict} today={localDate(appTimezone())} />
        </CardBody>
      </Card>
    </>
  )
}
