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
import { listActiveAccounts } from '@/server/purchases/purchases'
import { can } from '@/server/rbac'
import { PROFIT_PERMISSIONS, getSale } from '@/server/sales/sales'
import type { UnitStatus } from '@/server/serials'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import { z } from 'zod'
import PurchaseStatusBadge from '../../purchases/StatusBadge'
import UnitChip from '../../purchases/UnitChip'
import SaleActions from './SaleActions'

export const metadata: Metadata = { title: 'Sale' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'sales.view')) return (<><PageBreadcrumb title="Sale" subtitle="Sales" /><NoAccess /></>)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  const b = await branchScope(session)
  let s
  try {
    s = await getSale(db, session.cid, b.restrict, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const canEdit = can(session, 'sales.edit')
  const showProfit = PROFIT_PERMISSIONS.some((k) => can(session, k))
  const accounts = canEdit ? await listActiveAccounts(db, session.cid) : []
  const returnable = s.items
    .filter((it) => it.qty - it.returnedQty > 0 && (!it.unitId || it.unitStatus === 'sold'))
    .map((it) => ({ id: it.id, productName: it.productName, serialNo: it.serialNo, qty: it.qty, returnedQty: it.returnedQty, netTotal: it.netTotal }))

  return (
    <>
      <PageBreadcrumb title={s.invoiceNo} subtitle="Sales" />
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h4 className="mb-1">
            {s.invoiceNo} <PurchaseStatusBadge p={s} />
          </h4>
          <div className="text-muted">
            {s.customerId ? <Link href={`/customers/${s.customerId}`}>{s.customerName}</Link> : 'Walk-in customer'} · {s.date}
            {s.createdByName && <> · sold by {s.createdByName}</>}
            {b.multi && s.branchName && <> · {s.branchName} branch</>}
          </div>
          {s.note && <div className="text-muted small mt-1" style={{ overflowWrap: 'anywhere' }}>{s.note}</div>}
        </div>
        <SaleActions saleId={s.id} invoiceNo={s.invoiceNo} total={s.total} paid={s.paid} due={s.due} returnedTotal={s.returnedTotal} accounts={accounts} today={localDate(appTimezone())} returnable={returnable} canEdit={canEdit} />
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
                      <th>Warranty</th>
                      <th className="text-end">Qty</th>
                      <th className="text-end">Unit price</th>
                      <th className="text-end">Amount</th>
                      {showProfit && <th className="text-end">Profit</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {s.items.map((it) => (
                      <tr key={it.id}>
                        <td>
                          <div className="fw-semibold">{can(session, 'products.view') ? <Link href={`/products/${it.productId}`}>{it.productName}</Link> : it.productName}</div>
                          <div className="text-muted small">{it.sku}</div>
                          {it.serialNo && <UnitChip serial={it.serialNo} status={it.unitStatus as UnitStatus} unitId={can(session, 'serials.view') ? it.unitId : null} />}
                          {it.returnedQty > 0 && <div className="small text-secondary">{it.returnedQty} returned</div>}
                        </td>
                        <td className="small text-nowrap">
                          {it.serialNo ? (
                            it.warrantyStart ? (
                              it.warrantyEnd ? (
                                <>
                                  {it.warrantyStart} → {it.warrantyEnd}
                                </>
                              ) : (
                                <span className="text-muted">No warranty</span>
                              )
                            ) : (
                              <span className="text-muted">-</span>
                            )
                          ) : it.productWarrantyMonths ? (
                            `${it.productWarrantyMonths} months`
                          ) : (
                            <span className="text-muted">-</span>
                          )}
                        </td>
                        <td className="text-end">{it.qty}</td>
                        <td className="text-end"><MoneyText value={it.unitPrice} /></td>
                        <td className="text-end"><MoneyText value={it.lineTotal} /></td>
                        {showProfit && (
                          <td className="text-end small">
                            <MoneyText value={it.profit} tone />
                            <div className="text-muted">cost <MoneyText value={it.unitCost} /></div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h5 className="mb-3">Returns</h5>
              {s.returns.length === 0 ? (
                <EmptyState icon="undo-2" title="No returns" description="Items the customer brings back will appear here." className="py-3" />
              ) : (
                <Table size="sm" responsive className="mb-0">
                  <thead>
                    <tr>
                      <th>Return no</th>
                      <th>Date</th>
                      <th>Items</th>
                      <th className="text-end">Value</th>
                      <th className="text-end">Refunded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.returns.map((r) => (
                      <tr key={r.id}>
                        <td className="text-nowrap">{r.returnNo}</td>
                        <td className="text-nowrap">{r.date}</td>
                        <td>
                          {r.items.map((x, i) => (
                            <span key={i} className="small me-2">
                              {x.serialNo ? <span className="font-monospace">{x.serialNo}</span> : `${x.qty} × ${x.productName}`}
                              {x.restock === 'damaged' && <span className="text-danger"> (damaged)</span>}
                            </span>
                          ))}
                          {r.note && <div className="text-muted small">{r.note}</div>}
                        </td>
                        <td className="text-end"><MoneyText value={r.creditTotal} /></td>
                        <td className="text-end"><MoneyText value={r.refundTotal} /></td>
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
                <dd className="col-6 text-end"><MoneyText value={s.subtotal} /></dd>
                <dt className="col-6 fw-normal">Discount</dt>
                <dd className="col-6 text-end"><MoneyText value={s.discount} /></dd>
                <dt className="col-6">Total</dt>
                <dd className="col-6 text-end fw-semibold"><MoneyText value={s.total} /></dd>
                {s.returnedTotal !== '0.00' && (
                  <>
                    <dt className="col-6 fw-normal">Returned</dt>
                    <dd className="col-6 text-end"><MoneyText value={s.returnedTotal} /></dd>
                  </>
                )}
                <dt className="col-6 fw-normal">Paid (net)</dt>
                <dd className="col-6 text-end"><MoneyText value={s.paid} /></dd>
                <dt className="col-6">Due</dt>
                <dd className="col-6 text-end fw-semibold"><MoneyText value={s.due} className={s.due !== '0.00' ? 'text-danger' : undefined} /></dd>
                {showProfit && (
                  <>
                    <dt className="col-6 fw-normal text-muted">Cost</dt>
                    <dd className="col-6 text-end text-muted"><MoneyText value={s.cost} /></dd>
                    <dt className="col-6 fw-normal text-muted">Profit{s.returnedTotal !== '0.00' ? ' (after returns)' : ''}</dt>
                    <dd className="col-6 text-end"><MoneyText value={s.profit} tone /></dd>
                  </>
                )}
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <h5 className="mb-3">Payments</h5>
              {s.payments.length === 0 ? (
                <EmptyState icon="wallet" title="No payments yet" className="py-3" />
              ) : (
                <Table size="sm" responsive className="mb-0">
                  <tbody>
                    {s.payments.map((x) => (
                      <tr key={x.id}>
                        <td>
                          <div className="text-nowrap">{x.date}</div>
                          <div className="text-muted small">
                            {x.direction === 'out' ? 'Refund from' : 'Into'} {x.accountName}
                            {x.method ? ` · ${x.method}` : ''}
                          </div>
                        </td>
                        <td className="text-end">
                          <MoneyText value={x.direction === 'out' ? `-${x.amount}` : x.amount} tone />
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
