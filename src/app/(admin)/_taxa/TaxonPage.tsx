import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { listTaxa, productCounts, type TaxonKind } from '@/server/catalog/taxonomy'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import TaxonList from './TaxonList'

/** Shared server page for /categories and /brands (both are gated by the products permissions). */
export default async function TaxonPage({ kind, sp }: { kind: TaxonKind; sp: RawSearchParams }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  const title = kind === 'category' ? 'Categories' : 'Brands'
  if (!can(session, 'products.view')) return (<><PageBreadcrumb title={title} subtitle="Inventory" /><NoAccess /></>)

  const { q, page, pageSize, offset } = parseListParams(sp)
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status
  const status = raw === 'inactive' || raw === 'all' ? raw : 'active'
  const db = getDb()
  const { rows, total } = await listTaxa(db, session.cid, kind, { q, status, limit: pageSize, offset })
  const counts = await productCounts(db, session.cid, kind, rows.map((r) => r.id))

  return (
    <>
      <PageBreadcrumb title={title} subtitle="Inventory" />
      <Card>
        <CardBody>
          <TaxonList
            kind={kind}
            rows={rows.map((r) => ({ id: r.id, name: r.name, active: r.active, products: counts[r.id] ?? 0 }))}
            total={total}
            page={page}
            pageSize={pageSize}
            q={q}
            status={status}
            can={{ create: can(session, 'products.create'), edit: can(session, 'products.edit'), delete: can(session, 'products.delete') }}
          />
        </CardBody>
      </Card>
    </>
  )
}
