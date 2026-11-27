/**
 * Page-level access: a salesman reaching /users, /roles, /settings or /activity directly (URL typed in, menu hidden)
 * gets the NoAccess panel; the page returns before any data is loaded. Pure test: no DB is touched.
 */
import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS } from '@/server/rbac'

const st = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('@/server/auth/current', () => ({ getSession: async () => st.session, getSessionUser: async () => null, authorize: async () => st.session }))
vi.mock('@/server/db', async (orig) => ({
  ...(await orig<typeof import('@/server/db')>()),
  getDb: () => {
    throw new Error('DB must not be touched')
  },
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
  notFound: () => {
    throw new Error('notFound')
  },
  useRouter: () => ({}),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

import NoAccess from '@/components/ui/NoAccess'

function contains(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((n) => contains(n, type))
  if (!isValidElement(node)) return false
  if (node.type === type) return true
  return contains((node.props as { children?: ReactNode }).children, type)
}

const salesman = { uid: 'u', cid: 'c', bid: null, role: 'salesman', adm: false, sv: 0, perms: DEFAULT_ROLE_PERMISSIONS.salesman }
const pages = {
  '/users': () => import('./(admin)/users/page'),
  '/roles': () => import('./(admin)/roles/page'),
  '/settings': () => import('./(admin)/settings/page'),
  '/activity': () => import('./(admin)/activity/page'),
}

describe('admin pages deny a salesman', () => {
  beforeEach(() => {
    st.session = salesman
  })
  it.each(Object.entries(pages))('%s renders NoAccess', async (_path, load) => {
    const Page = (await load()).default as (p: { searchParams: Promise<object> }) => Promise<ReactNode>
    const out = await Page({ searchParams: Promise.resolve({}) })
    expect(contains(out, NoAccess)).toBe(true)
  })
  it.each(Object.entries(pages))('%s redirects when signed out', async (_path, load) => {
    st.session = null
    const Page = (await load()).default as (p: { searchParams: Promise<object> }) => Promise<ReactNode>
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/auth/login')
  })
})
