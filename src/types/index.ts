/** What every navigation entry has: a stable key, a visible name and (optionally) a lucide icon. */
interface NavEntry {
  readonly slug: string
  readonly label: string
  readonly icon?: string
}

/**
 * One node of the navigation tree (src/layouts/components/data.ts). Shapes in use:
 *  - section: `isTitle` + `children` (a labelled group of entries);
 *  - group:   `children` without `isTitle` (a collapsible disclosure);
 *  - leaf:    `url` (a link) - or, after filterMenu(), `isDisabled` and no url (greyed out).
 */
export interface MenuItemType extends NavEntry {
  url?: string
  isTitle?: boolean
  /** RBAC key (`can()`) needed to see the entry; omitted = every signed-in user. */
  permission?: string
  /** false = the page is not built yet: shown greyed out and never linked. Flip to true when the page ships. */
  ready?: boolean
  /** Set by filterMenu() on `ready: false` leaves. */
  isDisabled?: boolean
  children?: MenuItemType[]
}
