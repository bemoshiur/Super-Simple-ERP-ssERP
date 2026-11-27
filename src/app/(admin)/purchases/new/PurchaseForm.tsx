'use client'
import BarcodeScanButton from '@/components/scan/BarcodeScanButton'
import { appendScanLine } from '@/components/scan/scanLogic'
import MoneyText from '@/components/ui/MoneyText'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import Icon from '@/components/wrappers/Icon'
import { createPurchaseAction, searchPurchaseProductsAction, searchPurchaseVendorsAction } from '@/server/actions/purchases'
import type { PurchaseProductOption } from '@/server/purchases/purchases'
import { MAX_UNITS_PER_INVOICE, formatSerialList, parseSerialText, serialsFromCsv, splitSerials } from '@/server/purchases/serialInput'
import { computePurchaseTotals } from '@/server/purchases/totals'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, CardBody, Col, Form, Row, Table } from 'react-bootstrap'

type Line = { key: string; product: PurchaseProductOption | null; qty: string; unitCost: string; serialText: string }
type Account = { id: string; name: string; type: string }

let seq = 0
const newLine = (): Line => ({ key: `l${++seq}`, product: null, qty: '1', unitCost: '', serialText: '' })
const MAX_CSV_BYTES = 1_000_000

const SerialBox = ({ line, index, serverError, onChange, onUseCount }: { line: Line; index: number; serverError?: string; onChange: (text: string) => void; onUseCount: (n: number) => void }) => {
  const fileRef = useRef<HTMLInputElement>(null)
  // Latest text, updated synchronously, so two quick camera reads never overwrite each other.
  const textRef = useRef(line.serialText)
  useEffect(() => {
    textRef.current = line.serialText
  }, [line.serialText])
  const [fileError, setFileError] = useState<string | null>(null)
  const parsed = useMemo(() => parseSerialText(line.serialText), [line.serialText])
  const qty = /^\d+$/.test(line.qty.trim()) ? Number(line.qty.trim()) : NaN
  const count = parsed.serials.length
  const matches = count === qty && parsed.duplicates.length === 0 && parsed.invalid.length === 0
  const id = `serials-${line.key}`
  return (
    <div className="border rounded p-2 bg-light-subtle">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-1">
        <Form.Label htmlFor={id} className="mb-0 small fw-semibold">
          Serial / IMEI numbers for line {index + 1} <span className="text-muted fw-normal">(one per line; commas and tabs also work; scan or paste)</span>
        </Form.Label>
        <div className="d-flex gap-2 align-items-center">
          <span className={`badge ${matches ? 'bg-success-subtle text-success' : 'bg-warning-subtle text-warning'}`} aria-live="polite">
            {count} / {Number.isNaN(qty) ? '?' : qty}
          </span>
          {count > 0 && count !== qty && (
            <Button size="sm" variant="link" className="p-0" onClick={() => onUseCount(count)}>
              Use {count} as quantity
            </Button>
          )}
          <BarcodeScanButton
            size="sm"
            continuous
            title={`Scan serials for line ${index + 1} with the camera`}
            onScan={(code) => {
              const next = appendScanLine(textRef.current, code)
              if (next === null) return false
              textRef.current = next
              onChange(next)
            }}
          />
          <Button size="sm" variant="tonal-secondary" onClick={() => fileRef.current?.click()}>
            <Icon icon="upload" className="me-1" /> CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="d-none"
            onChange={async (e) => {
              setFileError(null)
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              if (f.size > MAX_CSV_BYTES) return setFileError('File is too large (max 1 MB).')
              const text = serialsFromCsv(await f.text())
              if (!text) return setFileError('No serials found in that file. Use one column, or a header row with a "serial" column.')
              onChange(line.serialText.trim() ? `${line.serialText.replace(/\s+$/, '')}\n${text}` : text)
            }}
          />
        </div>
      </div>
      <Form.Control
        as="textarea"
        id={id}
        rows={Math.min(8, Math.max(3, count + 1))}
        className="font-monospace"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        value={line.serialText}
        isInvalid={!!serverError || parsed.duplicates.length > 0 || parsed.invalid.length > 0}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'356789012345678\n356789012345679'}
      />
      <div className="small mt-1">
        {parsed.duplicates.length > 0 && <div className="text-danger">Entered more than once: {formatSerialList(parsed.duplicates)}</div>}
        {parsed.invalid.length > 0 && <div className="text-danger">Invalid (1-64 printable characters, no spaces): {formatSerialList(parsed.invalid.map((i) => i.value))}</div>}
        {parsed.caseOnly.length > 0 && <div className="text-warning">Differ only by letter case (saved as different serials): {formatSerialList(parsed.caseOnly.map((g) => g.join(' / ')))}</div>}
        {!Number.isNaN(qty) && count !== qty && <div className="text-muted">Enter exactly {qty} unique serial{qty === 1 ? '' : 's'}.</div>}
        {fileError && <div className="text-danger">{fileError}</div>}
        {serverError && <div className="text-danger">{serverError}</div>}
      </div>
    </div>
  )
}

const PurchaseForm = ({ accounts, today }: { accounts: Account[]; today: string }) => {
  const router = useRouter()
  const [vendor, setVendor] = useState<SearchOption | null>(null)
  const [date, setDate] = useState(today)
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Line[]>(() => [newLine()])
  const [discount, setDiscount] = useState('')
  const [paid, setPaid] = useState('')
  const [accountId, setAccountId] = useState(accounts.find((a) => a.type === 'cash')?.id ?? accounts[0]?.id ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const totals = useMemo(() => computePurchaseTotals({ items: lines.map((l) => ({ qty: l.qty, unitCost: l.unitCost })), discount, paid }), [lines, discount, paid])
  const unitCount = lines.reduce((a, l) => a + (/^\d+$/.test(l.qty.trim()) ? Number(l.qty.trim()) : 0), 0)
  const err = (k: string) => errors[k] ?? (!totals.ok ? totals.errors[k] : undefined)

  const localProblems = (): string | null => {
    if (!vendor) return 'Choose a vendor.'
    if (lines.some((l) => !l.product)) return 'Choose a product on every line (or remove empty lines).'
    if (!totals.ok) return 'Fix the highlighted amounts.'
    if (unitCount > MAX_UNITS_PER_INVOICE) return `At most ${MAX_UNITS_PER_INVOICE} units per invoice. Split it into several invoices.`
    for (const [i, l] of lines.entries()) {
      if (!l.product?.trackSerial) continue
      const p = parseSerialText(l.serialText)
      if (p.duplicates.length || p.invalid.length || p.serials.length !== Number(l.qty)) return `Line ${i + 1}: enter exactly ${l.qty} unique, valid serials.`
    }
    if (totals.ok && totals.totals.paid !== '0.00' && !accountId) return 'Choose the account you paid from.'
    return null
  }

  const submit = async () => {
    setFormError(null)
    setErrors({})
    const problem = localProblems()
    if (problem) return setFormError(problem)
    setSaving(true)
    // The server recomputes every amount and takes company/user from the session; expectedTotal only guards against a stale screen.
    const res = await createPurchaseAction({
      vendorId: vendor?.value,
      date,
      note,
      items: lines.map((l) => ({ productId: l.product?.value, qty: l.qty, unitCost: l.unitCost, serials: l.product?.trackSerial ? splitSerials(l.serialText) : [] })),
      discount,
      paid,
      accountId: totals.ok && totals.totals.paid !== '0.00' ? accountId : '',
      expectedTotal: totals.ok ? totals.totals.total : undefined,
    })
    if (res.ok) {
      router.push(`/purchases/${res.data.id}`)
      return
    }
    setSaving(false)
    setErrors(res.fieldErrors ?? {})
    setFormError(res.error)
  }

  return (
    <Form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        // Barcode scanners end with Enter: never submit from a single-line input by accident.
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault()
      }}
    >
      {formError && (
        <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>
          {formError}
          {errors.items && <div>{errors.items}</div>}
          {errors._ && <div>{errors._}</div>}
        </Alert>
      )}
      <div className="text-end mb-2">
        <Link href="/purchases/import" className="small">
          Many serials in a spreadsheet? Import a CSV file instead
        </Link>
      </div>
      <Card>
        <CardBody>
          <Row className="g-3">
            <Col md={5}>
              <Form.Label htmlFor="vendor">Vendor</Form.Label>
              <SearchSelect id="vendor" loadOptions={searchPurchaseVendorsAction} value={vendor} onChange={setVendor} placeholder="Search vendor…" invalid={!!errors.vendorId} />
              {errors.vendorId && <div className="invalid-feedback d-block">{errors.vendorId}</div>}
            </Col>
            <Col md={3}>
              <Form.Label htmlFor="date">Date</Form.Label>
              <Form.Control id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!errors.date} />
              {errors.date && <Form.Control.Feedback type="invalid">{errors.date}</Form.Control.Feedback>}
            </Col>
            <Col md={4}>
              <Form.Label htmlFor="note">Note</Form.Label>
              <Form.Control id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Vendor bill no, remarks…" />
            </Col>
          </Row>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h5 className="mb-3">Items</h5>
          <div className="table-responsive">
            <Table className="align-middle mb-0">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th style={{ minWidth: 260 }}>Product</th>
                  <th style={{ width: 110 }}>Qty</th>
                  <th style={{ width: 160 }}>Unit cost</th>
                  <th className="text-end" style={{ width: 160 }}>
                    Line total
                  </th>
                  <th style={{ width: 50 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <LineRows
                    key={l.key}
                    line={l}
                    index={i}
                    lineTotal={totals.ok ? totals.totals.lines[i] : null}
                    err={err}
                    canRemove={lines.length > 1}
                    onChange={(patch) => update(l.key, patch)}
                    onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  />
                ))}
              </tbody>
            </Table>
          </div>
          <Button variant="tonal-primary" className="mt-2" onClick={() => setLines((ls) => [...ls, newLine()])}>
            <Icon icon="plus" className="me-1" /> Add line
          </Button>
          <span className="text-muted small ms-3">
            {unitCount} unit{unitCount === 1 ? '' : 's'} (max {MAX_UNITS_PER_INVOICE})
          </span>
        </CardBody>
      </Card>

      <Row>
        <Col lg={{ span: 5, offset: 7 }}>
          <Card>
            <CardBody>
              <dl className="row mb-0">
                <dt className="col-6 fw-normal">Subtotal</dt>
                <dd className="col-6 text-end">{totals.ok ? <MoneyText value={totals.totals.subtotal} /> : '-'}</dd>
                <dt className="col-6 fw-normal">
                  <Form.Label htmlFor="discount" className="mb-0">
                    Discount
                  </Form.Label>
                </dt>
                <dd className="col-6">
                  <Form.Control id="discount" size="sm" className="text-end" inputMode="decimal" placeholder="0.00" value={discount} onChange={(e) => setDiscount(e.target.value)} isInvalid={!!err('discount')} />
                  {err('discount') && <Form.Control.Feedback type="invalid">{err('discount')}</Form.Control.Feedback>}
                </dd>
                <dt className="col-6">Total</dt>
                <dd className="col-6 text-end fw-semibold fs-5">{totals.ok ? <MoneyText value={totals.totals.total} /> : '-'}</dd>
                {errors.total && <dd className="col-12 text-danger small">{errors.total}</dd>}
                <dt className="col-6 fw-normal">
                  <Form.Label htmlFor="paid" className="mb-0">
                    Paid now
                  </Form.Label>
                </dt>
                <dd className="col-6">
                  <Form.Control id="paid" size="sm" className="text-end" inputMode="decimal" placeholder="0.00" value={paid} onChange={(e) => setPaid(e.target.value)} isInvalid={!!err('paid')} />
                  {err('paid') && <Form.Control.Feedback type="invalid">{err('paid')}</Form.Control.Feedback>}
                </dd>
                {totals.ok && totals.totals.paid !== '0.00' && (
                  <>
                    <dt className="col-6 fw-normal">
                      <Form.Label htmlFor="account" className="mb-0">
                        Paid from
                      </Form.Label>
                    </dt>
                    <dd className="col-6">
                      <Form.Select id="account" size="sm" value={accountId} onChange={(e) => setAccountId(e.target.value)} isInvalid={!!errors.accountId}>
                        <option value="">Choose account…</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </Form.Select>
                      {errors.accountId && <Form.Control.Feedback type="invalid">{errors.accountId}</Form.Control.Feedback>}
                    </dd>
                  </>
                )}
                <dt className="col-6">Due</dt>
                <dd className="col-6 text-end fw-semibold">{totals.ok ? <MoneyText value={totals.totals.due} className={totals.totals.due !== '0.00' ? 'text-danger' : undefined} /> : '-'}</dd>
              </dl>
              <div className="d-flex gap-2 justify-content-end mt-3">
                <Button variant="light" onClick={() => router.push('/purchases')} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save purchase'}
                </Button>
              </div>
            </CardBody>
          </Card>
        </Col>
      </Row>
    </Form>
  )
}

const LineRows = ({ line, index, lineTotal, err, canRemove, onChange, onRemove }: { line: Line; index: number; lineTotal: string | null; err: (k: string) => string | undefined; canRemove: boolean; onChange: (patch: Partial<Line>) => void; onRemove: () => void }) => {
  const k = (f: string) => `items.${index}.${f}`
  return (
    <>
      <tr>
        <td className="text-muted">{index + 1}</td>
        <td>
          <SearchSelect
            loadOptions={searchPurchaseProductsAction}
            value={line.product}
            placeholder="Search product or SKU…"
            ariaLabel={`Product line ${index + 1}`}
            invalid={!!err(k('productId'))}
            onChange={(o) => {
              const p = o as PurchaseProductOption | null
              onChange({ product: p, unitCost: line.unitCost || (p && p.unitCost !== '0.00' ? p.unitCost : ''), serialText: p?.trackSerial ? line.serialText : '' })
            }}
          />
          {err(k('productId')) && <div className="invalid-feedback d-block">{err(k('productId'))}</div>}
        </td>
        <td>
          <Form.Control inputMode="numeric" value={line.qty} onChange={(e) => onChange({ qty: e.target.value })} isInvalid={!!err(k('qty'))} aria-label={`Quantity line ${index + 1}`} />
          {err(k('qty')) && <Form.Control.Feedback type="invalid">{err(k('qty'))}</Form.Control.Feedback>}
        </td>
        <td>
          <Form.Control inputMode="decimal" className="text-end" placeholder="0.00" value={line.unitCost} onChange={(e) => onChange({ unitCost: e.target.value })} isInvalid={!!err(k('unitCost'))} aria-label={`Unit cost line ${index + 1}`} />
          {err(k('unitCost')) && <Form.Control.Feedback type="invalid">{err(k('unitCost'))}</Form.Control.Feedback>}
        </td>
        <td className="text-end">{lineTotal ? <MoneyText value={lineTotal} /> : '-'}</td>
        <td>
          {canRemove && (
            <Button size="sm" variant="tonal-danger" className="btn-square" aria-label={`Remove line ${index + 1}`} onClick={onRemove}>
              <Icon icon="trash-2" />
            </Button>
          )}
        </td>
      </tr>
      {line.product?.trackSerial ? (
        <tr>
          <td />
          <td colSpan={5} className="pt-0">
            <SerialBox line={line} index={index} serverError={err(k('serials'))} onChange={(serialText) => onChange({ serialText })} onUseCount={(n) => onChange({ qty: String(n) })} />
          </td>
        </tr>
      ) : (
        err(k('serials')) && (
          <tr>
            <td />
            <td colSpan={5} className="pt-0 text-danger small">
              {err(k('serials'))}
            </td>
          </tr>
        )
      )}
    </>
  )
}

export default PurchaseForm
