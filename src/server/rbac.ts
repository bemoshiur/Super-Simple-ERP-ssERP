/** Pure RBAC: permission catalog, default role sets, can()/requirePermission(). No DB access. */
export const MODULES = ['vendors', 'customers', 'products', 'purchases', 'sales', 'serials', 'accounts', 'reports', 'users', 'settings'] as const
export const ACTIONS = ['view', 'create', 'edit', 'delete'] as const

export type Module = (typeof MODULES)[number]
export type Action = (typeof ACTIONS)[number]

/**
 * Non-CRUD keys: activity.view (activity log); branches.all (Task 14: read every branch and switch the active branch in the
 * top bar; without it a user is restricted to its own branch for reading AND writing).
 */
export const PERMISSIONS = [...MODULES.flatMap((m) => ACTIONS.map((a) => `${m}.${a}` as `${Module}.${Action}`)), 'activity.view' as const, 'branches.all' as const]
export type Permission = (typeof PERMISSIONS)[number]

const admin: Permission[] = [...PERMISSIONS]
const manager: Permission[] = PERMISSIONS.filter((p) => p !== 'users.delete' && p !== 'settings.delete')
const salesman: Permission[] = (['sales', 'customers', 'serials'] as const).flatMap((m) => [`${m}.view` as const, `${m}.create` as const])

export const DEFAULT_ROLE_PERMISSIONS: Record<'admin' | 'manager' | 'salesman', Permission[]> = { admin, manager, salesman }

export type PermissionSubject = { adm: boolean; perms: readonly string[] } | null | undefined

/** System-admin flag (`adm`, computed at login from roles.is_system && name='admin') always passes. Others need the key. */
export function can(session: PermissionSubject, key: Permission): boolean {
  if (!session) return false
  if (session.adm === true) return true
  return session.perms.includes(key)
}

export class ForbiddenError extends Error {
  constructor(public permission: string) {
    super(`Forbidden: missing permission ${permission}`)
    this.name = 'ForbiddenError'
  }
}
export class UnauthorizedError extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'UnauthorizedError'
  }
}

/** Pure check: returns the session or throws. */
export function requirePermission<S extends NonNullable<PermissionSubject>>(session: S | null | undefined, key: Permission): S {
  if (!session) throw new UnauthorizedError()
  if (!can(session, key)) throw new ForbiddenError(key)
  return session
}
