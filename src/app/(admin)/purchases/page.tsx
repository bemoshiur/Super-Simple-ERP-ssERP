import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb, schema } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { listPurchases } from '@/server/purchases/purchases'
import { dateField } from '@/server/purchases/schemas'
import { can } from '@/server/rbac'
import { and, eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import { z } from 'zod'
import PurchaseList from './PurchaseList'

export const metadata: Metadata = { title: 'Purchases' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'purchases.view')) return (<><PageBreadcrumb title="Purchases" subtitle="Business" /><NoAccess /></>)

  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const vendorId = z.uuid().safeParse(one(sp.vendor)).data
  const from = dateField.safeParse(one(sp.from)).data
  const to = dateField.safeParse(one(sp.to)).data
  const dueOnly = one(sp.due) === '1'
  const rawStatus = one(sp.status)
  const status = rawStatus === 'unpaid' || rawStatus === 'partially_paid' || rawStatus === 'paid' || rawStatus === 'returned' ? rawStatus : undefined

  const db = getDb()
  const b = await branchScope(session)
  const [{ rows, total }, vendor] = await Promise.all([
    listPurchases(db, session.cid, b.filter, { q, vendorId, from, to, dueOnly, status, limit: pageSize, offset }),
    vendorId ? db.select({ id: schema.vendors.id, name: schema.vendors.name }).from(schema.vendors).where(and(eq(schema.vendors.id, vendorId), eq(schema.vendors.companyId, session.cid))) : [],
  ])

  return (
    <>
      <PageBreadcrumb title="Purchases" subtitle="Business" />
      <Card>
        <CardBody>
          <PurchaseList
            showBranch={b.multi && b.filter === null}
            rows={rows}
            total={total}
            page={page}
            pageSize={pageSize}
            q={q}
            filters={{ vendor: vendor[0] ? { value: vendor[0].id, label: vendor[0].name } : null, from: from ?? '', to: to ?? '', dueOnly, status: status ?? '' }}
            canCreate={can(session, 'purchases.create')}
          />
        </CardBody>
      </Card>
    </>
  )
}
