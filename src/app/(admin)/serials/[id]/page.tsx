import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone } from '@/server/dashboard'
import { formatLocalDateTime } from '@/server/dates'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { UnitInOtherBranchError, canSeeProfit, findUnitIdBySerial, getUnitDetail } from '@/server/lookup/lookup'
import { decodeIfEncoded, docHref, linkAccess } from '@/server/lookup/links'
import { can } from '@/server/rbac'
import { STATUS_LABEL } from '@/server/serials'
import { OUTCOME_EFFECT, type TicketOutcome } from '@/server/service/schemas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Alert, Badge, Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import { z } from 'zod'
import { UNIT_TONE } from '../../purchases/UnitChip'
import TicketStatusBadge from '../TicketStatusBadge'
import { OpenTicketButton, TicketRowActions } from '../TicketActions'

export const metadata: Metadata = { title: 'Serial history' }

const Fact = ({ label, children }: { label: string; children?: React.ReactNode }) => (
  <div className="mb-3">
    <div className="text-muted small">{label}</div>
    <div style={{ overflowWrap: 'anywhere' }}>{children || <span className="text-muted">-</span>}</div>
  </div>
)

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ order?: string; via?: string }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'serials.view')) return (<><PageBreadcrumb title="Serial history" subtitle="Serial Lookup" /><NoAccess /></>)
  const { id: param } = await params
  const sp = await searchParams
  const order = sp.order === 'desc' ? 'desc' : 'asc'
  const via = sp.via === 'partial' || sp.via === 'case' ? sp.via : null
  const access = linkAccess(session)
  const db = getDb()
  if (!z.uuid().safeParse(param).success) {
    // /serials/<serial>: use the segment as-is; only if that finds nothing, try it percent-decoded (a serial may contain a literal '%').
    let found = await findUnitIdBySerial(db, session.cid, param)
    const decoded = decodeIfEncoded(param)
    if (!found && decoded !== param) found = await findUnitIdBySerial(db, session.cid, decoded)
    redirect(found ? `/serials/${found}` : `/serials?q=${encodeURIComponent(decoded)}`)
  }
  const b = await branchScope(session)
  let d
  try {
    d = await getUnitDetail(db, session.cid, b.restrict, { id: param }, { withCost: canSeeProfit(session), order })
  } catch (e) {
    // Restricted viewer, unit in another branch: it exists, and only its status and branch may be shown.
    if (e instanceof UnitInOtherBranchError)
      return (
        <>
          <PageBreadcrumb title={e.serialNo} subtitle="Serial Lookup" />
          <Alert variant="info">
            <span className="font-monospace">{e.serialNo}</span> is <strong>{STATUS_LABEL[e.status].toLowerCase()}</strong> at <strong>{e.branchName ?? 'another branch'}</strong>. Its details are visible to that branch only.
          </Alert>
          <Link href="/serials" className="btn btn-light btn-sm">Back to serial lookup</Link>
        </>
      )
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const tz = appTimezone()
  const when = (x: Date) => formatLocalDateTime(x, tz)
  const cur = d.currentSale
  const showCost = d.cost !== null
  const canOpen = d.unit.status === 'sold' && can(session, 'serials.create')
  const canEdit = can(session, 'serials.edit')
  const tone = UNIT_TONE[d.unit.status]
  const w = d.warranty

  return (
    <>
      <PageBreadcrumb title={d.unit.serialNo} subtitle="Serial Lookup" />
      {via && <Alert variant="info" className="py-2">{via === 'partial' ? 'Matched by partial text: this was the only serial containing what you typed.' : 'Matched ignoring letter case.'}</Alert>}
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h4 className="mb-1">
            <span className="font-monospace" style={{ overflowWrap: 'anywhere' }}>{d.unit.serialNo}</span>{' '}
            <Badge bg={`${tone}-subtle`} text={tone}>{STATUS_LABEL[d.unit.status]}</Badge>
            {d.flags.returnedByCustomer > 0 && <Badge bg="warning-subtle" text="warning" className="ms-1">Returned by customer {d.flags.returnedByCustomer}×</Badge>}
            {d.flags.serviceTickets > 0 && <Badge bg="info-subtle" text="info" className="ms-1">Serviced {d.flags.serviceTickets}×</Badge>}
          </h4>
          <div className="text-muted">
            {d.product.name} · {d.unit.locationLabel}
          </div>
        </div>
        <div className="d-flex gap-2">
          <Link href="/serials" className="btn btn-light">Look up another</Link>
          <a href={`/serials/labels?ids=${d.unit.id}`} className="btn btn-tonal-secondary" target="_blank" rel="noopener">Print label</a>
          {canOpen && !d.activeTicketId && <OpenTicketButton unitId={d.unit.id} serialNo={d.unit.serialNo} underWarranty={d.flags.underWarrantyNow} />}
        </div>
      </div>

      <Row className="g-3 mb-3">
        <Col lg={4}>
          <Card className="h-100">
            <CardBody>
              <h5 className="mb-3">Where it came from</h5>
              <Fact label="Product">
                {access.products ? <Link href={`/products?q=${encodeURIComponent(d.product.sku)}`}>{d.product.name}</Link> : d.product.name} <span className="text-muted small">{d.product.sku}</span>
              </Fact>
              <Fact label="Category / brand">{[d.product.categoryName, d.product.brandName].filter(Boolean).join(' · ')}</Fact>
              <Fact label="Vendor">{d.vendor && (access.vendors ? <Link href={`/vendors/${d.vendor.id}`}>{d.vendor.name}</Link> : d.vendor.name)}</Fact>
              <Fact label="Purchase invoice">{d.purchase && (access.purchases ? <Link href={`/purchases/${d.purchase.id}`}>{d.purchase.invoiceNo}</Link> : d.purchase.invoiceNo)}</Fact>
              <Fact label="Purchase date">{d.purchase?.date}</Fact>
              {showCost && (
                <Fact label="Purchase cost">
                  <MoneyText value={d.cost} className="fw-semibold" /> <span className="text-muted small">net of invoice discount</span>
                </Fact>
              )}
            </CardBody>
          </Card>
        </Col>
        <Col lg={4}>
          <Card className="h-100">
            <CardBody>
              <h5 className="mb-3">Where it is now</h5>
              <Fact label="Status">
                <Badge bg={`${tone}-subtle`} text={tone}>{STATUS_LABEL[d.unit.status]}</Badge> <span className="ms-1">{d.unit.locationLabel}</span>
                {b.multi && d.unit.branchName && <span className="ms-1 text-muted">· {d.unit.branchName} branch</span>}
              </Fact>
              {cur ? (
                <>
                  <Fact label="Customer">{cur.customerId ? (access.customers ? <Link href={`/customers/${cur.customerId}`}>{cur.customerName}</Link> : cur.customerName) : 'Walk-in customer'}</Fact>
                  <Fact label="Sale date">{cur.date}</Fact>
                  <Fact label="Sale invoice">
                    {access.sales ? <Link href={`/sales/${cur.saleId}`}>{cur.invoiceNo}</Link> : cur.invoiceNo}
                  </Fact>
                  <Fact label="Sale price">
                    <MoneyText value={cur.salePrice} className="fw-semibold" />
                    {cur.netRevenue !== cur.salePrice && <span className="text-muted small"> · {`after discount `}<MoneyText value={cur.netRevenue} /></span>}
                  </Fact>
                  {showCost && (
                    <Fact label="Profit on this unit">
                      <MoneyText value={cur.profit} tone className="fw-semibold" />
                    </Fact>
                  )}
                </>
              ) : (
                <div className="text-muted">{d.unit.status === 'in_stock' ? 'Not sold. It is in stock.' : 'Not currently sold to a customer.'}</div>
              )}
            </CardBody>
          </Card>
        </Col>
        <Col lg={4}>
          <Card className="h-100">
            <CardBody>
              <h5 className="mb-3">Warranty</h5>
              {w ? (
                <>
                  <Fact label="Status">
                    <Badge bg={`${w.tone}-subtle`} text={w.tone} className="fs-6">{w.label}</Badge>
                  </Fact>
                  <Fact label="Starts (sale date)">{w.start}</Fact>
                  <Fact label="Ends">{w.end}</Fact>
                  <Fact label="Period">{w.months ? `${w.months} month${w.months === 1 ? '' : 's'}` : 'None'}</Fact>
                </>
              ) : (
                <div className="text-muted">Warranty starts when the unit is sold.</div>
              )}
              <Fact label="Flags">
                {[d.flags.returnedByCustomer ? `Returned by a customer ${d.flags.returnedByCustomer}×` : null, d.flags.serviceTickets ? `${d.flags.serviceTickets} service ticket${d.flags.serviceTickets === 1 ? '' : 's'}` : null, d.flags.inService ? 'In service now' : null, d.flags.returnedToVendor ? 'Returned to vendor' : null].filter(Boolean).join(' · ')}
              </Fact>
            </CardBody>
          </Card>
        </Col>
      </Row>

      {d.sales.length > 0 && (d.sales.length > 1 || !cur) && (
        <Card className="mb-3">
          <CardBody>
            <h5 className="mb-3">Sales history</h5>
            <Table responsive size="sm" className="align-middle mb-0">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th className="text-end">Price</th>
                  {showCost && <th className="text-end">Profit</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.sales.map((l) => (
                  <tr key={l.saleItemId}>
                    <td>{access.sales ? <Link href={`/sales/${l.saleId}`}>{l.invoiceNo}</Link> : l.invoiceNo}</td>
                    <td className="text-nowrap">{l.date}</td>
                    <td>{l.customerId ? (access.customers ? <Link href={`/customers/${l.customerId}`}>{l.customerName}</Link> : l.customerName) : <span className="text-muted">Walk-in</span>}</td>
                    <td className="text-end"><MoneyText value={l.salePrice} /></td>
                    {showCost && <td className="text-end"><MoneyText value={l.profit} tone /></td>}
                    <td>{l.current ? <Badge bg="primary-subtle" text="primary">Current</Badge> : l.returned ? <Badge bg="warning-subtle" text="warning">Returned</Badge> : null}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      <Card className="mb-3" id="tickets">
        <CardBody>
          <h5 className="mb-3">Warranty and service tickets</h5>
          {d.tickets.length === 0 ? (
            <div className="text-muted">No service tickets for this unit.</div>
          ) : (
            <Table responsive size="sm" className="align-middle mb-0">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Issue</th>
                  <th>Status</th>
                  <th>Opened</th>
                  <th>Result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.tickets.map((tk) => (
                  <tr key={tk.id}>
                    <td className="fw-semibold text-nowrap">{tk.ticketNo ?? '-'}</td>
                    <td style={{ overflowWrap: 'anywhere', maxWidth: 280 }}>
                      {tk.issue}
                      {tk.notes && <div className="text-muted small">{tk.notes}</div>}
                    </td>
                    <td><TicketStatusBadge status={tk.status} underWarranty={tk.underWarranty} /></td>
                    <td className="text-nowrap small">{when(tk.openedAt)}{tk.openedByName ? ` · ${tk.openedByName}` : ''}</td>
                    <td className="small" style={{ overflowWrap: 'anywhere', maxWidth: 260 }}>
                      {tk.outcome ? <><span className="fw-semibold">{OUTCOME_EFFECT[tk.outcome as TicketOutcome]?.label ?? tk.outcome}</span><div className="text-muted">{tk.resolution}</div>{tk.closedAt && <div className="text-muted">{when(tk.closedAt)}{tk.closedByName ? ` · ${tk.closedByName}` : ''}</div>}</> : <span className="text-muted">-</span>}
                    </td>
                    <td>{canEdit && (tk.status === 'open' || tk.status === 'in_progress') && <TicketRowActions ticketId={tk.id} ticketNo={tk.ticketNo} status={tk.status} />}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {d.activeTicketId && !canEdit && <div className="text-muted small mt-2">Your role can open tickets but not update or finish them.</div>}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h5 className="mb-0">Timeline</h5>
            <div className="btn-group btn-group-sm" role="group" aria-label="Timeline order">
              <Link href={`/serials/${d.unit.id}`} className={`btn ${order === 'asc' ? 'btn-primary' : 'btn-light'}`} replace>Oldest first</Link>
              <Link href={`/serials/${d.unit.id}?order=desc`} className={`btn ${order === 'desc' ? 'btn-primary' : 'btn-light'}`} replace>Newest first</Link>
            </div>
          </div>
          {d.timeline.length === 0 ? (
            <EmptyState icon="history" title="No history yet" className="py-4" />
          ) : (
            <Table responsive className="align-middle mb-0">
              <thead>
                <tr>
                  <th>When ({tz})</th>
                  <th>Event</th>
                  <th>Who</th>
                  <th className="text-end">Price</th>
                  <th>Document</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {d.timeline.map((e) => (
                  <tr key={e.id}>
                    <td className="text-nowrap">{when(e.at)}</td>
                    <td>
                      <Badge bg={`${e.tone}-subtle`} text={e.tone}>{e.label}</Badge>
                      {e.statusChange && <div className="text-muted small">{e.statusChange}</div>}
                    </td>
                    <td>{e.actorName ?? <span className="text-muted">-</span>}</td>
                    <td className="text-end">{e.price !== null ? <MoneyText value={e.price} /> : <span className="text-muted">-</span>}</td>
                    <td>{e.doc ? (docHref(e.doc, access) ? <Link href={docHref(e.doc, access) as string}>{e.doc.label}</Link> : e.doc.label) : <span className="text-muted">-</span>}</td>
                    <td className="small" style={{ overflowWrap: 'anywhere', maxWidth: 280 }}>{e.note ?? <span className="text-muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  )
}
