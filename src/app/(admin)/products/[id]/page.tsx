import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import HistoryButton from '@/components/ui/HistoryButton'
import LinkPager from '@/components/ui/LinkPager'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone, formatLocalDateTime, localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { listAdjustments } from '@/server/inventory/adjustments'
import { getProductProfile, listProductPurchases, listProductSales, listProductUnits, priceHistory, productStock, stockCard, stockCardHref } from '@/server/inventory/product'
import { ADJUST_REASON_LABEL } from '@/server/inventory/pure'
import { canSeeProfit } from '@/server/lookup/lookup'
import { linkAccess } from '@/server/lookup/links'
import { warrantyInfo } from '@/server/lookup/pure'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { STATUS_LABEL, UNIT_STATUSES, type UnitStatus } from '@/server/serials'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { Badge, Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import { z } from 'zod'
import { UNIT_TONE } from '../../purchases/UnitChip'
import AdjustStock from '../../stock/AdjustStock'

export const metadata: Metadata = { title: 'Product' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const TYPE_LABEL: Record<string, string> = { purchase: 'Purchase', sale: 'Sale', sale_return: 'Customer return', purchase_return: 'Return to vendor', adjustment: 'Adjustment', transfer: 'Branch transfer' }
const FIELD_LABEL = { purchasePrice: 'Purchase price', salePrice: 'Sale price' } as const

type Tab = 'serials' | 'card' | 'adjustments' | 'purchases' | 'sales'

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.view')) return (<><PageBreadcrumb title="Product" subtitle="Inventory" /><NoAccess /></>)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const db = getDb()
  let p
  try {
    p = await getProductProfile(db, session.cid, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const withCost = canSeeProfit(session)
  const links = linkAccess(session)
  const canAdjust = can(session, 'products.edit')
  const tz = appTimezone()
  const today = localDate(tz)
  const tabs: { key: Tab; label: string; allowed: boolean }[] = [
    { key: 'serials', label: 'Serials', allowed: p.trackSerial },
    { key: 'card', label: 'Stock card', allowed: !p.trackSerial },
    { key: 'adjustments', label: 'Adjustments', allowed: true },
    { key: 'purchases', label: 'Purchases', allowed: true },
    { key: 'sales', label: 'Sales', allowed: true },
  ]
  const rawTab = one(sp.tab) as Tab | undefined
  const tab: Tab = tabs.find((t) => t.key === rawTab && t.allowed)?.key ?? (p.trackSerial ? 'serials' : 'card')
  const { page, pageSize, offset } = parseListParams(sp)
  const rawStatus = one(sp.status)
  const status = (UNIT_STATUSES as readonly string[]).includes(rawStatus ?? '') ? (rawStatus as UnitStatus) : undefined

  const b = await branchScope(session)
  const [stock, allPrices] = await Promise.all([productStock(db, session.cid, b.filter, id), priceHistory(db, session.cid, id)])
  // Purchase price is cost data: like /stock, only profit-visibility holders see it (profile and price history).
  const prices = allPrices.map((h) => ({ ...h, changes: h.changes.filter((c) => withCost || c.field !== 'purchasePrice') })).filter((h) => h.changes.length > 0)
  const path = `/products/${id}`
  const tabHref = (t: Tab) => `${path}?tab=${t}`

  let body: ReactNode = null
  if (tab === 'serials') {
    const units = await listProductUnits(db, session.cid, b.filter, id, { status, limit: pageSize, offset, withCost })
    const allCount = Object.values(units.byStatus).reduce((a, n) => a + (n ?? 0), 0)
    const showCustomer = links.customers || links.sales
    // Vendor names / purchase invoice numbers are shown (not just unlinked) only to viewers who may see vendors / purchases.
    const showSupply = links.vendors || links.purchases
    body = (
      <>
        <div className="d-flex flex-wrap gap-1 mb-3">
          <Link href={tabHref('serials')} className={`btn btn-sm ${status ? 'btn-light' : 'btn-primary'}`}>
            All <Badge bg="light" text="dark" className="ms-1">{allCount}</Badge>
          </Link>
          {UNIT_STATUSES.map((st) => (
            <Link key={st} href={`${tabHref('serials')}&status=${st}`} className={`btn btn-sm ${status === st ? 'btn-primary' : 'btn-light'}`}>
              {STATUS_LABEL[st]} <Badge bg={`${UNIT_TONE[st]}-subtle`} text={UNIT_TONE[st]} className="ms-1">{units.byStatus[st] ?? 0}</Badge>
            </Link>
          ))}
        </div>
        {units.rows.length === 0 ? (
          <EmptyState icon="scan-barcode" title="No units" description={status ? `No units are ${STATUS_LABEL[status].toLowerCase()}.` : 'Units appear here when this product is purchased.'} className="py-3" />
        ) : (
          <Table size="sm" responsive className="align-middle mb-0">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Status</th>
                {showSupply && <th>{links.vendors && links.purchases ? 'Vendor / purchase' : links.vendors ? 'Vendor' : 'Purchase'}</th>}
                {withCost && <th className="text-end">Net cost</th>}
                {showCustomer && <th>Customer / sale</th>}
                <th>Warranty</th>
              </tr>
            </thead>
            <tbody>
              {units.rows.map((u) => {
                const w = u.status === 'sold' || u.status === 'in_service' ? warrantyInfo(u.warrantyEnd, today) : null
                return (
                  <tr key={u.id}>
                    <td className="font-monospace">{links.serials ? <Link href={`/serials/${u.id}`}>{u.serialNo}</Link> : u.serialNo}</td>
                    <td>
                      <Badge bg={`${UNIT_TONE[u.status]}-subtle`} text={UNIT_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>
                    </td>
                    {showSupply && (
                      <td className="small">
                        {links.vendors ? u.vendorName && u.vendorId ? <Link href={`/vendors/${u.vendorId}`}>{u.vendorName}</Link> : '-' : null}
                        {links.purchases && u.purchaseInvoiceNo && (
                          <div className="text-muted">
                            <Link href={`/purchases/${u.purchaseId}`}>{u.purchaseInvoiceNo}</Link>
                          </div>
                        )}
                      </td>
                    )}
                    {withCost && (
                      <td className="text-end">
                        <MoneyText value={u.purchasePrice} />
                      </td>
                    )}
                    {showCustomer && (
                      <td className="small">
                        {u.saleId ? (
                          <>
                            {u.customerName ? links.customers && u.customerId ? <Link href={`/customers/${u.customerId}`}>{u.customerName}</Link> : u.customerName : 'Walk-in'}
                            <div className="text-muted">{links.sales ? <Link href={`/sales/${u.saleId}`}>{u.saleInvoiceNo}</Link> : u.saleInvoiceNo}</div>
                          </>
                        ) : (
                          '-'
                        )}
                      </td>
                    )}
                    <td className="small">
                      {w ? (
                        <>
                          {u.warrantyEnd ?? '-'}
                          <div>
                            <Badge bg={`${w.tone}-subtle`} text={w.tone}>{w.label}</Badge>
                          </div>
                        </>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
        <LinkPager path={path} sp={sp} total={units.total} page={page} pageSize={pageSize} itemsName="units" />
      </>
    )
  } else if (tab === 'card') {
    const card = await stockCard(db, session.cid, b.filter, id, { limit: pageSize, offset })
    body =
      card.rows.length === 0 ? (
        <EmptyState icon="list" title="No stock movements yet" className="py-3" />
      ) : (
        <>
          <Table size="sm" responsive className="align-middle mb-0">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Reference</th>
                <th className="text-end">Change</th>
                <th className="text-end">Balance</th>
              </tr>
            </thead>
            <tbody>
              {card.rows.map((r) => {
                const href = stockCardHref(r.doc, { ...links, transfers: true })
                return (
                  <tr key={r.id}>
                    <td className="text-nowrap small">{formatLocalDateTime(r.at, tz)}</td>
                    <td>
                      {TYPE_LABEL[r.type] ?? r.type}
                      {r.byName && <div className="small text-muted">by {r.byName}</div>}
                    </td>
                    <td className="small">
                      {r.doc && r.doc.kind !== 'adjustment' ? href ? <Link href={href}>{r.doc.label}</Link> : r.doc.label : null}
                      {r.type === 'adjustment' && r.note && <span style={{ overflowWrap: 'anywhere' }}>{r.note}</span>}
                    </td>
                    <td className={`text-end fw-semibold ${r.qtyChange < 0 ? 'text-danger' : 'text-success'}`}>{r.qtyChange > 0 ? `+${r.qtyChange}` : r.qtyChange}</td>
                    <td className="text-end">{r.balance}</td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
          <LinkPager path={path} sp={sp} total={card.total} page={page} pageSize={pageSize} itemsName="movements" />
        </>
      )
  } else if (tab === 'adjustments') {
    const adj = await listAdjustments(db, session.cid, b.filter, id, 100)
    body =
      adj.length === 0 ? (
        <EmptyState icon="sliders-horizontal" title="No adjustments" description="Manual corrections (damage, loss, found, counts) are listed here." className="py-3" />
      ) : (
        <Table size="sm" responsive className="align-middle mb-0">
          <thead>
            <tr>
              <th>Date</th>
              <th>Reason</th>
              <th>Unit / note</th>
              <th className="text-end">Change</th>
              {withCost && <th className="text-end">Value</th>}
            </tr>
          </thead>
          <tbody>
            {adj.map((x) => (
              <tr key={x.id}>
                <td className="small text-nowrap">
                  {formatLocalDateTime(x.createdAt, tz)}
                  {x.byName && <div className="text-muted">by {x.byName}</div>}
                </td>
                <td>{p.trackSerial && x.reason === 'loss' ? 'Lost' : ADJUST_REASON_LABEL[x.reason]}</td>
                <td className="small" style={{ overflowWrap: 'anywhere' }}>
                  {x.serialNo && <div className="font-monospace">{links.serials && x.unitId ? <Link href={`/serials/${x.unitId}`}>{x.serialNo}</Link> : x.serialNo}</div>}
                  {x.note}
                </td>
                <td className={`text-end fw-semibold ${x.qtyChange < 0 ? 'text-danger' : 'text-success'}`}>{x.qtyChange > 0 ? `+${x.qtyChange}` : x.qtyChange}</td>
                {withCost && (
                  <td className="text-end">
                    <MoneyText value={x.value} tone />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )
  } else if (tab === 'purchases') {
    if (!links.purchases) body = <NoAccess />
    else {
      const pr = await listProductPurchases(db, session.cid, b.filter, id, { limit: pageSize, offset })
      body =
        pr.rows.length === 0 ? (
          <EmptyState icon="shopping-cart" title="Not purchased yet" className="py-3" />
        ) : (
          <>
            <Table size="sm" responsive className="align-middle mb-0">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Vendor</th>
                  <th className="text-end">Qty</th>
                  {withCost && <th className="text-end">Net cost</th>}
                </tr>
              </thead>
              <tbody>
                {pr.rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/purchases/${r.id}`}>{r.invoiceNo}</Link></td>
                    <td className="text-nowrap">{r.date}</td>
                    <td>{links.vendors ? <Link href={`/vendors/${r.vendorId}`}>{r.vendorName}</Link> : r.vendorName}</td>
                    <td className="text-end">{r.qty}</td>
                    {withCost && (
                      <td className="text-end">
                        <MoneyText value={r.net} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
            <LinkPager path={path} sp={sp} total={pr.total} page={page} pageSize={pageSize} itemsName="invoices" />
          </>
        )
    }
  } else {
    if (!links.sales) body = <NoAccess />
    else {
      const sa = await listProductSales(db, session.cid, b.filter, id, { limit: pageSize, offset })
      body =
        sa.rows.length === 0 ? (
          <EmptyState icon="receipt" title="Not sold yet" className="py-3" />
        ) : (
          <>
            <Table size="sm" responsive className="align-middle mb-0">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th className="text-end">Qty</th>
                  <th className="text-end">Net revenue</th>
                </tr>
              </thead>
              <tbody>
                {sa.rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/sales/${r.id}`}>{r.invoiceNo}</Link></td>
                    <td className="text-nowrap">{r.date}</td>
                    <td>{r.customerId ? links.customers ? <Link href={`/customers/${r.customerId}`}>{r.customerName}</Link> : r.customerName : <span className="text-muted">Walk-in</span>}</td>
                    <td className="text-end">{r.qty}</td>
                    <td className="text-end">
                      <MoneyText value={r.net} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <LinkPager path={path} sp={sp} total={sa.total} page={page} pageSize={pageSize} itemsName="invoices" />
          </>
        )
    }
  }

  const onHand = stock?.onHand ?? 0
  return (
    <>
      <PageBreadcrumb title={p.name} subtitle="Inventory" />
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h4 className="mb-1">
            {p.name}{' '}
            {p.trackSerial ? <Badge bg="info-subtle" text="info">Serial</Badge> : <Badge bg="secondary-subtle" text="secondary">Quantity</Badge>}{' '}
            {p.active ? <Badge bg="success-subtle" text="success">Active</Badge> : <Badge bg="secondary-subtle" text="secondary">Inactive</Badge>}
          </h4>
          <div className="text-muted">
            {p.sku} · <Link href="/stock">All stock</Link>
          </div>
        </div>
        <div className="d-flex flex-wrap gap-2">
          {canAdjust && <AdjustStock target={{ productId: p.id, name: p.name, trackSerial: p.trackSerial, onHand }} label="Adjust stock" />}
          <HistoryButton entity="product" id={p.id} title={p.name} />
        </div>
      </div>

      <Row>
        <Col lg={4}>
          <Card>
            <CardBody>
              <h5 className="mb-3">Profile</h5>
              <dl className="row mb-0 small">
                <dt className="col-6 fw-normal text-muted">Category</dt>
                <dd className="col-6 text-end">{p.categoryName ?? '-'}</dd>
                <dt className="col-6 fw-normal text-muted">Brand</dt>
                <dd className="col-6 text-end">{p.brandName ?? '-'}</dd>
                {withCost && (
                  <>
                    <dt className="col-6 fw-normal text-muted">Purchase price</dt>
                    <dd className="col-6 text-end"><MoneyText value={p.purchasePrice} /></dd>
                  </>
                )}
                <dt className="col-6 fw-normal text-muted">Sale price</dt>
                <dd className="col-6 text-end"><MoneyText value={p.salePrice} /></dd>
                <dt className="col-6 fw-normal text-muted">Warranty</dt>
                <dd className="col-6 text-end">{p.warrantyMonths ? `${p.warrantyMonths} months` : 'None'}</dd>
                <dt className="col-6 fw-normal text-muted">Low-stock alert at</dt>
                <dd className="col-6 text-end">{p.lowStockThreshold || 'Off'}</dd>
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col lg={4}>
          <Card>
            <CardBody>
              <h5 className="mb-3">Stock</h5>
              <dl className="row mb-0 small">
                <dt className="col-7 fw-normal text-muted">On hand</dt>
                <dd className="col-5 text-end fw-semibold">
                  {onHand}
                  {stock?.low && <Badge bg="danger-subtle" text="danger" className="ms-1">Low</Badge>}
                </dd>
                {p.trackSerial && (
                  <>
                    <dt className="col-7 fw-normal text-muted">Sold</dt>
                    <dd className="col-5 text-end">{stock?.sold ?? 0}</dd>
                    <dt className="col-7 fw-normal text-muted">In service</dt>
                    <dd className="col-5 text-end">{stock?.inService ?? 0}</dd>
                    <dt className="col-7 fw-normal text-muted">Damaged</dt>
                    <dd className="col-5 text-end">{stock?.damaged ?? 0}</dd>
                    <dt className="col-7 fw-normal text-muted">Returned to vendor</dt>
                    <dd className="col-5 text-end">{stock?.returned ?? 0}</dd>
                  </>
                )}
                {withCost && (
                  <>
                    <dt className="col-7 fw-normal text-muted">Avg net unit cost</dt>
                    <dd className="col-5 text-end"><MoneyText value={stock?.unitCost ?? '0.00'} /></dd>
                    <dt className="col-7 fw-normal text-muted">Stock value</dt>
                    <dd className="col-5 text-end fw-semibold"><MoneyText value={stock?.value ?? '0.00'} /></dd>
                  </>
                )}
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col lg={4}>
          <Card>
            <CardBody>
              <h5 className="mb-3">Price history</h5>
              {prices.length === 0 ? (
                <p className="text-muted small mb-0">No price changes recorded.</p>
              ) : (
                <ul className="list-unstyled small mb-0" style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {prices.map((h, i) => (
                    <li key={i} className="mb-2">
                      <div className="text-muted">
                        {formatLocalDateTime(h.at, tz)}
                        {h.byName ? ` · ${h.byName}` : ''}
                      </div>
                      {h.changes.map((c) => (
                        <div key={c.field}>
                          {FIELD_LABEL[c.field]}: <MoneyText value={c.from} /> → <MoneyText value={c.to} className="fw-semibold" />
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </Col>
      </Row>

      <Card>
        <CardBody>
          <ul className="nav nav-tabs mb-3">
            {tabs
              .filter((t) => t.allowed)
              .map((t) => (
                <li key={t.key} className="nav-item">
                  <Link href={tabHref(t.key)} className={`nav-link${t.key === tab ? ' active' : ''}`} aria-current={t.key === tab ? 'page' : undefined}>
                    {t.label}
                  </Link>
                </li>
              ))}
          </ul>
          {body}
        </CardBody>
      </Card>
    </>
  )
}
