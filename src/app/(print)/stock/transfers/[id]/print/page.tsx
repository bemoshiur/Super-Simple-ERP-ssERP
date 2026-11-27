import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getCompanyProfile } from '@/server/company'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { getStockTransfer } from '@/server/inventory/transfers'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import CompanyLogo from '../../../../CompanyLogo'
import PrintButton from '../../../../PrintButton'

export const metadata: Metadata = { title: 'Print transfer' }

const CSS = `
@page { size: A4; margin: 12mm; }
.print-doc { max-width: 190mm; margin: 0 auto; padding: 16px; color: #000; background: #fff; font-size: 12px; }
.print-doc table { width: 100%; border-collapse: collapse; }
.print-doc th, .print-doc td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
.print-doc th { background: #f2f2f2; text-align: left; }
.print-doc .num { text-align: right; white-space: nowrap; }
.print-doc .mono { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
@media print { body { background: #fff !important; } .no-print { display: none !important; } .print-doc { padding: 0; max-width: none; } tr { page-break-inside: avoid; } }
`

/** Transfer note (delivery slip) with signature lines for the sending and receiving branch. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'products.view')) return <p className="p-4">You do not have permission to view transfers.</p>
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  let t
  try {
    t = await getStockTransfer(db, session.cid, (await branchScope(session)).restrict, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const company = await getCompanyProfile(db, session.cid)
  return (
    <>
      <style>{CSS}</style>
      <div className="print-doc">
        <div className="no-print d-flex justify-content-between mb-3">
          <a href={`/stock/transfers/${t.id}`} className="btn btn-light btn-sm">Back</a>
          <PrintButton />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <CompanyLogo src={company.logoUrl} name={company.name} />
            <div style={{ fontSize: 16, fontWeight: 700 }}>{company.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>STOCK TRANSFER</div>
            <div>{t.transferNo}</div>
            <div>Date: {t.date}</div>
          </div>
        </div>
        <table style={{ marginBottom: 12 }}>
          <tbody>
            <tr>
              <th style={{ width: '50%' }}>From</th>
              <th>To</th>
            </tr>
            <tr>
              <td>{t.fromName} ({t.fromCode})</td>
              <td>{t.toName} ({t.toCode})</td>
            </tr>
          </tbody>
        </table>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Product</th>
              <th>SKU</th>
              <th>Serial / IMEI</th>
              <th className="num">Qty</th>
            </tr>
          </thead>
          <tbody>
            {t.items.map((i, n) => (
              <tr key={i.id}>
                <td>{n + 1}</td>
                <td>{i.productName}</td>
                <td>{i.sku}</td>
                <td className="mono">{i.serialNo ?? ''}</td>
                <td className="num">{i.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.note && <p style={{ marginTop: 8 }}>Note: {t.note}</p>}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 48 }}>
          <div style={{ borderTop: '1px solid #000', width: '40%', textAlign: 'center', paddingTop: 4 }}>Sent by ({t.fromName}){t.createdByName ? `: ${t.createdByName}` : ''}</div>
          <div style={{ borderTop: '1px solid #000', width: '40%', textAlign: 'center', paddingTop: 4 }}>Received by ({t.toName})</div>
        </div>
      </div>
    </>
  )
}
