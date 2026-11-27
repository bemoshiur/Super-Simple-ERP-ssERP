'use client'
import MoneyText from '@/components/ui/MoneyText'
import Icon from '@/components/wrappers/Icon'
import { collectCustomerDueAction } from '@/server/actions/sales'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap'

type Account = { id: string; name: string; type: string }

/** Customer-level due collection: one amount applied to the oldest unpaid invoices first (server-side). */
const CollectDue = ({ customerId, invoiceDue, accounts, today }: { customerId: string; invoiceDue: string; accounts: Account[]; today: string }) => {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(invoiceDue)
  const [accountId, setAccountId] = useState(accounts.find((a) => a.type === 'cash')?.id ?? '')
  const [date, setDate] = useState(today)
  const [method, setMethod] = useState('')
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    const res = await collectCustomerDueAction(customerId, { amount, accountId, date, method, note })
    setSaving(false)
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {})
      return setError(res.error)
    }
    setOpen(false)
    setDone(`Applied to ${res.data.allocations.map((a) => `${a.invoiceNo} (${a.amount})`).join(', ')}.`)
    router.refresh()
  }
  return (
    <>
      <Button variant="success" onClick={() => setOpen(true)}>
        <Icon icon="hand-coins" className="me-1" /> Collect due
      </Button>
      {done && (
        <Alert variant="success" className="mt-2 mb-0 py-1 small" dismissible onClose={() => setDone(null)}>
          {done}
        </Alert>
      )}
      {open && (
        <Modal show onHide={() => setOpen(false)} centered backdrop="static">
          <Form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Modal.Header closeButton>
              <Modal.Title as="h5">Collect due</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              {error && <Alert variant="danger">{error}</Alert>}
              <p className="text-muted">
                Unpaid invoices total <MoneyText value={invoiceDue} className="fw-semibold" />. The amount is applied to the oldest invoices first.
              </p>
              <Row className="g-3">
                <Col sm={6}>
                  <Form.Label htmlFor="col-amount">Amount</Form.Label>
                  <Form.Control id="col-amount" inputMode="decimal" className="text-end" value={amount} onChange={(e) => setAmount(e.target.value)} isInvalid={!!errors.amount} />
                  {errors.amount && <Form.Control.Feedback type="invalid">{errors.amount}</Form.Control.Feedback>}
                </Col>
                <Col sm={6}>
                  <Form.Label htmlFor="col-date">Date</Form.Label>
                  <Form.Control id="col-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} isInvalid={!!errors.date} />
                </Col>
                <Col sm={6}>
                  <Form.Label htmlFor="col-account">Received into</Form.Label>
                  <Form.Select id="col-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} isInvalid={!!errors.accountId}>
                    <option value="">Choose account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Form.Select>
                  {errors.accountId && <Form.Control.Feedback type="invalid">{errors.accountId}</Form.Control.Feedback>}
                </Col>
                <Col sm={6}>
                  <Form.Label htmlFor="col-method">Method / reference</Form.Label>
                  <Form.Control id="col-method" maxLength={50} value={method} onChange={(e) => setMethod(e.target.value)} />
                </Col>
                <Col xs={12}>
                  <Form.Label htmlFor="col-note">Note</Form.Label>
                  <Form.Control id="col-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                </Col>
              </Row>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="light" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Collect'}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      )}
    </>
  )
}

export default CollectDue
