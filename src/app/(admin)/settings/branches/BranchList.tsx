'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import EmptyState from '@/components/ui/EmptyState'
import FormModal, { PlusLabel, type ModalField } from '@/components/ui/FormModal'
import HistoryButton from '@/components/ui/HistoryButton'
import Icon from '@/components/wrappers/Icon'
import { toConfirmResult } from '@/components/ui/actionUi'
import { activateBranchAction, createBranchAction, deactivateBranchAction, updateBranchAction } from '@/server/actions/branches'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Badge, Button, Table } from 'react-bootstrap'

export type BranchListRow = { id: string; name: string; code: string; address: string | null; phone: string | null; isDefault: boolean; active: boolean; users: number; unitsInStock: number }

const FIELDS: ModalField[] = [
  { name: 'name', label: 'Name', maxLength: 80, col: 6 },
  { name: 'code', label: 'Code', maxLength: 10, col: 6, help: 'Short code, e.g. DHK. Shown on invoices.' },
  { name: 'address', label: 'Address', maxLength: 300 },
  { name: 'phone', label: 'Phone', maxLength: 40, col: 6 },
]

const BranchList = ({ rows, can }: { rows: BranchListRow[]; can: { edit: boolean; delete: boolean } }) => {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      {error && (
        <Alert variant="danger" dismissible onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <div className="d-flex justify-content-end mb-3">
        {can.edit && (
          <FormModal
            trigger={<PlusLabel>New branch</PlusLabel>}
            title="New branch"
            intro="A new branch starts empty. Move stock into it with a transfer, and assign its staff on the Users page."
            fields={FIELDS}
            initial={{ name: '', code: '', address: '', phone: '' }}
            onSubmit={(v) => createBranchAction(v)}
          />
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="building-2" title="No branches" />
      ) : (
        <div className="table-responsive">
          <Table hover className="align-middle mb-0">
            <thead>
              <tr>
                <th>Branch</th>
                <th>Code</th>
                <th>Address / phone</th>
                <th className="text-end">Users</th>
                <th className="text-end">Units in stock</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className={b.active ? undefined : 'text-muted'}>
                  <td className="fw-semibold">
                    {b.name} {b.isDefault && <Badge bg="primary-subtle" text="primary">Main</Badge>} {!b.active && <Badge bg="secondary">Inactive</Badge>}
                  </td>
                  <td className="font-monospace">{b.code}</td>
                  <td className="small">
                    {b.address ?? ''}
                    {b.address && b.phone ? <br /> : null}
                    {b.phone ?? ''}
                  </td>
                  <td className="text-end">{b.users}</td>
                  <td className="text-end">{b.unitsInStock}</td>
                  <td className="text-end text-nowrap">
                    <HistoryButton entity="branch" id={b.id} title={b.name} />
                    {can.edit && (
                      <FormModal
                        trigger={<Icon icon="pencil" />}
                        triggerVariant="tonal-secondary"
                        triggerSize="sm"
                        triggerClassName="btn-square ms-1"
                        triggerLabel={`Edit ${b.name}`}
                        title={`Edit ${b.name}`}
                        fields={FIELDS}
                        initial={{ name: b.name, code: b.code, address: b.address ?? '', phone: b.phone ?? '' }}
                        onSubmit={(v) => updateBranchAction(b.id, v)}
                      />
                    )}
                    {b.active
                      ? can.delete &&
                        !b.isDefault && (
                          <ConfirmDelete
                            title="Deactivate this branch?"
                            itemName={b.name}
                            message="Its history stays. It must be empty first: no stock, no open service tickets and no users assigned."
                            confirmLabel="Deactivate"
                            onConfirm={async () => toConfirmResult(await deactivateBranchAction(b.id))}
                          />
                        )
                      : can.edit && (
                          <Button
                            size="sm"
                            variant="tonal-success"
                            className="ms-1"
                            onClick={async () => {
                              const r = await activateBranchAction(b.id)
                              if (!r.ok) setError(r.error)
                              else router.refresh()
                            }}
                          >
                            Reactivate
                          </Button>
                        )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </>
  )
}

export default BranchList
