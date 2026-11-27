'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import MoneyText from '@/components/ui/MoneyText'
import PaginatedTable from '@/components/ui/PaginatedTable'
import StatusFilter, { type StatusValue } from '@/components/ui/StatusFilter'
import { toConfirmResult } from '@/components/ui/actionUi'
import Icon from '@/components/wrappers/Icon'
import { activatePartyAction, deactivatePartyAction } from '@/server/actions/parties'
import type { PartyKind } from '@/server/parties/parties'
import type { ColumnDef } from '@tanstack/react-table'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Alert, Badge, Button } from 'react-bootstrap'
import PartyModal, { type PartyFormRow } from './PartyModal'

type Props = {
  kind: PartyKind
  rows: PartyFormRow[]
  total: number
  page: number
  pageSize: number
  q: string
  status: StatusValue
  can: { create: boolean; edit: boolean; delete: boolean }
}

const PartyList = ({ kind, rows, total, page, pageSize, q, status, can }: Props) => {
  const [editing, setEditing] = useState<PartyFormRow | 'new' | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const noun = kind === 'vendor' ? 'vendor' : 'customer'
  const base = kind === 'vendor' ? '/vendors' : '/customers'

  const columnDefs = useMemo(
    () =>
      [
        {
          id: 'name',
          header: 'Name',
          accessorKey: 'name',
          enableSorting: false,
          cell: ({ row }) => (
            <Link href={`${base}/${row.original.id}`} className="fw-semibold">
              {row.original.name}
            </Link>
          ),
        },
        { id: 'phone', header: 'Phone', accessorFn: (r) => r.phone ?? '-', enableSorting: false },
        { id: 'email', header: 'Email', accessorFn: (r) => r.email ?? '-', enableSorting: false },
        { id: 'openingBalance', header: 'Opening balance', accessorKey: 'openingBalance', enableSorting: false, meta: { align: 'end' }, cell: ({ getValue }) => <MoneyText value={getValue() as string} tone /> },
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
                <Link href={`${base}/${r.id}`} className="btn btn-sm btn-tonal-secondary btn-square" aria-label={`View ${r.name}`}>
                  <Icon icon="eye" />
                </Link>
                {can.edit && (
                  <Button size="sm" variant="tonal-primary" className="btn-square" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <Icon icon="pencil" />
                  </Button>
                )}
                {r.active && can.delete && (
                  <ConfirmDelete itemName={r.name} title={`Deactivate this ${noun}?`} message="They will be hidden from lists and pickers. Their history is kept and you can restore them later." confirmLabel="Deactivate" onConfirm={async () => toConfirmResult(await deactivatePartyAction(kind, r.id))} />
                )}
                {!r.active && can.edit && (
                  <Button
                    size="sm"
                    variant="tonal-success"
                    onClick={async () => {
                      setRowError(null)
                      const res = await activatePartyAction(kind, r.id)
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
      ] as ColumnDef<PartyFormRow, never>[],
    [can.edit, can.delete, kind, noun, base],
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
        searchPlaceholder="Search name, phone or email…"
        itemsName={`${noun}s`}
        emptyTitle={`No ${noun}s yet`}
        emptyDescription={can.create ? `Add your first ${noun}.` : undefined}
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
      {editing && <PartyModal kind={kind} row={editing === 'new' ? null : editing} onHide={() => setEditing(null)} />}
    </>
  )
}

export default PartyList
