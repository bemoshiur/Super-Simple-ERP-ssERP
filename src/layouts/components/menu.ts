import { can, type Permission, type PermissionSubject } from '@/server/rbac'
import type { MenuItemType } from '@/types'

/**
 * Pure menu filtering (no React, no DB). Leaves are hidden when `permission` is set and `can()` says no;
 * parents/titles are hidden when no visible child remains. Leaves with `ready: false` stay visible but
 * become `isDisabled` with no `url`, so they render greyed out and cannot 404.
 */
export function filterMenu(items: MenuItemType[], subject: PermissionSubject): MenuItemType[] {
  const out: MenuItemType[] = []
  for (const item of items) {
    if (item.children) {
      const children = filterMenu(item.children, subject)
      if (children.length) out.push({ ...item, children })
      continue
    }
    if (item.permission && !can(subject, item.permission as Permission)) continue
    if (item.ready === false) {
      const disabled: MenuItemType = { ...item, isDisabled: true }
      delete disabled.url
      out.push(disabled)
    } else {
      out.push(item)
    }
  }
  return out
}

/** All linkable urls in the menu (leaves with a url). */
export function menuUrls(items: MenuItemType[]): string[] {
  return items.flatMap((i) => (i.children ? menuUrls(i.children) : i.url ? [i.url] : []))
}

/** The single most specific menu url matching `pathname` (so /sales/returns does not also activate /sales). */
export function activeMenuUrl(pathname: string, items: MenuItemType[]): string | null {
  let best: string | null = null
  for (const u of menuUrls(items)) {
    if ((pathname === u || pathname.startsWith(u + '/')) && (!best || u.length > best.length)) best = u
  }
  return best
}

/** True when `url` is a link somewhere under `item` (used to highlight / auto-open the active group). */
export function containsUrl(item: MenuItemType, url: string | null): boolean {
  if (!url) return false
  return item.url === url || (item.children ?? []).some((c) => containsUrl(c, url))
}
