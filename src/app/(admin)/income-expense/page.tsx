import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import FilterBar from '@/components/ui/FilterBar'
import LinkPager from '@/components/ui/LinkPager'
import MoneyText from '@/components/ui/MoneyText'
import NoAccess from '@/components/ui/NoAccess'
import { listActiveAccountOptions } from '@/server/accounting/accounts'
import { incomeCategorySuggestions, listExpenseCategories, listExpenses, listIncomes, type EntryRow } from '@/server/accounting/entries'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone, localDate } from '@/server/dates'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { isIsoDate } from '@/server/reports/pure'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Badge, Card, CardBody, Table } from 'react-bootstrap'
import CategoryManager from './CategoryManager'
import { EntryRowActions, EntryToolbar } from './EntryActions'

export const metadata: Metadata = { title: 'Income / Expense' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'accounts.view')) return (<><PageBreadcrumb title="Income / Expense" subtitle="Finance" /><NoAccess /></>)

  const sp = await searchParams
  const tab = one(sp.tab) === 'income' ? 'income' : one(sp.tab) === 'categories' ? 'categories' : 'expense'
  const { q, page, pageSize, offset } = parseListParams(sp, { pageSize: 25 })
  const from = isIsoDate(one(sp.from)) ? one(sp.from) : undefined
  const to = isIsoDate(one(sp.to)) ? one(sp.to) : undefined
  const status = one(sp.status) === 'voided' ? 'voided' : one(sp.status) === 'all' ? 'all' : 'active'
  const db = getDb()
  const cid = session.cid
  const perms = { create: can(session, 'accounts.create'), edit: can(session, 'accounts.edit'), delete: can(session, 'accounts.delete') }
  const [accounts, categories, suggestions] = await Promise.all([listActiveAccountOptions(db, cid), listExpenseCategories(db, cid, tab === 'categories' ? 'all' : 'active'), incomeCategorySuggestions(db, cid)])
  const today = localDate(appTimezone())
  const b = await branchScope(session)

  const list = tab === 'categories' ? null : tab === 'expense' ? await listExpenses(db, cid, b.filter, { from, to, status, q, limit: pageSize, offset }) : await listIncomes(db, cid, b.filter, { from, to, status, q, limit: pageSize, offset })

  const tabHref = (t: string) => `/income-expense?tab=${t}`
  return (
    <>
      <PageBreadcrumb title="Income / Expense" subtitle="Finance" />
      <Card>
        <CardBody>
          <ul className="nav nav-tabs mb-3 d-print-none">
            {(['expense', 'income', 'categories'] as const).map((t) => (
              <li className="nav-item" key={t}>
                <Link className={`nav-link${tab === t ? ' active' : ''}`} href={tabHref(t)}>
                  {t === 'expense' ? 'Expenses' : t === 'income' ? 'Other income' : 'Expense categories'}
                </Link>
              </li>
            ))}
          </ul>

          {tab === 'categories' ? (
            <CategoryManager rows={categories} can={perms} />
          ) : (
            <>
              <FilterBar
                hidden={{ tab }}
                values={{ from: from ?? '', to: to ?? '', status: status === 'active' ? '' : status, q }}
                fields={[
                  { name: 'from', label: 'From', type: 'date' },
                  { name: 'to', label: 'To', type: 'date' },
                  { name: 'status', label: 'Show', type: 'select', options: [{ value: '', label: 'Active entries' }, { value: 'voided', label: 'Voided only' }, { value: 'all', label: 'All' }] },
                  { name: 'q', label: 'Search', type: 'text', placeholder: 'Note or category', width: 170 },
                ]}
                resetHref={tabHref(tab)}
                extra={perms.create && <EntryToolbar kind={tab} accounts={accounts.map((a) => ({ value: a.id, label: a.name }))} categories={categories.map((c) => ({ value: c.id, label: c.name }))} suggestions={suggestions} today={today} />}
              />
              {list && list.rows.length === 0 ? (
                <EmptyState icon="wallet" title={tab === 'expense' ? 'No expenses' : 'No other income'} description={perms.create ? 'Use the button above to record one.' : undefined} className="py-4" />
              ) : (
                <div className="table-responsive">
                  <Table hover size="sm" className="align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Category</th>
                        <th>Account</th>
                        <th>Note</th>
                        <th className="text-end">Amount</th>
                        <th className="d-print-none" />
                      </tr>
                    </thead>
                    <tbody>
                      {list?.rows.map((r: EntryRow) => (
                        <tr key={r.id} className={r.voidedAt ? 'text-muted' : undefined}>
                          <td className="text-nowrap">{r.date}</td>
                          <td>{r.category ?? <span className="text-muted">Uncategorized</span>}</td>
                          <td>{r.accountName}</td>
                          <td className="small">
                            {r.note ?? '-'} {r.voidedAt && <Badge bg="warning" text="dark" title={r.voidReason ?? undefined}>Voided{r.voidReason ? `: ${r.voidReason}` : ''}</Badge>}
                          </td>
                          <td className="text-end">
                            <MoneyText value={r.amount} className={r.voidedAt ? 'text-decoration-line-through' : undefined} />
                          </td>
                          <td className="text-end text-nowrap d-print-none">
                            {!r.voidedAt && (perms.edit || perms.delete) && <EntryRowActions kind={tab} row={{ id: r.id, note: r.note ?? '', categoryId: r.categoryId ?? '', category: r.category ?? '' }} categories={categories.map((c) => ({ value: c.id, label: c.name }))} suggestions={suggestions} can={perms} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {list && (
                      <tfoot>
                        <tr className="fw-semibold">
                          <td colSpan={4} className="text-end">
                            Total of active entries matching the filters
                          </td>
                          <td className="text-end"><MoneyText value={list.sum} /></td>
                          <td className="d-print-none" />
                        </tr>
                      </tfoot>
                    )}
                  </Table>
                </div>
              )}
              {list && <LinkPager path="/income-expense" sp={sp} total={list.total} page={page} pageSize={pageSize} itemsName="entries" />}
            </>
          )}
        </CardBody>
      </Card>
    </>
  )
}
