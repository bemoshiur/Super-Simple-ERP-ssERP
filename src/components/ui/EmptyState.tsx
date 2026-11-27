import Icon from '@/components/wrappers/Icon'
import Link from 'next/link'
import type { ReactNode } from 'react'

type Props = {
  title: string
  description?: ReactNode
  /** lucide icon name */
  icon?: string
  action?: { label: string; href: string } | ReactNode
  className?: string
}

const isLink = (a: Props['action']): a is { label: string; href: string } => !!a && typeof a === 'object' && 'href' in (a as object) && 'label' in (a as object)

const EmptyState = ({ title, description, icon = 'inbox', action, className = 'py-5' }: Props) => (
  <div className={`text-center text-muted ${className}`}>
    <Icon icon={icon} className="fs-1 mb-2 opacity-50" />
    <h5 className="mb-1 text-body">{title}</h5>
    {description && <p className="mb-3">{description}</p>}
    {isLink(action) ? (
      <Link href={action.href} className="btn btn-primary btn-sm">
        {action.label}
      </Link>
    ) : (
      action
    )}
  </div>
)

export default EmptyState
