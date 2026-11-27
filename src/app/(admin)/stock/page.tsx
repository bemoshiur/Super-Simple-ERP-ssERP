import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import LinkPager from '@/components/ui/LinkPager'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import Icon from '@/components/wrappers/Icon'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb, schema } from '@/server/db'
import { canSeeProfit } from '@/server/lookup/lookup'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { countStockRows, stockRows, stockSummary, type StockFilter } from '@/server/reports/stock'
import { and, eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Badge, Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import { z } from 'zod'
import KpiCard from '../dashboard/components/KpiCard'
import AdjustStock from './AdjustStock'
import StockFilters from './StockFilters'

export const metadata: Metadata = { title: 'Stock' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.view')) return (<><PageBreadcrumb title="Stock" subtitle="Inventory" /><NoAccess /></>)

  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const categoryId = z.uuid().safeParse(one(sp.category)).data
  const brandId = z.uuid().safeParse(one(sp.brand)).data
  const low = one(sp.low) === '1'
  const rawType = one(sp.type)
  const tracking = rawType === 'serial' || rawType === 'plain' ? rawType : undefined
  const filter: StockFilter = { q: q || undefined, categoryId, brandId, lowOnly: low, tracking }
  const withCost = canSeeProfit(session)
  const canAdjust = can(session, 'products.edit')

  const db = getDb()
  const b = await branchScope(session)
  const [{ rows }, total, summary, category, brand] = await Promise.all([
    stockRows({ db, companyId: session.cid, branch: b.filter, limit: pageSize }, { ...filter, offset }),
    countStockRows(db, session.cid, b.filter, filter),
    stockSummary(db, session.cid, b.filter, filter),
    categoryId ? db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).where(and(eq(schema.categories.id, categoryId), eq(schema.categories.companyId, session.cid))) : [],
    brandId ? db.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(and(eq(schema.brands.id, brandId), eq(schema.brands.companyId, session.cid))) : [],
  ])
  const dash = <span className="text-muted">-</span>
  const filtered = !!(q || categoryId || brandId || low || tracking)

  return (
    <>
      <PageBreadcrumb title="Stock" subtitle="Inventory" />
      <Row className="g-3 mb-3">
        <Col md={withCost ? 3 : 4} sm={6}>
          <KpiCard icon="boxes" tone="primary" label="Units on hand" value={summary.units.toLocaleString('en-IN')} hint={`${summary.products} product${summary.products === 1 ? '' : 's'}${filtered ? ' (filtered)' : ''}`} />
        </Col>
        {withCost && (
          <Col md={3} sm={6}>
            <KpiCard icon="package" tone="success" label="Stock value" value={<MoneyText value={summary.value} />} hint="at net cost" />
          </Col>
        )}
        <Col md={withCost ? 3 : 4} sm={6}>
          <Link href="/stock?low=1" className="text-reset text-decoration-none">
            <KpiCard icon="triangle-alert" tone={summary.lowCount > 0 ? 'danger' : 'secondary'} label="Low stock" value={String(summary.lowCount)} hint="at or below threshold" />
          </Link>
        </Col>
        {canAdjust && (
          <Col md={withCost ? 3 : 4} sm={6} className="d-flex align-items-center justify-content-md-end">
            <Link href="/stock/count" className="btn btn-tonal-primary">
              <Icon icon="clipboard-check" className="me-1" /> Stock count
            </Link>
          </Col>
        )}
      </Row>
      <Card>
        <CardBody>
          <StockFilters q={q} category={category[0] ? { value: category[0].id, label: category[0].name } : null} brand={brand[0] ? { value: brand[0].id, label: brand[0].name } : null} low={low} type={tracking ?? ''} />
          {rows.length === 0 ? (
            <EmptyState icon="package" title={filtered ? 'No products match these filters' : 'No stock yet'} description={filtered ? 'Change or reset the filters.' : 'Stock appears here once purchases are recorded.'} />
          ) : (
            <div className="table-responsive">
              <Table className="align-middle mb-0" hover>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Category / brand</th>
                    <th className="text-end">On hand</th>
                    <th className="text-end">Sold</th>
                    <th className="text-end">In service</th>
                    <th className="text-end">Damaged</th>
                    <th className="text-end">Returned</th>
                    {withCost && <th className="text-end">Avg unit cost</th>}
                    {withCost && <th className="text-end">Value</th>}
                    {canAdjust && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/products/${r.id}`} className="fw-semibold">
                          {r.name}
                        </Link>
                        <div className="small text-muted">
                          {r.sku}
                          {r.trackSerial ? (
                            <Badge bg="info-subtle" text="info" className="ms-2">Serial</Badge>
                          ) : (
                            <Badge bg="secondary-subtle" text="secondary" className="ms-2">Quantity</Badge>
                          )}
                          {!r.active && <Badge bg="secondary-subtle" text="secondary" className="ms-1">Inactive</Badge>}
                        </div>
                      </td>
                      <td className="small">
                        {r.category ?? '-'}
                        <div className="text-muted">{r.brand ?? ''}</div>
                      </td>
                      <td className="text-end text-nowrap">
                        {r.low && <Badge bg="danger-subtle" text="danger" className="me-1" title={`Threshold ${r.threshold}`}>Low</Badge>}
                        {r.trackSerial ? (
                          <Link href={`/products/${r.id}?tab=serials&status=in_stock`} className="fw-semibold">
                            {r.onHand}
                          </Link>
                        ) : (
                          <span className="fw-semibold">{r.onHand}</span>
                        )}
                      </td>
                      {(['sold', 'in_service', 'damaged', 'returned_to_vendor'] as const).map((st) => {
                        const n = st === 'sold' ? r.sold : st === 'in_service' ? r.inService : st === 'damaged' ? r.damaged : r.returned
                        return (
                          <td key={st} className="text-end">
                            {r.trackSerial ? n > 0 ? <Link href={`/products/${r.id}?tab=serials&status=${st}`}>{n}</Link> : <span className="text-muted">0</span> : dash}
                          </td>
                        )
                      })}
                      {withCost && (
                        <td className="text-end">
                          <MoneyText value={r.unitCost} />
                        </td>
                      )}
                      {withCost && (
                        <td className="text-end fw-semibold">
                          <MoneyText value={r.value} />
                        </td>
                      )}
                      {canAdjust && (
                        <td className="text-end">
                          <AdjustStock size="sm" target={{ productId: r.id, name: r.name, trackSerial: r.trackSerial, onHand: r.onHand }} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <LinkPager path="/stock" sp={sp} total={total} page={page} pageSize={pageSize} itemsName="products" />
        </CardBody>
      </Card>
    </>
  )
}
