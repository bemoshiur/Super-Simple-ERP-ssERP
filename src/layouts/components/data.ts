import { type MenuItemType } from '@/types'

/**
 * ERP navigation. Each leaf has:
 *  - `permission`: RBAC key; the item is hidden when the signed-in role lacks it (see filterMenu()).
 *  - `ready`: false until the page exists. Not-ready items render greyed out with no link, so nothing
 *    404s. LATER TASKS: flip `ready: true` for the routes you ship - that is the only change needed here.
 */
export const menuItems: MenuItemType[] = [
  {
    icon: 'layout-dashboard',
    slug: 'overview',
    label: 'Overview',
    isTitle: true,
    children: [{ url: '/dashboard', slug: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', ready: true }],
  },
  {
    icon: 'briefcase',
    slug: 'business',
    label: 'Business',
    isTitle: true,
    children: [
      {
        slug: 'parties',
        label: 'Parties',
        icon: 'users',
        children: [
          { url: '/vendors', slug: 'vendors', label: 'Vendors', permission: 'vendors.view', ready: true },
          { url: '/customers', slug: 'customers', label: 'Customers', permission: 'customers.view', ready: true },
        ],
      },
      {
        slug: 'inventory',
        label: 'Inventory',
        icon: 'package',
        children: [
          { url: '/products', slug: 'products', label: 'Products', permission: 'products.view', ready: true },
          { url: '/categories', slug: 'categories', label: 'Categories', permission: 'products.view', ready: true },
          { url: '/brands', slug: 'brands', label: 'Brands', permission: 'products.view', ready: true },
          { url: '/stock', slug: 'stock', label: 'Stock', permission: 'products.view', ready: true },
          // Multi-branch only: the admin layout drops this item while the company has a single active branch.
          { url: '/stock/transfers', slug: 'stock-transfers', label: 'Transfers', permission: 'products.view', ready: true },
        ],
      },
      { url: '/purchases', slug: 'purchases', label: 'Purchases', icon: 'shopping-cart', permission: 'purchases.view', ready: true },
      {
        slug: 'sales-group',
        label: 'Sales',
        icon: 'receipt',
        children: [
          { url: '/sales', slug: 'sales', label: 'Invoices', permission: 'sales.view', ready: true },
          { url: '/sales/returns', slug: 'sales-returns', label: 'Returns', permission: 'sales.view', ready: true },
        ],
      },
      { url: '/serials', slug: 'serials', label: 'Serial Lookup', icon: 'scan-barcode', permission: 'serials.view', ready: true },
      { url: '/service', slug: 'service', label: 'Service', icon: 'wrench', permission: 'serials.view', ready: true },
    ],
  },
  {
    icon: 'wallet',
    slug: 'finance',
    label: 'Finance',
    isTitle: true,
    children: [
      {
        slug: 'accounts-group',
        label: 'Accounts',
        icon: 'landmark',
        children: [
          { url: '/accounts', slug: 'accounts', label: 'Accounts', permission: 'accounts.view', ready: true },
          { url: '/payments', slug: 'payments', label: 'Payments', permission: 'accounts.view', ready: true },
          { url: '/income-expense', slug: 'income-expense', label: 'Income / Expense', permission: 'accounts.view', ready: true },
          { url: '/dues', slug: 'dues', label: 'Dues', permission: 'accounts.view', ready: true },
        ],
      },
      { url: '/reports', slug: 'reports', label: 'Reports', icon: 'chart-column', permission: 'reports.view', ready: true },
    ],
  },
  {
    icon: 'settings',
    slug: 'admin',
    label: 'Administration',
    isTitle: true,
    children: [
      { url: '/settings', slug: 'settings', label: 'Settings', icon: 'settings', permission: 'settings.view', ready: true },
      { url: '/settings/branches', slug: 'branches', label: 'Branches', icon: 'building-2', permission: 'settings.view', ready: true },
      { url: '/users', slug: 'users', label: 'Users & Roles', icon: 'user-cog', permission: 'users.view', ready: true },
      { url: '/activity', slug: 'activity', label: 'Activity Log', icon: 'history', permission: 'activity.view', ready: true },
    ],
  },
]
