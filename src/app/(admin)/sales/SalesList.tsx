'use client'
import MoneyText from '@/components/ui/MoneyText'
import PaginatedTable from '@/components/ui/PaginatedTable'
import SearchSelect, { type SearchOption } from '@/components/ui/SearchSelect'
import Icon from '@/components/wrappers/Icon'
import { searchSaleCustomersAction } from '@/server/actions/sales'
import type { ColumnDef } from '@tanstack/react-table'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useTransition } from 'react'
import { Form } from 'react-bootstrap'
import PurchaseStatusBadge, { STATUS_OPTIONS } from '../purchases/StatusBadge'

export type SaleListRow = {
  id: string
  /** Shown only in the multi-branch "All branches" view. */
  branchName?: string | null
  invoiceNo: string
  date: string
  customerId: string | null
  customerName: string | null
  total: string
  paid: string
  due: string
  returnedTotal: string
  status: string
}

type Filters = { customer: SearchOption | null; from: string; to: string; dueOnly: boolean; status: string }
type Sums = { total: string; returned: string; paid: string; due: string }

/** Customer / date range / status / due-only filters kept in the URL; any change resets paging. */
const SaleFilters = ({ filters }: { filters: Filters }) => {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  const set = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams(sp.toString())
    params.delete('page')
    for (const [k, v] of Object.entries(patch)) {
      if (v) params.set(k, v)
      else params.delete(k)
    }
    const qs = params.toString()
    start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
  }
  return (
    <div className="d-flex flex-wrap gap-2 align-items-start" style={{ opacity: pending ? 0.6 : 1 }}>
      <div style={{ minWidth: 220 }}>
        <SearchSelect loadOptions={searchSaleCustomersAction} value={filters.customer} placeholder="All customers" onChange={(o) => set({ customer: o?.value ?? null })} />
      </div>
      <Form.Control type="date" size="sm" style={{ width: 'auto' }} aria-label="From date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value || null })} />
      <Form.Control type="date" size="sm" style={{ width: 'auto' }} aria-label="To date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value || null })} />
      <Form.Select size="sm" style={{ width: 'auto' }} aria-label="Filter by status" value={filters.status} onChange={(e) => set({ status: e.target.value || null })}>
        <option value="">Any status</option>
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Form.Select>
      <Form.Check type="switch" id="due-only" label="Due only" className="mt-1" checked={filters.dueOnly} onChange={(e) => set({ due: e.target.checked ? '1' : null })} />
    </div>
  )
}

const SalesList = ({ showBranch = false, rows, total, sums, page, pageSize, q, filters, canCreate }: { showBranch?: boolean; rows: SaleListRow[]; total: number; sums: Sums; page: number; pageSize: number; q: string; filters: Filters; canCreate: boolean }) => {
  const columnDefs = useMemo(
    () =>
      [
        { id: 'invoiceNo', header: 'Invoice', enableSorting: false, cell: ({ row }) => <Link href={`/sales/${row.original.id}`} className="fw-semibold text-nowrap">{row.original.invoiceNo}</Link> },
        {
          id: 'customer',
          header: 'Customer',
          enableSorting: false,
          cell: ({ row }) => (row.original.customerId ? <Link href={`/customers/${row.original.customerId}`}>{row.original.customerName}</Link> : <span className="text-muted">Walk-in</span>),
        },
        { id: 'date', header: 'Date', accessorKey: 'date', enableSorting: false },
        ...(showBranch ? [{ id: 'branch', header: 'Branch', enableSorting: false, cell: ({ row }: { row: { original: SaleListRow } }) => <span className="text-nowrap">{row.original.branchName ?? ''}</span> }] : []),
        { id: 'total', header: 'Total', enableSorting: false, meta: { align: 'end' }, cell: ({ row }) => <MoneyText value={row.original.total} /> },
        { id: 'paid', header: 'Paid', enableSorting: false, meta: { align: 'end' }, cell: ({ row }) => <MoneyText value={row.original.paid} /> },
        { id: 'due', header: 'Due', enableSorting: false, meta: { align: 'end' }, cell: ({ row }) => <MoneyText value={row.original.due} className={row.original.due !== '0.00' ? 'text-danger fw-semibold' : undefined} /> },
        { id: 'status', header: 'Status', enableSorting: false, cell: ({ row }) => <PurchaseStatusBadge p={row.original} /> },
        {
          id: 'actions',
          header: '',
          enableSorting: false,
          cell: ({ row }) => (
            <div className="d-flex gap-1 justify-content-end">
              <Link href={`/sales/${row.original.id}`} className="btn btn-sm btn-tonal-secondary btn-square" aria-label={`View ${row.original.invoiceNo}`}>
                <Icon icon="eye" />
              </Link>
              <a href={`/sales/${row.original.id}/print`} target="_blank" rel="noopener" className="btn btn-sm btn-tonal-secondary btn-square" aria-label={`Print ${row.original.invoiceNo}`}>
                <Icon icon="printer" />
              </a>
            </div>
          ),
        },
      ] as ColumnDef<SaleListRow, never>[],
    [showBranch],
  )
  const filtered = !!(filters.customer || filters.from || filters.to || filters.dueOnly || filters.status || q)
  return (
    <>
      <div className="mb-3">
        <SaleFilters filters={filters} />
      </div>
      <PaginatedTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        q={q}
        columnDefs={columnDefs}
        searchPlaceholder="Search invoice, customer or serial…"
        itemsName="invoices"
        emptyTitle={filtered ? 'No invoices match these filters' : 'No sales yet'}
        emptyDescription={!filtered && canCreate ? 'Scan a serial on a new sale to make your first invoice.' : undefined}
        toolbar={
          canCreate && (
            <Link href="/sales/new" className="btn btn-primary">
              <Icon icon="scan-barcode" className="me-1" /> New sale
            </Link>
          )
        }
      />
      {total > 0 && (
        <div className="d-flex flex-wrap gap-4 justify-content-end border-top pt-2 mt-2 small" aria-label="Totals for all matching invoices">
          <span className="text-muted">
            {total} invoice{total === 1 ? '' : 's'}
            {filtered ? ' matching' : ''}:
          </span>
          <span>
            Total <MoneyText value={sums.total} className="fw-semibold" />
          </span>
          {sums.returned !== '0.00' && (
            <span>
              Returned <MoneyText value={sums.returned} className="fw-semibold" />
            </span>
          )}
          <span>
            Paid <MoneyText value={sums.paid} className="fw-semibold" />
          </span>
          <span>
            Due <MoneyText value={sums.due} className={sums.due !== '0.00' ? 'fw-semibold text-danger' : 'fw-semibold'} />
          </span>
        </div>
      )}
    </>
  )
}

export default SalesList
