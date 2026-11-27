'use client'
import FormField, { FormProvider, useZodForm } from '@/components/ui/FormField'
import { applyActionErrors } from '@/components/ui/actionUi'
import { createPartyAction, updatePartyAction } from '@/server/actions/parties'
import type { PartyKind } from '@/server/parties/parties'
import { partySchema } from '@/server/parties/schemas'
import { useState } from 'react'
import { Alert, Button, Col, Modal, Row } from 'react-bootstrap'

export type PartyFormRow = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  openingBalance: string
  notes: string | null
  active: boolean
}

const PartyModal = ({ kind, row, onHide }: { kind: PartyKind; row: PartyFormRow | null; onHide: () => void }) => {
  const noun = kind === 'vendor' ? 'vendor' : 'customer'
  const form = useZodForm(partySchema, {
    defaultValues: {
      name: row?.name ?? '',
      phone: row?.phone ?? '',
      email: row?.email ?? '',
      address: row?.address ?? '',
      openingBalance: row?.openingBalance ?? '',
      notes: row?.notes ?? '',
    },
  })
  const [error, setError] = useState<string | null>(null)
  const submit = form.handleSubmit(async (values) => {
    setError(null)
    const res = row ? await updatePartyAction(kind, row.id, values) : await createPartyAction(kind, values)
    if (!res.ok) return setError(applyActionErrors(form, res))
    onHide()
  })
  return (
    <Modal show onHide={onHide} centered size="lg" backdrop="static">
      <form onSubmit={submit} noValidate>
        <Modal.Header closeButton>
          <Modal.Title as="h5">{row ? `Edit ${noun}` : `New ${noun}`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <FormProvider {...form}>
            <FormField name="name" label="Name" required />
            <Row>
              <Col md={6}>
                <FormField name="phone" label="Phone" type="tel" autoComplete="off" help="Not required to be unique." />
              </Col>
              <Col md={6}>
                <FormField name="email" label="Email" type="email" autoComplete="off" />
              </Col>
            </Row>
            <FormField name="address" label="Address" type="textarea" rows={2} />
            <FormField
              name="openingBalance"
              label="Opening balance"
              placeholder="0.00"
              help={kind === 'vendor' ? 'Amount you already owe this vendor. Negative = advance paid to them.' : 'Amount this customer already owes you. Negative = advance received.'}
            />
            <FormField name="notes" label="Notes" type="textarea" rows={2} />
          </FormProvider>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={form.formState.isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : `Save ${noun}`}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

export default PartyModal
