import { and, eq } from 'drizzle-orm'
import { getDb, schema, type Db } from '../db'
import { safeLog } from '../errors'
import type { SessionPayload } from './session'

export type SessionUser = { session: SessionPayload; name: string; email: string }

/**
 * Revocation check for an already signature-verified token: user exists and is active, session_version
 * matches, the role still exists and the company matches. Returns null otherwise. Fails closed on DB errors.
 * (No Next.js imports: the cookie-reading wrapper lives in ./current.ts.)
 */
export async function loadSessionUser(token: SessionPayload, db: Db = getDb()): Promise<SessionUser | null> {
  try {
    const [row] = await db
      .select({ name: schema.users.name, email: schema.users.email, active: schema.users.active, sv: schema.users.sessionVersion, roleId: schema.roles.id, companyId: schema.users.companyId })
      .from(schema.users)
      .leftJoin(schema.roles, and(eq(schema.roles.id, schema.users.roleId), eq(schema.roles.companyId, schema.users.companyId)))
      .where(eq(schema.users.id, token.uid))
      .limit(1)
    if (!row || !row.active || row.sv !== token.sv || !row.roleId || row.companyId !== token.cid) return null
    return { session: token, name: row.name, email: row.email }
  } catch (e) {
    safeLog('[auth] session revalidation failed; treating as logged out', e)
    return null
  }
}
