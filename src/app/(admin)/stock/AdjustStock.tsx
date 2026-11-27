'use client'
import Icon from '@/components/wrappers/Icon'
import { adjustStockAction } from '@/server/actions/inventory'
import { ADJUST_REASONS, ADJUST_REASON_LABEL, UNIT_ADJUST_REASONS, adjustmentProblem, parseSignedQty, type AdjustReason } from '@/server/inventory/pure'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap'
import { newUuid } from '@/utils/uuid'

export type AdjustTarget = { productId: string; name: string; trackSerial: boolean; onHand: number }

const newKey = newUuid

const AdjustModal = ({ t, onHide }: { t: AdjustTarget; onHide: () => void }) => {
  const router = useRouter()
  const [qty, setQty] = useState('')
  const [serial, setSerial] = useState('')
  const [reason, setReason] = useState<AdjustReason>(t.trackSerial ? 'damage' : 'count_correction')
  const [note, setNote] = useState('')
  // One key per form attempt: a double click / resubmit of the same attempt adjusts only once (server-side check).
  const [key, setKey] = useState(newKey)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const n = parseSignedQty(qty)
  const preview = !t.trackSerial && qty.trim() !== '' ? (n === null ? 'Enter a whole number, e.g. -2 or 5' : adjustmentProblem({ reason, qtyChange: n, onHand: t.onHand, productName: t.name })) : null

  const submit = async () => {
    if (saving) return
    setError(null)
    setErrors({})
    if (!t.trackSerial && (n === null || preview)) return setErrors({ qtyChange: preview ?? 'Enter a quantity' })
    setSaving(true)
    const res = await adjustStockAction(t.trackSerial ? { kind: 'unit', productId: t.productId, serial, reason, note, idempotencyKey: key } : { kind: 'qty', productId: t.productId, qtyChange: qty, reason, note, idempotencyKey: key })
    setSaving(false)
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {})
      // A changed form is a new attempt.
      setKey(newKey())
      return setError(res.error)
    }
    onHide()
    router.refresh()
  }

  const reasons = t.trackSerial ? UNIT_ADJUST_REASONS : ADJUST_REASONS
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
          <Modal.Title as="h5">Adjust stock · {t.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger" style={{ overflowWrap: 'anywhere' }}>{error}</Alert>}
          <p className="text-muted mb-3">
            On hand now: <span className="fw-semibold">{t.onHand}</span>
            {t.trackSerial && ' units in stock. Scan or type the serial of the unit that is damaged or lost; it will be marked damaged.'}
          </p>
          <Row className="g-3">
            {t.trackSerial ? (
              <Col xs={12}>
                <Form.Label htmlFor="adj-serial">Serial / IMEI</Form.Label>
                <Form.Control
                  id="adj-serial"
                  autoFocus
                  className="font-monospace"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.preventDefault()
                  }}
                  isInvalid={!!errors.serial || !!errors.units}
                />
                {(errors.serial || errors.units) && <Form.Control.Feedback type="invalid">{errors.serial ?? errors.units}</Form.Control.Feedback>}
              </Col>
            ) : (
              <Col sm={6}>
                <Form.Label htmlFor="adj-qty">Change (+/-)</Form.Label>
                <Form.Control id="adj-qty" autoFocus inputMode="numeric" className="text-end" placeholder="-2 or 5" value={qty} onChange={(e) => setQty(e.target.value)} isInvalid={!!errors.qtyChange || !!preview} />
                <Form.Control.Feedback type="invalid">{errors.qtyChange ?? preview}</Form.Control.Feedback>
                {n !== null && !preview && <Form.Text className="text-muted">New on hand: {t.onHand + n}</Form.Text>}
              </Col>
            )}
            <Col sm={t.trackSerial ? 12 : 6}>
              <Form.Label htmlFor="adj-reason">Reason</Form.Label>
              <Form.Select id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value as AdjustReason)} isInvalid={!!errors.reason}>
                {reasons.map((r) => (
                  <option key={r} value={r}>
                    {t.trackSerial && r === 'loss' ? 'Lost (marked damaged)' : ADJUST_REASON_LABEL[r]}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col xs={12}>
              <Form.Label htmlFor="adj-note">Note</Form.Label>
              <Form.Control id="adj-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
            </Col>
          </Row>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || (t.trackSerial ? !serial.trim() : !qty.trim() || !!preview)}>
            {saving ? 'Saving…' : t.trackSerial ? 'Mark unit' : 'Save adjustment'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

/** "Adjust stock" button + modal (products.edit; the server enforces it regardless). */
const AdjustStock = ({ target, size, label = 'Adjust' }: { target: AdjustTarget; size?: 'sm'; label?: string }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size={size} variant="tonal-primary" onClick={() => setOpen(true)} aria-label={`Adjust stock of ${target.name}`}>
        <Icon icon="sliders-horizontal" className="me-1" />
        {label}
      </Button>
      {open && <AdjustModal t={target} onHide={() => setOpen(false)} />}
    </>
  )
}

export default AdjustStock
