'use client'
import Icon from '@/components/wrappers/Icon'
import { closeServiceTicketAction, openServiceTicketAction, updateServiceTicketAction } from '@/server/actions/serials'
import { OUTCOME_EFFECT, TICKET_OUTCOMES, type TicketOutcome } from '@/server/service/schemas'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Button, Form, Modal } from 'react-bootstrap'

type Fields = Record<string, string>

const useRun = (onDone: () => void) => {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Fields>({})
  const run = async (fn: () => Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: Fields }>) => {
    if (saving) return
    setSaving(true)
    setError(null)
    setErrors({})
    const res = await fn()
    setSaving(false)
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {})
      return setError(res.error)
    }
    onDone()
    router.refresh()
  }
  return { saving, error, errors, run }
}

/** "Open service ticket" for a sold unit (needs serials.create). */
export const OpenTicketButton = ({ unitId, serialNo, underWarranty }: { unitId: string; serialNo: string; underWarranty: boolean }) => {
  const [show, setShow] = useState(false)
  const [issue, setIssue] = useState('')
  const [notes, setNotes] = useState('')
  const { saving, error, errors, run } = useRun(() => {
    setShow(false)
    setIssue('')
    setNotes('')
  })
  return (
    <>
      <Button variant="warning" onClick={() => setShow(true)}>
        <Icon icon="wrench" className="me-1" /> Open service ticket
      </Button>
      {show && (
        <Modal show onHide={() => !saving && setShow(false)} centered backdrop="static">
          <Form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => openServiceTicketAction(unitId, { issue, notes }))
            }}
          >
            <Modal.Header closeButton>
              <Modal.Title as="h5">
                Open service ticket · <span className="font-monospace">{serialNo}</span>
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              {error && <Alert variant="danger">{error}</Alert>}
              <p className={underWarranty ? 'text-success' : 'text-muted'}>{underWarranty ? 'This unit is still under warranty.' : 'This unit is out of warranty (the ticket is recorded as such).'} It will be marked &quot;In service&quot; until the ticket is finished.</p>
              <Form.Label htmlFor="tk-issue">What is wrong?</Form.Label>
              <Form.Control id="tk-issue" as="textarea" rows={3} autoFocus maxLength={1000} value={issue} onChange={(e) => setIssue(e.target.value)} isInvalid={!!errors.issue} />
              {errors.issue && <Form.Control.Feedback type="invalid">{errors.issue}</Form.Control.Feedback>}
              <Form.Label htmlFor="tk-notes" className="mt-3">
                Notes (optional)
              </Form.Label>
              <Form.Control id="tk-notes" as="textarea" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Modal.Body>
            <Modal.Footer>
              <Button variant="light" onClick={() => setShow(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Opening…' : 'Open ticket'}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      )}
    </>
  )
}

/** Mark in progress / finish an active ticket (needs serials.edit). */
export const TicketRowActions = ({ ticketId, ticketNo, status }: { ticketId: string; ticketNo: string | null; status: string }) => {
  const [show, setShow] = useState(false)
  const [outcome, setOutcome] = useState<TicketOutcome | ''>('')
  const [resolution, setResolution] = useState('')
  const progress = useRun(() => {})
  const close = useRun(() => setShow(false))
  return (
    <div className="d-flex flex-wrap gap-2 align-items-center">
      {status === 'open' && (
        <Button size="sm" variant="tonal-info" disabled={progress.saving} onClick={() => void progress.run(() => updateServiceTicketAction(ticketId, { status: 'in_progress' }))}>
          Mark in progress
        </Button>
      )}
      <Button size="sm" variant="tonal-primary" onClick={() => setShow(true)}>
        Finish ticket
      </Button>
      {progress.error && <span className="text-danger small">{progress.error}</span>}
      {show && (
        <Modal show onHide={() => !close.saving && setShow(false)} centered backdrop="static">
          <Form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void close.run(() => closeServiceTicketAction(ticketId, { outcome, resolution }))
            }}
          >
            <Modal.Header closeButton>
              <Modal.Title as="h5">Finish {ticketNo ?? 'ticket'}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              {close.error && <Alert variant="danger">{close.error}</Alert>}
              <Form.Label className="fw-semibold">How did it end?</Form.Label>
              {TICKET_OUTCOMES.map((o) => (
                <Form.Check key={o} type="radio" id={`outcome-${o}`} name="outcome" className="mb-2" checked={outcome === o} onChange={() => setOutcome(o)} label={<><span className="fw-semibold">{OUTCOME_EFFECT[o].label}</span><div className="text-muted small">{OUTCOME_EFFECT[o].help}</div></>} />
              ))}
              {close.errors.outcome && <div className="text-danger small mb-2">{close.errors.outcome}</div>}
              <Form.Label htmlFor="tk-res" className="mt-2">
                What was done?
              </Form.Label>
              <Form.Control id="tk-res" as="textarea" rows={3} maxLength={1000} value={resolution} onChange={(e) => setResolution(e.target.value)} isInvalid={!!close.errors.resolution} />
              {close.errors.resolution && <Form.Control.Feedback type="invalid">{close.errors.resolution}</Form.Control.Feedback>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="light" onClick={() => setShow(false)} disabled={close.saving}>
                Cancel
              </Button>
              <Button type="submit" disabled={close.saving}>
                {close.saving ? 'Saving…' : 'Finish ticket'}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      )}
    </div>
  )
}
