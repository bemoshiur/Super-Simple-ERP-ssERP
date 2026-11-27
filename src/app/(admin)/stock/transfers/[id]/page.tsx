import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { getStockTransfer } from '@/server/inventory/transfers'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Card, CardBody, Col, Row, Table } from 'react-bootstrap'
import { z } from 'zod'

export const metadata: Metadata = { title: 'Transfer' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.view')) return (<><PageBreadcrumb title="Transfer" subtitle="Inventory" /><NoAccess /></>)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  let t
  try {
    t = await getStockTransfer(getDb(), session.cid, (await branchScope(session)).restrict, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const units = t.items.filter((i) => i.unitId)
  const lines = t.items.filter((i) => !i.unitId)
  const showSerials = can(session, 'serials.view')
  return (
    <>
      <PageBreadcrumb title={t.transferNo} subtitle="Transfers" />
      <div className="d-flex justify-content-end gap-2 mb-3">
        <Link href={`/stock/transfers/${t.id}/print`} className="btn btn-light btn-sm" target="_blank">Print</Link>
        <Link href="/stock/transfers" className="btn btn-light btn-sm">All transfers</Link>
      </div>
      <Card>
        <CardBody>
          <Row className="g-3 mb-3">
            <Col sm={3}><div className="text-muted small">From</div><div className="fw-semibold">{t.fromName} ({t.fromCode})</div></Col>
            <Col sm={3}><div className="text-muted small">To</div><div className="fw-semibold">{t.toName} ({t.toCode})</div></Col>
            <Col sm={3}><div className="text-muted small">Date</div><div>{t.date}</div></Col>
            <Col sm={3}><div className="text-muted small">By</div><div>{t.createdByName ?? ''}</div></Col>
            {t.note && <Col sm={12}><div className="text-muted small">Note</div><div>{t.note}</div></Col>}
          </Row>
          <Table size="sm" responsive className="align-middle mb-0">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Serial</th>
                <th className="text-end">Qty</th>
              </tr>
            </thead>
            <tbody>
              {[...units, ...lines].map((i) => (
                <tr key={i.id}>
                  <td>{i.productName}</td>
                  <td className="text-muted">{i.sku}</td>
                  <td className="font-monospace">{i.serialNo ? (showSerials ? <Link href={`/serials/${i.unitId}`}>{i.serialNo}</Link> : i.serialNo) : ''}</td>
                  <td className="text-end">{i.qty}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="text-muted small mt-2">{units.length} serial unit{units.length === 1 ? '' : 's'}, {lines.reduce((a, l) => a + l.qty, 0)} quantity item{lines.length === 1 ? '' : 's'}. Transfers are immediate: the goods were moved when this was saved.</div>
        </CardBody>
      </Card>
    </>
  )
}
