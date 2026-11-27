import EmptyState from '@/components/ui/EmptyState'
import MoneyText from '@/components/ui/MoneyText'
import PageBreadcrumb from '@/components/PageBreadcrumb'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { loadDashboard } from '@/server/dashboard'
import { canSeeProfit } from '@/server/lookup/lookup'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert, Col, Row } from 'react-bootstrap'
import DashboardCharts from './components/DashboardCharts'
import KpiCard from './components/KpiCard'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')

  // Each widget group is gated by the permission that owns its data; queries only run for visible groups.
  const scope = { sales: can(session, 'sales.view'), inventory: can(session, 'products.view'), accounts: can(session, 'accounts.view'), stockValue: canSeeProfit(session) }
  const b = await branchScope(session)
  const { data, failed } = await loadDashboard(session.cid, b.filter, scope)
  const nothing = !scope.sales && !scope.inventory && !scope.accounts

  return (
    <>
      <PageBreadcrumb title="Dashboard" />

      {failed.length > 0 && (
        <Alert variant="warning" className="mb-3">
          Some figures could not be loaded ({failed.join(', ')}) and are shown as zero. Check the database connection and reload.
        </Alert>
      )}

      {nothing ? (
        <EmptyState icon="layout-dashboard" title="Welcome to ssERP" description="Your role has no dashboard widgets. Use the menu to open the sections you have access to." />
      ) : (
        <>
          <Row className="g-3 mb-3">
            {scope.sales && (
              <>
                <Col xxl={2} md={4} sm={6}>
                  <KpiCard icon="banknote" tone="primary" label="Today's Sales" value={<MoneyText value={data.salesToday} />} />
                </Col>
                <Col xxl={2} md={4} sm={6}>
                  <KpiCard icon="calendar-days" tone="info" label="This Month's Sales" value={<MoneyText value={data.salesMonth} />} />
                </Col>
              </>
            )}
            {scope.inventory && (
              <>
                {scope.stockValue && (
                  <Col xxl={2} md={4} sm={6}>
                    <KpiCard icon="package" tone="success" label="Stock Value" value={<MoneyText value={data.stockValue} />} hint="at net cost" />
                  </Col>
                )}
                <Col xxl={2} md={4} sm={6}>
                  <Link href="/stock?low=1" className="text-reset text-decoration-none" title="Open low-stock products">
                    <KpiCard icon="triangle-alert" tone={data.lowStock > 0 ? 'danger' : 'secondary'} label="Low Stock Items" value={String(data.lowStock)} hint={data.lowStock > 0 ? 'at or below threshold' : 'all stocked'} />
                  </Link>
                </Col>
              </>
            )}
            {scope.accounts && (
              <>
                <Col xxl={2} md={4} sm={6}>
                  <KpiCard icon="hand-coins" tone="warning" label="Customer Due" value={<MoneyText value={data.customerDue} />} hint="to receive" />
                </Col>
                <Col xxl={2} md={4} sm={6}>
                  <KpiCard icon="wallet" tone="danger" label="Vendor Due" value={<MoneyText value={data.vendorDue} />} hint="to pay" />
                </Col>
              </>
            )}
          </Row>

          {scope.sales && <DashboardCharts last7={data.last7} top={data.top} />}
        </>
      )}
    </>
  )
}
