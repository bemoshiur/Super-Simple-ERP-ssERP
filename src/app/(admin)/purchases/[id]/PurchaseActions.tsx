'use client'
import MoneyText from '@/components/ui/MoneyText'
import Icon from '@/components/wrappers/Icon'
import { createPurchaseReturnAction, recordVendorPaymentAction } from '@/server/actions/purchases'
import { fromMinor, toMinor } from '@/server/money'
import { returnCredit } from '@/server/sales/totals'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap'

type Account = { id: string; name: string; type: string }
export type ReturnableUnit = { id: string; serialNo: string; productName: string; purchasePrice: string }
/** A non-serial line with qty still returnable (received - already returned). onHand caps it: sold stock cannot go back. */
export type ReturnableLine = { id: string; productName: string; qty: number; returnedQty: number; netTotal: string; onHand: number }

type Props = {
  purchaseId: string
  invoiceNo: string
  total: string
  paid: string
  due: string
  returnedTotal: string
  accounts: Account[]
  today: string
  returnable: ReturnableUnit[]
  returnableLines: ReturnableLine[]
  canEdit: boolean
}

const safeMinor = (v: string): number | null => {
  try {
    return toMinor(v.trim() === '' ? '0' : v.trim())
  } catch {
    return null
  }
}

const AccountSelect = ({ id, accounts, value, onChange, invalid, error }: { id: string; accounts: Account[]; value: string; onChange: (v: string) => void; invalid?: boolean; error?: string }) => (
  <>
    <Form.Select id={id} value={value} onChange={(e) => onChange(e.target.value)} isInvalid={invalid}>
      <option value="">Choose account…</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Form.Select>
    {error && <Form.Control.Feedback type="invalid">{error}</Form.Control.Feedback>}
  </>
)

const PaymentModal = ({ p, onHide }: { p: Props; onHide: () => void }) => {
  const router = useRouter()
  const [amount, setAmount] = useState(p.due)
  const [accountId, setAccountId] = useState(p.accounts.find((a) => a.type === 'cash')?.id ?? '')
  const [date, setDate] = useState(p.today)
  const [method, setMethod] = useState('')
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    setError(null)
    const res = await recordVendorPaymentAction(p.purchaseId, { amount, accountId, date, method, note })
    setSaving(false)
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {})
      return setError(res.error)
    }
    onHide()
    router.refresh()
  }
  return (
    <Modal show onHide={onHide} centered backdrop="static">
      <Form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h5">Pay vendor · {p.invoiceNo}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <p className="text-muted">
            Due on this invoice: <MoneyText value={p.due} className="fw-semibold" />. Partial payments are fine.
          </p>
          <Row className="g-3">
            <Col sm={6}>
              <Form.Label htmlFor="pay-amount">Amount</Form.Label>
              <Form.Control id="pay-amount" inputMode="decimal" className="text-end" value={amount} onChange={(e) => setAmount(e.target.value)} isInvalid={!!errors.amount} />
              {errors.amount && <Form.Control.Feedback type="invalid">{errors.amount}</Form.Control.Feedback>}
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="pay-date">Date</Form.Label>
              <Form.Control id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!errors.date} />
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="pay-account">Paid from</Form.Label>
              <AccountSelect id="pay-account" accounts={p.accounts} value={accountId} onChange={setAccountId} invalid={!!errors.accountId} error={errors.accountId} />
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="pay-method">Method / reference</Form.Label>
              <Form.Control id="pay-method" maxLength={50} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Cash, cheque no, TrxID…" />
            </Col>
            <Col xs={12}>
              <Form.Label htmlFor="pay-note">Note</Form.Label>
              <Form.Control id="pay-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Col>
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Record payment'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

const ReturnModal = ({ p, onHide }: { p: Props; onHide: () => void }) => {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lineQty, setLineQty] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')
  const [date, setDate] = useState(p.today)
  const [note, setNote] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [refundAccountId, setRefundAccountId] = useState(p.accounts.find((a) => a.type === 'cash')?.id ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? p.returnable.filter((u) => u.serialNo.toLowerCase().includes(f) || u.productName.toLowerCase().includes(f)) : p.returnable
  }, [filter, p.returnable])

  // Loose quantities to return: whole numbers within what is still returnable on the line and on hand.
  const lineMax = (l: ReturnableLine) => Math.max(0, Math.min(l.qty - l.returnedQty, l.onHand))
  const lines = useMemo(
    () =>
      p.returnableLines.flatMap((l) => {
        const raw = (lineQty[l.id] ?? '').trim()
        if (!raw) return []
        const k = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN
        return [{ line: l, qty: k, valid: Number.isInteger(k) && k >= 1 && k <= Math.max(0, Math.min(l.qty - l.returnedQty, l.onHand)) }]
      }),
    [lineQty, p.returnableLines],
  )
  const linesValid = lines.every((x) => x.valid)
  const items = selected.size + lines.filter((x) => x.valid).length

  // Same rule as the server (preview only; the server recomputes under a row lock).
  const preview = useMemo(() => {
    const unitsGross = p.returnable.filter((u) => selected.has(u.id)).reduce((a, u) => a + toMinor(u.purchasePrice), 0)
    const gross = unitsGross + lines.filter((x) => x.valid).reduce((a, x) => a + returnCredit(toMinor(x.line.netTotal), x.line.qty, x.line.returnedQty, x.qty), 0)
    const total = toMinor(p.total)
    const returned = toMinor(p.returnedTotal)
    const credit = Math.min(gross, Math.max(0, total - returned))
    const refundable = Math.max(0, returned + credit + toMinor(p.paid) - total)
    const dueAfter = Math.max(0, total - returned - credit - toMinor(p.paid))
    return { credit: fromMinor(credit), refundable: fromMinor(refundable), refundableMinor: refundable, dueAfter: fromMinor(dueAfter) }
  }, [selected, lines, p])

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const refundMinor = safeMinor(refundAmount)

  const submit = async () => {
    setError(null)
    if (!linesValid) return setError('Fix the quantities to return.')
    if (items === 0) return setError('Select at least one unit or quantity to return.')
    if (saving) return
    setSaving(true)
    const sent = lines.filter((x) => x.valid)
    const res = await createPurchaseReturnAction(p.purchaseId, { unitIds: [...selected], lines: sent.map((x) => ({ purchaseItemId: x.line.id, qty: x.qty })), date, note, refundAmount, refundAccountId: refundMinor ? refundAccountId : '' })
    setSaving(false)
    if (!res.ok) {
      // Map `lines.<i>.qty` (index into what was sent) back to the line id.
      const fe: Record<string, string> = { ...(res.fieldErrors ?? {}) }
      sent.forEach((x, i) => {
        if (fe[`lines.${i}.qty`]) fe[`line:${x.line.id}`] = fe[`lines.${i}.qty`]
      })
      setErrors(fe)
      return setError(res.fieldErrors?.unitIds ?? res.fieldErrors?.lines ?? res.error)
    }
    onHide()
    router.refresh()
  }

  return (
    <Modal show onHide={onHide} centered size="lg" backdrop="static" scrollable>
      <Form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h5">Return to vendor · {p.invoiceNo}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>{error}</Alert>}
          {p.returnable.length > 0 && <h6 className="mb-2">Serial units</h6>}
          <div className={`d-flex flex-wrap gap-2 align-items-center mb-2${p.returnable.length ? '' : ' d-none'}`}>
            <Form.Control size="sm" style={{ maxWidth: 260 }} placeholder="Filter serial or product…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter units" />
            <Button size="sm" variant="tonal-secondary" onClick={() => setSelected(new Set([...selected, ...shown.map((u) => u.id)]))}>
              Select shown
            </Button>
            <Button size="sm" variant="tonal-secondary" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <span className="small text-muted ms-auto">
              {selected.size} of {p.returnable.length} in-stock units selected
            </span>
          </div>
          <div className={`border rounded mb-3${p.returnable.length ? '' : ' d-none'}`} style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.map((u) => (
              <Form.Check key={u.id} id={`ret-${u.id}`} className="px-5 py-1 border-bottom" checked={selected.has(u.id)} onChange={() => toggle(u.id)} label={<span><span className="font-monospace">{u.serialNo}</span> <span className="text-muted">· {u.productName} · <MoneyText value={u.purchasePrice} /></span></span>} />
            ))}
            {shown.length === 0 && <div className="p-2 text-muted small">No matching in-stock units.</div>}
          </div>
          {p.returnableLines.length > 0 && (
            <>
              <h6 className="mb-2">Quantity items</h6>
              <div className="border rounded mb-3">
                {p.returnableLines.map((l) => {
                  const max = lineMax(l)
                  const raw = lineQty[l.id] ?? ''
                  const bad = raw.trim() !== '' && !lines.find((x) => x.line.id === l.id)?.valid
                  return (
                    <div key={l.id} className="d-flex flex-wrap align-items-center gap-2 px-3 py-2 border-bottom">
                      <div className="flex-grow-1">
                        <div>{l.productName}</div>
                        <div className="small text-muted">
                          Received {l.qty}
                          {l.returnedQty > 0 && ` · returned ${l.returnedQty}`} · in stock {l.onHand} · can return {max}
                        </div>
                      </div>
                      <div style={{ width: 110 }}>
                        <Form.Control size="sm" inputMode="numeric" className="text-end" placeholder="0" aria-label={`Quantity of ${l.productName} to return`} value={raw} disabled={max === 0} onChange={(e) => setLineQty((s) => ({ ...s, [l.id]: e.target.value }))} isInvalid={bad || !!errors[`line:${l.id}`]} />
                        <Form.Control.Feedback type="invalid">{errors[`line:${l.id}`] ?? `0 to ${max}`}</Form.Control.Feedback>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          <dl className="row small mb-3">
            <dt className="col-7 fw-normal">Vendor credit for this return</dt>
            <dd className="col-5 text-end fw-semibold"><MoneyText value={preview.credit} /></dd>
            <dt className="col-7 fw-normal">Invoice due after return</dt>
            <dd className="col-5 text-end"><MoneyText value={preview.dueAfter} /></dd>
            <dt className="col-7 fw-normal">Can be refunded in cash (credit beyond the due)</dt>
            <dd className="col-5 text-end"><MoneyText value={preview.refundable} /></dd>
          </dl>
          <Row className="g-3">
            <Col sm={6}>
              <Form.Label htmlFor="ret-date">Date</Form.Label>
              <Form.Control id="ret-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!errors.date} />
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="ret-note">Reason / note</Form.Label>
              <Form.Control id="ret-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Faulty, wrong model…" />
            </Col>
            {preview.refundableMinor > 0 && (
              <>
                <Col sm={6}>
                  <Form.Label htmlFor="ret-refund">Refund received now (optional)</Form.Label>
                  <Form.Control id="ret-refund" inputMode="decimal" className="text-end" placeholder="0.00" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} isInvalid={!!errors.refundAmount || refundMinor === null} />
                  {errors.refundAmount && <Form.Control.Feedback type="invalid">{errors.refundAmount}</Form.Control.Feedback>}
                  <Form.Text className="text-muted">Anything not refunded stays as credit with this vendor.</Form.Text>
                </Col>
                {!!refundMinor && (
                  <Col sm={6}>
                    <Form.Label htmlFor="ret-account">Received into</Form.Label>
                    <AccountSelect id="ret-account" accounts={p.accounts} value={refundAccountId} onChange={setRefundAccountId} invalid={!!errors.refundAccountId} error={errors.refundAccountId} />
                  </Col>
                )}
              </>
            )}
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={saving || items === 0 || !linesValid}>
            {saving ? 'Saving…' : `Return ${items} item${items === 1 ? '' : 's'}`}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

/** Header action bar on the purchase detail page. Buttons are hidden without purchases.edit; the server enforces it regardless. */
const PurchaseActions = (p: Props) => {
  const [open, setOpen] = useState<'pay' | 'return' | null>(null)
  return (
    <>
      <div className="d-flex flex-wrap gap-2">
        {p.canEdit && p.due !== '0.00' && (
          <Button onClick={() => setOpen('pay')}>
            <Icon icon="banknote" className="me-1" /> Record payment
          </Button>
        )}
        {p.canEdit && (p.returnable.length > 0 || p.returnableLines.length > 0) && (
          <Button variant="tonal-danger" onClick={() => setOpen('return')}>
            <Icon icon="undo-2" className="me-1" /> Return items
          </Button>
        )}
        <a href={`/purchases/${p.purchaseId}/print`} target="_blank" rel="noopener" className="btn btn-tonal-secondary">
          <Icon icon="printer" className="me-1" /> Print
        </a>
      </div>
      {open === 'pay' && <PaymentModal p={p} onHide={() => setOpen(null)} />}
      {open === 'return' && <ReturnModal p={p} onHide={() => setOpen(null)} />}
    </>
  )
}

export default PurchaseActions
