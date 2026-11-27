import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import FilterBar from '@/components/ui/FilterBar'
import LinkPager from '@/components/ui/LinkPager'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import Icon from '@/components/wrappers/Icon'
import { PAYMENT_REF_TYPES, listPayments, parsePaymentFilter } from '@/server/accounting/payments'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb, schema } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Badge, Card, CardBody, Table } from 'react-bootstrap'

export const metadata: Metadata = { title: 'Payments' }

const REF_LABEL: Record<string, string> = { sale: 'Sale', purchase: 'Purchase', expense: 'Expense', income: 'Income', manual: 'Manual', transfer: 'Transfer' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'accounts.view')) return (<><PageBreadcrumb title="Payments" subtitle="Finance" /><NoAccess /></>)

  const sp = await searchParams
  const { page, pageSize, offset } = parseListParams(sp, { pageSize: 25 })
  const filter = parsePaymentFilter(sp)
  const db = getDb()
  const b = await branchScope(session)
  const [{ rows, total, totalIn, totalOut }, accounts] = await Promise.all([listPayments(db, session.cid, b.filter, { ...filter, limit: pageSize, offset }), db.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.companyId, session.cid)).orderBy(schema.accounts.name)])

  const qs = new URLSearchParams(Object.entries({ from: filter.from, to: filter.to, direction: filter.direction, account: filter.accountId, party: filter.partyType, method: filter.method, ref: filter.refType }).filter((e): e is [string, string] => !!e[1])).toString()

  return (
    <>
      <PageBreadcrumb title="Payments" subtitle="Finance" />
      <Card>
        <CardBody>
          <FilterBar
            values={{ from: filter.from ?? '', to: filter.to ?? '', direction: filter.direction ?? '', account: filter.accountId ?? '', party: filter.partyType ?? '', method: filter.method ?? '', ref: filter.refType ?? '' }}
            fields={[
              { name: 'from', label: 'From', type: 'date' },
              { name: 'to', label: 'To', type: 'date' },
              { name: 'direction', label: 'Direction', type: 'select', options: [{ value: '', label: 'In and out' }, { value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }] },
              { name: 'account', label: 'Account', type: 'select', options: [{ value: '', label: 'All accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))] },
              { name: 'party', label: 'Party', type: 'select', options: [{ value: '', label: 'Any' }, { value: 'customer', label: 'Customers' }, { value: 'vendor', label: 'Vendors' }, { value: 'none', label: 'No party' }] },
              { name: 'ref', label: 'Type', type: 'select', options: [{ value: '', label: 'All types' }, ...PAYMENT_REF_TYPES.map((r) => ({ value: r, label: REF_LABEL[r] }))] },
              { name: 'method', label: 'Method', type: 'text', placeholder: 'e.g. bKash', width: 130 },
            ]}
            extra={
              <a className="btn btn-sm btn-light" href={`/payments/csv${qs ? `?${qs}` : ''}`}>
                <Icon icon="download" className="me-1" /> Export CSV
              </a>
            }
          />

          {rows.length === 0 ? (
            <EmptyState icon="credit-card" title="No payments" description="Payments from sales, purchases, expenses, income and transfers appear here." className="py-4" />
          ) : (
            <div className="table-responsive">
              <Table hover size="sm" className="align-middle mb-0">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Account</th>
                    <th>Party</th>
                    <th>Type</th>
                    <th>Reference</th>
                    <th>Method / note</th>
                    <th className="text-end">In</th>
                    <th className="text-end">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="text-nowrap">{r.date}</td>
                      <td>{r.accountName}</td>
                      <td>{r.partyName ? <Link href={`/${r.partyType === 'vendor' ? 'vendors' : 'customers'}/${r.partyId}`}>{r.partyName}</Link> : <span className="text-muted">-</span>}</td>
                      <td>
                        {REF_LABEL[r.refType]} {r.isReversal && <Badge bg="warning" text="dark">void</Badge>}
                      </td>
                      <td>{r.refHref ? <Link href={r.refHref}>{r.refLabel}</Link> : <span className="text-muted">-</span>}</td>
                      <td className="small text-muted">{[r.method, r.note].filter(Boolean).join(' · ') || '-'}</td>
                      <td className="text-end">{r.direction === 'in' ? <MoneyText value={r.amount} className="text-success" /> : ''}</td>
                      <td className="text-end">{r.direction === 'out' ? <MoneyText value={r.amount} className="text-danger" /> : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="fw-semibold">
                    <td colSpan={6} className="text-end">
                      Totals for all {total} matching payments
                    </td>
                    <td className="text-end"><MoneyText value={totalIn} /></td>
                    <td className="text-end"><MoneyText value={totalOut} /></td>
                  </tr>
                </tfoot>
              </Table>
            </div>
          )}
          <LinkPager path="/payments" sp={sp} total={total} page={page} pageSize={pageSize} itemsName="payments" />
        </CardBody>
      </Card>
    </>
  )
}
