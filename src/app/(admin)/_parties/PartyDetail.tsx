import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { fmtBD } from '@/server/money'
import { getLedger } from '@/server/parties/ledger'
import { getParty, type PartyKind } from '@/server/parties/parties'
import { listActiveAccounts, listPurchases, listVendorPayments, listVendorUnits } from '@/server/purchases/purchases'
import { getCustomerWarrantyPanel } from '@/server/lookup/lookup'
import { listCustomerPayments, listCustomerUnits, listSales } from '@/server/sales/sales'
import { appTimezone } from '@/server/dashboard'
import { localDate } from '@/server/dates'
import Link from 'next/link'
import { can } from '@/server/rbac'
import { notFound, redirect } from 'next/navigation'
import { Badge, Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import PurchaseStatusBadge from '../purchases/StatusBadge'
import UnitChip from '../purchases/UnitChip'
import { z } from 'zod'
import { PartyHeaderActions, PartyTabs } from './PartyDetailClient'
import CollectDue from './CollectDue'
import TicketStatusBadge from '../serials/TicketStatusBadge'
import HistoryButton from '@/components/ui/HistoryButton'

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="mb-3">
    <div className="text-muted small">{label}</div>
    <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{children || <span className="text-muted">-</span>}</div>
  </div>
)

const Stat = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <Card className="h-100">
    <CardBody>
      <div className="text-muted small">{label}</div>
      <div className="fs-4 fw-semibold">{children}</div>
      {hint && <div className="text-muted small">{hint}</div>}
    </CardBody>
  </Card>
)

/** Shared detail page for /vendors/[id] and /customers/[id]: profile, ledger summary, history tabs. */
export default async function PartyDetail({ kind, id }: { kind: PartyKind; id: string }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  const mod = kind === 'vendor' ? 'vendors' : 'customers'
  const title = kind === 'vendor' ? 'Vendor' : 'Customer'
  if (!can(session, `${mod}.view`)) return (<><PageBreadcrumb title={title} subtitle={`${title}s`} /><NoAccess /></>)
  if (!z.uuid().safeParse(id).success) notFound()

  const db = getDb()
  let party
  try {
    party = await getParty(db, session.cid, kind, id) // company-scoped: another company's id is "not found"
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const b = await branchScope(session)
  const ledger = await getLedger(db, session.cid, b.filter, kind, party.id)
  const isVendor = kind === 'vendor'
  const canSerials = can(session, 'serials.view')
  const empty = (what: string) => <EmptyState icon="inbox" title={`No ${what} yet`} description={`${what[0].toUpperCase()}${what.slice(1)} will appear here once they are recorded.`} className="py-4" />
  const canPurchases = isVendor && can(session, 'purchases.view')
  const [purchases, payments, units] = canPurchases
    ? await Promise.all([listPurchases(db, session.cid, b.filter, { vendorId: party.id, limit: 50, offset: 0 }), listVendorPayments(db, session.cid, b.filter, party.id, 100), listVendorUnits(db, session.cid, b.filter, party.id, 200)])
    : [null, null, null]
  const noPurchaseAccess = <EmptyState icon="lock" title="No access" description="Your role cannot view purchases." className="py-4" />
  const vendorTabs = {
    history: !canPurchases ? (
      noPurchaseAccess
    ) : purchases!.rows.length === 0 ? (
      empty('purchases')
    ) : (
      <>
        <Table size="sm" responsive className="mb-0 align-middle">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th className="text-end">Total</th>
              <th className="text-end">Paid</th>
              <th className="text-end">Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {purchases!.rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/purchases/${r.id}`}>{r.invoiceNo}</Link></td>
                <td className="text-nowrap">{r.date}</td>
                <td className="text-end"><MoneyText value={r.total} /></td>
                <td className="text-end"><MoneyText value={r.paid} /></td>
                <td className="text-end"><MoneyText value={r.due} /></td>
                <td><PurchaseStatusBadge p={r} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
        {purchases!.total > purchases!.rows.length && (
          <div className="small text-muted mt-2">
            Showing the latest {purchases!.rows.length} of {purchases!.total}. <Link href={`/purchases?vendor=${party.id}`}>See all</Link>
          </div>
        )}
      </>
    ),
    payments: !canPurchases ? (
      noPurchaseAccess
    ) : payments!.length === 0 ? (
      empty('payments')
    ) : (
      <Table size="sm" responsive className="mb-0">
        <thead>
          <tr>
            <th>Date</th>
            <th>Invoice</th>
            <th>Account</th>
            <th>Note</th>
            <th className="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>
          {payments!.map((x) => (
            <tr key={x.id}>
              <td className="text-nowrap">{x.date}</td>
              <td>{x.purchaseId ? <Link href={`/purchases/${x.purchaseId}`}>{x.invoiceNo}</Link> : <span className="text-muted">-</span>}</td>
              <td>{x.accountName}{x.method ? ` · ${x.method}` : ''}</td>
              <td className="small" style={{ overflowWrap: 'anywhere' }}>{x.direction === 'in' ? 'Refund from vendor. ' : ''}{x.note}</td>
              <td className="text-end"><MoneyText value={x.direction === 'in' ? `-${x.amount}` : x.amount} tone /></td>
            </tr>
          ))}
        </tbody>
      </Table>
    ),
    serials: !canPurchases ? (
      noPurchaseAccess
    ) : units!.rows.length === 0 ? (
      empty('serial units')
    ) : (
      <>
        <Table size="sm" responsive className="mb-0 align-middle">
          <thead>
            <tr>
              <th>Serial</th>
              <th>Product</th>
              <th>Invoice</th>
              <th className="text-end">Cost</th>
            </tr>
          </thead>
          <tbody>
            {units!.rows.map((u) => (
              <tr key={u.id}>
                <td><UnitChip serial={u.serialNo} status={u.status} unitId={canSerials ? u.id : null} /></td>
                <td>{u.productName}</td>
                <td>{u.purchaseId ? <Link href={`/purchases/${u.purchaseId}`}>{u.invoiceNo}</Link> : '-'}</td>
                <td className="text-end"><MoneyText value={u.purchasePrice} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
        {units!.total > units!.rows.length && <div className="small text-muted mt-2">Showing the latest {units!.rows.length} of {units!.total} units.</div>}
      </>
    ),
  }

  const canSales = !isVendor && can(session, 'sales.view')
  const [sales, custPayments, custUnits] = canSales
    ? await Promise.all([listSales(db, session.cid, b.filter, { customerId: party.id, limit: 50, offset: 0 }), listCustomerPayments(db, session.cid, b.filter, party.id, 100), listCustomerUnits(db, session.cid, b.filter, party.id, 200)])
    : [null, null, null]
  const canCollect = canSales && can(session, 'sales.edit')
  // Collection allocates over the ACTIVE branch's invoices only (collectCustomerDue), so the due shown is that branch's.
  const invoiceDue = canCollect && b.active ? (await listSales(db, session.cid, b.active, { customerId: party.id, dueOnly: true, limit: 1, offset: 0 })).sums.due : '0.00'
  const collectAccounts = canCollect && invoiceDue !== '0.00' ? await listActiveAccounts(db, session.cid) : []
  const noSalesAccess = <EmptyState icon="lock" title="No access" description="Your role cannot view sales." className="py-4" />
  const customerTabs = {
    history: !canSales ? (
      noSalesAccess
    ) : sales!.rows.length === 0 ? (
      empty('sales')
    ) : (
      <>
        <Table size="sm" responsive className="mb-0 align-middle">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th className="text-end">Total</th>
              <th className="text-end">Paid</th>
              <th className="text-end">Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sales!.rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/sales/${r.id}`}>{r.invoiceNo}</Link></td>
                <td className="text-nowrap">{r.date}</td>
                <td className="text-end"><MoneyText value={r.total} /></td>
                <td className="text-end"><MoneyText value={r.paid} /></td>
                <td className="text-end"><MoneyText value={r.due} /></td>
                <td><PurchaseStatusBadge p={r} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
        {sales!.total > sales!.rows.length && (
          <div className="small text-muted mt-2">
            Showing the latest {sales!.rows.length} of {sales!.total}. <Link href={`/sales?customer=${party.id}`}>See all</Link>
          </div>
        )}
      </>
    ),
    payments: !canSales ? (
      noSalesAccess
    ) : custPayments!.length === 0 ? (
      empty('payments')
    ) : (
      <Table size="sm" responsive className="mb-0">
        <thead>
          <tr>
            <th>Date</th>
            <th>Invoice</th>
            <th>Account</th>
            <th>Note</th>
            <th className="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>
          {custPayments!.map((x) => (
            <tr key={x.id}>
              <td className="text-nowrap">{x.date}</td>
              <td>{x.saleId ? <Link href={`/sales/${x.saleId}`}>{x.invoiceNo}</Link> : <span className="text-muted">-</span>}</td>
              <td>{x.accountName}{x.method ? ` · ${x.method}` : ''}</td>
              <td className="small" style={{ overflowWrap: 'anywhere' }}>{x.direction === 'out' ? 'Refund to customer. ' : ''}{x.note}</td>
              <td className="text-end"><MoneyText value={x.direction === 'out' ? `-${x.amount}` : x.amount} tone /></td>
            </tr>
          ))}
        </tbody>
      </Table>
    ),
    serials: !canSales ? (
      noSalesAccess
    ) : custUnits!.rows.length === 0 ? (
      empty('serial units')
    ) : (
      <>
        <Table size="sm" responsive className="mb-0 align-middle">
          <thead>
            <tr>
              <th>Serial</th>
              <th>Product</th>
              <th>Invoice</th>
              <th>Warranty until</th>
              <th className="text-end">Price</th>
            </tr>
          </thead>
          <tbody>
            {custUnits!.rows.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.current ? <UnitChip serial={u.serialNo} status={u.status} unitId={canSerials ? u.unitId : null} /> : <span className="font-monospace small text-muted text-decoration-line-through">{u.serialNo}</span>}
                  {!u.current && <Badge bg="secondary-subtle" text="secondary" className="ms-1">No longer with this customer</Badge>}
                </td>
                <td>{u.productName}</td>
                <td><Link href={`/sales/${u.saleId}`}>{u.invoiceNo}</Link></td>
                <td className="text-nowrap">{u.current && u.status === 'sold' ? (u.warrantyEnd ?? <span className="text-muted">No warranty</span>) : <span className="text-muted">-</span>}</td>
                <td className="text-end"><MoneyText value={u.price} /></td>
              </tr>
            ))}
          </tbody>
        </Table>
        {custUnits!.total > custUnits!.rows.length && <div className="small text-muted mt-2">Showing the latest {custUnits!.rows.length} of {custUnits!.total} units.</div>}
      </>
    ),
  }

  const warrantyPanel = !isVendor && canSerials ? await getCustomerWarrantyPanel(db, session.cid, b.filter, party.id) : null
  const warrantyTab = !isVendor && (
    <Card>
      <CardBody>
        {!warrantyPanel ? (
          <EmptyState icon="lock" title="No access" description="Your role cannot view serials." className="py-4" />
        ) : (
          <>
            <h6 className="mb-2">Units with this customer</h6>
            {warrantyPanel.units.length === 0 ? (
              empty('units under warranty')
            ) : (
              <Table size="sm" responsive className="mb-4 align-middle">
                <thead>
                  <tr>
                    <th>Serial</th>
                    <th>Product</th>
                    <th>Invoice</th>
                    <th>Warranty</th>
                  </tr>
                </thead>
                <tbody>
                  {warrantyPanel.units.map((u) => (
                    <tr key={u.unitId}>
                      <td><UnitChip serial={u.serialNo} status={u.status} unitId={u.unitId} /></td>
                      <td>{u.productName}</td>
                      <td>{can(session, 'sales.view') ? <Link href={`/sales/${u.saleId}`}>{u.invoiceNo}</Link> : u.invoiceNo}</td>
                      <td>
                        <Badge bg={`${u.info.tone}-subtle`} text={u.info.tone}>{u.info.label}</Badge>
                        {u.warrantyEnd && <span className="text-muted small ms-2">until {u.warrantyEnd}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <h6 className="mb-2">Service tickets</h6>
            {warrantyPanel.tickets.length === 0 ? (
              empty('service tickets')
            ) : (
              <Table size="sm" responsive className="mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Serial</th>
                    <th>Product</th>
                    <th>Issue</th>
                    <th>Opened</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {warrantyPanel.tickets.map((x) => (
                    <tr key={x.id}>
                      <td className="fw-semibold text-nowrap">{x.ticketNo ?? '-'}</td>
                      <td><Link href={`/serials/${x.unitId}`} className="font-monospace">{x.serialNo}</Link></td>
                      <td>{x.productName}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{x.issue}</td>
                      <td className="text-nowrap">{localDate(appTimezone(), x.openedAt)}</td>
                      <td><TicketStatusBadge status={x.status} underWarranty={x.underWarranty} /></td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )

  return (
    <>
      <PageBreadcrumb title={party.name} subtitle={`${title}s`} />
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h4 className="mb-1" style={{ overflowWrap: 'anywhere' }}>
            {party.name}{' '}
            {party.active ? <Badge bg="success-subtle" text="success">Active</Badge> : <Badge bg="secondary-subtle" text="secondary">Inactive</Badge>}
          </h4>
          <div className="text-muted">{[party.phone, party.email].filter(Boolean).join(' · ') || 'No contact details'}</div>
        </div>
        <div className="d-flex flex-column align-items-end gap-2">
          <HistoryButton entity={kind} id={party.id} title={party.name} />
          <PartyHeaderActions
            kind={kind}
            row={{ id: party.id, name: party.name, phone: party.phone, email: party.email, address: party.address, openingBalance: party.openingBalance, notes: party.notes, active: party.active }}
            can={{ edit: can(session, `${mod}.edit`), delete: can(session, `${mod}.delete`) }}
          />
          {canCollect && invoiceDue !== '0.00' && <CollectDue customerId={party.id} invoiceDue={invoiceDue} accounts={collectAccounts} today={localDate(appTimezone())} />}
        </div>
      </div>

      <Row className="g-3 mb-3">
        <Col md={3} sm={6}>
          <Stat label="Opening balance">
            <MoneyText value={ledger.opening} tone />
          </Stat>
        </Col>
        <Col md={3} sm={6}>
          <Stat label={isVendor ? 'Total purchased' : 'Total sold'} hint={`${ledger.documents} ${isVendor ? 'purchase' : 'sale'}${ledger.documents === 1 ? '' : 's'}${ledger.returned !== '0.00' ? `, less ${fmtBD(ledger.returned)} returned` : ''}`}>
            <MoneyText value={ledger.billed} />
          </Stat>
        </Col>
        <Col md={3} sm={6}>
          <Stat label={isVendor ? 'Paid to vendor' : 'Received (net of refunds)'}>
            <MoneyText value={ledger.paid} />
          </Stat>
        </Col>
        <Col md={3} sm={6}>
          <Stat label={isVendor ? 'We owe (due)' : 'Customer owes (due)'} hint={ledger.returned !== '0.00' ? 'opening + billed - returned - paid' : 'opening + billed - paid'}>
            <MoneyText value={ledger.due} tone />
          </Stat>
        </Col>
      </Row>

      <PartyTabs
        tabs={[
          {
            key: 'profile',
            title: 'Profile',
            content: (
              <Card>
                <CardBody>
                  <Row>
                    <Col md={6}>
                      <Field label="Phone">{party.phone}</Field>
                      <Field label="Email">{party.email}</Field>
                    </Col>
                    <Col md={6}>
                      <Field label="Address">{party.address}</Field>
                      <Field label="Notes">{party.notes}</Field>
                    </Col>
                  </Row>
                </CardBody>
              </Card>
            ),
          },
          { key: 'history', title: isVendor ? 'Purchase history' : 'Sales history', content: <Card><CardBody>{isVendor ? vendorTabs.history : customerTabs.history}</CardBody></Card> },
          { key: 'payments', title: 'Payments', content: <Card><CardBody>{isVendor ? vendorTabs.payments : customerTabs.payments}</CardBody></Card> },
          { key: 'serials', title: isVendor ? 'Serials supplied' : 'Serials sold', content: <Card><CardBody>{isVendor ? vendorTabs.serials : customerTabs.serials}</CardBody></Card> },
          ...(warrantyTab ? [{ key: 'warranty', title: 'Warranty & Service History', content: warrantyTab }] : []),
        ]}
      />
    </>
  )
}
