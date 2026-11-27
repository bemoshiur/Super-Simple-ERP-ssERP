import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { listParties, type PartyKind } from '@/server/parties/parties'
import { can } from '@/server/rbac'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import PartyList from './PartyList'

/** Shared server page for /vendors and /customers. */
export default async function PartyPage({ kind, sp }: { kind: PartyKind; sp: RawSearchParams }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  const mod = kind === 'vendor' ? 'vendors' : 'customers'
  const title = kind === 'vendor' ? 'Vendors' : 'Customers'
  if (!can(session, `${mod}.view`)) return (<><PageBreadcrumb title={title} subtitle="Parties" /><NoAccess /></>)

  const { q, page, pageSize, offset } = parseListParams(sp)
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status
  const status = raw === 'inactive' || raw === 'all' ? raw : 'active'
  const { rows, total } = await listParties(getDb(), session.cid, kind, { q, status, limit: pageSize, offset })

  return (
    <>
      <PageBreadcrumb title={title} subtitle="Parties" />
      <Card>
        <CardBody>
          <PartyList
            kind={kind}
            rows={rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address, openingBalance: r.openingBalance, notes: r.notes, active: r.active }))}
            total={total}
            page={page}
            pageSize={pageSize}
            q={q}
            status={status}
            can={{ create: can(session, `${mod}.create`), edit: can(session, `${mod}.edit`), delete: can(session, `${mod}.delete`) }}
          />
        </CardBody>
      </Card>
    </>
  )
}
