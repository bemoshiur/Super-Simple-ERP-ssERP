/**
 * Roles data layer: list, create, edit (name + permission matrix), clone, delete.
 * Permission keys: users.view (list), users.create (create/clone), users.edit (edit), users.delete (delete).
 *
 * Rules (see policy.ts): the system admin role is immutable; manager/salesman keep their names but their permissions
 * are editable; custom roles are fully editable and deletable when no user holds them. 'admin' is a reserved name.
 * No privilege escalation and no peer takeover: for a non-admin actor every role it creates, clones, edits (before AND after
 * the edit) or deletes must be STRICTLY below its own permissions (it holds all of the role's permissions and at least one
 * more), and it can never edit the role it holds itself. So a role equal to your own permission set (a peer's role) can't
 * be edited by you, and you cannot strip a peer's role down to "below you" and then manage that peer. Admins are unrestricted.
 * A permission change bumps session_version of every holder of the role in the same transaction (revokeRoleSessions).
 */
import { and, asc, count, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { logActivity } from '../audit'
import { revokeRoleSessions } from '../auth/revoke'
import { schema, type Db } from '../db'
import { FieldErrors, NotFoundError, PolicyError } from '../errors'
import { writeHistory } from '../history'
import { iamTx, findRole, type Actor, type Tx, type FreshActor, type RoleWithPerms } from './core'
import { canGrant, effectivePermissions, isReservedRoleName, isStrictlyBelow, missingPermissions, permissionsField, roleEditRules, roleNameField, roleNameKey } from './policy'

export const roleSchema = z.object({ name: roleNameField, permissions: permissionsField })
export const cloneRoleSchema = z.object({ name: roleNameField })
export type RoleInput = z.input<typeof roleSchema>

export const ESCALATION = 'You can only grant permissions that you hold yourself.'
const RESERVED = "'admin' is reserved for the system administrator role."
const DUPLICATE = 'A role with this name already exists.'

export type RoleSummary = { id: string; name: string; isSystem: boolean; userCount: number; permissions: string[] }

export async function listRoles(db: Pick<Db, 'select'>, companyId: string): Promise<RoleSummary[]> {
  const roles = await db
    .select({ id: schema.roles.id, name: schema.roles.name, isSystem: schema.roles.isSystem })
    .from(schema.roles)
    .where(eq(schema.roles.companyId, companyId))
    .orderBy(asc(schema.roles.isSystem), asc(schema.roles.name))
  const [perms, counts] = await Promise.all([
    db.select({ roleId: schema.rolePermissions.roleId, p: schema.rolePermissions.permission }).from(schema.rolePermissions).where(eq(schema.rolePermissions.companyId, companyId)),
    db.select({ roleId: schema.users.roleId, n: count() }).from(schema.users).where(eq(schema.users.companyId, companyId)).groupBy(schema.users.roleId),
  ])
  // System roles first (admin, manager, salesman), then custom roles by name.
  const order = (r: { isSystem: boolean; name: string }) => (r.isSystem ? ['admin', 'manager', 'salesman'].indexOf(r.name) : 10)
  return roles
    .map((r) => ({
      ...r,
      userCount: Number(counts.find((c) => c.roleId === r.id)?.n ?? 0),
      permissions: effectivePermissions(r, perms.filter((p) => p.roleId === r.id).map((p) => p.p)),
    }))
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
}

export async function getRole(db: Pick<Db, 'select'>, companyId: string, id: string): Promise<RoleSummary> {
  const role = (await listRoles(db, companyId)).find((r) => r.id === id)
  if (!role) throw new NotFoundError('Role')
  return role
}

async function assertNameFree(tx: Tx, companyId: string, name: string, exceptId?: string) {
  if (isReservedRoleName(name)) throw new FieldErrors({ name: RESERVED })
  const key = roleNameKey(name)
  const others = await tx
    .select({ name: schema.roles.name })
    .from(schema.roles)
    .where(and(eq(schema.roles.companyId, companyId), exceptId ? ne(schema.roles.id, exceptId) : undefined))
  if (others.some((o) => roleNameKey(o.name) === key)) throw new FieldErrors({ name: DUPLICATE })
}

export const PEER_ROLE = 'You can only manage roles with fewer permissions than your own. Ask an administrator.'

/** Non-admins: `perms` must be strictly below the actor's own permissions (no escalation, no peer roles). */
function assertCanGrant(me: FreshActor, perms: readonly string[]) {
  if (!canGrant(me, perms)) throw new PolicyError(`${ESCALATION} Missing: ${missingPermissions(me.perms, perms).join(', ')}`)
  if (!isStrictlyBelow(me, perms)) throw new PolicyError(PEER_ROLE)
}

/** A non-admin may only manage a role strictly below their own permissions, and never their own role. */
function assertCanManageRole(me: FreshActor, role: RoleWithPerms) {
  if (role.id === me.roleId) throw new PolicyError('You cannot change the role you hold yourself. Ask another administrator.')
  assertCanGrant(me, effectivePermissions(role, role.perms))
}

async function writePerms(tx: Tx, companyId: string, roleId: string, perms: readonly string[]) {
  await tx.delete(schema.rolePermissions).where(and(eq(schema.rolePermissions.roleId, roleId), eq(schema.rolePermissions.companyId, companyId)))
  if (perms.length) await tx.insert(schema.rolePermissions).values(perms.map((permission) => ({ companyId, roleId, permission })))
}

async function insertRole(tx: Tx, me: FreshActor, name: string, perms: readonly string[], action: string, extra: Record<string, unknown> = {}) {
  assertCanGrant(me, perms)
  await assertNameFree(tx, me.companyId, name)
  const [row] = await tx.insert(schema.roles).values({ companyId: me.companyId, name, isSystem: false }).returning({ id: schema.roles.id })
  await writePerms(tx, me.companyId, row.id, perms)
  await logActivity({ companyId: me.companyId, userId: me.userId, action, entity: 'role', entityId: row.id, after: { name, permissions: perms, ...extra } }, tx)
  return row
}

export async function createRole(db: Db, actor: Actor, input: unknown): Promise<{ id: string }> {
  const d = roleSchema.parse(input)
  return iamTx(db, actor, 'users.create', (tx, me) => insertRole(tx, me, d.name, d.permissions, 'role.create'))
}

export async function cloneRole(db: Db, actor: Actor, sourceId: string, input: unknown): Promise<{ id: string }> {
  const d = cloneRoleSchema.parse(input)
  return iamTx(db, actor, 'users.create', async (tx, me) => {
    const src = await findRole(tx, me.companyId, sourceId)
    if (!src) throw new NotFoundError('Role')
    return insertRole(tx, me, d.name, effectivePermissions(src, src.perms), 'role.clone', { clonedFrom: src.id })
  })
}

/** Save name + permission matrix. Returns how many users must sign in again. */
export async function updateRole(db: Db, actor: Actor, id: string, input: unknown): Promise<{ id: string; signedOut: number }> {
  const d = roleSchema.parse(input)
  return iamTx(db, actor, 'users.edit', async (tx, me) => {
    const role = await findRole(tx, me.companyId, id, { forUpdate: true })
    if (!role) throw new NotFoundError('Role')
    const rules = roleEditRules(role)
    if (!rules.canEditPermissions) throw new PolicyError('The administrator role always has every permission and cannot be edited.')
    assertCanManageRole(me, role)
    assertCanGrant(me, d.permissions)

    const renamed = d.name !== role.name
    if (renamed) {
      if (!rules.canRename) throw new FieldErrors({ name: 'System roles cannot be renamed.' })
      await assertNameFree(tx, me.companyId, d.name, role.id)
      await tx.update(schema.roles).set({ name: d.name, updatedAt: new Date() }).where(and(eq(schema.roles.id, role.id), eq(schema.roles.companyId, me.companyId)))
    }
    const before = [...role.perms].sort()
    const after: string[] = [...d.permissions].sort()
    const permsChanged = before.join(',') !== after.join(',')
    let signedOut = 0
    if (permsChanged) {
      await writePerms(tx, me.companyId, role.id, d.permissions)
      signedOut = await revokeRoleSessions(tx, me.companyId, role.id)
    }
    if (!renamed && !permsChanged) return { id: role.id, signedOut }
    const added = after.filter((p) => !before.includes(p))
    const removed = before.filter((p) => !after.includes(p))
    await writeHistory(tx, {
      companyId: me.companyId,
      userId: me.userId,
      entity: 'role',
      entityId: role.id,
      diff: { ...(renamed ? { name: { from: role.name, to: d.name } } : {}), ...(permsChanged ? { permissions: { from: before.join(', '), to: after.join(', ') } } : {}) },
    })
    await logActivity(
      { companyId: me.companyId, userId: me.userId, action: 'role.update', entity: 'role', entityId: role.id, before: { name: role.name, permissions: before }, after: { name: d.name, permissions: after, added, removed, usersSignedOut: signedOut } },
      tx,
    )
    return { id: role.id, signedOut }
  })
}

/** Delete a custom role nobody holds. */
export async function deleteRole(db: Db, actor: Actor, id: string): Promise<void> {
  await iamTx(db, actor, 'users.delete', async (tx, me) => {
    const role = await findRole(tx, me.companyId, id, { forUpdate: true })
    if (!role) throw new NotFoundError('Role')
    if (!roleEditRules(role).canDelete) throw new PolicyError('System roles cannot be deleted.')
    assertCanManageRole(me, role)
    const [{ n }] = await tx.select({ n: count() }).from(schema.users).where(and(eq(schema.users.roleId, role.id), eq(schema.users.companyId, me.companyId)))
    if (Number(n) > 0) throw new PolicyError(`This role is assigned to ${n} user(s). Move them to another role first (deactivated users count too).`)
    await revokeRoleSessions(tx, me.companyId, role.id) // no holders by now; kept so the rule "role change => revoke" has no exceptions
    await tx.delete(schema.roles).where(and(eq(schema.roles.id, role.id), eq(schema.roles.companyId, me.companyId)))
    await logActivity({ companyId: me.companyId, userId: me.userId, action: 'role.delete', entity: 'role', entityId: role.id, before: { name: role.name, permissions: role.perms } }, tx)
  })
}
