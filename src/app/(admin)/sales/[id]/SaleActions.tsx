'use client'
import MoneyText from '@/components/ui/MoneyText'
import Icon from '@/components/wrappers/Icon'
import { createSaleReturnAction, recordCustomerPaymentAction } from '@/server/actions/sales'
import { fromMinor, toMinor } from '@/server/money'
import { returnCredit } from '@/server/sales/totals'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { Alert, Button, Col, Form, Modal, Row, Table } from 'react-bootstrap'

type Account = { id: string; name: string; type: string }
export type ReturnableLine = { id: string; productName: string; serialNo: string | null; qty: number; returnedQty: number; netTotal: string }

type Props = {
  saleId: string
  invoiceNo: string
  total: string
  paid: string
  due: string
  returnedTotal: string
  accounts: Account[]
  today: string
  returnable: ReturnableLine[]
  canEdit: boolean
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
    if (saving) return
    setSaving(true)
    setError(null)
    const res = await recordCustomerPaymentAction(p.saleId, { amount, accountId, date, method, note })
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
          <Modal.Title as="h5">Collect payment · {p.invoiceNo}</Modal.Title>
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
              {errors.date && <Form.Control.Feedback type="invalid">{errors.date}</Form.Control.Feedback>}
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="pay-account">Received into</Form.Label>
              <AccountSelect id="pay-account" accounts={p.accounts} value={accountId} onChange={setAccountId} invalid={!!errors.accountId} error={errors.accountId} />
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="pay-method">Method / reference</Form.Label>
              <Form.Control id="pay-method" maxLength={50} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Cash, TrxID…" />
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

type Picked = { qty: string; restock: 'in_stock' | 'damaged' }

const ReturnModal = ({ p, onHide }: { p: Props; onHide: () => void }) => {
  const router = useRouter()
  const [picked, setPicked] = useState<Record<string, Picked>>({})
  const [date, setDate] = useState(p.today)
  const [note, setNote] = useState('')
  const [refundAccountId, setRefundAccountId] = useState(p.accounts.find((a) => a.type === 'cash')?.id ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const chosen = p.returnable.filter((l) => picked[l.id])
  // Same rule as the server (preview only; the server recomputes under a row lock).
  const preview = useMemo(() => {
    let credit = 0
    let ok = true
    for (const l of p.returnable) {
      const pk = picked[l.id]
      if (!pk) continue
      const n = /^\d+$/.test(pk.qty.trim()) ? Number(pk.qty) : NaN
      if (!(n >= 1 && n <= l.qty - l.returnedQty)) {
        ok = false
        continue
      }
      credit += returnCredit(toMinor(l.netTotal), l.qty, l.returnedQty, n)
    }
    const total = toMinor(p.total)
    const returned = toMinor(p.returnedTotal)
    credit = Math.min(credit, Math.max(0, total - returned))
    const refund = Math.max(0, returned + credit + toMinor(p.paid) - total)
    const dueAfter = Math.max(0, total - returned - credit - toMinor(p.paid))
    return { ok, credit: fromMinor(credit), refund: fromMinor(refund), refundMinor: refund, dueAfter: fromMinor(dueAfter) }
  }, [picked, p])

  const toggle = (l: ReturnableLine) =>
    setPicked((s) => {
      const n = { ...s }
      if (n[l.id]) delete n[l.id]
      else n[l.id] = { qty: String(l.qty - l.returnedQty), restock: 'in_stock' }
      return n
    })

  const submit = async () => {
    if (saving) return
    setError(null)
    if (chosen.length === 0) return setError('Select at least one item to return.')
    if (!preview.ok) return setError('Check the return quantities.')
    setSaving(true)
    const res = await createSaleReturnAction(p.saleId, {
      items: chosen.map((l) => ({ saleItemId: l.id, qty: picked[l.id].qty, restock: l.serialNo ? picked[l.id].restock : 'in_stock' })),
      date,
      note,
      refundAccountId: preview.refundMinor > 0 ? refundAccountId : '',
    })
    setSaving(false)
    if (!res.ok) {
      const fe = res.fieldErrors ?? {}
      setErrors(fe)
      // items.N refers to the chosen lines in order: show the message with the line's name.
      const lineMsgs = Object.entries(fe)
        .map(([key, v]) => {
          const m = /^items\.(\d+)\./.exec(key)
          return m && chosen[Number(m[1])] ? `${chosen[Number(m[1])].serialNo ?? chosen[Number(m[1])].productName}: ${v}` : null
        })
        .filter(Boolean)
      return setError(lineMsgs.length ? lineMsgs.join(' ') : (fe.items ?? res.error))
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
          <Modal.Title as="h5">Customer return · {p.invoiceNo}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>{error}</Alert>}
          <Table size="sm" className="align-middle">
            <thead>
              <tr>
                <th style={{ width: 32 }} />
                <th>Item</th>
                <th style={{ width: 110 }}>Return qty</th>
                <th style={{ width: 150 }}>Condition</th>
              </tr>
            </thead>
            <tbody>
              {p.returnable.map((l) => {
                const pk = picked[l.id]
                const left = l.qty - l.returnedQty
                return (
                  <tr key={l.id}>
                    <td>
                      <Form.Check id={`ret-${l.id}`} checked={!!pk} onChange={() => toggle(l)} aria-label={`Return ${l.serialNo ?? l.productName}`} />
                    </td>
                    <td>
                      <label htmlFor={`ret-${l.id}`} className="mb-0">
                        {l.productName} {l.serialNo && <span className="font-monospace small">· {l.serialNo}</span>}
                        <div className="small text-muted">
                          {left} of {l.qty} returnable
                        </div>
                      </label>
                    </td>
                    <td>
                      {l.serialNo ? (
                        <span className="ps-2">1</span>
                      ) : (
                        <Form.Control size="sm" inputMode="numeric" disabled={!pk} value={pk?.qty ?? ''} onChange={(e) => setPicked((s) => ({ ...s, [l.id]: { ...s[l.id], qty: e.target.value } }))} aria-label={`Return quantity for ${l.productName}`} />
                      )}
                    </td>
                    <td>
                      {l.serialNo ? (
                        <Form.Select size="sm" disabled={!pk} value={pk?.restock ?? 'in_stock'} onChange={(e) => setPicked((s) => ({ ...s, [l.id]: { ...s[l.id], restock: e.target.value as Picked['restock'] } }))} aria-label={`Condition of ${l.serialNo}`}>
                          <option value="in_stock">Back in stock</option>
                          <option value="damaged">Damaged</option>
                        </Form.Select>
                      ) : (
                        <span className="small text-muted">Back in stock</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
          <dl className="row small mb-3">
            <dt className="col-7 fw-normal">Value returned (after the invoice discount)</dt>
            <dd className="col-5 text-end fw-semibold">
              <MoneyText value={preview.credit} />
            </dd>
            <dt className="col-7 fw-normal">Invoice due after return</dt>
            <dd className="col-5 text-end">
              <MoneyText value={preview.dueAfter} />
            </dd>
            <dt className="col-7 fw-normal">Cash refund to the customer now</dt>
            <dd className="col-5 text-end fw-semibold">
              <MoneyText value={preview.refund} />
            </dd>
          </dl>
          <Row className="g-3">
            <Col sm={6}>
              <Form.Label htmlFor="ret-date">Date</Form.Label>
              <Form.Control id="ret-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!errors.date} />
              {errors.date && <Form.Control.Feedback type="invalid">{errors.date}</Form.Control.Feedback>}
            </Col>
            <Col sm={6}>
              <Form.Label htmlFor="ret-note">Reason / note</Form.Label>
              <Form.Control id="ret-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Faulty, changed mind…" />
            </Col>
            {preview.refundMinor > 0 && (
              <Col sm={6}>
                <Form.Label htmlFor="ret-account">Refund paid from</Form.Label>
                <AccountSelect id="ret-account" accounts={p.accounts} value={refundAccountId} onChange={setRefundAccountId} invalid={!!errors.refundAccountId} error={errors.refundAccountId} />
              </Col>
            )}
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={saving || chosen.length === 0}>
            {saving ? 'Saving…' : `Return ${chosen.length} item${chosen.length === 1 ? '' : 's'}`}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

/** Header action bar on the sale detail page. Buttons are hidden without sales.edit; the server enforces it regardless. */
const SaleActions = (p: Props) => {
  const [open, setOpen] = useState<'pay' | 'return' | null>(null)
  return (
    <>
      <div className="d-flex flex-wrap gap-2">
        {p.canEdit && p.due !== '0.00' && (
          <Button onClick={() => setOpen('pay')}>
            <Icon icon="banknote" className="me-1" /> Collect payment
          </Button>
        )}
        {p.canEdit && p.returnable.length > 0 && (
          <Button variant="tonal-danger" onClick={() => setOpen('return')}>
            <Icon icon="undo-2" className="me-1" /> Return items
          </Button>
        )}
        <a href={`/sales/${p.saleId}/print`} target="_blank" rel="noopener" className="btn btn-tonal-secondary">
          <Icon icon="printer" className="me-1" /> Print
        </a>
      </div>
      {open === 'pay' && <PaymentModal p={p} onHide={() => setOpen(null)} />}
      {open === 'return' && <ReturnModal p={p} onHide={() => setOpen(null)} />}
    </>
  )
}

export default SaleActions
