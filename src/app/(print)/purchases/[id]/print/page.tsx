import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getCompanyProfile } from '@/server/company'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { fmtBD } from '@/server/money'
import { getPurchase } from '@/server/purchases/purchases'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import CompanyLogo from '../../../CompanyLogo'
import PrintButton from '../../../PrintButton'

export const metadata: Metadata = { title: 'Print purchase' }

const CSS = `
@page { size: A4; margin: 12mm; }
.print-doc { max-width: 190mm; margin: 0 auto; padding: 16px; color: #000; background: #fff; font-size: 12px; }
.print-doc table { width: 100%; border-collapse: collapse; }
.print-doc th, .print-doc td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
.print-doc th { background: #f2f2f2; text-align: left; }
.print-doc .num { text-align: right; white-space: nowrap; }
.print-doc .serials { font-family: ui-monospace, Menlo, monospace; font-size: 10px; word-break: break-all; }
.print-doc .totals td { border: none; padding: 2px 6px; }
@media print {
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .print-doc { padding: 0; max-width: none; }
  tr { page-break-inside: avoid; }
}
`

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'purchases.view')) return <p className="p-4">You do not have permission to view purchases.</p>
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const db = getDb()
  let p
  try {
    p = await getPurchase(db, session.cid, (await branchScope(session)).restrict, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const company = await getCompanyProfile(db, session.cid)
  const money = (v: string) => fmtBD(v, company.currencySymbol)

  return (
    <>
      <style>{CSS}</style>
      <div className="print-doc">
        <div className="no-print d-flex justify-content-between mb-3">
          <a href={`/purchases/${p.id}`} className="btn btn-light btn-sm">
            Back
          </a>
          <PrintButton />
        </div>
        <div className="d-flex justify-content-between align-items-start mb-3">
          <div>
            <CompanyLogo src={company.logoUrl} name={company.name} />
            <h2 className="mb-0" style={{ fontSize: 20 }}>{company.name}</h2>
            <div>Purchase invoice</div>
          </div>
          <div className="text-end">
            <div style={{ fontSize: 16, fontWeight: 600 }}>{p.invoiceNo}</div>
            <div>Date: {p.date}</div>
          </div>
        </div>
        <div className="mb-3">
          <strong>Vendor:</strong> {p.vendorName}
          {p.vendorPhone && <> · {p.vendorPhone}</>}
          {p.vendorAddress && <div style={{ whiteSpace: 'pre-line' }}>{p.vendorAddress}</div>}
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}>#</th>
              <th>Product / serials</th>
              <th className="num">Qty</th>
              <th className="num">Unit cost</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((it, i) => (
              <tr key={it.id}>
                <td>{i + 1}</td>
                <td>
                  <div>
                    {it.productName} <span style={{ color: '#555' }}>({it.sku})</span>
                  </div>
                  {it.units.length > 0 && <div className="serials">{it.units.map((u) => u.serialNo).join(', ')}</div>}
                </td>
                <td className="num">{it.qty}</td>
                <td className="num">{money(it.unitCost)}</td>
                <td className="num">{money(it.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="totals mt-2" style={{ width: '45%', marginLeft: 'auto' }}>
          <tbody>
            <tr><td>Subtotal</td><td className="num">{money(p.subtotal)}</td></tr>
            <tr><td>Discount</td><td className="num">{money(p.discount)}</td></tr>
            <tr><td><strong>Total</strong></td><td className="num"><strong>{money(p.total)}</strong></td></tr>
            {p.returnedTotal !== '0.00' && <tr><td>Returned (credit)</td><td className="num">{money(p.returnedTotal)}</td></tr>}
            <tr><td>Paid</td><td className="num">{money(p.paid)}</td></tr>
            <tr><td><strong>Due</strong></td><td className="num"><strong>{money(p.due)}</strong></td></tr>
          </tbody>
        </table>
        {p.note && <p className="mt-3" style={{ whiteSpace: 'pre-line' }}>Note: {p.note}</p>}
        <div className="d-flex justify-content-between" style={{ marginTop: 60 }}>
          <div style={{ borderTop: '1px solid #000', width: 180, textAlign: 'center' }}>Received by</div>
          <div style={{ borderTop: '1px solid #000', width: 180, textAlign: 'center' }}>Authorised signature</div>
        </div>
      </div>
    </>
  )
}
