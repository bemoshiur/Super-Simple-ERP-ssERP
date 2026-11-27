'use client'
import Icon from '@/components/wrappers/Icon'
import { pageWindow } from '@/server/pagination'

/** Where the list is (0-based page index of `count`) and how to move. */
export type PagerNav = { index: number; count: number; canPrev: boolean; canNext: boolean; go: (index: number) => void; prev: () => void; next: () => void }
/** Optional "Showing 21 to 40 of 95 products" line. */
export type PagerSummary = { start: number; end: number; total: number; noun?: string }

/** A compact page list (first, last and a window around the current page) with an optional range summary. */
export default function Pager({ nav, summary }: { nav: PagerNav; summary?: PagerSummary }) {
  const current = nav.index + 1
  const step = (label: string, icon: string, enabled: boolean, onClick: () => void) => (
    <li className={`page-item${enabled ? '' : ' disabled'}`}>
      <button type="button" className="page-link" onClick={onClick} disabled={!enabled} aria-label={label}>
        <Icon icon={icon} aria-hidden="true" />
      </button>
    </li>
  )
  return (
    <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
      {summary ? (
        <p className="text-muted small mb-0">
          Showing <strong>{summary.start}</strong> to <strong>{summary.end}</strong> of <strong>{summary.total}</strong> {summary.noun ?? 'items'}
        </p>
      ) : (
        <span />
      )}
      <nav aria-label="Pages">
        <ul className="pagination pagination-sm mb-0">
          {step('Previous page', 'chevron-left', nav.canPrev, nav.prev)}
          {pageWindow(current, nav.count).map((n, i) =>
            n === null ? (
              <li key={`gap${i}`} className="page-item disabled" aria-hidden="true">
                <span className="page-link">…</span>
              </li>
            ) : (
              <li key={n} className={`page-item${n === current ? ' active' : ''}`}>
                <button type="button" className="page-link" onClick={() => nav.go(n - 1)} aria-current={n === current ? 'page' : undefined} aria-label={`Page ${n}`}>
                  {n}
                </button>
              </li>
            ),
          )}
          {step('Next page', 'chevron-right', nav.canNext, nav.next)}
        </ul>
      </nav>
    </div>
  )
}
