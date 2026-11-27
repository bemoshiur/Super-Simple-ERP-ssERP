import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { getCompanyProfile } from '@/server/company'
import { getDb } from '@/server/db'
import { NotFoundError } from '@/server/errors'
import { loadLabelUnits } from '@/server/labels/labels'
import { LABEL_LAYOUTS, LAYOUT_ORDER, MAX_LABELS, labelQuery, parseLabelParams } from '@/server/labels/pure'
import type { RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import PrintButton from '../../PrintButton'
import LabelSheet from './LabelSheet'

export const metadata: Metadata = { title: 'Print labels' }

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'serials.view')) return <p className="p-4">You do not have permission to print serial labels.</p>
  const params = parseLabelParams(await searchParams)
  const db = getDb()
  let sel
  try {
    sel = await loadLabelUnits(db, session.cid, await branchScope(session), params)
  } catch (e) {
    if (e instanceof NotFoundError) return <p className="p-4">That purchase was not found. <Link href="/purchases">Back to purchases</Link></p>
    throw e
  }
  const company = await getCompanyProfile(db, session.cid)
  const backHref = params.source === 'purchase' ? `/purchases/${params.purchaseId}` : '/serials'

  return (
    <div className="p-3">
      <div className="no-print mb-3">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
          <div>
            <h4 className="mb-0">Serial labels</h4>
            <div className="text-muted small">
              {sel.title}: {sel.labels.length} label{sel.labels.length === 1 ? '' : 's'}. The QR code holds the serial number only; no prices are printed.
            </div>
          </div>
          <div className="d-flex gap-2">
            <a href={backHref} className="btn btn-light btn-sm">
              Back
            </a>
            <PrintButton label="Print labels" />
          </div>
        </div>
        {(sel.truncated || (params.source === 'ids' && params.tooMany)) && (
          <div className="alert alert-warning py-2">
            Only the first {MAX_LABELS} of {sel.total > sel.labels.length ? sel.total : 'more than ' + MAX_LABELS} units are shown: one print job holds at most {MAX_LABELS} labels. Narrow the selection (a product SKU, or one purchase invoice) for the rest.
          </div>
        )}
        <form method="get" className="row g-2 align-items-end">
          {params.source === 'purchase' && <input type="hidden" name="purchase" value={params.purchaseId} />}
          {params.source === 'ids' && <input type="hidden" name="ids" value={params.ids.join(',')} />}
          {params.source === 'stock' && (
            <div className="col-auto">
              <label htmlFor="lbl-sku" className="form-label small mb-0">
                Product SKU (blank = every unit in stock)
              </label>
              <input id="lbl-sku" name="sku" className="form-control form-control-sm" defaultValue={params.sku ?? ''} maxLength={100} autoComplete="off" />
            </div>
          )}
          <div className="col-auto">
            <label htmlFor="lbl-layout" className="form-label small mb-0">
              Label size
            </label>
            <select id="lbl-layout" name="layout" className="form-select form-select-sm" defaultValue={params.layout}>
              {LAYOUT_ORDER.map((id) => (
                <option key={id} value={id}>
                  {LABEL_LAYOUTS[id].name}
                </option>
              ))}
            </select>
          </div>
          <div className="col-auto">
            <div className="form-check mb-1">
              <input id="lbl-barcode" className="form-check-input" type="checkbox" name="barcode" value="1" defaultChecked={params.barcode} />
              <label htmlFor="lbl-barcode" className="form-check-label small">
                Also print a Code 128 barcode
              </label>
            </div>
          </div>
          <div className="col-auto">
            <button type="submit" className="btn btn-tonal-primary btn-sm">
              Update
            </button>
          </div>
        </form>
        <div className="text-muted small mt-2">
          {LABEL_LAYOUTS[params.layout].description}. In the print dialog set margins to &quot;Default&quot; (or &quot;None&quot; for roll printers) and scale to 100%. Share this exact selection: <code>?{labelQuery(params)}</code>
        </div>
      </div>
      {sel.labels.length === 0 ? (
        <p className="text-muted">No units match this selection.</p>
      ) : (
        <LabelSheet labels={sel.labels} layout={params.layout} shop={company.name} barcode={params.barcode} />
      )}
    </div>
  )
}
