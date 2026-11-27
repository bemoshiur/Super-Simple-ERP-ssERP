import PageBreadcrumb from '@/components/PageBreadcrumb'
import EmptyState from '@/components/ui/EmptyState'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { searchSerials, SEARCH_LIMIT } from '@/server/lookup/lookup'
import type { RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardBody, Table } from 'react-bootstrap'
import UnitChip from '../purchases/UnitChip'
import SerialSearchBox from './SerialSearchBox'

export const metadata: Metadata = { title: 'Serial Lookup' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'serials.view')) return (<><PageBreadcrumb title="Serial Lookup" subtitle="Business" /><NoAccess /></>)
  const raw = (await searchParams).q
  const b = await branchScope(session)
  const result = await searchSerials(getDb(), session.cid, b.restrict, Array.isArray(raw) ? raw[0] : raw)
  if (result.redirectUnitId) redirect(`/serials/${result.redirectUnitId}${result.match === 'partial' ? '?via=partial' : result.match === 'exact_ci' ? '?via=case' : ''}`)

  return (
    <>
      <PageBreadcrumb title="Serial Lookup" subtitle="Business" />
      <Card>
        <CardBody>
          <SerialSearchBox initial={result.query} />
          <p className="text-muted small mt-2 mb-0">
            Where did this unit come from, who has it now, and what happened in between? Scan or paste a serial / IMEI.{' '}
            <a href="/serials/labels" target="_blank" rel="noopener">
              Print labels for units in stock
            </a>
          </p>
        </CardBody>
      </Card>
      {result.match === 'none' && (
        <Card className="mt-3">
          <CardBody>
            <EmptyState icon="search-x" title={`No serial matches "${result.query}"`} description="Check the number and try again. A partial number works too." className="py-4" />
          </CardBody>
        </Card>
      )}
      {result.matches.length > 0 && (
        <Card className="mt-3">
          <CardBody>
            <h5 className="mb-3">
              {result.match === 'partial' ? 'Partial matches' : result.match === 'exact' ? 'Found' : 'Matches that differ only by letter case'} for <span className="font-monospace">{result.query}</span>
            </h5>
            <Table responsive hover className="align-middle mb-0">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Product</th>
                  {b.multi && <th>Branch</th>}
                  <th>Warranty until</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.matches.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <UnitChip serial={m.serialNo} status={m.status} />
                    </td>
                    <td>{m.inScope ? m.productName : <span className="text-muted">-</span>}</td>
                    {b.multi && <td>{m.branchName ?? ''}</td>}
                    <td className="text-nowrap">{m.warrantyEnd ?? <span className="text-muted">-</span>}</td>
                    <td className="text-end">
                      {m.inScope ? (
                        <Link href={`/serials/${m.id}`} className="btn btn-sm btn-tonal-primary">
                          Open history
                        </Link>
                      ) : (
                        <span className="text-muted small">Details visible to {m.branchName ?? 'that branch'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {result.truncated && <div className="small text-muted mt-2">Showing the first {SEARCH_LIMIT} matches. Type more of the serial to narrow it down.</div>}
          </CardBody>
        </Card>
      )}
    </>
  )
}
