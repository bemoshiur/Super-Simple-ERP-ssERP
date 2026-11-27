import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { getDb } from '@/server/db'
import { isPermission, isStrictlyBelow, roleEditRules } from '@/server/iam/policy'
import { listRoles } from '@/server/iam/roles'
import { can } from '@/server/rbac'
import { getSessionUserRoleId } from '@/server/iam/session-role'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import AdminTabs from '../users/AdminTabs'
import RoleList from './RoleList'

export const metadata: Metadata = { title: 'Roles & permissions' }

export default async function Page() {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'users.view')) return (<><PageBreadcrumb title="Roles & permissions" subtitle="Administration" /><NoAccess /></>)

  const db = getDb()
  const [roles, ownRoleId] = await Promise.all([listRoles(db, session.cid), getSessionUserRoleId(db, session)])
  // Catalog keys only (a retired key in an old session must not count as an extra permission), same as the server.
  const ownPerms = session.perms.filter(isPermission)
  const actor = { adm: session.adm, perms: new Set<string>(ownPerms) }

  return (
    <>
      <PageBreadcrumb title="Roles & permissions" subtitle="Administration" />
      <AdminTabs active="roles" />
      <Card>
        <CardBody>
          <RoleList
            roles={roles.map((r) => {
              const rules = roleEditRules(r)
              // UI hints only; the server re-checks with fresh permissions.
              const withinMine = isStrictlyBelow(actor, r.permissions) // same rule as the server: strictly fewer permissions than mine
              return { ...r, ...rules, own: r.id === ownRoleId, manageable: withinMine && r.id !== ownRoleId, cloneable: withinMine }
            })}
            grantable={session.adm ? null : ownPerms}
            can={{ create: can(session, 'users.create'), edit: can(session, 'users.edit'), delete: can(session, 'users.delete') }}
          />
        </CardBody>
      </Card>
    </>
  )
}
