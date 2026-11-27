import EmptyState from '@/components/ui/EmptyState'
import MoneyText from '@/components/ui/MoneyText'
import type { ReportColumn, ReportRow, ReportTable } from '@/server/reports/types'
import Link from 'next/link'
import { Table } from 'react-bootstrap'

function Cell({ col, value, href, first }: { col: ReportColumn; value: ReportRow[string]; href?: string | null; first: boolean }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted">-</span>
  if (col.kind === 'money') return <MoneyText value={value as string} tone />
  if (col.kind === 'percent') return <>{String(value)}%</>
  const text = String(value)
  return first && href ? <Link href={href}>{text}</Link> : <>{text}</>
}

const ReportTables = ({ tables }: { tables: ReportTable[] }) => (
  <>
    {tables.map((t, ti) => {
      const right = (c: ReportColumn) => c.kind === 'money' || c.kind === 'int' || c.kind === 'percent'
      return (
        <div key={ti} className="mb-4">
          {t.title && <h5 className="mb-2">{t.title}</h5>}
          {t.rows.length === 0 && !t.totals ? (
            <EmptyState icon="file-search" title="Nothing to show" description="No records match these filters." className="py-4" />
          ) : (
            <div className="table-responsive">
              <Table hover size="sm" className="align-middle mb-0 report-table">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.key} className={right(c) ? 'text-end' : undefined}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, i) => {
                    const style = r._style
                    if (style === 'heading')
                      return (
                        <tr key={i} className="table-light">
                          <td colSpan={t.columns.length} className="fw-bold">
                            {String(r[t.columns[0].key])}
                          </td>
                        </tr>
                      )
                    return (
                      <tr key={i} className={style === 'total' ? 'fw-bold border-top border-2' : style === 'sub' ? 'fw-semibold' : undefined}>
                        {t.columns.map((c, ci) => (
                          <td key={c.key} className={right(c) ? 'text-end' : undefined} style={c.kind === 'text' && ci === 0 && String(r[c.key] ?? '').startsWith('  ') ? { paddingLeft: '1.5rem', whiteSpace: 'pre' } : undefined}>
                            <Cell col={c} value={typeof r[c.key] === 'string' && ci === 0 ? String(r[c.key]).trim() : r[c.key]} href={r._href as string | null | undefined} first={ci === 0} />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
                {t.totals && (
                  <tfoot>
                    <tr className="fw-bold">
                      {t.columns.map((c) => (
                        <td key={c.key} className={right(c) ? 'text-end' : undefined}>
                          <Cell col={c} value={t.totals![c.key]} first={false} />
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </Table>
            </div>
          )}
        </div>
      )
    })}
  </>
)

export default ReportTables
