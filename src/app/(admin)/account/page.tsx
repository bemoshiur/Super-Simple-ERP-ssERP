import PageBreadcrumb from '@/components/PageBreadcrumb'
import { getSessionUser } from '@/server/auth/current'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Card, CardBody, Col, Row } from 'react-bootstrap'

export const metadata: Metadata = { title: 'My profile' }

export default async function Page() {
  const me = await getSessionUser()
  if (!me) redirect('/auth/login')
  const { session, name, email } = me
  return (
    <>
      <PageBreadcrumb title="My profile" subtitle="Account" />
      <Row>
        <Col lg={6}>
          <Card>
            <CardBody>
              <dl className="row mb-0">
                <dt className="col-sm-4">Name</dt>
                <dd className="col-sm-8">{name}</dd>
                <dt className="col-sm-4">Email</dt>
                <dd className="col-sm-8" style={{ overflowWrap: 'anywhere' }}>{email}</dd>
                <dt className="col-sm-4">Role</dt>
                <dd className="col-sm-8 text-capitalize">{session.role}</dd>
              </dl>
              <hr />
              <div className="d-flex flex-wrap gap-2">
                <Link href="/account/password" className="btn btn-primary">
                  Change password
                </Link>
                {can(session, 'users.edit') && (
                  <Link href="/users" className="btn btn-light">
                    Manage users
                  </Link>
                )}
              </div>
              <p className="text-muted small mt-3 mb-0">To change your name, email or role, ask an administrator.</p>
            </CardBody>
          </Card>
        </Col>
      </Row>
    </>
  )
}
