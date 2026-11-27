/**
 * Transaction scaffolding shared by the users and roles data layer.
 *
 * Every identity/access mutation runs inside `iamTx`, which:
 *  1. takes a per-company advisory transaction lock, so user/role changes within one company are serialised
 *     (no lost updates, no case-variant duplicate role names, no deadlocks between two admins editing each other);
 *  2. re-loads the ACTOR from the database (active, same company, same session_version, role permissions) and
 *     re-checks the required permission against those fresh permissions. The JWT may be up to one request stale;
 *     escalation decisions are never made from it.
 * Callers that can reduce the number of administrators also call `lockAdmins` (SELECT ... FOR UPDATE on the
 * company's active admin rows) before writing and `assertAdminRemains` after writing, inside the same transaction.
 */
import { and, asc, count, eq, sql } from 'drizzle-orm'
import { schema, type Db } from '../db'
import { PolicyError } from '../errors'
import { PERMISSIONS, UnauthorizedError, ForbiddenError, type Permission } from '../rbac'
import { isPermission, isSystemAdminRole, type ActorPerms } from './policy'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Who is acting. `sv` (the session's session_version) is checked when given: a revoked session cannot act. */
export type Actor = { companyId: string; userId: string; sv?: number; ip?: string | null }

export type FreshActor = ActorPerms & { companyId: string; userId: string; roleId: string }

export const LAST_ADMIN = 'This would leave the company without an active administrator. Make another user an administrator first.'

export async function loadActor(tx: Tx, actor: Actor): Promise<FreshActor> {
  const [me] = await tx
    .select({ active: schema.users.active, sv: schema.users.sessionVersion, roleId: schema.users.roleId, roleName: schema.roles.name, isSystem: schema.roles.isSystem })
    .from(schema.users)
    .innerJoin(schema.roles, and(eq(schema.roles.id, schema.users.roleId), eq(schema.roles.companyId, actor.companyId)))
    .where(and(eq(schema.users.id, actor.userId), eq(schema.users.companyId, actor.companyId)))
  if (!me || !me.active || (actor.sv !== undefined && me.sv !== actor.sv)) throw new UnauthorizedError()
  const adm = isSystemAdminRole({ isSystem: me.isSystem, name: me.roleName })
  // Only keys in the current catalog count: a retired permission still stored on the role must never make the actor look
  // "strictly above" a peer (isStrictlyBelow counts any extra key).
  const perms = adm
    ? [...PERMISSIONS]
    : (await tx.select({ p: schema.rolePermissions.permission }).from(schema.rolePermissions).where(and(eq(schema.rolePermissions.roleId, me.roleId), eq(schema.rolePermissions.companyId, actor.companyId))))
        .map((r) => r.p)
        .filter(isPermission)
  return { companyId: actor.companyId, userId: actor.userId, roleId: me.roleId, adm, perms: new Set(perms) }
}

/** Run `fn` in a transaction holding the company's IAM lock, with the actor re-validated and holding `permission`. */
export async function iamTx<T>(db: Db, actor: Actor, permission: Permission, fn: (tx: Tx, me: FreshActor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'sserp:iam:' + actor.companyId}))`)
    const me = await loadActor(tx, actor)
    if (!me.adm && !me.perms.has(permission)) throw new ForbiddenError(permission)
    return fn(tx, me)
  })
}

export async function adminRoleId(tx: Pick<Db, 'select'>, companyId: string): Promise<string | null> {
  const [r] = await tx
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(and(eq(schema.roles.companyId, companyId), eq(schema.roles.isSystem, true), eq(schema.roles.name, 'admin')))
  return r?.id ?? null
}

/** Row-lock the company's active administrators (in id order) for the rest of the transaction. */
export async function lockAdmins(tx: Tx, companyId: string): Promise<string[]> {
  const rid = await adminRoleId(tx, companyId)
  if (!rid) return []
  const rows = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.companyId, companyId), eq(schema.users.roleId, rid), eq(schema.users.active, true)))
    .orderBy(asc(schema.users.id))
    .for('update')
  return rows.map((r) => r.id)
}

/** Throws PolicyError (rolling the transaction back) when no active user holds the system admin role any more. */
export async function assertAdminRemains(tx: Tx, companyId: string): Promise<void> {
  const rid = await adminRoleId(tx, companyId)
  const [{ n }] = rid
    ? await tx.select({ n: count() }).from(schema.users).where(and(eq(schema.users.companyId, companyId), eq(schema.users.roleId, rid), eq(schema.users.active, true)))
    : [{ n: 0 }]
  if (Number(n) < 1) throw new PolicyError(LAST_ADMIN)
}

export type RoleWithPerms = { id: string; name: string; isSystem: boolean; perms: string[] }

/** A role of `companyId` with its stored permissions, or null (a foreign id looks exactly like a missing one). */
export async function findRole(tx: Pick<Db, 'select'>, companyId: string, roleId: string, opts: { forUpdate?: boolean } = {}): Promise<RoleWithPerms | null> {
  const q = tx.select({ id: schema.roles.id, name: schema.roles.name, isSystem: schema.roles.isSystem }).from(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.companyId, companyId)))
  const [role] = opts.forUpdate ? await q.for('update') : await q
  if (!role) return null
  const perms = (await tx.select({ p: schema.rolePermissions.permission }).from(schema.rolePermissions).where(and(eq(schema.rolePermissions.roleId, role.id), eq(schema.rolePermissions.companyId, companyId)))).map((r) => r.p)
  return { ...role, perms }
}
