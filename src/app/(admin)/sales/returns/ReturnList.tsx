'use client'
import MoneyText from '@/components/ui/MoneyText'
import PaginatedTable from '@/components/ui/PaginatedTable'
import type { ColumnDef } from '@tanstack/react-table'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useTransition } from 'react'
import { Form } from 'react-bootstrap'

export type ReturnRow = {
  id: string
  returnNo: string
  date: string
  saleId: string
  invoiceNo: string
  customerId: string | null
  customerName: string | null
  creditTotal: string
  refundTotal: string
  units: number
  note: string | null
}

const ReturnList = ({ rows, total, sums, page, pageSize, q, from, to }: { rows: ReturnRow[]; total: number; sums: { credit: string; refund: string }; page: number; pageSize: number; q: string; from: string; to: string }) => {
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
  const columnDefs = useMemo(
    () =>
      [
        { id: 'returnNo', header: 'Return', enableSorting: false, cell: ({ row }) => <span className="fw-semibold text-nowrap">{row.original.returnNo}</span> },
        { id: 'invoice', header: 'Invoice', enableSorting: false, cell: ({ row }) => <Link href={`/sales/${row.original.saleId}`}>{row.original.invoiceNo}</Link> },
        { id: 'customer', header: 'Customer', enableSorting: false, cell: ({ row }) => (row.original.customerId ? <Link href={`/customers/${row.original.customerId}`}>{row.original.customerName}</Link> : <span className="text-muted">Walk-in</span>) },
        { id: 'date', header: 'Date', accessorKey: 'date', enableSorting: false },
        { id: 'units', header: 'Qty', enableSorting: false, meta: { align: 'end' }, cell: ({ row }) => row.original.units },
        { id: 'credit', header: 'Value', enableSorting: false, meta: { align: 'end' }, cell: ({ row }) => <MoneyText value={row.original.creditTotal} /> },
        { id: 'refund', header: 'Refunded', enableSorting: false, meta: { align: 'end' }, cell: ({ row }) => <MoneyText value={row.original.refundTotal} /> },
      ] as ColumnDef<ReturnRow, never>[],
    [],
  )
  const filtered = !!(from || to || q)
  return (
    <>
      <div className="d-flex flex-wrap gap-2 mb-3" style={{ opacity: pending ? 0.6 : 1 }}>
        <Form.Control type="date" size="sm" style={{ width: 'auto' }} aria-label="From date" value={from} max={to || undefined} onChange={(e) => set({ from: e.target.value || null })} />
        <Form.Control type="date" size="sm" style={{ width: 'auto' }} aria-label="To date" value={to} min={from || undefined} onChange={(e) => set({ to: e.target.value || null })} />
      </div>
      <PaginatedTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        q={q}
        columnDefs={columnDefs}
        searchPlaceholder="Search return no, invoice or customer…"
        itemsName="returns"
        emptyTitle={filtered ? 'No returns match these filters' : 'No customer returns yet'}
        emptyDescription={filtered ? undefined : 'Returns are made from an invoice: open the sale and choose “Return items”.'}
      />
      {total > 0 && (
        <div className="d-flex flex-wrap gap-4 justify-content-end border-top pt-2 mt-2 small">
          <span className="text-muted">
            {total} return{total === 1 ? '' : 's'}:
          </span>
          <span>
            Value <MoneyText value={sums.credit} className="fw-semibold" />
          </span>
          <span>
            Refunded <MoneyText value={sums.refund} className="fw-semibold" />
          </span>
        </div>
      )}
    </>
  )
}

export default ReturnList
