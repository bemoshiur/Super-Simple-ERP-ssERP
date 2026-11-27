import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getCompanyProfile } from '@/server/company'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { fmtBD } from '@/server/money'
import { can } from '@/server/rbac'
import { getSale } from '@/server/sales/sales'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import CompanyLogo from '../../../CompanyLogo'
import PrintButton from '../../../PrintButton'

export const metadata: Metadata = { title: 'Print invoice' }

const A4 = `
@page { size: A4; margin: 12mm; }
.print-doc { max-width: 190mm; margin: 0 auto; padding: 16px; color: #000; background: #fff; font-size: 12px; }
.print-doc table.lines { width: 100%; border-collapse: collapse; }
.print-doc table.lines th, .print-doc table.lines td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
.print-doc table.lines th { background: #f2f2f2; text-align: left; }
.print-doc .totals { width: 45%; margin-left: auto; border-collapse: collapse; }
.print-doc .totals td { padding: 2px 6px; }
.print-doc .sign { display: flex; justify-content: space-between; margin-top: 60px; }
.print-doc .sign div { border-top: 1px solid #000; width: 180px; text-align: center; }
`

const THERMAL = `
@page { size: 80mm auto; margin: 3mm; }
.print-doc { width: 74mm; margin: 0 auto; padding: 4px 0; color: #000; background: #fff; font-size: 11px; line-height: 1.3; }
.print-doc .head { text-align: center; display: block !important; }
.print-doc .head > div { text-align: center !important; }
.print-doc table.lines { width: 100%; border-collapse: collapse; }
.print-doc table.lines th { border-bottom: 1px dashed #000; text-align: left; font-weight: 600; padding: 2px 0; }
.print-doc table.lines td { padding: 2px 0; vertical-align: top; border-bottom: 1px dotted #bbb; }
.print-doc table.lines .col-no, .print-doc table.lines .col-unit { display: none; }
.print-doc .totals { width: 100%; border-top: 1px dashed #000; margin-top: 4px; }
.print-doc .totals td { padding: 1px 0; }
.print-doc .sign { display: none; }
`

const COMMON = `
.print-doc .num { text-align: right; white-space: nowrap; }
.print-doc .serials { font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; word-break: break-all; }
.print-doc .muted { color: #555; }
@media print {
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .print-doc { padding: 0; }
  tr { page-break-inside: avoid; }
}
`

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ paper?: string | string[] }> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'sales.view')) return <p className="p-4">You do not have permission to view sales.</p>
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const thermal = (Array.isArray(sp.paper) ? sp.paper[0] : sp.paper) === '80mm'
  const db = getDb()
  let s
  let scope
  try {
    scope = await branchScope(session)
    s = await getSale(db, session.cid, scope.restrict, id)
  } catch (e) {
    if (e instanceof NotFoundError) notFound()
    throw e
  }
  const co = await getCompanyProfile(db, session.cid)
  const money = (v: string) => fmtBD(v, co.currencySymbol)

  return (
    <>
      <style>{(thermal ? THERMAL : A4) + COMMON}</style>
      <div className="print-doc">
        <div className="no-print d-flex flex-wrap gap-2 justify-content-between align-items-center mb-3">
          <a href={`/sales/${s.id}`} className="btn btn-light btn-sm">
            Back
          </a>
          <div className="btn-group btn-group-sm" role="group" aria-label="Paper size">
            <a href={`/sales/${s.id}/print`} className={`btn ${thermal ? 'btn-outline-secondary' : 'btn-secondary'}`} aria-current={!thermal}>
              A4
            </a>
            <a href={`/sales/${s.id}/print?paper=80mm`} className={`btn ${thermal ? 'btn-secondary' : 'btn-outline-secondary'}`} aria-current={thermal}>
              80mm receipt
            </a>
          </div>
          <PrintButton label="Print / Save as PDF" />
        </div>
        <div className="head d-flex justify-content-between align-items-start mb-2">
          <div>
            <CompanyLogo src={co.logoUrl} name={co.name} height={thermal ? 36 : 48} />
            <div style={{ fontSize: thermal ? 14 : 20, fontWeight: 700 }}>{co.name}</div>
            {co.address && <div style={{ whiteSpace: 'pre-line' }}>{co.address}</div>}
            {co.phone && <div>Phone: {co.phone}</div>}
          </div>
          <div className="text-end">
            <div style={{ fontSize: thermal ? 12 : 16, fontWeight: 600 }}>INVOICE {s.invoiceNo}</div>
            {scope.multi && s.branchName && <div>Branch: {s.branchName} ({s.branchCode})</div>}
            <div>Date: {s.date}</div>
            {s.createdByName && <div className="muted">Sold by: {s.createdByName}</div>}
          </div>
        </div>
        <div className="mb-2">
          <strong>Customer:</strong> {s.customerId ? s.customerName : 'Walk-in customer'}
          {s.customerPhone && <> · {s.customerPhone}</>}
          {s.customerAddress && !thermal && <div style={{ whiteSpace: 'pre-line' }}>{s.customerAddress}</div>}
        </div>
        <table className="lines">
          <thead>
            <tr>
              <th className="col-no" style={{ width: 28 }}>#</th>
              <th>Item</th>
              <th className="num">Qty</th>
              <th className="num col-unit">Price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {s.items.map((it, i) => (
              <tr key={it.id}>
                <td className="col-no">{i + 1}</td>
                <td>
                  <div>{it.productName}</div>
                  {it.serialNo && <div className="serials">S/N: {it.serialNo}</div>}
                  {it.serialNo && it.warrantyEnd && <div className="muted">Warranty until {it.warrantyEnd}</div>}
                  {!it.serialNo && it.productWarrantyMonths > 0 && <div className="muted">Warranty {it.productWarrantyMonths} months</div>}
                  {thermal && it.qty > 1 && <div className="muted">{it.qty} × {money(it.unitPrice)}</div>}
                  {it.returnedQty > 0 && <div className="muted">Returned: {it.returnedQty}</div>}
                </td>
                <td className="num">{it.qty}</td>
                <td className="num col-unit">{money(it.unitPrice)}</td>
                <td className="num">{money(it.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="totals mt-2">
          <tbody>
            <tr><td>Subtotal</td><td className="num">{money(s.subtotal)}</td></tr>
            {s.discount !== '0.00' && <tr><td>Discount</td><td className="num">-{money(s.discount)}</td></tr>}
            <tr><td><strong>Total</strong></td><td className="num"><strong>{money(s.total)}</strong></td></tr>
            {s.returnedTotal !== '0.00' && <tr><td>Returned</td><td className="num">-{money(s.returnedTotal)}</td></tr>}
            <tr><td>Paid</td><td className="num">{money(s.paid)}</td></tr>
            <tr><td><strong>Due</strong></td><td className="num"><strong>{money(s.due)}</strong></td></tr>
          </tbody>
        </table>
        {s.payments.length > 0 && (
          <div className="mt-2 muted">
            {s.payments.map((x) => (
              <div key={x.id}>
                {x.direction === 'out' ? 'Refund' : 'Paid'} {money(x.amount)} · {x.accountName}
                {x.method ? ` (${x.method})` : ''} · {x.date}
              </div>
            ))}
          </div>
        )}
        {s.note && <p className="mt-2" style={{ whiteSpace: 'pre-line' }}>Note: {s.note}</p>}
        {co.footer && <p className="mt-3 text-center" style={{ whiteSpace: 'pre-line' }}>{co.footer}</p>}
        <div className="sign">
          <div>Customer signature</div>
          <div>Authorised signature</div>
        </div>
      </div>
    </>
  )
}
