import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import LinkPager from '@/components/ui/LinkPager'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { listStockTransfers } from '@/server/inventory/transfers'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardBody, Table } from 'react-bootstrap'

export const metadata: Metadata = { title: 'Stock transfers' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.view')) return (<><PageBreadcrumb title="Transfers" subtitle="Inventory" /><NoAccess /></>)
  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const b = await branchScope(session)
  const { rows, total } = await listStockTransfers(getDb(), session.cid, b.filter, { q, limit: pageSize, offset })
  const canCreate = can(session, 'products.edit') && b.multi
  return (
    <>
      <PageBreadcrumb title="Transfers" subtitle="Inventory" />
      <Card>
        <CardBody>
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
            <form className="d-flex gap-2" role="search">
              <input name="q" defaultValue={q} className="form-control form-control-sm" placeholder="Transfer no. or note" aria-label="Search transfers" />
              <button className="btn btn-sm btn-light" type="submit">Search</button>
            </form>
            {canCreate && (
              <Link href="/stock/transfers/new" className="btn btn-primary btn-sm">
                New transfer
              </Link>
            )}
          </div>
          {!b.multi && <p className="text-muted small">Transfers move stock between branches. Add a second branch under Settings, Branches to use them.</p>}
          {rows.length === 0 ? (
            <EmptyState icon="arrow-left-right" title="No transfers yet" description="Moving serial units or quantities between branches creates a transfer here." />
          ) : (
            <div className="table-responsive">
              <Table hover className="align-middle mb-0">
                <thead>
                  <tr>
                    <th>Transfer</th>
                    <th>Date</th>
                    <th>From</th>
                    <th>To</th>
                    <th className="text-end">Units</th>
                    <th className="text-end">Quantity</th>
                    <th>By</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link href={`/stock/transfers/${r.id}`} className="fw-semibold">{r.transferNo}</Link></td>
                      <td className="text-nowrap">{r.date}</td>
                      <td>{r.fromName}</td>
                      <td>{r.toName}</td>
                      <td className="text-end">{r.units}</td>
                      <td className="text-end">{r.qty}</td>
                      <td>{r.createdByName ?? ''}</td>
                      <td className="small text-muted">{r.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <LinkPager path="/stock/transfers" sp={sp} total={total} page={page} pageSize={pageSize} itemsName="transfers" />
        </CardBody>
      </Card>
    </>
  )
}
