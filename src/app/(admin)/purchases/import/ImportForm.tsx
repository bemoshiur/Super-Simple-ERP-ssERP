'use client'
import MoneyText from '@/components/ui/MoneyText'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import Icon from '@/components/wrappers/Icon'
import { importPurchaseAction, previewPurchaseImportAction } from '@/server/actions/purchaseImport'
import { searchPurchaseVendorsAction } from '@/server/actions/purchases'
import type { ImportedPurchase, ImportPreview } from '@/server/purchases/import'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { Alert, Button, Card, CardBody, Col, Form, Row, Table } from 'react-bootstrap'
import { newUuid } from '@/utils/uuid'

type Account = { id: string; name: string; type: string }

const downloadText = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

const ImportForm = ({ accounts, today, maxRows, canPrintLabels }: { accounts: Account[]; today: string; maxRows: number; canPrintLabels: boolean }) => {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [vendor, setVendor] = useState<SearchOption | null>(null)
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [discount, setDiscount] = useState('')
  const [paid, setPaid] = useState('')
  const [accountId, setAccountId] = useState(accounts.find((a) => a.type === 'cash')?.id ?? accounts[0]?.id ?? '')
  // One key per import attempt: a double click or retry returns the invoice that was already created.
  const [key, setKey] = useState(() => newUuid())
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [done, setDone] = useState<ImportedPurchase | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)

  const stale = () => {
    setPreview(null)
    setError(null)
    setFieldErrors({})
  }
  const build = () => {
    const fd = new FormData()
    if (file) fd.set('file', file)
    fd.set('vendorId', vendor?.value ?? '')
    fd.set('date', date)
    fd.set('note', note)
    fd.set('discount', discount)
    fd.set('paid', paid)
    fd.set('accountId', paid.trim() ? accountId : '')
    fd.set('idempotencyKey', key)
    return fd
  }
  const run = async (kind: 'preview' | 'import') => {
    setError(null)
    setFieldErrors({})
    if (!file) return setError('Choose a CSV file first.')
    if (!vendor) return setFieldErrors({ vendorId: 'Choose a vendor' })
    setBusy(kind)
    try {
      if (kind === 'preview') {
        const r = await previewPurchaseImportAction(build())
        if (r.ok) setPreview(r.data)
        else {
          setError(r.error)
          setFieldErrors(r.fieldErrors ?? {})
        }
      } else {
        const r = await importPurchaseAction(build())
        if (r.ok) setDone(r.data)
        else {
          setError(r.error)
          setFieldErrors(r.fieldErrors ?? {})
        }
      }
    } catch {
      setError('The request failed (the file may be too large or the connection dropped). Nothing was imported; check Purchases before retrying.')
    } finally {
      setBusy(null)
    }
  }
  const reset = () => {
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
    setPreview(null)
    setDone(null)
    setError(null)
    setFieldErrors({})
    setKey(newUuid())
  }

  if (done)
    return (
      <Card>
        <CardBody>
          <Alert variant="success" className="mb-3">
            <h5 className="alert-heading mb-1">{done.duplicate ? 'Already imported' : 'Imported'}: {done.units} serial{done.units === 1 ? '' : 's'} in {done.lines} line{done.lines === 1 ? '' : 's'}</h5>
            One purchase, <strong>{done.invoiceNo}</strong>, total <MoneyText value={done.total} />{done.due !== '0.00' && <>, due <MoneyText value={done.due} /></>}.
            {done.duplicate && <div className="small">This file had already been imported with this form, so nothing was added twice.</div>}
          </Alert>
          <div className="d-flex flex-wrap gap-2">
            <Link href={`/purchases/${done.id}`} className="btn btn-primary">
              Open invoice {done.invoiceNo}
            </Link>
            {canPrintLabels && (
              <Link href={`/serials/labels?purchase=${done.id}`} className="btn btn-tonal-primary">
                <Icon icon="printer" className="me-1" /> Print labels
              </Link>
            )}
            <Button variant="light" onClick={reset}>
              Import another file
            </Button>
          </div>
        </CardBody>
      </Card>
    )

  const s = preview?.summary
  return (
    <>
      <Card>
        <CardBody>
          <p className="text-muted mb-3">
            Upload a CSV with the columns <code>serial</code>, <code>product_sku</code>, <code>unit_cost</code> (optional: <code>warranty_months</code>, <code>note</code>). Up to {maxRows.toLocaleString('en-US')} rows become <strong>one</strong> purchase invoice. Check the file first: the dry run lists every problem and saves nothing. Quote amounts that use commas, like <code>&quot;12,50,000&quot;</code>.{' '}
            <a href="/examples/serials-import.csv" download>
              Download an example file
            </a>
            .
          </p>
          {error && (
            <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>
              {error}
            </Alert>
          )}
          <Row className="g-3">
            <Col md={5}>
              <Form.Label htmlFor="imp-vendor">Vendor</Form.Label>
              <SearchSelect id="imp-vendor" loadOptions={searchPurchaseVendorsAction} value={vendor} onChange={(o) => { setVendor(o); stale() }} placeholder="Search vendor…" invalid={!!(fieldErrors.vendorId || preview?.headerErrors.vendorId)} />
              {(fieldErrors.vendorId || preview?.headerErrors.vendorId) && <div className="invalid-feedback d-block">{fieldErrors.vendorId || preview?.headerErrors.vendorId}</div>}
            </Col>
            <Col md={3}>
              <Form.Label htmlFor="imp-date">Date</Form.Label>
              <Form.Control id="imp-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); stale() }} isInvalid={!!fieldErrors.date} />
              {fieldErrors.date && <Form.Control.Feedback type="invalid">{fieldErrors.date}</Form.Control.Feedback>}
            </Col>
            <Col md={4}>
              <Form.Label htmlFor="imp-note">Note</Form.Label>
              <Form.Control id="imp-note" value={note} maxLength={500} onChange={(e) => { setNote(e.target.value); stale() }} placeholder="Vendor bill no, remarks…" />
            </Col>
            <Col md={3}>
              <Form.Label htmlFor="imp-discount">Discount</Form.Label>
              <Form.Control id="imp-discount" inputMode="decimal" className="text-end" placeholder="0.00" value={discount} onChange={(e) => { setDiscount(e.target.value); stale() }} isInvalid={!!(fieldErrors.discount || preview?.headerErrors.discount)} />
              <Form.Control.Feedback type="invalid">{fieldErrors.discount || preview?.headerErrors.discount}</Form.Control.Feedback>
            </Col>
            <Col md={3}>
              <Form.Label htmlFor="imp-paid">Paid now</Form.Label>
              <Form.Control id="imp-paid" inputMode="decimal" className="text-end" placeholder="0.00" value={paid} onChange={(e) => { setPaid(e.target.value); stale() }} isInvalid={!!(fieldErrors.paid || preview?.headerErrors.paid)} />
              <Form.Control.Feedback type="invalid">{fieldErrors.paid || preview?.headerErrors.paid}</Form.Control.Feedback>
            </Col>
            {paid.trim() !== '' && (
              <Col md={3}>
                <Form.Label htmlFor="imp-account">Paid from</Form.Label>
                <Form.Select id="imp-account" value={accountId} onChange={(e) => { setAccountId(e.target.value); stale() }} isInvalid={!!(fieldErrors.accountId || preview?.headerErrors.accountId)}>
                  <option value="">Choose account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Form.Select>
                <Form.Control.Feedback type="invalid">{fieldErrors.accountId || preview?.headerErrors.accountId}</Form.Control.Feedback>
              </Col>
            )}
            <Col md={12}>
              <Form.Label htmlFor="imp-file">CSV file</Form.Label>
              <Form.Control
                ref={fileRef}
                id="imp-file"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                isInvalid={!!fieldErrors.file}
                onChange={(e) => {
                  setFile((e.target as HTMLInputElement).files?.[0] ?? null)
                  stale()
                }}
              />
              {fieldErrors.file && <Form.Control.Feedback type="invalid">{fieldErrors.file}</Form.Control.Feedback>}
              <div className="form-text">UTF-8 or Excel &quot;Unicode Text&quot; (UTF-16); comma, semicolon or tab separated. Max 800 KB.</div>
            </Col>
          </Row>
          <div className="mt-3 d-flex gap-2">
            <Button onClick={() => void run('preview')} disabled={busy !== null || !file}>
              {busy === 'preview' ? 'Checking…' : 'Check file (dry run)'}
            </Button>
            <Link href="/purchases" className="btn btn-light">
              Cancel
            </Link>
          </div>
        </CardBody>
      </Card>

      {preview && s && (
        <Card>
          <CardBody>
            {preview.fileErrors.map((m) => (
              <Alert key={m} variant="danger" className="mb-2">
                {m}
              </Alert>
            ))}
            {s.rows > 0 && (
              <>
                <div className="d-flex flex-wrap gap-4 mb-3" aria-live="polite">
                  <Stat label="Rows" value={s.rows.toLocaleString('en-US')} />
                  <Stat label="Ready to import" value={s.valid.toLocaleString('en-US')} tone={s.valid === s.rows ? 'success' : undefined} />
                  <Stat label="With problems" value={s.invalid.toLocaleString('en-US')} tone={s.invalid ? 'danger' : undefined} />
                  <Stat label="Products" value={String(s.products)} />
                  <Stat label="Invoice lines" value={String(preview.lines)} />
                  <div>
                    <div className="text-muted small">Invoice total</div>
                    <div className="fs-5 fw-semibold">{preview.totals ? <MoneyText value={preview.totals.total} /> : '-'}</div>
                  </div>
                </div>
                <div className="small text-muted mb-3">
                  New serials {s.newSerials} · repeated in the file {s.duplicatesInFile} · already in stock records {s.alreadyExist} · unknown SKU {s.unknownSku} · not serial-tracked {s.notSerial} · read as {preview.encoding}, separator {preview.delimiter === '\t' ? 'tab' : `"${preview.delimiter}"`}
                  {preview.totals && preview.totals.due !== preview.totals.total && <> · due after payment <MoneyText value={preview.totals.due} /></>}
                </div>
              </>
            )}
            {Object.entries(preview.headerErrors)
              .filter(([k]) => !['vendorId', 'date', 'discount', 'paid', 'accountId'].includes(k))
              .map(([k, m]) => (
                <Alert key={k} variant="danger" className="mb-2">
                  {m}
                </Alert>
              ))}
            {preview.rows.some((r) => r.errors.length > 0) && (
              <>
                <div className="d-flex justify-content-between align-items-center mb-2">
                  <h6 className="mb-0">Problems</h6>
                  {preview.errorCsv && (
                    <Button size="sm" variant="tonal-secondary" onClick={() => downloadText('serials-import-errors.csv', preview.errorCsv)}>
                      <Icon icon="download" className="me-1" /> Download error report (CSV)
                    </Button>
                  )}
                </div>
                <div className="table-responsive" style={{ maxHeight: 420 }}>
                  <Table size="sm" className="align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Serial</th>
                        <th>SKU</th>
                        <th>Cost</th>
                        <th>Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows
                        .filter((r) => r.errors.length > 0)
                        .map((r) => (
                          <tr key={r.line}>
                            <td>{r.line}</td>
                            <td className="font-monospace text-break">{r.serial}</td>
                            <td className="text-break">{r.sku}</td>
                            <td className="text-nowrap">{r.unitCost}</td>
                            <td className="text-danger small">{r.errors.map((e) => e.message).join('; ')}</td>
                          </tr>
                        ))}
                    </tbody>
                  </Table>
                </div>
                {preview.rowsTruncated && <div className="small text-muted mt-1">Only the first problems are shown here; the error report has all of them.</div>}
              </>
            )}
            {preview.canImport ? (
              <div className="mt-3">
                <Alert variant="success" className="py-2">
                  Every row is valid. Importing creates one purchase with {s?.valid.toLocaleString('en-US')} serial{s?.valid === 1 ? '' : 's'}; if anything fails nothing is saved.
                </Alert>
                <Button variant="success" onClick={() => void run('import')} disabled={busy !== null}>
                  {busy === 'import' ? 'Importing…' : `Import ${s?.valid.toLocaleString('en-US')} serial${s?.valid === 1 ? '' : 's'}`}
                </Button>
              </div>
            ) : (
              s &&
              s.rows > 0 && (
                <Alert variant="warning" className="mt-3 mb-0">
                  Nothing can be imported yet. Fix the problems above in your file (or the invoice fields) and check again. A file with even one bad row is rejected as a whole.
                </Alert>
              )
            )}
          </CardBody>
        </Card>
      )}
    </>
  )
}

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) => (
  <div>
    <div className="text-muted small">{label}</div>
    <div className={`fs-5 fw-semibold ${tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : ''}`}>{value}</div>
  </div>
)

export default ImportForm
