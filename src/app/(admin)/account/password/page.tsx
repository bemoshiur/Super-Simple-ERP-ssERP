import PageBreadcrumb from '@/components/PageBreadcrumb'
import { getSession } from '@/server/auth/current'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody, Col, Row } from 'react-bootstrap'
import ChangePasswordForm from './ChangePasswordForm'

export const metadata: Metadata = { title: 'Change password' }

export default async function Page() {
  if (!(await getSession())) redirect('/auth/login')
  return (
    <>
      <PageBreadcrumb title="Change password" subtitle="Account" />
      <Row>
        <Col lg={6}>
          <Card>
            <CardBody>
              <ChangePasswordForm />
            </CardBody>
          </Card>
        </Col>
      </Row>
    </>
  )
}
