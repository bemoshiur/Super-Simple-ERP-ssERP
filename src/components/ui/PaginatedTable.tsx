'use client'
import DataTable from '@/components/table/DataTable'
import Pager from '@/components/table/Pager'
import EmptyState from '@/components/ui/EmptyState'
import MoneyText from '@/components/ui/MoneyText'
import Icon from '@/components/wrappers/Icon'
import { listHref, pageMeta } from '@/server/pagination'
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState, useTransition, type ReactNode } from 'react'
import { useDebounceCallback } from 'usehooks-ts'

/** Serializable column spec, so server components can declare columns inline. */
export type PaginatedColumn<T> = {
  header: string
  accessorKey: keyof T & string
  kind?: 'text' | 'money' | 'number' | 'date'
  align?: 'start' | 'end'
}

type Props<T> = {
  /** The current page's rows, already fetched server-side (LIMIT/OFFSET from parseListParams). */
  rows: T[]
  /** Total rows matching the current search (a COUNT(*) with the same WHERE). */
  total: number
  page: number
  pageSize: number
  /** Current search text (from parseListParams). */
  q: string
  columns?: PaginatedColumn<T>[]
  /** Full tanstack column defs for custom cells. Functions are not serializable: only usable from a client component. */
  columnDefs?: ColumnDef<T, never>[]
  searchPlaceholder?: string
  /** e.g. "products" in "Showing 1 to 20 of 45 products". */
  itemsName?: string
  emptyTitle?: string
  emptyDescription?: ReactNode
  /** Right-side toolbar (e.g. an "Add" button). */
  toolbar?: ReactNode
}

function toColumnDefs<T>(columns: PaginatedColumn<T>[]): ColumnDef<T, never>[] {
  return columns.map((c) => ({
    id: c.accessorKey,
    header: c.header,
    accessorKey: c.accessorKey,
    enableSorting: false,
    meta: { align: c.align },
    cell: ({ getValue }: { getValue: () => unknown }) => {
      const v = getValue()
      if (c.kind === 'money') return <MoneyText value={v as string | number | null} />
      if (c.kind === 'number') return <span className="text-nowrap">{v === null || v === undefined ? '-' : String(v)}</span>
      return v === null || v === undefined || v === '' ? <span className="text-muted">-</span> : String(v)
    },
  })) as unknown as ColumnDef<T, never>[]
}

/**
 * Server-driven list: search box + table + pager. All state lives in the URL (`?q=&page=`), so pages are
 * shareable, back/forward work, and the server component re-queries on navigation. Nothing is sorted or
 * filtered client-side.
 */
function PaginatedTable<T>({ rows, total, page, pageSize, q, columns, columnDefs, searchPlaceholder = 'Search…', itemsName = 'items', emptyTitle = 'Nothing here yet', emptyDescription, toolbar }: Props<T>) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [text, setText] = useState(q)
  useEffect(() => setText(q), [q])

  const go = (patch: { q?: string; page?: number }) => startTransition(() => router.push(listHref(pathname, sp, patch)))
  const debouncedSearch = useDebounceCallback((value: string) => go({ q: value.trim() }), 350)

  const meta = pageMeta(total, page, pageSize)
  const defs = useMemo(() => columnDefs ?? toColumnDefs(columns ?? []), [columnDefs, columns])
  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack table instance is only used for rendering below
  const table = useReactTable({ data: rows, columns: defs as ColumnDef<T>[], getCoreRowModel: getCoreRowModel(), manualPagination: true, manualFiltering: true, manualSorting: true, pageCount: meta.pageCount })

  return (
    <div>
      <div className="d-flex flex-wrap gap-2 justify-content-between align-items-center mb-3">
        <form
          role="search"
          className="ss-search"
          onSubmit={(e) => {
            e.preventDefault()
            debouncedSearch.cancel()
            go({ q: text.trim() })
          }}
        >
          <input
            type="search"
            name="q"
            className="form-control"
            placeholder={searchPlaceholder}
            aria-label="Search"
            value={text}
            maxLength={100}
            onChange={(e) => {
              setText(e.target.value)
              debouncedSearch(e.target.value)
            }}
          />
          <Icon icon="search" className="ss-search__icon" aria-hidden="true" />
        </form>
        {toolbar && <div className="d-flex gap-2">{toolbar}</div>}
      </div>

      <div style={{ opacity: pending ? 0.6 : 1, transition: 'opacity .15s' }} aria-busy={pending}>
        <DataTable
          table={table}
          emptyMessage={
            q ? <EmptyState icon="search-x" title="No results" description={<>Nothing matches “{q}”.</>} className="py-4" /> : <EmptyState title={emptyTitle} description={emptyDescription} className="py-4" />
          }
        />
      </div>

      {total > 0 && (
        <div className="mt-3">
          <Pager
            summary={{ start: meta.start, end: meta.end, total: meta.total, noun: itemsName }}
            nav={{
              index: meta.page - 1,
              count: meta.pageCount,
              canPrev: meta.hasPrev,
              canNext: meta.hasNext,
              go: (i) => go({ page: i + 1 }),
              prev: () => go({ page: meta.page - 1 }),
              next: () => go({ page: meta.page + 1 }),
            }}
          />
        </div>
      )}
    </div>
  )
}

export default PaginatedTable
