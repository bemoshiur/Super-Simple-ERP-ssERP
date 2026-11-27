import { listHref, pageMeta, pageWindow, type RawSearchParams } from '@/server/pagination'
import Link from 'next/link'

/** Server-rendered pager: plain links that keep every other query param. Used by pages with their own filter bars. */
const LinkPager = ({ path, sp, total, page, pageSize, itemsName = 'items' }: { path: string; sp: RawSearchParams; total: number; page: number; pageSize: number; itemsName?: string }) => {
  const meta = pageMeta(total, page, pageSize)
  if (total === 0) return null
  const href = (p: number) => listHref(path, sp, { page: p })
  return (
    <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-3 d-print-none">
      <div className="text-muted">
        Showing <span className="fw-semibold">{meta.start}</span> to <span className="fw-semibold">{meta.end}</span> of <span className="fw-semibold">{meta.total}</span> {itemsName}
      </div>
      {meta.pageCount > 1 && (
        <nav aria-label="Pages">
          <ul className="pagination pagination-sm mb-0">
            <li className={`page-item${meta.hasPrev ? '' : ' disabled'}`}>{meta.hasPrev ? <Link className="page-link" href={href(meta.page - 1)}>Previous</Link> : <span className="page-link">Previous</span>}</li>
            {pageWindow(meta.page, meta.pageCount).map((n, i) =>
              n === null ? (
                <li key={`gap-${i}`} className="page-item disabled">
                  <span className="page-link">…</span>
                </li>
              ) : (
                <li key={n} className={`page-item${n === meta.page ? ' active' : ''}`}>
                  <Link className="page-link" href={href(n)} aria-current={n === meta.page ? 'page' : undefined}>
                    {n}
                  </Link>
                </li>
              ),
            )}
            <li className={`page-item${meta.hasNext ? '' : ' disabled'}`}>{meta.hasNext ? <Link className="page-link" href={href(meta.page + 1)}>Next</Link> : <span className="page-link">Next</span>}</li>
          </ul>
        </nav>
      )}
    </div>
  )
}

export default LinkPager
