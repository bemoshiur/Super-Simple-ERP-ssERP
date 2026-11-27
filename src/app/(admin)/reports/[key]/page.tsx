import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getCompanyProfile } from '@/server/company'
import { getDb, schema } from '@/server/db'
import { ForbiddenError, can } from '@/server/rbac'
import type { RawSearchParams } from '@/server/pagination'
import { reportByKey, runReport } from '@/server/reports/registry'
import { and, asc, eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { Alert, Card, CardBody } from 'react-bootstrap'
import ReportFilters from './ReportFilters'
import ReportTables from './ReportTables'

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const def = reportByKey((await params).key)
  return { title: def?.title ?? 'Report' }
}

export default async function Page({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  const { key } = await params
  const def = reportByKey(key)
  if (!def) notFound()
  if (!can(session, 'reports.view')) return (<><PageBreadcrumb title={def.title} subtitle="Reports" /><NoAccess /></>)

  const sp = await searchParams
  const db = getDb()
  let run
  try {
    run = await runReport(db, session, (await branchScope(session)).filter, key, sp)
  } catch (e) {
    if (e instanceof ForbiddenError) return (<><PageBreadcrumb title={def.title} subtitle="Reports" /><NoAccess /></>)
    throw e
  }
  const { params: p, result } = run
  const cid = session.cid
  const [cust, vend, prod, categories, company] = await Promise.all([
    p.customerId ? db.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(and(eq(schema.customers.id, p.customerId), eq(schema.customers.companyId, cid))) : [],
    p.vendorId ? db.select({ id: schema.vendors.id, name: schema.vendors.name }).from(schema.vendors).where(and(eq(schema.vendors.id, p.vendorId), eq(schema.vendors.companyId, cid))) : [],
    p.productId ? db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(and(eq(schema.products.id, p.productId), eq(schema.products.companyId, cid))) : [],
    def.filters.includes('category') ? db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).where(and(eq(schema.categories.companyId, cid), eq(schema.categories.active, true))).orderBy(asc(schema.categories.name)).limit(300) : [],
    getCompanyProfile(db, cid),
  ])
  const opt = (r: { id: string; name: string }[]) => (r[0] ? { value: r[0].id, label: r[0].name } : null)

  return (
    <>
      <PageBreadcrumb title={def.title} subtitle="Reports" />
      <Card>
        <CardBody>
          <div className="d-none d-print-block mb-3">
            <h4 className="mb-0">{company.name}</h4>
            <div>
              {result.title}
              {result.from && result.to ? ` · ${result.from} to ${result.to}` : ''}
            </div>
          </div>
          <ReportFilters
            filters={def.filters}
            values={{ from: p.from, to: p.to, group: p.group, days: String(p.days), category: (Array.isArray(sp.category) ? sp.category[0] : sp.category) ?? '' }}
            customer={opt(cust)}
            vendor={opt(vend)}
            product={opt(prod)}
            categories={categories.map((c) => ({ value: c.id, label: c.name }))}
            csvBase={`/reports/${key}/csv`}
          />
          {result.truncated && <Alert variant="warning">Only the first rows are shown. Narrow the filters or export the CSV for more.</Alert>}
          <ReportTables tables={result.tables} />
          {result.notes.length > 0 && (
            <div className="small text-muted border-top pt-2">
              {result.notes.map((n, i) => (
                <p key={i} className="mb-1">
                  {n}
                </p>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  )
}
