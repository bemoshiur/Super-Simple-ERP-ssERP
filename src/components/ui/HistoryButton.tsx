'use client'
import Icon from '@/components/wrappers/Icon'
import { useOptionalShell } from '@/context/useShellContext'
import { getRecordHistoryAction, type HistoryItem } from '@/server/actions/activity'
import { useState } from 'react'
import { Alert, Button, Offcanvas, Spinner, Table } from 'react-bootstrap'

/**
 * "History" button + side drawer listing record_history changes for one record (who, when, field from -> to).
 * The server action checks the record's view permission and scopes by the session's company; values are rendered as text.
 */
/** Documents whose history a branch-restricted user may read (mirrors BRANCH_OWNED in server/actions/activity.ts). */
const BRANCH_OWNED = new Set(['sale', 'purchase', 'expense', 'income'])

const HistoryButton = ({ entity, id, title, size, iconOnly }: { entity: string; id: string; title: string; size?: 'sm'; iconOnly?: boolean }) => {
  const shell = useOptionalShell()
  // Shared records' history spans every branch: in a multi-branch company the server refuses it without "All branches",
  // so do not offer a button that can only fail. (UI only; the server action enforces the rule.)
  const hidden = !!shell?.branch?.multi && !shell.branch.canSwitch && !BRANCH_OWNED.has(entity)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const show = async () => {
    setOpen(true)
    setItems(null)
    setError(null)
    try {
      const res = await getRecordHistoryAction(entity, id)
      if (res.ok) setItems(res.data)
      else setError(res.error)
    } catch {
      setError('Could not load history. Try again.')
    }
  }

  if (hidden) return null
  return (
    <>
      <Button variant={iconOnly ? 'tonal-secondary' : 'light'} size={size} className={iconOnly ? 'btn-square' : undefined} onClick={show} aria-label={`Change history of ${title}`} title="Change history">
        <Icon icon="history" className={iconOnly ? undefined : 'me-1'} />
        {!iconOnly && 'History'}
      </Button>
      <Offcanvas show={open} onHide={() => setOpen(false)} placement="end" style={{ width: 'min(520px, 100vw)' }}>
        <Offcanvas.Header closeButton>
          <Offcanvas.Title as="h5" style={{ overflowWrap: 'anywhere' }}>
            History · {title}
          </Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          {!error && items === null && (
            <div className="text-center text-muted py-4">
              <Spinner size="sm" className="me-2" /> Loading…
            </div>
          )}
          {items && items.length === 0 && <p className="text-muted">No tracked changes yet. Price, contact and other key-field edits appear here.</p>}
          {items?.map((it) => (
            <div key={it.id} className="mb-3 border-bottom pb-2">
              <div className="small text-muted mb-1">
                {it.at} · {it.by}
              </div>
              <Table size="sm" className="mb-0" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>Field</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {it.rows.map((r) => (
                    <tr key={r.key}>
                      <td className="text-muted">{r.key}</td>
                      <td style={{ overflowWrap: 'anywhere' }}>{r.before}</td>
                      <td style={{ overflowWrap: 'anywhere' }} className="fw-semibold">
                        {r.after}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ))}
        </Offcanvas.Body>
      </Offcanvas>
    </>
  )
}

export default HistoryButton
