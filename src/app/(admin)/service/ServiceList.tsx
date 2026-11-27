'use client'
import PaginatedTable from '@/components/ui/PaginatedTable'
import type { ColumnDef } from '@tanstack/react-table'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useTransition } from 'react'
import { Form } from 'react-bootstrap'
import TicketStatusBadge from '../serials/TicketStatusBadge'

export type TicketRow = {
  id: string
  ticketNo: string | null
  status: string
  issue: string
  outcome: string | null
  underWarranty: boolean
  openedAt: string
  closedAt: string | null
  unitId: string
  serialNo: string
  productName: string
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
}

const StatusSelect = ({ value, counts }: { value: string; counts: Record<string, number> }) => {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  const active = (counts.open ?? 0) + (counts.in_progress ?? 0)
  return (
    <Form.Select
      size="sm"
      style={{ width: 'auto' }}
      aria-label="Filter by ticket status"
      value={value}
      disabled={pending}
      onChange={(e) => {
        const params = new URLSearchParams(sp.toString())
        params.delete('page')
        if (e.target.value) params.set('status', e.target.value)
        else params.delete('status')
        const qs = params.toString()
        start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
      }}
    >
      <option value="">All tickets</option>
      <option value="active">Active ({active})</option>
      <option value="open">Open ({counts.open ?? 0})</option>
      <option value="in_progress">In progress ({counts.in_progress ?? 0})</option>
      <option value="resolved">Resolved ({counts.resolved ?? 0})</option>
      <option value="closed">Closed ({counts.closed ?? 0})</option>
      <option value="rejected">Rejected ({counts.rejected ?? 0})</option>
    </Form.Select>
  )
}

const ServiceList = ({ rows, total, page, pageSize, q, status, counts, canCustomers }: { canCustomers: boolean; rows: TicketRow[]; total: number; page: number; pageSize: number; q: string; status: string; counts: Record<string, number> }) => {
  const columnDefs = useMemo(
    () =>
      [
        { id: 'ticketNo', header: 'Ticket', enableSorting: false, cell: ({ row }) => <span className="fw-semibold text-nowrap">{row.original.ticketNo ?? '-'}</span> },
        { id: 'serial', header: 'Serial', enableSorting: false, cell: ({ row }) => <Link href={`/serials/${row.original.unitId}`} className="font-monospace">{row.original.serialNo}</Link> },
        { id: 'product', header: 'Product', enableSorting: false, accessorKey: 'productName' },
        { id: 'customer', header: 'Customer', enableSorting: false, cell: ({ row }) => (row.original.customerId ? canCustomers ? <Link href={`/customers/${row.original.customerId}`}>{row.original.customerName}</Link> : <span>{row.original.customerName}</span> : <span className="text-muted">Walk-in</span>) },
        { id: 'issue', header: 'Issue', enableSorting: false, cell: ({ row }) => <span style={{ overflowWrap: 'anywhere' }}>{row.original.issue}</span> },
        { id: 'status', header: 'Status', enableSorting: false, cell: ({ row }) => <TicketStatusBadge status={row.original.status} underWarranty={row.original.underWarranty} /> },
        { id: 'opened', header: 'Opened', enableSorting: false, cell: ({ row }) => <span className="text-nowrap">{row.original.openedAt.slice(0, 10)}</span> },
      ] as ColumnDef<TicketRow, never>[],
    [canCustomers],
  )
  const filtered = !!(q || status)
  return (
    <>
      <div className="mb-3">
        <StatusSelect value={status} counts={counts} />
      </div>
      <PaginatedTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        q={q}
        columnDefs={columnDefs}
        searchPlaceholder="Search serial, customer, ticket or product…"
        itemsName="tickets"
        emptyTitle={filtered ? 'No tickets match these filters' : 'No service tickets yet'}
        emptyDescription={!filtered ? 'Open a ticket from a sold unit on the Serial Lookup page.' : undefined}
      />
    </>
  )
}

export default ServiceList
