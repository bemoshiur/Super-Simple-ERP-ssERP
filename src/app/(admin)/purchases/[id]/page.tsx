import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone } from '@/server/dashboard'
import { localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { getPurchase, listActiveAccounts } from '@/server/purchases/purchases'
import { onHandQty } from '@/server/sales/sales'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import { z } from 'zod'
import PurchaseStatusBadge from '../StatusBadge'
import UnitChip from '../UnitChip'
import PurchaseActions from './PurchaseActions'

export const metadata: Metadata = { title: 'Purchase' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'purchases.view')) return (<><PageBreadcrumb title="Purchase" subtitle="Purchases" /><NoAccess /></>)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const b = await branchScope(session)
  let p
  try {
    p = await getPurchase(db, session.cid, b.restrict, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const canEdit = can(session, 'purchases.edit')
  const accounts = canEdit ? await listActiveAccounts(db, session.cid) : []
  // Returns leave from the ACTIVE branch: only units located there are offered.
  const returnable = p.items.flatMap((it) => it.units.filter((u) => u.status === 'in_stock' && u.branchId === b.active).map((u) => ({ id: u.id, serialNo: u.serialNo, productName: it.productName, purchasePrice: u.purchasePrice })))
  const plainItems = p.items.filter((it) => !it.trackSerial && it.qty - it.returnedQty > 0)
  const onHand = canEdit && plainItems.length ? await onHandQty(db, session.cid, b.active ?? b.home, plainItems.map((it) => it.productId)) : new Map<string, number>()
  const returnableLines = plainItems.map((it) => ({ id: it.id, productName: it.productName, qty: it.qty, returnedQty: it.returnedQty, netTotal: it.netTotal, onHand: onHand.get(it.productId) ?? 0 }))

  return (
    <>
      <PageBreadcrumb title={p.invoiceNo} subtitle="Purchases" />
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h4 className="mb-1">
            {p.invoiceNo} <PurchaseStatusBadge p={p} />
          </h4>
          <div className="text-muted">
            <Link href={`/vendors/${p.vendorId}`}>{p.vendorName}</Link> · {p.date}
            {p.createdByName && <> · recorded by {p.createdByName}</>}
          </div>
          {p.note && <div className="text-muted small mt-1" style={{ overflowWrap: 'anywhere' }}>{p.note}</div>}
          {can(session, 'serials.view') && p.items.some((it) => it.trackSerial) && (
            <a href={`/serials/labels?purchase=${p.id}`} className="btn btn-tonal-secondary btn-sm mt-2" target="_blank" rel="noopener">
              Print labels
            </a>
          )}
        </div>
        <PurchaseActions purchaseId={p.id} invoiceNo={p.invoiceNo} total={p.total} paid={p.paid} due={p.due} returnedTotal={p.returnedTotal} accounts={accounts} today={localDate(appTimezone())} returnable={returnable} returnableLines={returnableLines} canEdit={canEdit} />
      </div>

      <Row>
        <Col lg={8}>
          <Card>
            <CardBody>
              <h5 className="mb-3">Items</h5>
              <div className="table-responsive">
                <Table className="align-middle mb-0">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="text-end">Qty</th>
                      <th className="text-end">Unit cost</th>
                      <th className="text-end">Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((it) => (
                      <tr key={it.id}>
                        <td>
                          <div className="fw-semibold">{can(session, 'products.view') ? <Link href={`/products/${it.productId}`}>{it.productName}</Link> : it.productName}</div>
                          <div className="text-muted small">{it.sku}</div>
                          {it.trackSerial && it.units.length > 0 && (
                            <details className="mt-1" open={it.units.length <= 10}>
                              <summary className="small text-muted">
                                {it.units.length} serial{it.units.length === 1 ? '' : 's'} ({it.units.filter((u) => u.status === 'in_stock').length} in stock)
                              </summary>
                              <div className="mt-1">
                                {it.units.map((u) => (
                                  <UnitChip key={u.id} serial={u.serialNo} status={u.status} unitId={can(session, 'serials.view') ? u.id : null} />
                                ))}
                              </div>
                            </details>
                          )}
                        </td>
                        <td className="text-end">
                          {it.qty}
                          {!it.trackSerial && it.returnedQty > 0 && <div className="small text-secondary text-nowrap">{it.returnedQty} returned</div>}
                        </td>
                        <td className="text-end"><MoneyText value={it.unitCost} /></td>
                        <td className="text-end"><MoneyText value={it.lineTotal} /></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h5 className="mb-3">Returns to vendor</h5>
              {p.returns.length === 0 ? (
                <EmptyState icon="undo-2" title="No returns" description="Units sent back to this vendor will appear here." className="py-3" />
              ) : (
                <Table size="sm" responsive className="mb-0">
                  <thead>
                    <tr>
                      <th>Return no</th>
                      <th>Date</th>
                      <th>Units</th>
                      <th className="text-end">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.returns.map((r) => (
                      <tr key={r.id}>
                        <td className="text-nowrap">{r.returnNo}</td>
                        <td className="text-nowrap">{r.date}</td>
                        <td>
                          {r.items.map((x, i) => (
                            <span key={i} className={`small me-2${x.serialNo ? ' font-monospace' : ''}`}>{x.serialNo ?? `${x.qty} × ${x.productName}`}</span>
                          ))}
                          {r.note && <div className="text-muted small">{r.note}</div>}
                        </td>
                        <td className="text-end"><MoneyText value={r.creditTotal} /></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </Col>

        <Col lg={4}>
          <Card>
            <CardBody>
              <h5 className="mb-3">Summary</h5>
              <dl className="row mb-0">
                <dt className="col-6 fw-normal">Subtotal</dt>
                <dd className="col-6 text-end"><MoneyText value={p.subtotal} /></dd>
                <dt className="col-6 fw-normal">Discount</dt>
                <dd className="col-6 text-end"><MoneyText value={p.discount} /></dd>
                <dt className="col-6">Total</dt>
                <dd className="col-6 text-end fw-semibold"><MoneyText value={p.total} /></dd>
                {p.returnedTotal !== '0.00' && (
                  <>
                    <dt className="col-6 fw-normal">Returned (credit)</dt>
                    <dd className="col-6 text-end"><MoneyText value={p.returnedTotal} /></dd>
                  </>
                )}
                <dt className="col-6 fw-normal">Paid (net)</dt>
                <dd className="col-6 text-end"><MoneyText value={p.paid} /></dd>
                <dt className="col-6">Due</dt>
                <dd className="col-6 text-end fw-semibold"><MoneyText value={p.due} className={p.due !== '0.00' ? 'text-danger' : undefined} /></dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h5 className="mb-3">Payments</h5>
              {p.payments.length === 0 ? (
                <EmptyState icon="wallet" title="No payments yet" className="py-3" />
              ) : (
                <Table size="sm" responsive className="mb-0">
                  <tbody>
                    {p.payments.map((x) => (
                      <tr key={x.id}>
                        <td>
                          <div className="text-nowrap">{x.date}</div>
                          <div className="text-muted small">
                            {x.direction === 'in' ? 'Refund into' : 'From'} {x.accountName}
                            {x.method ? ` · ${x.method}` : ''}
                          </div>
                        </td>
                        <td className="text-end">
                          <MoneyText value={x.direction === 'in' ? `-${x.amount}` : x.amount} tone />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
        </Col>
      </Row>
    </>
  )
}
