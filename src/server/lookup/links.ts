/** Which cross-page links a viewer may follow. Pure: computed server-side from the session, passed down as booleans. */
import { can, type PermissionSubject } from '../rbac'
import type { TimelineDoc } from './pure'

export type LinkAccess = { sales: boolean; purchases: boolean; vendors: boolean; customers: boolean; products: boolean; serials: boolean }

export const linkAccess = (s: PermissionSubject): LinkAccess => ({
  sales: can(s, 'sales.view'),
  purchases: can(s, 'purchases.view'),
  vendors: can(s, 'vendors.view'),
  customers: can(s, 'customers.view'),
  products: can(s, 'products.view'),
  serials: can(s, 'serials.view'),
})

/** The href for a timeline document, or null (render plain text) when the viewer lacks the target's view permission. */
export function docHref(doc: TimelineDoc, a: LinkAccess): string | null {
  if (!doc) return null
  switch (doc.kind) {
    case 'purchase':
    case 'purchase_return':
      return a.purchases ? doc.href : null
    case 'sale':
    case 'sale_return':
      return a.sales ? doc.href : null
    case 'service_ticket':
      return a.serials ? doc.href : null
  }
}

/** Route segment that may arrive percent-encoded or already decoded: decode only when it still holds a valid %XX escape. */
export function decodeIfEncoded(p: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(p)) return p
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}
