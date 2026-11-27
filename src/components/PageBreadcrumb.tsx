import { META_DATA } from '@/config/constants'
import Link from 'next/link'

/**
 * Page header: a breadcrumb trail (ssERP / section / page) above the page's single <h1>.
 * `subtitle` is the menu section the page belongs to (e.g. "Inventory").
 */
const PageBreadcrumb = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <div className="ss-page-head">
    <div className="min-w-0">
      <nav aria-label="Breadcrumb">
        <ol className="breadcrumb">
          <li className="breadcrumb-item">
            <Link href="/dashboard">{META_DATA.name}</Link>
          </li>
          {subtitle && <li className="breadcrumb-item">{subtitle}</li>}
          <li className="breadcrumb-item active" aria-current="page">
            {title}
          </li>
        </ol>
      </nav>
      <h1 className="ss-page-head__title">{title}</h1>
    </div>
  </div>
)

export default PageBreadcrumb
