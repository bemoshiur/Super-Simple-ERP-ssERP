import { cookies } from 'next/headers'
import { cache } from 'react'
import { Permission, requirePermission } from '../rbac'
import { SESSION_COOKIE } from './constants'
import { SessionPayload, verifySession } from './session'
import { loadSessionUser } from './session-user'

/**
 * Current session for server components / actions, or null. Cached per request (one DB read shared by getSession/getSessionUser).
 * Node-side only: after the pure token check it does one cheap DB read to enforce revocation
 * (user active, session_version matches, role still exists). Fails closed if the DB errors.
 */
const loadSession = cache(async (): Promise<{ session: SessionPayload; name: string; email: string } | null> => {
  const jar = await cookies()
  const token = await verifySession(jar.get(SESSION_COOKIE)?.value)
  if (!token) return null
  return loadSessionUser(token)
})

export const getSession = async (): Promise<SessionPayload | null> => (await loadSession())?.session ?? null

/** Session plus the user's display name/email (same single revalidation query, cached per request). */
export const getSessionUser = async (): Promise<{ session: SessionPayload; name: string; email: string } | null> => loadSession()

/** Request-scoped guard: loads the session, returns it or throws UnauthorizedError / ForbiddenError. */
export async function authorize(key: Permission): Promise<SessionPayload> {
  return requirePermission(await getSession(), key)
}
