/** /serials/labels: permission is checked before any data is touched. Pure test: the DB must not be reached. */
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
}))

const user = (perms: string[]) => ({ uid: 'u', cid: 'c', bid: null, role: 'custom', adm: false, sv: 0, perms })

describe('labels page access', () => {
  beforeEach(() => {
    st.session = null
  })
  it('signed-out users go to login', async () => {
    const { default: Page } = await import('./(print)/serials/labels/page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/auth/login')
  })
  it('a role without serials.view gets a message and no data', async () => {
    const { default: Page } = await import('./(print)/serials/labels/page')
    st.session = user(['sales.view', 'purchases.view'])
    const el = (await Page({ searchParams: Promise.resolve({ purchase: '11111111-1111-4111-8111-111111111111' }) })) as { props: { children: string } }
    expect(String(el.props.children)).toMatch(/do not have permission/)
  })
  it('salesman (serials.view) passes the permission gate and reaches the data layer', async () => {
    const { default: Page } = await import('./(print)/serials/labels/page')
    st.session = user([...DEFAULT_ROLE_PERMISSIONS.salesman])
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('DB must not be touched')
  })
})
