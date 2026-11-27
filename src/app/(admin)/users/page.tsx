import PageBreadcrumb from '@/components/PageBreadcrumb'
import NoAccess from '@/components/ui/NoAccess'
import { getSession } from '@/server/auth/current'
import { branchScope } from '@/server/branch'
import { appTimezone, formatLocalDateTime } from '@/server/dates'
import { getDb } from '@/server/db'
import { isStrictlyBelow, isSystemAdminRole } from '@/server/iam/policy'
import { listRoles } from '@/server/iam/roles'
import { listBranches, listUsers } from '@/server/iam/users'
import { parseListParams, type RawSearchParams } from '@/server/pagination'
import { can } from '@/server/rbac'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Card, CardBody } from 'react-bootstrap'
import { z } from 'zod'
import AdminTabs from './AdminTabs'
import UserList from './UserList'

export const metadata: Metadata = { title: 'Users' }

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const session = await getSession()
  if (!session) redirect('/auth/login')
  if (!can(session, 'users.view')) return (<><PageBreadcrumb title="Users" subtitle="Administration" /><NoAccess /></>)

  const sp = await searchParams
  const { q, page, pageSize, offset } = parseListParams(sp)
  const rawStatus = one(sp.status)
  const status = rawStatus === 'inactive' || rawStatus === 'all' ? rawStatus : 'active'
  const roleId = z.uuid().safeParse(one(sp.role)).data

  const db = getDb()
  const b = await branchScope(session)
  // Without branches.all an actor sees (and may assign) only its own branch's users (enforced again in iam/users.ts).
  const [{ rows, total }, roles, allBranches] = await Promise.all([listUsers(db, session.cid, { q, status, roleId, branchId: b.restrict, limit: pageSize, offset }), listRoles(db, session.cid), listBranches(db, session.cid)])
  const branches = b.all ? allBranches : allBranches.filter((x) => x.id === b.home)

  // UI hints only (the server re-checks everything with fresh permissions): which roles this user may assign / manage.
  const actor = { adm: session.adm, perms: new Set(session.perms) }
  const manageable = (r: { isSystem: boolean; name: string; permissions: string[] }) => (isSystemAdminRole(r) ? session.adm : isStrictlyBelow(actor, r.permissions)) // same rule as the server (strict subset)
  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name, assignable: manageable(r) }))
  const tz = appTimezone()

  return (
    <>
      <PageBreadcrumb title="Users" subtitle="Administration" />
      <AdminTabs active="users" />
      <Card>
        <CardBody>
          <UserList
            rows={rows.map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              active: u.active,
              roleId: u.roleId,
              roleName: u.roleName,
              branchId: u.branchId,
              branchName: u.branchName,
              lastLogin: u.lastLoginAt ? formatLocalDateTime(u.lastLoginAt, tz) : null,
              isSelf: u.id === session.uid,
              // yourself: always editable here (name / email; the server forbids own role, branch, reset and deactivation)
              manageable: u.id === session.uid || manageable({ isSystem: u.roleIsSystem, name: u.roleName, permissions: roles.find((r) => r.id === u.roleId)?.permissions ?? [] }),
            }))}
            total={total}
            page={page}
            pageSize={pageSize}
            q={q}
            status={status}
            roleFilter={roleId ?? ''}
            roles={roleOptions}
            branches={branches.map((b) => ({ id: b.id, name: b.name }))}
            can={{ create: can(session, 'users.create'), edit: can(session, 'users.edit'), delete: can(session, 'users.delete') }}
          />
        </CardBody>
      </Card>
    </>
  )
}
