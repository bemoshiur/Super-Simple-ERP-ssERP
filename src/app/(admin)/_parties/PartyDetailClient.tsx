'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import { toConfirmResult } from '@/components/ui/actionUi'
import Icon from '@/components/wrappers/Icon'
import { activatePartyAction, deactivatePartyAction } from '@/server/actions/parties'
import type { PartyKind } from '@/server/parties/parties'
import { useState, type ReactNode } from 'react'
import { Alert, Button, Tab, Tabs } from 'react-bootstrap'
import PartyModal, { type PartyFormRow } from './PartyModal'

/** Edit / deactivate / restore controls for the detail header. */
export const PartyHeaderActions = ({ kind, row, can }: { kind: PartyKind; row: PartyFormRow; can: { edit: boolean; delete: boolean } }) => {
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const noun = kind === 'vendor' ? 'vendor' : 'customer'
  return (
    <>
      <div className="d-flex gap-2">
        {can.edit && (
          <Button variant="primary" onClick={() => setEditing(true)}>
            <Icon icon="pencil" className="me-1" /> Edit
          </Button>
        )}
        {row.active && can.delete && (
          <ConfirmDelete itemName={row.name} title={`Deactivate this ${noun}?`} message="They will be hidden from lists and pickers. Their history is kept and you can restore them later." confirmLabel="Deactivate" onConfirm={async () => toConfirmResult(await deactivatePartyAction(kind, row.id))}>
            Deactivate
          </ConfirmDelete>
        )}
        {!row.active && can.edit && (
          <Button
            variant="success"
            onClick={async () => {
              setErr(null)
              const res = await activatePartyAction(kind, row.id)
              if (!res.ok) setErr(res.error)
            }}
          >
            Restore
          </Button>
        )}
      </div>
      {err && (
        <Alert variant="danger" className="mt-2 mb-0">
          {err}
        </Alert>
      )}
      {editing && <PartyModal kind={kind} row={row} onHide={() => setEditing(false)} />}
    </>
  )
}

/** Tab strip; panes are server-rendered nodes passed in. */
export const PartyTabs = ({ tabs }: { tabs: { key: string; title: string; content: ReactNode }[] }) => (
  <Tabs defaultActiveKey={tabs[0]?.key} className="mb-3">
    {tabs.map((t) => (
      <Tab key={t.key} eventKey={t.key} title={t.title}>
        {t.content}
      </Tab>
    ))}
  </Tabs>
)
