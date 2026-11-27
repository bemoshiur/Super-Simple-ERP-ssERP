import { and, eq } from 'drizzle-orm'
import { schema, type Db } from '../db'

/** The signed-in user's current role id (the JWT carries only the role name). */
export async function getSessionUserRoleId(db: Pick<Db, 'select'>, session: { uid: string; cid: string }): Promise<string | null> {
  const [u] = await db
    .select({ roleId: schema.users.roleId })
    .from(schema.users)
    .where(and(eq(schema.users.id, session.uid), eq(schema.users.companyId, session.cid)))
  return u?.roleId ?? null
}
