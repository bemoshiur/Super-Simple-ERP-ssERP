import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS } from '@/server/rbac'
import type { MenuItemType } from '@/types'
import { menuItems } from './data'
import { activeMenuUrl, filterMenu, menuUrls } from './menu'

const labels = (items: MenuItemType[]): string[] => items.flatMap((i) => [i.label, ...(i.children ? labels(i.children) : [])])
const admin = { adm: true, perms: [] as string[] }
const salesman = { adm: false, perms: DEFAULT_ROLE_PERMISSIONS.salesman as string[] }

describe('menu data', () => {
  it('contains the planned ERP entries', () => {
    const all = labels(menuItems)
    for (const l of ['Dashboard', 'Parties', 'Vendors', 'Customers', 'Inventory', 'Products', 'Categories', 'Brands', 'Stock', 'Purchases', 'Sales', 'Invoices', 'Returns', 'Serial Lookup', 'Accounts', 'Payments', 'Income / Expense', 'Dues', 'Reports', 'Settings', 'Users & Roles', 'Activity Log']) {
      expect(all).toContain(l)
    }
  })
  it('every leaf declares an explicit ready flag', () => {
    const leaves = (items: MenuItemType[]): MenuItemType[] => items.flatMap((i) => (i.children ? leaves(i.children) : [i]))
    for (const l of leaves(menuItems)) expect(typeof l.ready, l.slug).toBe('boolean')
  })
})

describe('filterMenu', () => {
  it('admin sees everything; not-ready leaves are disabled and have no url', () => {
    const all = filterMenu(menuItems, admin)
    expect(labels(all)).toContain('Activity Log')
    const flat = all.flatMap((g) => g.children ?? []).flatMap((i) => [i, ...(i.children ?? [])])
    for (const [slug, url] of [['accounts', '/accounts'], ['payments', '/payments'], ['income-expense', '/income-expense'], ['dues', '/dues'], ['reports', '/reports'], ['stock', '/stock'], ['settings', '/settings'], ['users', '/users'], ['activity', '/activity']]) {
      const item = flat.find((i) => i.slug === slug)! // shipped in Tasks 9 and 10
      expect(item.isDisabled, slug).toBeFalsy()
      expect(item.url, slug).toBe(url)
    }
    const vendors = flat.find((i) => i.slug === 'vendors')! // shipped in Task 5
    expect(vendors.isDisabled).toBeFalsy()
    expect(vendors.url).toBe('/vendors')
    const dash = all[0].children![0]
    expect(dash.isDisabled).toBeFalsy()
    expect(dash.url).toBe('/dashboard')
  })
  it('hides items the role lacks and prunes empty groups', () => {
    const l = labels(filterMenu(menuItems, salesman))
    expect(l).toContain('Dashboard')
    expect(l).toContain('Customers')
    expect(l).toContain('Invoices')
    expect(l).toContain('Serial Lookup')
    for (const hidden of ['Vendors', 'Products', 'Purchases', 'Accounts', 'Reports', 'Settings', 'Users & Roles', 'Activity Log', 'Finance', 'Administration', 'Inventory']) {
      expect(l, hidden).not.toContain(hidden)
    }
  })
  it('a signed-in user with no permissions only sees the dashboard', () => {
    expect(labels(filterMenu(menuItems, { adm: false, perms: [] }))).toEqual(['Overview', 'Dashboard'])
  })
  it('does not mutate the source menu', () => {
    filterMenu(menuItems, admin)
    expect(JSON.stringify(menuItems)).toContain('"/vendors"')
  })
})

describe('activeMenuUrl', () => {
  it('picks the most specific match', () => {
    expect(activeMenuUrl('/sales/returns', menuItems)).toBe('/sales/returns')
    expect(activeMenuUrl('/sales/returns/5', menuItems)).toBe('/sales/returns')
    expect(activeMenuUrl('/sales/abc', menuItems)).toBe('/sales')
    expect(activeMenuUrl('/salesx', menuItems)).toBeNull()
    expect(activeMenuUrl('/dashboard', menuItems)).toBe('/dashboard')
    expect(menuUrls(menuItems)).toContain('/sales')
  })
})
