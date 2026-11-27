'use client'
import { changeOwnPasswordAction } from '@/server/actions/account'
import { useState } from 'react'
import { Alert, Button, Form } from 'react-bootstrap'

const ChangePasswordForm = () => {
  const [v, setV] = useState({ current: '', next: '', confirm: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    setErrors({})
    setDone(false)
    try {
      const res = await changeOwnPasswordAction(v)
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {})
        setError(res.fieldErrors && Object.keys(res.fieldErrors).length ? null : res.error)
        return
      }
      setDone(true)
      setV({ current: '', next: '', confirm: '' })
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }
  const input = (name: keyof typeof v, label: string, autoComplete: string, help?: string) => (
    <Form.Group className="mb-3" controlId={`pw-${name}`}>
      <Form.Label>{label}</Form.Label>
      <Form.Control type="password" autoComplete={autoComplete} value={v[name]} onChange={(e) => setV((s) => ({ ...s, [name]: e.target.value }))} isInvalid={!!errors[name]} maxLength={200} />
      {errors[name] ? <Form.Control.Feedback type="invalid">{errors[name]}</Form.Control.Feedback> : help ? <Form.Text className="text-muted">{help}</Form.Text> : null}
    </Form.Group>
  )
  return (
    <Form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      {error && <Alert variant="danger">{error}</Alert>}
      {done && <Alert variant="success">Password changed. You stay signed in here; every other device has been signed out.</Alert>}
      {input('current', 'Current password', 'current-password')}
      {input('next', 'New password', 'new-password', 'At least 10 characters.')}
      {input('confirm', 'Confirm new password', 'new-password')}
      <Button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Change password'}
      </Button>
    </Form>
  )
}

export default ChangePasswordForm
