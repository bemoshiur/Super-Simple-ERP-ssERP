'use client'
import { updateSettingsAction } from '@/server/actions/settings'
import { safeLogoUrl } from '@/server/settings/pure'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, Row } from 'react-bootstrap'

type Values = {
  companyName: string
  companyAddress: string
  companyPhone: string
  companyEmail: string
  currencySymbol: string
  invoiceFooter: string
  logoUrl: string
  prefixSale: string
  prefixPurchase: string
  prefixSaleReturn: string
  prefixPurchaseReturn: string
  prefixService: string
}

const PREFIXES: { name: keyof Values; label: string }[] = [
  { name: 'prefixSale', label: 'Sale invoice' },
  { name: 'prefixPurchase', label: 'Purchase invoice' },
  { name: 'prefixSaleReturn', label: 'Sale return' },
  { name: 'prefixPurchaseReturn', label: 'Purchase return' },
  { name: 'prefixService', label: 'Service ticket' },
]

const SettingsForm = ({ initial, timezone, weekStart, canEdit }: { initial: Values; timezone: string; weekStart: string; canEdit: boolean }) => {
  const router = useRouter()
  const [v, setV] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const logo = safeLogoUrl(v.logoUrl)
  // After a save the server re-renders with normalised values (e.g. upper-cased prefixes): show those.
  const initialKey = JSON.stringify(initial)
  const [seenKey, setSeenKey] = useState(initialKey)
  if (seenKey !== initialKey) {
    setSeenKey(initialKey)
    setV(initial)
  }

  const field = (name: keyof Values, label: string, opts: { help?: ReactNode; as?: 'textarea'; maxLength?: number; type?: string; className?: string } = {}) => (
    <Form.Group className={opts.className ?? 'mb-3'} controlId={`s-${name}`}>
      <Form.Label>{label}</Form.Label>
      <Form.Control
        as={opts.as}
        rows={opts.as ? 3 : undefined}
        type={opts.type}
        value={v[name]}
        maxLength={opts.maxLength}
        disabled={!canEdit}
        isInvalid={!!errors[name]}
        onChange={(e) => {
          setSaved(false)
          setV((s) => ({ ...s, [name]: e.target.value }))
        }}
      />
      {errors[name] ? <Form.Control.Feedback type="invalid">{errors[name]}</Form.Control.Feedback> : opts.help ? <Form.Text className="text-muted">{opts.help}</Form.Text> : null}
    </Form.Group>
  )

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    setErrors({})
    setSaved(false)
    try {
      const res = await updateSettingsAction(v)
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {})
        setError(res.error)
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {!canEdit && <Alert variant="info">You can view these settings. Changing them needs the “Settings: edit” permission.</Alert>}
      {error && <Alert variant="danger">{error}</Alert>}
      {saved && <Alert variant="success">Settings saved. New invoices and prints use them right away.</Alert>}
      <Row className="g-3">
        <Col lg={6}>
          <Card className="h-100">
            <CardHeader>
              <h5 className="mb-0">Company profile</h5>
            </CardHeader>
            <CardBody>
              {field('companyName', 'Company name', { maxLength: 120 })}
              {field('companyAddress', 'Address', { as: 'textarea', maxLength: 300, help: 'Printed on invoices. Leave empty to use the branch address.' })}
              <Row>
                <Col sm={6}>{field('companyPhone', 'Phone', { maxLength: 40 })}</Col>
                <Col sm={6}>{field('companyEmail', 'Email', { type: 'email', maxLength: 254 })}</Col>
              </Row>
              {field('logoUrl', 'Logo URL', { maxLength: 500, help: 'An https:// image address or a path on this site such as /logo.png. Shown on printed invoices.' })}
              {logo && (
                <div className="border rounded p-2 d-inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element -- validated https/same-origin URL; plain img avoids remote-image config */}
                  <img src={logo} alt="Logo preview" referrerPolicy="no-referrer" style={{ maxHeight: 60, maxWidth: 220 }} />
                </div>
              )}
            </CardBody>
          </Card>
        </Col>
        <Col lg={6}>
          <Card className="mb-3">
            <CardHeader>
              <h5 className="mb-0">Invoices</h5>
            </CardHeader>
            <CardBody>
              <Row>
                <Col sm={4}>{field('currencySymbol', 'Currency symbol', { maxLength: 5, help: 'e.g. ৳, Tk, BDT' })}</Col>
              </Row>
              <div className="mb-2 fw-semibold">Document number prefixes</div>
              <Row>
                {PREFIXES.map((p) => (
                  <Col sm={4} key={p.name}>
                    {field(p.name, p.label, { maxLength: 10 })}
                  </Col>
                ))}
              </Row>
              <p className="text-muted small">Letters, numbers, - and _ (max 10, not ending in a digit). A new prefix applies to new documents only; existing numbers never change and numbering continues.</p>
              {field('invoiceFooter', 'Invoice footer', { as: 'textarea', maxLength: 500, help: 'e.g. return policy or a thank-you note, printed at the bottom of invoices.' })}
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <h5 className="mb-0">Region</h5>
            </CardHeader>
            <CardBody>
              <Row>
                <Col sm={6}>
                  <Form.Group className="mb-2" controlId="s-tz">
                    <Form.Label>Time zone</Form.Label>
                    <Form.Control value={timezone} readOnly disabled />
                  </Form.Group>
                </Col>
                <Col sm={6}>
                  <Form.Group className="mb-2" controlId="s-week">
                    <Form.Label>Week starts on</Form.Label>
                    <Form.Control value={weekStart} readOnly disabled />
                  </Form.Group>
                </Col>
              </Row>
              <p className="text-muted small mb-0">Set by the server (APP_TIMEZONE environment variable); used for dates, reports and “today”.</p>
            </CardBody>
          </Card>
        </Col>
      </Row>
      {canEdit && (
        <div className="d-flex justify-content-end mt-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      )}
    </Form>
  )
}

export default SettingsForm
