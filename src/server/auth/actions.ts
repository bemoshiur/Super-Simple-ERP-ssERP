'use server'

import { and, eq } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { logActivity } from '../audit'
import { getDb, schema } from '../db'
import { pgCodeOf } from '../errors'
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, safeNext, sessionCookieOptions } from './constants'
import { clientIpFrom } from './client-ip'
import { getSession } from './current'
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from './password'
import { loginThrottle } from './login-throttle'
import { signSession } from './session'

export type LoginState = { error?: string }

const GENERIC_ERROR = 'Invalid email or password'
const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(254).email(), password: z.string().min(1).max(200) })

async function clientIp() {
  const h = await headers()
  return clientIpFrom((n) => h.get(n))
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get('email'), password: formData.get('password') })
  if (!parsed.success) return { error: GENERIC_ERROR }
  const { email, password } = parsed.data
  const next = safeNext(String(formData.get('next') ?? ''))

  const ip = await clientIp()
  if (await loginThrottle.isLimited(email, ip)) return { error: 'Too many failed attempts. Please try again in 15 minutes.' }

  const db = getDb()
  const [row] = await db
    .select({ user: schema.users, roleName: schema.roles.name, roleIsSystem: schema.roles.isSystem })
    .from(schema.users)
    .innerJoin(schema.roles, and(eq(schema.roles.id, schema.users.roleId), eq(schema.roles.companyId, schema.users.companyId)))
    .where(eq(schema.users.email, email))
    .limit(1)

  // Always run exactly one bcrypt compare, whether or not the email exists / is active.
  const ok = row ? await verifyPassword(password, row.user.passwordHash) : await dummyVerify(password)
  if (!row || !ok || !row.user.active) {
    await loginThrottle.recordFailure(email, ip)
    return { error: GENERIC_ERROR }
  }
  await loginThrottle.recordSuccess(email, ip)

  const { user, roleName } = row
  const isAdmin = row.roleIsSystem && roleName === 'admin'
  const perms =
    isAdmin
      ? []
      : (await db.select({ p: schema.rolePermissions.permission }).from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, user.roleId))).map((r) => r.p)

  const token = await signSession({ uid: user.id, cid: user.companyId, bid: user.branchId ?? null, role: roleName, adm: isAdmin, sv: user.sessionVersion, perms })
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: SESSION_MAX_AGE_SECONDS })

  // Upgrade hashes made with an older bcrypt cost while we hold the plain password (compare-and-set on the old hash).
  // A password reset that lands in between changes the hash, so this update then matches nothing (the reset wins).
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id))
  if (needsRehash(user.passwordHash)) {
    // Best effort: a failed upgrade must never fail the login (the old hash keeps working; we retry next time).
    try {
      const rehash = await hashPassword(password)
      await db.update(schema.users).set({ passwordHash: rehash }).where(and(eq(schema.users.id, user.id), eq(schema.users.passwordHash, user.passwordHash)))
    } catch (e) {
      // Fixed message + user id + error code only: a DB error message would carry the query params (the new hash).
      console.error(`[auth] password rehash after login failed (login continues) user=${user.id} code=${pgCodeOf(e) ?? (e instanceof Error ? e.name : 'unknown')}`)
    }
  }
  await logActivity({ companyId: user.companyId, userId: user.id, action: 'login', entity: 'user', entityId: user.id, ip })

  redirect(next)
}

export async function logoutAction(): Promise<void> {
  const session = await getSession()
  const jar = await cookies()
  jar.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0, expires: new Date(0) })
  if (session) {
    await logActivity({ companyId: session.cid, userId: session.uid, action: 'logout', entity: 'user', entityId: session.uid, ip: await clientIp() })
  }
  redirect('/auth/login')
}
