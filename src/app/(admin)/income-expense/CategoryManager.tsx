'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import EmptyState from '@/components/ui/EmptyState'
import FormModal, { PlusLabel } from '@/components/ui/FormModal'
import { toConfirmResult } from '@/components/ui/actionUi'
import Icon from '@/components/wrappers/Icon'
import { activateExpenseCategoryAction, createExpenseCategoryAction, deactivateExpenseCategoryAction, renameExpenseCategoryAction } from '@/server/actions/accounting'
import { Badge, Button, Table } from 'react-bootstrap'

type Row = { id: string; name: string; active: boolean }

const CategoryManager = ({ rows, can }: { rows: Row[]; can: { create: boolean; edit: boolean; delete: boolean } }) => (
  <>
    <div className="d-flex justify-content-between align-items-center mb-3">
      <p className="text-muted mb-0">Categories group your expenses in the profit &amp; loss. Income categories are free text with suggestions.</p>
      {can.create && <FormModal trigger={<PlusLabel>Add category</PlusLabel>} title="Add expense category" fields={[{ name: 'name', label: 'Name', maxLength: 100 }]} initial={{ name: '' }} onSubmit={(v) => createExpenseCategoryAction(v)} />}
    </div>
    {rows.length === 0 ? (
      <EmptyState icon="tags" title="No categories" className="py-4" />
    ) : (
      <Table hover size="sm" className="align-middle mb-0" style={{ maxWidth: 520 }}>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className={c.active ? undefined : 'text-muted'}>
              <td>
                {c.name} {!c.active && <Badge bg="secondary">Inactive</Badge>}
              </td>
              <td className="text-end text-nowrap">
                {can.edit && (
                  <FormModal trigger={<Icon icon="pencil" />} triggerVariant="tonal-secondary" triggerSize="sm" triggerClassName="btn-square me-1" triggerLabel={`Rename ${c.name}`} title="Rename category" fields={[{ name: 'name', label: 'Name', maxLength: 100 }]} initial={{ name: c.name }} onSubmit={(v) => renameExpenseCategoryAction(c.id, v)} />
                )}
                {c.active
                  ? can.delete && <ConfirmDelete title="Deactivate this category?" itemName={c.name} message="Existing expenses keep it; it just can't be chosen for new ones." confirmLabel="Deactivate" onConfirm={async () => toConfirmResult(await deactivateExpenseCategoryAction(c.id))} />
                  : can.edit && (
                      <Button size="sm" variant="tonal-success" onClick={async () => void (await activateExpenseCategoryAction(c.id))}>
                        Reactivate
                      </Button>
                    )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    )}
  </>
)

export default CategoryManager
