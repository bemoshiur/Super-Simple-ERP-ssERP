import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { dateField } from '@/server/purchases/schemas'
import { can } from '@/server/rbac'
import { listSaleReturns } from '@/server/sales/sales'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import ReturnList from './ReturnList'

export const metadata: Metadata = { title: 'Sales returns' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'sales.view')) return (<><PageBreadcrumb title="Returns" subtitle="Sales" /><NoAccess /></>)
  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const from = dateField.safeParse(one(sp.from)).data
  const to = dateField.safeParse(one(sp.to)).data
  const { rows, total, sums } = await listSaleReturns(getDb(), session.cid, (await branchScope(session)).filter, { q, from, to, limit: pageSize, offset })
  return (
    <>
      <PageBreadcrumb title="Returns" subtitle="Sales" />
      <Card>
        <CardBody>
          <ReturnList rows={rows} total={total} sums={sums} page={page} pageSize={pageSize} q={q} from={from ?? ''} to={to ?? ''} />
        </CardBody>
      </Card>
    </>
  )
}
