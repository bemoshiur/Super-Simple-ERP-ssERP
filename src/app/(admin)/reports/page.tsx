import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import Icon from '@/components/wrappers/Icon'
import { getSession } from '@/server/auth/current'
import { can } from '@/server/rbac'
import { REPORTS, canOpenReport } from '@/server/reports/registry'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardBody, Col, Row } from 'react-bootstrap'

export const metadata: Metadata = { title: 'Reports' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'reports.view')) return (<><PageBreadcrumb title="Reports" subtitle="Finance" /><NoAccess /></>)
  const cards = REPORTS.filter((r) => canOpenReport(session, r))
  return (
    <>
      <PageBreadcrumb title="Reports" subtitle="Finance" />
      <Row className="g-3">
        {cards.map((r) => (
          <Col key={r.key} md={6} xl={4}>
            <Link href={`/reports/${r.key}`} className="text-reset text-decoration-none">
              <Card className="h-100 border">
                <CardBody className="d-flex gap-3">
                  <div className="icon-tile bg-primary-subtle text-primary" aria-hidden="true">
                    <Icon icon={r.icon} className="fs-4" />
                  </div>
                  <div>
                    <h5 className="mb-1">{r.title}</h5>
                    <p className="text-muted mb-0">{r.description}</p>
                  </div>
                </CardBody>
              </Card>
            </Link>
          </Col>
        ))}
        {can(session, 'serials.view') && (
          <Col md={6} xl={4}>
            <Link href="/serials" className="text-reset text-decoration-none">
              <Card className="h-100 border">
                <CardBody className="d-flex gap-3">
                  <div className="icon-tile bg-primary-subtle text-primary" aria-hidden="true">
                    <Icon icon="scan-barcode" className="fs-4" />
                  </div>
                  <div>
                    <h5 className="mb-1">Serial history</h5>
                    <p className="text-muted mb-0">Look up one serial / IMEI: purchase, sale, warranty, service and the full timeline.</p>
                  </div>
                </CardBody>
              </Card>
            </Link>
          </Col>
        )}
      </Row>
    </>
  )
}
