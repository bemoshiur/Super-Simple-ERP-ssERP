'use server'

import { and, eq } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'
import { clientIpFrom } from '../auth/client-ip'
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionCookieOptions } from '../auth/constants'
import { getSession } from '../auth/current'
import { loginThrottle } from '../auth/login-throttle'
import { signSession } from '../auth/session'
import { getDb, schema } from '../db'
import { changeOwnPassword, WrongPasswordError } from '../iam/users'
import { failureOf, type ActionResult } from './guard'

/**
 * "Change my password": any signed-in user, current password required. Every other session is signed out (session_version
 * bump) and this browser gets a fresh cookie carrying the new version, so the user stays signed in here.
 * Wrong current-password attempts count against the same limiter as failed logins (a stolen session cannot brute-force it).
 */
export async function changeOwnPasswordAction(input: unknown): Promise<ActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, error: 'Your session has expired. Please sign in again.' }
  const db = getDb()
  const h = await headers()
  const ip = clientIpFrom((n) => h.get(n))
  const [me] = await db.select({ email: schema.users.email }).from(schema.users).where(and(eq(schema.users.id, session.uid), eq(schema.users.companyId, session.cid)))
  if (!me) return { ok: false, error: 'Your session has expired. Please sign in again.' }
  if (await loginThrottle.isLimited(me.email, ip)) return { ok: false, error: 'Too many failed attempts. Please try again in 15 minutes.' }
  try {
    const { sessionVersion } = await changeOwnPassword(db, { companyId: session.cid, userId: session.uid, sv: session.sv, ip }, input)
    const token = await signSession({ ...session, sv: sessionVersion })
    const jar = await cookies()
    jar.set(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: SESSION_MAX_AGE_SECONDS })
    return { ok: true, data: undefined }
  } catch (e) {
    if (e instanceof WrongPasswordError) await loginThrottle.recordFailure(me.email, ip)
    return failureOf(e)
  }
}
