import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import LinkPager from '@/components/ui/LinkPager'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import { listActiveAccountOptions } from '@/server/accounting/accounts'
import { customerDues, vendorDueInvoices, vendorDuesSummary, type AgingTotals } from '@/server/accounting/dues'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone, localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Badge, Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import CollectDue from '../_parties/CollectDue'
import PayInvoice from './PayInvoice'

export const metadata: Metadata = { title: 'Dues' }

const BUCKETS = [
  { key: 'current', label: 'Current (0-29 days)', tone: 'success' },
  { key: 'd30', label: '30-59 days', tone: 'warning' },
  { key: 'd60', label: '60-89 days', tone: 'orange' },
  { key: 'd90', label: '90+ days', tone: 'danger' },
] as const
const BUCKET_BADGE: Record<string, { label: string; bg: string }> = { current: { label: 'Current', bg: 'success' }, '30': { label: '30+', bg: 'warning' }, '60': { label: '60+', bg: 'warning' }, '90+': { label: '90+', bg: 'danger' } }

const AgingCards = ({ totals }: { totals: AgingTotals }) => (
  <Row className="g-3 mb-3">
    {BUCKETS.map((b) => (
      <Col key={b.key} sm={6} lg={3}>
        <div className="border rounded p-3 h-100">
          <div className="text-muted small">{b.label}</div>
          <div className="fs-5 fw-semibold">
            <MoneyText value={totals[b.key]} />
          </div>
        </div>
      </Col>
    ))}
  </Row>
)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'accounts.view')) return (<><PageBreadcrumb title="Dues" subtitle="Finance" /><NoAccess /></>)

  const sp = await searchParams
  const tab = (Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) === 'vendors' ? 'vendors' : 'customers'
  const { q, page, pageSize, offset } = parseListParams(sp)
  const db = getDb()
  const today = localDate(appTimezone())
  const b = await branchScope(session)
  const accounts = await listActiveAccountOptions(db, session.cid)
  const canCollect = can(session, 'sales.edit')
  const canPay = can(session, 'purchases.edit')

  const customers = tab === 'customers' ? await customerDues(db, session.cid, b.filter, { today, q, limit: pageSize, offset }) : null
  const vendorSummary = tab === 'vendors' ? await vendorDuesSummary(db, session.cid, b.filter, { today, q, limit: 1, offset: 0 }) : null
  const vendorInvoices = tab === 'vendors' ? await vendorDueInvoices(db, session.cid, b.filter, { today, q, limit: pageSize, offset }) : null

  return (
    <>
      <PageBreadcrumb title="Dues" subtitle="Finance" />
      <Card>
        <CardBody>
          <ul className="nav nav-tabs mb-3">
            <li className="nav-item"><Link className={`nav-link${tab === 'customers' ? ' active' : ''}`} href="/dues?tab=customers">Customers owe us</Link></li>
            <li className="nav-item"><Link className={`nav-link${tab === 'vendors' ? ' active' : ''}`} href="/dues?tab=vendors">We owe vendors</Link></li>
          </ul>

          <form className="d-flex gap-2 mb-3" role="search" action="/dues">
            <input type="hidden" name="tab" value={tab} />
            <input className="form-control form-control-sm" style={{ maxWidth: 280 }} type="search" name="q" defaultValue={q} placeholder={tab === 'customers' ? 'Search customer name or phone' : 'Search vendor or invoice'} aria-label="Search" maxLength={100} />
            <button className="btn btn-sm btn-primary" type="submit">Search</button>
          </form>

          <p className="small text-muted">Totals are the unpaid amounts of invoices only. Party opening balances and unapplied credits (advances, overpayments) are not included; see the customer or vendor ledger for those.</p>

          {tab === 'customers' && customers && (
            <>
              <AgingCards totals={customers.totals} />
              {customers.rows.length === 0 ? (
                <EmptyState icon="hand-coins" title="No customer dues" description={q ? 'Nothing matches your search.' : 'Every invoice is paid.'} className="py-4" />
              ) : (
                <div className="table-responsive">
                  <Table hover size="sm" className="align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Customer</th>
                        <th className="text-end">Invoices</th>
                        <th className="text-end">Current</th>
                        <th className="text-end">30-59</th>
                        <th className="text-end">60-89</th>
                        <th className="text-end">90+</th>
                        <th className="text-end">Total due</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {customers.rows.map((r) => (
                        <tr key={r.partyId ?? 'walk-in'}>
                          <td>{r.partyId ? <Link href={`/customers/${r.partyId}`}>{r.name}</Link> : r.name} {r.phone && <span className="text-muted small">{r.phone}</span>}</td>
                          <td className="text-end">{r.invoices}</td>
                          <td className="text-end"><MoneyText value={r.current} /></td>
                          <td className="text-end"><MoneyText value={r.d30} /></td>
                          <td className="text-end"><MoneyText value={r.d60} /></td>
                          <td className="text-end"><MoneyText value={r.d90} className={r.d90 !== '0.00' ? 'text-danger' : undefined} /></td>
                          <td className="text-end fw-semibold"><MoneyText value={r.total} /></td>
                          <td className="text-end">{canCollect && r.partyId && <CollectDue customerId={r.partyId} invoiceDue={r.total} accounts={accounts} today={today} />}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="fw-semibold">
                        <td>All {customers.count} customers</td>
                        <td className="text-end">{customers.totals.invoices}</td>
                        <td className="text-end"><MoneyText value={customers.totals.current} /></td>
                        <td className="text-end"><MoneyText value={customers.totals.d30} /></td>
                        <td className="text-end"><MoneyText value={customers.totals.d60} /></td>
                        <td className="text-end"><MoneyText value={customers.totals.d90} /></td>
                        <td className="text-end"><MoneyText value={customers.totals.total} /></td>
                        <td />
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              )}
              <LinkPager path="/dues" sp={sp} total={customers.count} page={page} pageSize={pageSize} itemsName="customers" />
            </>
          )}

          {tab === 'vendors' && vendorSummary && vendorInvoices && (
            <>
              <AgingCards totals={vendorSummary.totals} />
              {vendorInvoices.rows.length === 0 ? (
                <EmptyState icon="wallet" title="No vendor dues" description={q ? 'Nothing matches your search.' : 'You owe nothing on any purchase.'} className="py-4" />
              ) : (
                <div className="table-responsive">
                  <Table hover size="sm" className="align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th>Invoice</th>
                        <th>Date</th>
                        <th className="text-end">Age</th>
                        <th className="text-end">Due</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {vendorInvoices.rows.map((r) => (
                        <tr key={r.purchaseId}>
                          <td><Link href={`/vendors/${r.vendorId}`}>{r.vendorName}</Link></td>
                          <td><Link href={`/purchases/${r.purchaseId}`}>{r.invoiceNo}</Link></td>
                          <td>{r.date}</td>
                          <td className="text-end">
                            {Math.max(r.ageDays, 0)} d <Badge bg={BUCKET_BADGE[r.bucket].bg}>{BUCKET_BADGE[r.bucket].label}</Badge>
                          </td>
                          <td className="text-end fw-semibold"><MoneyText value={r.due} /></td>
                          <td className="text-end">{canPay && <PayInvoice purchaseId={r.purchaseId} invoiceNo={r.invoiceNo} due={r.due} accounts={accounts} today={today} />}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="fw-semibold">
                        <td colSpan={4} className="text-end">Total due over all {vendorSummary.totals.invoices} open invoices</td>
                        <td className="text-end"><MoneyText value={vendorSummary.totals.total} /></td>
                        <td />
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              )}
              <LinkPager path="/dues" sp={sp} total={vendorInvoices.count} page={page} pageSize={pageSize} itemsName="invoices" />
            </>
          )}
        </CardBody>
      </Card>
    </>
  )
}
