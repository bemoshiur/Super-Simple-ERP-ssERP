import DbUnavailable from '@/components/DbUnavailable'
import { menuItems } from '@/layouts/components/data'
import { filterMenu } from '@/layouts/components/menu'
import MainLayout from '@/layouts/MainLayout'
import { NAV_COOKIE } from '@/config/constants'
import { getSessionUser } from '@/server/auth/current'
import { branchScope, shellBranch, type BranchScope } from '@/server/branch'
import { safeLog } from '@/server/errors'
import { installGuard, isInstalled } from '@/server/install'
import { migrationsStatus } from '@/server/migrations-status'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { connection } from 'next/server'
import type { ReactNode } from 'react'

const Layout = async ({ children }: { children: ReactNode }) => {
  await connection() // per-request: install state and session must never be baked in at build time
  const decision = installGuard(await isInstalled(), 'app')
  if (decision === 'redirect-install') redirect('/install')
  if (decision === 'unavailable') return <DbUnavailable />

  // The proxy only checks the JWT signature. This is what enforces revocation (disabled user, bumped
  // session_version, deleted role): getSession() revalidates against the DB on every request.
  const current = await getSessionUser()
  if (!current) redirect('/auth/login')

  const { session, name, email } = current
  let scope: BranchScope | null = null
  try {
    scope = await branchScope(session)
  } catch (e) {
    safeLog('[layout] branch scope failed', e) // a company without any active branch: pages show their own errors
  }
  // Single-branch installs: no branch selector and no Transfers menu item (no branch UI noise).
  const menu = filterMenu(menuItems, session).map((g) => (scope?.multi ? g : dropUrl(g, '/stock/transfers')))
  // Admins only: the code is newer than the database schema (cached 60s; never throws).
  const migrationsPending = session.adm && (await migrationsStatus()) === 'pending'

  const navCollapsed = (await cookies()).get(NAV_COOKIE)?.value === 'collapsed'
  const banner = migrationsPending ? (
    <div className="alert alert-warning ss-banner" role="alert">
      <strong>Database update needed.</strong> This version of ssERP includes database migrations that have not been applied yet, so some pages may fail. Back up the database, then run{' '}
      <code>npm run db:migrate</code> against it (see &ldquo;Upgrading&rdquo; in the README).
    </div>
  ) : null

  return (
    <MainLayout menu={menu} user={{ name, email, role: session.role }} branch={scope ? shellBranch(scope) : undefined} navCollapsed={navCollapsed} banner={banner}>
      {children}
    </MainLayout>
  )
}

function dropUrl<T extends { url?: string; children?: T[] }>(item: T, url: string): T {
  return item.children ? { ...item, children: item.children.filter((c) => c.url !== url).map((c) => dropUrl(c, url)) } : item
}

export default Layout
