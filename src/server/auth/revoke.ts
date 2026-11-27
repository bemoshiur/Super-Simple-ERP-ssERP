import { and, eq, sql } from 'drizzle-orm'
import { getDb, schema, type Db } from '../db'

/** Invalidate all outstanding sessions of a user of `companyId`. Call on role/permission/active/password change. */
export async function revokeUserSessions(companyId: string, userId: string, tx?: Pick<Db, 'update'>) {
  const db = tx ?? getDb()
  await db
    .update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(and(eq(schema.users.id, userId), eq(schema.users.companyId, companyId)))
}

/**
 * Invalidate the sessions of every user holding `roleId` in `companyId` (JWTs carry the permission list, so a role's
 * permission change must force those users to sign in again). Call inside the transaction that changes the role.
 * Returns the number of users affected.
 */
export async function revokeRoleSessions(tx: Pick<Db, 'update'>, companyId: string, roleId: string): Promise<number> {
  const rows = await tx
    .update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(and(eq(schema.users.roleId, roleId), eq(schema.users.companyId, companyId)))
    .returning({ id: schema.users.id })
  return rows.length
}
