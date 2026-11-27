'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import FormField, { FormProvider, useZodForm } from '@/components/ui/FormField'
import PaginatedTable from '@/components/ui/PaginatedTable'
import StatusFilter, { type StatusValue } from '@/components/ui/StatusFilter'
import { applyActionErrors, toConfirmResult } from '@/components/ui/actionUi'
import Icon from '@/components/wrappers/Icon'
import { createTaxonAction, renameTaxonAction, setTaxonActiveAction } from '@/server/actions/catalog'
import { taxonSchema } from '@/server/catalog/schemas'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { Alert, Badge, Button, Modal } from 'react-bootstrap'

export type TaxonKind = 'category' | 'brand'
export type TaxonListRow = { id: string; name: string; active: boolean; products: number }

type Props = {
  kind: TaxonKind
  rows: TaxonListRow[]
  total: number
  page: number
  pageSize: number
  q: string
  status: StatusValue
  can: { create: boolean; edit: boolean; delete: boolean }
}

const TaxonModal = ({ kind, row, onHide }: { kind: TaxonKind; row: TaxonListRow | null; onHide: () => void }) => {
  const form = useZodForm(taxonSchema, { defaultValues: { name: row?.name ?? '' } })
  const [error, setError] = useState<string | null>(null)
  const noun = kind === 'category' ? 'category' : 'brand'
  const submit = form.handleSubmit(async (values) => {
    setError(null)
    const res = row ? await renameTaxonAction(kind, row.id, values) : await createTaxonAction(kind, values)
    if (!res.ok) return setError(applyActionErrors(form, res))
    onHide()
  })
  return (
    <Modal show onHide={onHide} centered>
      <form onSubmit={submit} noValidate>
        <Modal.Header closeButton>
          <Modal.Title as="h5">{row ? `Edit ${noun}` : `New ${noun}`}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <FormProvider {...form}>
            <FormField name="name" label="Name" required placeholder={kind === 'category' ? 'e.g. Smartphones' : 'e.g. Samsung'} />
          </FormProvider>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={form.formState.isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Saving…' : 'Save'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

const TaxonList = ({ kind, rows, total, page, pageSize, q, status, can }: Props) => {
  const [editing, setEditing] = useState<TaxonListRow | 'new' | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const noun = kind === 'category' ? 'category' : 'brand'

  const columnDefs = useMemo(
    () =>
      [
        { id: 'name', header: 'Name', accessorKey: 'name', enableSorting: false },
        { id: 'products', header: 'Active products', accessorKey: 'products', enableSorting: false },
        {
          id: 'active',
          header: 'Status',
          accessorKey: 'active',
          enableSorting: false,
          cell: ({ row }) => (row.original.active ? <Badge bg="success-subtle" text="success">Active</Badge> : <Badge bg="secondary-subtle" text="secondary">Inactive</Badge>),
        },
        {
          id: 'actions',
          header: '',
          enableSorting: false,
          cell: ({ row }) => {
            const r = row.original
            return (
              <div className="d-flex gap-1 justify-content-end">
                {can.edit && (
                  <Button size="sm" variant="tonal-primary" className="btn-square" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <Icon icon="pencil" />
                  </Button>
                )}
                {r.active && can.delete && (
                  <ConfirmDelete itemName={r.name} title={`Deactivate this ${noun}?`} message="It will be hidden from lists and pickers. Existing products keep it. You can restore it later." confirmLabel="Deactivate" onConfirm={async () => toConfirmResult(await setTaxonActiveAction(kind, r.id, false))} />
                )}
                {!r.active && can.edit && (
                  <Button
                    size="sm"
                    variant="tonal-success"
                    onClick={async () => {
                      setRowError(null)
                      const res = await setTaxonActiveAction(kind, r.id, true)
                      if (!res.ok) setRowError(res.error)
                    }}
                  >
                    Restore
                  </Button>
                )}
              </div>
            )
          },
        },
      ] as ColumnDef<TaxonListRow, never>[],
    [can.edit, can.delete, kind, noun],
  )

  return (
    <>
      {rowError && (
        <Alert variant="danger" dismissible onClose={() => setRowError(null)}>
          {rowError}
        </Alert>
      )}
      <PaginatedTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        q={q}
        columnDefs={columnDefs}
        searchPlaceholder={`Search ${noun === 'category' ? 'categories' : 'brands'}…`}
        itemsName={noun === 'category' ? 'categories' : 'brands'}
        emptyTitle={`No ${noun === 'category' ? 'categories' : 'brands'} yet`}
        emptyDescription={can.create ? `Add your first ${noun} to organise products.` : undefined}
        toolbar={
          <>
            <StatusFilter value={status} />
            {can.create && (
              <Button onClick={() => setEditing('new')}>
                <Icon icon="plus" className="me-1" /> Add {noun}
              </Button>
            )}
          </>
        }
      />
      {editing && <TaxonModal kind={kind} row={editing === 'new' ? null : editing} onHide={() => setEditing(null)} />}
    </>
  )
}

export default TaxonList
