/** JWT sign/verify. Uses only `jose` + constants so it is safe to import from the proxy. */
import { SignJWT, jwtVerify } from 'jose'
import { SESSION_MAX_AGE_SECONDS, getAuthSecret } from './constants'

export type SessionPayload = {
  uid: string
  cid: string
  bid: string | null
  /** Display name of the role. NOT used for authorization. */
  role: string
  /** True only when the role row is a system role named 'admin' (computed at login). Admin passes all checks. */
  adm: boolean
  /** users.session_version at login; bumping it server-side revokes the session. */
  sv: number
  /** Compact permission list loaded from DB at login. Empty for admin. */
  perms: string[]
}

/** Cookies are limited to ~4KB total; keep the token comfortably below. */
export const MAX_TOKEN_BYTES = 3500

export async function signSession(payload: SessionPayload, secret: Uint8Array = getAuthSecret()): Promise<string> {
  const token = await new SignJWT({ cid: payload.cid, bid: payload.bid, role: payload.role, adm: payload.adm, sv: payload.sv, perms: payload.perms })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.uid)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret)
  if (new TextEncoder().encode(token).length > MAX_TOKEN_BYTES) {
    throw new Error('Session token too large for a cookie: role has too many permissions')
  }
  return token
}

/** Pure token check (signature + expiry + shape). Does NOT check revocation; see getSession(). */
export async function verifySession(token: string | undefined | null, secret?: Uint8Array): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret ?? getAuthSecret(), { algorithms: ['HS256'] })
    const { sub, cid, bid, role, adm, sv, perms } = payload as Record<string, unknown>
    if (typeof sub !== 'string' || typeof cid !== 'string' || typeof role !== 'string') return null
    if (bid !== null && typeof bid !== 'string') return null
    if (typeof adm !== 'boolean' || typeof sv !== 'number' || !Number.isInteger(sv)) return null
    if (!Array.isArray(perms) || !perms.every((p) => typeof p === 'string')) return null
    return { uid: sub, cid, bid: bid ?? null, role, adm, sv, perms: perms as string[] }
  } catch (e) {
    // Misconfigured secret must surface; bad tokens must not.
    if (e instanceof Error && e.message.startsWith('AUTH_SECRET')) throw e
    return null
  }
}
