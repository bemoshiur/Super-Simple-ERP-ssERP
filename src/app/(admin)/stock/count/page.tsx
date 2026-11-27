import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import CountSheet from './CountSheet'

export const metadata: Metadata = { title: 'Stock count' }

/** Stock-take helper: count vs system difference report; non-serial corrections can be applied (products.edit). */
export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.edit')) return (<><PageBreadcrumb title="Stock count" subtitle="Inventory" /><NoAccess /></>)
  return (
    <>
      <PageBreadcrumb title="Stock count" subtitle="Inventory" />
      <Card>
        <CardBody>
          <CountSheet canViewSerials={can(session, 'serials.view')} />
        </CardBody>
      </Card>
    </>
  )
}
