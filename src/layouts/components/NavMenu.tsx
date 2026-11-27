'use client'
import Icon from '@/components/wrappers/Icon'
import { useShell } from '@/context/useShellContext'
import type { MenuItemType } from '@/types'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId, useState, type KeyboardEvent } from 'react'
import { activeMenuUrl, containsUrl } from './menu'

type ItemProps = { item: MenuItemType; activeUrl: string | null; depth: number; onNavigate?: () => void }

/** A link, or a greyed-out placeholder for pages that are not built yet (`ready: false`). */
function Leaf({ item, activeUrl, depth, onNavigate }: ItemProps) {
  const icon = depth === 0 && item.icon ? <Icon icon={item.icon} className="ss-menu__icon" /> : null
  if (item.isDisabled || !item.url) {
    return (
      <li>
        <span className="ss-menu__link is-disabled" aria-disabled="true">
          {icon}
          <span className="ss-menu__label">{item.label}</span>
          <span className="ss-menu__soon">Soon</span>
        </span>
      </li>
    )
  }
  const current = item.url === activeUrl
  return (
    <li>
      <Link href={item.url} className="ss-menu__link" aria-current={current ? 'page' : undefined} onClick={onNavigate}>
        {icon}
        <span className="ss-menu__label">{item.label}</span>
      </Link>
    </li>
  )
}

/** Disclosure button + nested list. Starts open when it contains the current page. */
function Group({ item, activeUrl, depth, onNavigate }: ItemProps) {
  const within = containsUrl(item, activeUrl)
  const [open, setOpen] = useState(within)
  const [wasWithin, setWasWithin] = useState(within)
  if (within !== wasWithin) {
    // navigated into (or out of) this group: open it so the current page stays visible
    setWasWithin(within)
    if (within) setOpen(true)
  }
  const listId = useId()
  return (
    <li>
      <button type="button" className={`ss-menu__link${within ? ' is-within' : ''}`} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        {depth === 0 && item.icon && <Icon icon={item.icon} className="ss-menu__icon" />}
        <span className="ss-menu__label">{item.label}</span>
        <Icon icon="chevron-right" className="ss-menu__chevron" />
      </button>
      <ul id={listId} className="ss-submenu" hidden={!open}>
        {item.children!.map((child) => (
          <Entry key={child.slug} item={child} activeUrl={activeUrl} depth={depth + 1} onNavigate={onNavigate} />
        ))}
      </ul>
    </li>
  )
}

const Entry = (props: ItemProps) => (props.item.children ? <Group {...props} /> : <Leaf {...props} />)

/** Up/Down/Home/End move between the visible menu entries (Tab still works as usual). */
function onMenuKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('a.ss-menu__link, button.ss-menu__link')).filter((el) => el.offsetParent !== null)
  const at = items.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  e.preventDefault()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

/** The RBAC-filtered navigation tree from the shell context (sections -> groups -> links). */
const NavMenu = ({ onNavigate }: { onNavigate?: () => void }) => {
  const { menu } = useShell()
  const pathname = usePathname()
  const activeUrl = activeMenuUrl(pathname, menu)
  const baseId = useId()
  return (
    <nav aria-label="Main menu" onKeyDown={onMenuKeyDown}>
      <ul className="ss-menu">
        {menu.map((section, i) =>
          section.isTitle ? (
            <li key={section.slug}>
              <div className="ss-menu__heading" id={`${baseId}-${i}`}>
                {section.label}
              </div>
              <ul aria-labelledby={`${baseId}-${i}`}>
                {(section.children ?? []).map((item) => (
                  <Entry key={item.slug} item={item} activeUrl={activeUrl} depth={0} onNavigate={onNavigate} />
                ))}
              </ul>
            </li>
          ) : (
            <Entry key={section.slug} item={section} activeUrl={activeUrl} depth={0} onNavigate={onNavigate} />
          ),
        )}
      </ul>
    </nav>
  )
}

export default NavMenu
