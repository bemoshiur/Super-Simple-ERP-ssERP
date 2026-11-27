'use client'
import Icon from '@/components/wrappers/Icon'
import { flexRender, type Table } from '@tanstack/react-table'
import type { ReactNode } from 'react'

type Align = 'start' | 'end' | undefined

/**
 * Renders a TanStack table instance as a Bootstrap table that scrolls horizontally inside its own wrapper.
 * Column `meta.align` ('end' for numbers) aligns header and cells; sortable columns get a real button in the header.
 */
function DataTable<T>({ table, emptyMessage = 'Nothing found.', className, showHeaders = true }: { table: Table<T>; emptyMessage?: ReactNode; className?: string; showHeaders?: boolean }) {
  const rows = table.getRowModel().rows
  const columnCount = table.getVisibleLeafColumns().length
  const alignOf = (meta: unknown): Align => (meta as { align?: Align } | undefined)?.align
  return (
    <div className={`table-responsive${className ? ` ${className}` : ''}`}>
      <table className="table table-hover ss-table">
        {showHeaders && (
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sortable = header.column.getCanSort()
                  const sorted = header.column.getIsSorted()
                  const label = header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={`${alignOf(header.column.columnDef.meta) === 'end' ? 'text-end' : ''}${sortable ? ' is-sortable' : ''}`}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    >
                      {sortable ? (
                        <button type="button" className="ss-sort-btn" onClick={header.column.getToggleSortingHandler()}>
                          {label}
                          {sorted && <Icon icon={sorted === 'asc' ? 'arrow-up' : 'arrow-down'} aria-hidden="true" />}
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
        )}
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className="text-center text-muted py-3">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={alignOf(cell.column.columnDef.meta) === 'end' ? 'text-end' : undefined} suppressHydrationWarning>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export default DataTable
