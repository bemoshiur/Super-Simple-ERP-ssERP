'use client'
import Icon from '@/components/wrappers/Icon'
import { useRouter } from 'next/navigation'
import { useId, useState, type ReactNode } from 'react'
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap'

export type ModalField = {
  name: string
  label: string
  type?: 'text' | 'money' | 'date' | 'select' | 'textarea'
  options?: { value: string; label: string }[]
  /** Select: first option with empty value. */
  placeholder?: string
  /** Text: suggestions (<datalist>). */
  suggestions?: string[]
  help?: ReactNode
  maxLength?: number
  /** Grid width on >= sm screens (default 12). */
  col?: 6 | 12
}

type Failure = { ok: false; error: string; fieldErrors?: Record<string, string> }
type Props = {
  /** Button content. */
  trigger: ReactNode
  triggerVariant?: string
  triggerSize?: 'sm' | 'lg'
  triggerClassName?: string
  triggerLabel?: string
  title: string
  intro?: ReactNode
  fields: ModalField[]
  initial?: Record<string, string>
  submitLabel?: string
  submitVariant?: string
  onSubmit: (values: Record<string, string>) => Promise<{ ok: true } | Failure | { ok: true; data?: unknown }>
}

/**
 * A button that opens a small form dialog. Values are plain strings sent to a guarded server action, which validates with zod
 * and returns field errors; on success the dialog closes and the server page re-renders (router.refresh).
 */
const FormModal = ({ trigger, triggerVariant = 'primary', triggerSize, triggerClassName, triggerLabel, title, intro, fields, initial = {}, submitLabel = 'Save', submitVariant = 'primary', onSubmit }: Props) => {
  const router = useRouter()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const show = () => {
    setValues(initial)
    setErrors({})
    setError(null)
    setOpen(true)
  }
  const set = (name: string, v: string) => setValues((s) => ({ ...s, [name]: v }))
  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await onSubmit(values)
      if (!res.ok) {
        setErrors((res as Failure).fieldErrors ?? {})
        setError((res as Failure).error)
        return
      }
      setOpen(false)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button variant={triggerVariant} size={triggerSize} className={triggerClassName} onClick={show} aria-label={triggerLabel}>
        {trigger}
      </Button>
      {open && (
        <Modal show onHide={() => !saving && setOpen(false)} centered backdrop="static">
          <Form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <Modal.Header closeButton>
              <Modal.Title as="h5">{title}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              {error && <Alert variant="danger">{error}</Alert>}
              {intro && <p className="text-muted">{intro}</p>}
              <Row className="g-3">
                {fields.map((f) => {
                  const id = `${uid}-${f.name}`
                  const invalid = !!errors[f.name]
                  const v = values[f.name] ?? ''
                  return (
                    <Col key={f.name} sm={f.col ?? 12}>
                      <Form.Label htmlFor={id}>{f.label}</Form.Label>
                      {f.type === 'select' ? (
                        <Form.Select id={id} value={v} onChange={(e) => set(f.name, e.target.value)} isInvalid={invalid}>
                          {f.placeholder !== undefined && <option value="">{f.placeholder}</option>}
                          {(f.options ?? []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Form.Select>
                      ) : f.type === 'textarea' ? (
                        <Form.Control as="textarea" rows={2} id={id} value={v} maxLength={f.maxLength} onChange={(e) => set(f.name, e.target.value)} isInvalid={invalid} />
                      ) : (
                        <>
                          <Form.Control
                            id={id}
                            type={f.type === 'date' ? 'date' : 'text'}
                            inputMode={f.type === 'money' ? 'decimal' : undefined}
                            className={f.type === 'money' ? 'text-end' : undefined}
                            value={v}
                            maxLength={f.maxLength}
                            list={f.suggestions ? `${id}-list` : undefined}
                            onChange={(e) => set(f.name, e.target.value)}
                            isInvalid={invalid}
                          />
                          {f.suggestions && (
                            <datalist id={`${id}-list`}>
                              {f.suggestions.map((s) => (
                                <option key={s} value={s} />
                              ))}
                            </datalist>
                          )}
                        </>
                      )}
                      {invalid && <Form.Control.Feedback type="invalid">{errors[f.name]}</Form.Control.Feedback>}
                      {!invalid && f.help && <Form.Text className="text-muted">{f.help}</Form.Text>}
                    </Col>
                  )
                })}
              </Row>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="light" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" variant={submitVariant} disabled={saving}>
                {saving ? 'Saving…' : submitLabel}
              </Button>
            </Modal.Footer>
          </Form>
        </Modal>
      )}
    </>
  )
}

export const PlusLabel = ({ children }: { children: ReactNode }) => (
  <>
    <Icon icon="plus" className="me-1" />
    {children}
  </>
)

export default FormModal
