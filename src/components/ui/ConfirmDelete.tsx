'use client'
import Icon from '@/components/wrappers/Icon'
import { useState, type ReactNode } from 'react'
import { Button, Modal } from 'react-bootstrap'

type Result = void | { error?: string } | undefined

type Props = {
  /** Runs on confirm. Can be a server action (e.g. `deleteProduct.bind(null, id)`). Return `{ error }` or throw to keep the dialog open with a message. */
  onConfirm: () => Promise<Result> | Result
  /** What is being deleted, e.g. the product name. Shown in the dialog. */
  itemName?: string
  title?: string
  message?: ReactNode
  confirmLabel?: string
  /** Custom trigger content; defaults to a small trash icon button. */
  children?: ReactNode
  className?: string
  disabled?: boolean
}

const ConfirmDelete = ({ onConfirm, itemName, title = 'Delete this item?', message, confirmLabel = 'Delete', children, className, disabled }: Props) => {
  const [show, setShow] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (pending) return
    setShow(false)
    setError(null)
  }

  const confirm = async () => {
    setPending(true)
    setError(null)
    try {
      const res = await onConfirm()
      if (res && typeof res === 'object' && res.error) {
        setError(res.error)
        return
      }
      setShow(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button variant={children ? 'danger' : 'tonal-danger'} size="sm" className={className ?? (children ? undefined : 'btn-square')} onClick={() => setShow(true)} disabled={disabled} aria-label={itemName ? `Delete ${itemName}` : 'Delete'}>
        {children ?? <Icon icon="trash-2" />}
      </Button>
      <Modal show={show} onHide={close} centered backdrop={pending ? 'static' : true}>
        <Modal.Header closeButton={!pending}>
          <Modal.Title as="h5">{title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {itemName && (
            <p className="fw-semibold mb-2" style={{ overflowWrap: 'anywhere' }}>
              {itemName}
            </p>
          )}
          <p className="mb-0 text-muted">{message ?? 'This action cannot be undone.'}</p>
          {error && (
            <div className="alert alert-danger mt-3 mb-0" role="alert">
              {error}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={pending}>
            {pending ? 'Deleting…' : confirmLabel}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  )
}

export default ConfirmDelete
