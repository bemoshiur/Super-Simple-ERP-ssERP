import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb, schema } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { dateField } from '@/server/purchases/schemas'
import { can } from '@/server/rbac'
import { listSales } from '@/server/sales/sales'
import { and, eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import { z } from 'zod'
import SalesList from './SalesList'

export const metadata: Metadata = { title: 'Sales' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'sales.view')) return (<><PageBreadcrumb title="Sales" subtitle="Business" /><NoAccess /></>)

  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const customerId = z.uuid().safeParse(one(sp.customer)).data
  const from = dateField.safeParse(one(sp.from)).data
  const to = dateField.safeParse(one(sp.to)).data
  const dueOnly = one(sp.due) === '1'
  const rawStatus = one(sp.status)
  const status = rawStatus === 'unpaid' || rawStatus === 'partially_paid' || rawStatus === 'paid' || rawStatus === 'returned' ? rawStatus : undefined

  const db = getDb()
  const b = await branchScope(session)
  const [{ rows, total, sums }, customer] = await Promise.all([
    listSales(db, session.cid, b.filter, { q, customerId, from, to, dueOnly, status, limit: pageSize, offset }),
    customerId ? db.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(and(eq(schema.customers.id, customerId), eq(schema.customers.companyId, session.cid))) : [],
  ])

  return (
    <>
      <PageBreadcrumb title="Sales" subtitle="Business" />
      <Card>
        <CardBody>
          <SalesList
            showBranch={b.multi && b.filter === null}
            rows={rows}
            total={total}
            sums={sums}
            page={page}
            pageSize={pageSize}
            q={q}
            filters={{ customer: customer[0] ? { value: customer[0].id, label: customer[0].name } : null, from: from ?? '', to: to ?? '', dueOnly, status: status ?? '' }}
            canCreate={can(session, 'sales.create')}
          />
        </CardBody>
      </Card>
    </>
  )
}
