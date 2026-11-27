import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { listBranchesAdmin } from '@/server/branches/branches'
import { getDb } from '@/server/db'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import BranchList from './BranchList'

export const metadata: Metadata = { title: 'Branches' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'settings.view')) return (<><PageBreadcrumb title="Branches" subtitle="Settings" /><NoAccess /></>)
  const rows = await listBranchesAdmin(getDb(), session.cid)
  return (
    <>
      <PageBreadcrumb title="Branches" subtitle="Settings" />
      <p className="text-muted">
        Every sale, purchase, payment and stock movement belongs to one branch. With a single branch nothing changes for you. Add a second branch to get the branch selector in the top bar,
        per-branch stock and reports, and <Link href="/stock/transfers">stock transfers</Link>. Users are assigned a branch on the <Link href="/users">Users</Link> page; only roles with
        &quot;All branches&quot; can switch branches.
      </p>
      <Card>
        <CardBody>
          <BranchList
            rows={rows.map((r) => ({ id: r.id, name: r.name, code: r.code, address: r.address, phone: r.phone, isDefault: r.isDefault, active: r.active, users: r.users, unitsInStock: r.unitsInStock }))}
            can={{ edit: can(session, 'settings.edit'), delete: can(session, 'settings.delete') }}
          />
        </CardBody>
      </Card>
    </>
  )
}
