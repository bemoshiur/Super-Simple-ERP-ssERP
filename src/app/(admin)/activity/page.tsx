import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import FilterBar from '@/components/ui/FilterBar'
import LinkPager from '@/components/ui/LinkPager'
import NoAccess from '@/components/ui/NoAccess'
import { activityFilterOptions, listActivity } from '@/server/activity/activity'
import { diffRows } from '@/server/activity/diff'
import { getSession } from '@/server/auth/current'
import { branchScope, seesCompanyWide } from '@/server/branch'
import { appTimezone, formatLocalDateTime } from '@/server/dates'
import { getDb } from '@/server/db'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import { isIsoDate } from '@/server/reports/pure'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardBody, Table } from 'react-bootstrap'
import { z } from 'zod'

export const metadata: Metadata = { title: 'Activity log' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const PAGE_SIZE = 50

/** Where a logged entity can be opened (only when the viewer may see that module). */
const LINKS: Record<string, { path: string; perm: Parameters<typeof can>[1] }> = {
  vendor: { path: '/vendors/', perm: 'vendors.view' },
  customer: { path: '/customers/', perm: 'customers.view' },
  purchase: { path: '/purchases/', perm: 'purchases.view' },
  sale: { path: '/sales/', perm: 'sales.view' },
}

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  // The log spans every branch: with more than one branch it also needs branches.all.
  if (!can(session, 'activity.view') || !seesCompanyWide(await branchScope(session))) return (<><PageBreadcrumb title="Activity log" subtitle="Administration" /><NoAccess /></>)

  const sp = await searchParams
  const { q, page, offset } = parseListParams(sp, { pageSize: PAGE_SIZE })
  const userId = z.uuid().safeParse(one(sp.user)).data
  const entity = (one(sp.entity) ?? '').slice(0, 40) || undefined
  const action = (one(sp.action) ?? '').trim().slice(0, 60) || undefined
  const from = isIsoDate(one(sp.from)) ? one(sp.from) : undefined
  const to = isIsoDate(one(sp.to)) ? one(sp.to) : undefined
  const tz = appTimezone()
  const showIp = can(session, 'users.view')

  const db = getDb()
  const [{ rows, total }, opts] = await Promise.all([listActivity(db, session.cid, { userId, entity, action, from, to, q, tz, limit: PAGE_SIZE, offset }), activityFilterOptions(db, session.cid)])

  return (
    <>
      <PageBreadcrumb title="Activity log" subtitle="Administration" />
      <Card>
        <CardBody>
          <FilterBar
            fields={[
              { name: 'q', label: 'Search', type: 'text', placeholder: 'action, record, user…', width: 200 },
              { name: 'user', label: 'User', type: 'select', options: [{ value: '', label: 'All users' }, ...opts.users.map((u) => ({ value: u.id, label: u.name }))], width: 180 },
              { name: 'entity', label: 'Record type', type: 'select', options: [{ value: '', label: 'All' }, ...opts.entities.map((e) => ({ value: e, label: e }))], width: 160 },
              { name: 'action', label: 'Action', type: 'text', placeholder: 'e.g. update', width: 140 },
              { name: 'from', label: 'From', type: 'date' },
              { name: 'to', label: 'To', type: 'date' },
            ]}
            values={{ q, user: userId ?? '', entity: entity ?? '', action: action ?? '', from: from ?? '', to: to ?? '' }}
          />
          <p className="text-muted small">Times in {tz}. Newest first.</p>
          {rows.length === 0 ? (
            <EmptyState icon="history" title="No activity found" description="Try a wider date range or clear the filters." />
          ) : (
            <Table responsive size="sm" className="align-middle">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Record</th>
                  {showIp && <th>IP</th>}
                  <th style={{ width: '35%' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const diff = diffRows(r.before, r.after)
                  const link = r.entityId && LINKS[r.entity] && can(session, LINKS[r.entity].perm) && z.uuid().safeParse(r.entityId).success ? LINKS[r.entity].path + r.entityId : null
                  return (
                    <tr key={r.id}>
                      <td className="text-nowrap small">{formatLocalDateTime(r.createdAt, tz)}</td>
                      <td>
                        {r.userName ?? <span className="text-muted">System</span>}
                        {r.userEmail && <div className="small text-muted">{r.userEmail}</div>}
                      </td>
                      <td>
                        <code>{r.action}</code>
                      </td>
                      <td className="small" style={{ overflowWrap: 'anywhere' }}>
                        {r.entity}
                        {r.entityId && <div className="text-muted">{link ? <Link href={link}>{r.entityId.slice(0, 8)}…</Link> : r.entityId.length > 12 ? `${r.entityId.slice(0, 8)}…` : r.entityId}</div>}
                      </td>
                      {showIp && <td className="small text-muted">{r.ip ?? '-'}</td>}
                      <td>
                        {diff.length === 0 ? (
                          <span className="text-muted small">-</span>
                        ) : (
                          <details>
                            <summary className="small">{diff.length} field(s)</summary>
                            <Table size="sm" bordered className="mt-1 mb-0 small" style={{ tableLayout: 'fixed' }}>
                              <thead>
                                <tr>
                                  <th style={{ width: '30%' }}>Field</th>
                                  <th>Before</th>
                                  <th>After</th>
                                </tr>
                              </thead>
                              <tbody>
                                {diff.map((d) => (
                                  <tr key={d.key} className={d.changed ? 'table-warning' : undefined}>
                                    <td>{d.key}</td>
                                    <td style={{ overflowWrap: 'anywhere' }}>{d.before}</td>
                                    <td style={{ overflowWrap: 'anywhere' }}>{d.after}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </Table>
                          </details>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          )}
          <LinkPager path="/activity" sp={sp} total={total} page={page} pageSize={PAGE_SIZE} itemsName="entries" />
        </CardBody>
      </Card>
    </>
  )
}
