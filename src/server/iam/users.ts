/**
 * Users data layer. Never selects or returns password hashes; never logs passwords, hashes or tokens.
 *
 * Permission keys: users.view (list), users.create (create), users.edit (edit name/email/role/branch, reset password,
 * reactivate), users.delete (deactivate = soft delete; users are never hard-deleted because activity rows reference them).
 * Email is part of "edit" (users.edit); it stays globally unique (users_email_uq) because login is by email alone.
 *
 * Guards, all inside one IAM transaction (see core.ts):
 *  - no self-service through admin screens: you cannot change your own role/branch, deactivate or reset yourself
 *    (use "Change password" for your own password);
 *  - no same-level takeover: a non-admin can only manage users whose effective permissions are a STRICT subset of its
 *    own (a peer with the same permissions cannot reset, deactivate or re-email another peer);
 *  - your own sign-in email changes only with your current password;
 *  - no escalation: a non-admin can only manage users whose role does not exceed their own permissions, and can only
 *    assign roles that do not exceed them; only an administrator can create, edit or assign administrators;
 *  - last admin: the company always keeps at least one ACTIVE user with the system admin role (admin rows locked FOR UPDATE);
 *  - any change of role, branch, active flag or password bumps the user's session_version (signed out on next request);
 *  - branches (Task 14): the branch must be an ACTIVE branch of the company (row taken FOR SHARE, so a concurrent branch
 *    deactivation waits and then sees the user); an actor WITHOUT branches.all can only see and manage users of its own
 *    branch and only assign its own branch.
 */
import { and, asc, count, eq, ilike, or } from 'drizzle-orm'
import { z } from 'zod'
import { logActivity } from '../audit'
import { hashPassword, verifyPassword } from '../auth/password'
import { revokeUserSessions } from '../auth/revoke'
import { schema, type Db } from '../db'
import { FieldErrors, NotFoundError, PolicyError, isUniqueViolation } from '../errors'
import { likePattern } from '../pagination'
import { UnauthorizedError } from '../rbac'
import { INACTIVE_BRANCH } from '../branch'
import { assertAdminRemains, findRole, iamTx, lockAdmins, type Actor, type FreshActor, type Tx } from './core'
import { passwordChoiceSchema } from './passwords'
import { canGrant, effectivePermissions, isStrictlyBelow, isSystemAdminRole, passwordField } from './policy'

const EMAIL_UQ = 'users_email_uq'
const EMAIL_DUP = 'This email is already used by another account.'

const optionalUuid = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.uuid().optional())

const userFields = {
  name: z.string().trim().min(1, 'Name is required').max(100, 'Must be at most 100 characters'),
  email: z.string().trim().toLowerCase().max(254).email('Enter a valid email address'),
  roleId: z.uuid('Choose a role'),
  branchId: optionalUuid,
}
/** currentPassword: required only when a user changes their OWN email (the sign-in identity). */
export const userUpdateSchema = z.object({ ...userFields, currentPassword: z.string().max(200).optional() })
export const userCreateSchema = z.object(userFields).and(passwordChoiceSchema)

/** The columns a client may ever see. */
const PUBLIC = {
  id: schema.users.id,
  name: schema.users.name,
  email: schema.users.email,
  active: schema.users.active,
  roleId: schema.users.roleId,
  roleName: schema.roles.name,
  roleIsSystem: schema.roles.isSystem,
  branchId: schema.users.branchId,
  branchName: schema.branches.name,
  lastLoginAt: schema.users.lastLoginAt,
  createdAt: schema.users.createdAt,
}
export type UserRow = { id: string; name: string; email: string; active: boolean; roleId: string; roleName: string; roleIsSystem: boolean; branchId: string | null; branchName: string | null; lastLoginAt: Date | null; createdAt: Date }

/** branchId: restrict to one branch (BranchScope.restrict for actors without branches.all). */
export type UserListFilter = { q?: string; status?: 'active' | 'inactive' | 'all'; roleId?: string; branchId?: string | null; limit: number; offset: number }

export async function listUsers(db: Pick<Db, 'select'>, companyId: string, f: UserListFilter): Promise<{ rows: UserRow[]; total: number }> {
  const u = schema.users
  const where = and(
    eq(u.companyId, companyId),
    f.q ? or(ilike(u.name, likePattern(f.q)), ilike(u.email, likePattern(f.q))) : undefined,
    f.roleId ? eq(u.roleId, f.roleId) : undefined,
    f.branchId ? eq(u.branchId, f.branchId) : undefined,
    f.status === 'inactive' ? eq(u.active, false) : f.status === 'all' ? undefined : eq(u.active, true),
  )
  const [rows, [{ n }]] = await Promise.all([
    db
      .select(PUBLIC)
      .from(u)
      .innerJoin(schema.roles, and(eq(schema.roles.id, u.roleId), eq(schema.roles.companyId, companyId)))
      .leftJoin(schema.branches, and(eq(schema.branches.id, u.branchId), eq(schema.branches.companyId, companyId)))
      .where(where)
      .orderBy(asc(u.name), asc(u.email))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(u).where(where),
  ])
  return { rows, total: Number(n) }
}

export async function getUser(db: Pick<Db, 'select'>, companyId: string, id: string): Promise<UserRow> {
  const [row] = await db
    .select(PUBLIC)
    .from(schema.users)
    .innerJoin(schema.roles, and(eq(schema.roles.id, schema.users.roleId), eq(schema.roles.companyId, companyId)))
    .leftJoin(schema.branches, and(eq(schema.branches.id, schema.users.branchId), eq(schema.branches.companyId, companyId)))
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, companyId)))
  if (!row) throw new NotFoundError('User')
  return row
}

export async function listBranches(db: Pick<Db, 'select'>, companyId: string) {
  return db
    .select({ id: schema.branches.id, name: schema.branches.name, isDefault: schema.branches.isDefault })
    .from(schema.branches)
    .where(and(eq(schema.branches.companyId, companyId), eq(schema.branches.active, true)))
    .orderBy(asc(schema.branches.name))
}

// ---------- helpers ----------

/** What gets logged about a user: never the password or its hash. */
const auditView = (u: { name: string; email: string; roleId: string; branchId: string | null; active?: boolean }, roleName?: string) => ({
  name: u.name,
  email: u.email,
  roleId: u.roleId,
  ...(roleName ? { role: roleName } : {}),
  branchId: u.branchId,
  ...(u.active === undefined ? {} : { active: u.active }),
})

/** Role to assign: must be in the company and not exceed the actor (only admins assign the admin role). */
async function assignableRole(tx: Tx, me: FreshActor, roleId: string) {
  const role = await findRole(tx, me.companyId, roleId)
  if (!role) throw new FieldErrors({ roleId: 'Role not found' })
  if (isSystemAdminRole(role) && !me.adm) throw new PolicyError('Only an administrator can assign the administrator role.')
  const perms = effectivePermissions(role, role.perms)
  if (!canGrant(me, perms)) throw new PolicyError('You cannot assign a role that has permissions you do not hold yourself.')
  // No peers by assignment: a non-admin only assigns roles strictly below its own permissions.
  if (!isStrictlyBelow(me, perms)) throw new PolicyError('You can only assign roles with fewer permissions than your own. Ask an administrator.')
  return role
}

/** The actor's own branch, or null when it may work across branches (admin / branches.all). */
async function actorOnlyBranch(tx: Tx, me: FreshActor): Promise<string | null> {
  if (me.adm || me.perms.has('branches.all')) return null
  // Fail closed: a restricted actor without an active branch can manage nobody.
  const [row] = await tx
    .select({ b: schema.users.branchId, active: schema.branches.active })
    .from(schema.users)
    .leftJoin(schema.branches, and(eq(schema.branches.id, schema.users.branchId), eq(schema.branches.companyId, me.companyId)))
    .where(and(eq(schema.users.id, me.userId), eq(schema.users.companyId, me.companyId)))
  if (!row?.b || !row.active) throw new PolicyError(INACTIVE_BRANCH)
  return row.b
}

async function resolveBranch(tx: Tx, me: FreshActor, branchId: string | undefined): Promise<string> {
  const only = await actorOnlyBranch(tx, me)
  const rows = await tx
    .select({ id: schema.branches.id, isDefault: schema.branches.isDefault })
    .from(schema.branches)
    .where(and(eq(schema.branches.companyId, me.companyId), eq(schema.branches.active, true)))
    .orderBy(asc(schema.branches.id))
    .for('share')
  const want = branchId ?? only ?? undefined
  const hit = want ? rows.find((b) => b.id === want) : (rows.find((b) => b.isDefault) ?? rows[0])
  if (!hit) throw new FieldErrors({ branchId: 'Branch not found' })
  if (only && hit.id !== only) throw new PolicyError('You can only assign users to your own branch.')
  return hit.id
}

/** Target user (locked) whose current role the actor may manage. */
async function manageableUser(tx: Tx, me: FreshActor, id: string) {
  const [u] = await tx
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, roleId: schema.users.roleId, branchId: schema.users.branchId, active: schema.users.active })
    .from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, me.companyId)))
    .for('update')
  if (!u) throw new NotFoundError('User')
  const only = await actorOnlyBranch(tx, me)
  if (only && u.branchId !== only) throw new NotFoundError('User') // another branch's user is invisible to a restricted actor
  const role = await findRole(tx, me.companyId, u.roleId)
  if (!role) throw new NotFoundError('User')
  if (isSystemAdminRole(role) && !me.adm) throw new PolicyError('Only an administrator can change an administrator account.')
  const targetPerms = effectivePermissions(role, role.perms)
  if (!canGrant(me, targetPerms)) throw new PolicyError('You cannot change a user whose role has permissions you do not hold yourself.')
  // No same-level peer takeover: a non-admin manages only users whose permissions are a STRICT subset of its own.
  if (u.id !== me.userId && !isStrictlyBelow(me, targetPerms)) throw new PolicyError('You cannot change a user with the same permissions as you. Ask an administrator.')
  return { user: u, role }
}

const withEmailMapping = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p
  } catch (e) {
    if (isUniqueViolation(e, EMAIL_UQ)) throw new FieldErrors({ email: EMAIL_DUP })
    throw e
  }
}

/** Your own sign-in email changes only with your current password (a stolen session cannot take the account over). */
async function assertOwnPassword(tx: Tx, me: FreshActor, current: string | undefined) {
  if (!current) throw new FieldErrors({ currentPassword: 'Enter your current password to change your own email' })
  const [row] = await tx.select({ hash: schema.users.passwordHash }).from(schema.users).where(and(eq(schema.users.id, me.userId), eq(schema.users.companyId, me.companyId)))
  if (!row || !(await verifyPassword(current, row.hash))) throw new WrongCurrentPasswordError()
}

// ---------- mutations ----------

/** Create a user. When the server generated the password it is returned ONCE so the admin can hand it over. */
export async function createUser(db: Db, actor: Actor, input: unknown): Promise<{ id: string; generatedPassword?: string }> {
  const d = userCreateSchema.parse(input)
  const passwordHash = await hashPassword(d.password)
  return withEmailMapping(
    iamTx(db, actor, 'users.create', async (tx, me) => {
      const role = await assignableRole(tx, me, d.roleId)
      const branchId = await resolveBranch(tx, me, d.branchId)
      const [row] = await tx
        .insert(schema.users)
        .values({ companyId: me.companyId, branchId, roleId: role.id, name: d.name, email: d.email, passwordHash })
        .returning({ id: schema.users.id })
      await logActivity({ companyId: me.companyId, userId: me.userId, action: 'user.create', entity: 'user', entityId: row.id, after: { ...auditView({ ...d, branchId }, role.name), generatedByServer: d.generate } }, tx)
      return d.generate ? { id: row.id, generatedPassword: d.password } : { id: row.id }
    }),
  )
}

/** Edit name / email / role / branch. Role or branch change signs the user out everywhere. */
export async function updateUser(db: Db, actor: Actor, id: string, input: unknown): Promise<{ id: string; signedOut: boolean }> {
  const d = userUpdateSchema.parse(input)
  return withEmailMapping(
    iamTx(db, actor, 'users.edit', async (tx, me) => {
      await lockAdmins(tx, me.companyId)
      const { user, role: oldRole } = await manageableUser(tx, me, id)
      const roleChanged = d.roleId !== user.roleId
      const branchId = d.branchId === undefined || d.branchId === user.branchId ? user.branchId : await resolveBranch(tx, me, d.branchId)
      const branchChanged = branchId !== user.branchId
      if (user.id === me.userId && (roleChanged || branchChanged)) throw new PolicyError('You cannot change your own role or branch. Ask another administrator.')
      if (user.id === me.userId && d.email !== user.email) await assertOwnPassword(tx, me, d.currentPassword)
      const newRole = roleChanged ? await assignableRole(tx, me, d.roleId) : oldRole
      await tx
        .update(schema.users)
        .set({ name: d.name, email: d.email, roleId: newRole.id, branchId, updatedAt: new Date() })
        .where(and(eq(schema.users.id, user.id), eq(schema.users.companyId, me.companyId)))
      const signedOut = roleChanged || branchChanged
      if (signedOut) await revokeUserSessions(me.companyId, user.id, tx)
      if (roleChanged) await assertAdminRemains(tx, me.companyId)
      await logActivity(
        { companyId: me.companyId, userId: me.userId, action: roleChanged ? 'user.role_change' : 'user.update', entity: 'user', entityId: user.id, before: auditView(user, oldRole.name), after: { ...auditView({ ...d, branchId }, newRole.name), sessionsRevoked: signedOut }, ip: actor.ip },
        tx,
      )
      return { id: user.id, signedOut }
    }),
  )
}

/** Admin password reset (type one or generate one). Signs the user out everywhere. Not for your own account. */
export async function resetUserPassword(db: Db, actor: Actor, id: string, input: unknown): Promise<{ generatedPassword?: string }> {
  const d = passwordChoiceSchema.parse(input)
  const passwordHash = await hashPassword(d.password)
  return iamTx(db, actor, 'users.edit', async (tx, me) => {
    if (id === me.userId) throw new PolicyError('Use "Change password" to change your own password.')
    const { user } = await manageableUser(tx, me, id)
    await tx.update(schema.users).set({ passwordHash, updatedAt: new Date() }).where(and(eq(schema.users.id, user.id), eq(schema.users.companyId, me.companyId)))
    await revokeUserSessions(me.companyId, user.id, tx)
    await logActivity({ companyId: me.companyId, userId: me.userId, action: 'user.password_reset', entity: 'user', entityId: user.id, after: { generatedByServer: d.generate, sessionsRevoked: true }, ip: actor.ip }, tx)
    return d.generate ? { generatedPassword: d.password } : {}
  })
}

/** Deactivate (needs users.delete) or reactivate (needs users.edit). Signs the user out everywhere. */
export async function setUserActive(db: Db, actor: Actor, id: string, active: boolean): Promise<void> {
  await iamTx(db, actor, active ? 'users.edit' : 'users.delete', async (tx, me) => {
    if (id === me.userId) throw new PolicyError('You cannot deactivate or reactivate your own account.')
    await lockAdmins(tx, me.companyId)
    const { user } = await manageableUser(tx, me, id)
    if (user.active === active) return
    if (active) {
      // A user can only come back into an ACTIVE branch (a deactivated branch has no users by construction).
      const [br] = user.branchId ? await tx.select({ active: schema.branches.active }).from(schema.branches).where(and(eq(schema.branches.id, user.branchId), eq(schema.branches.companyId, me.companyId))).for('share') : []
      if (!br?.active) throw new PolicyError("This user's branch is inactive or not set. Edit the user and choose an active branch first.")
    }
    await tx.update(schema.users).set({ active, updatedAt: new Date() }).where(and(eq(schema.users.id, user.id), eq(schema.users.companyId, me.companyId)))
    await revokeUserSessions(me.companyId, user.id, tx)
    if (!active) await assertAdminRemains(tx, me.companyId)
    await logActivity({ companyId: me.companyId, userId: me.userId, action: active ? 'user.activate' : 'user.deactivate', entity: 'user', entityId: user.id, before: { active: user.active }, after: { active, sessionsRevoked: true }, ip: actor.ip }, tx)
  })
}

export const changeOwnPasswordSchema = z
  .object({ current: z.string().min(1, 'Enter your current password').max(200), next: passwordField, confirm: z.string() })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })
  .refine((v) => v.next !== v.current, { path: ['next'], message: 'Choose a password different from the current one' })

export class WrongPasswordError extends FieldErrors {
  constructor() {
    super({ current: 'Current password is incorrect' })
  }
}

/** Wrong current password on a self email change (counted by the action against the login throttle). */
export class WrongCurrentPasswordError extends FieldErrors {
  constructor() {
    super({ currentPassword: 'Current password is incorrect' })
  }
}

/**
 * Self-service password change. Requires the current password; bumps session_version (every other session is signed
 * out) and returns the new version so the caller can re-issue its own cookie.
 */
export async function changeOwnPassword(db: Db, actor: Required<Actor>, input: unknown): Promise<{ sessionVersion: number }> {
  const d = changeOwnPasswordSchema.parse(input)
  const [u] = await db
    .select({ hash: schema.users.passwordHash, active: schema.users.active, sv: schema.users.sessionVersion })
    .from(schema.users)
    .where(and(eq(schema.users.id, actor.userId), eq(schema.users.companyId, actor.companyId)))
  if (!u || !u.active || u.sv !== actor.sv) throw new UnauthorizedError()
  if (!(await verifyPassword(d.current, u.hash))) throw new WrongPasswordError()
  const passwordHash = await hashPassword(d.next)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.users)
      .set({ passwordHash, sessionVersion: u.sv + 1, updatedAt: new Date() })
      // Compare-and-set on the version: a concurrent revocation wins and this change is refused.
      .where(and(eq(schema.users.id, actor.userId), eq(schema.users.companyId, actor.companyId), eq(schema.users.sessionVersion, u.sv), eq(schema.users.active, true)))
      .returning({ sv: schema.users.sessionVersion })
    if (!row) throw new UnauthorizedError()
    await logActivity({ companyId: actor.companyId, userId: actor.userId, action: 'user.password_change', entity: 'user', entityId: actor.userId, after: { otherSessionsRevoked: true }, ip: actor.ip }, tx)
    return { sessionVersion: row.sv }
  })
}
