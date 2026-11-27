import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { listServiceTickets } from '@/server/service/tickets'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import ServiceList from './ServiceList'

export const metadata: Metadata = { title: 'Service' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'serials.view')) return (<><PageBreadcrumb title="Service" subtitle="Business" /><NoAccess /></>)
  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const rawStatus = Array.isArray(sp.status) ? sp.status[0] : sp.status
  const status = ['active', 'open', 'in_progress', 'resolved', 'closed', 'rejected'].includes(rawStatus ?? '') ? (rawStatus as string) : ''
  const { rows, total, counts } = await listServiceTickets(getDb(), session.cid, (await branchScope(session)).filter, { q, status, limit: pageSize, offset })
  return (
    <>
      <PageBreadcrumb title="Service" subtitle="Business" />
      <Card>
        <CardBody>
          <ServiceList canCustomers={can(session, 'customers.view')} rows={rows.map((r) => ({ ...r, openedAt: r.openedAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null }))} total={total} page={page} pageSize={pageSize} q={q} status={status} counts={counts} />
        </CardBody>
      </Card>
    </>
  )
}
