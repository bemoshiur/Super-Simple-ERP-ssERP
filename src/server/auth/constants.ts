/** Edge-safe constants and helpers (no DB, no Node-only imports). */
export const SESSION_COOKIE = 'sserp_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days

/** Read lazily so `next build` works without env present. */
export function getAuthSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is not set. Set it to a random string of at least 32 characters.')
  if (secret.length < 32) throw new Error('AUTH_SECRET is too short: it must be at least 32 characters.')
  return new TextEncoder().encode(secret)
}

/** Shared by login (set) and logout (expire): attributes must be identical for the browser to overwrite. */
export const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
})

/**
 * Only allow same-site relative redirect targets. Rejects control chars, whitespace and backslashes
 * outright, then normalises through URL parsing and requires the origin to stay put.
 */
export function safeNext(next: string | null | undefined): string {
  const fallback = '/dashboard'
  if (!next || !next.startsWith('/')) return fallback
  if (/[\u0000-\u001f\u007f\s\\]/.test(next)) return fallback
  let u: URL
  try {
    u = new URL(next, 'http://localhost')
  } catch {
    return fallback
  }
  if (u.origin !== 'http://localhost') return fallback
  if (u.pathname.startsWith('//')) return fallback
  let decoded = u.pathname
  try {
    decoded = decodeURIComponent(u.pathname)
  } catch {
    return fallback
  }
  if (decoded.startsWith('//') || decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded)) return fallback
  if (u.pathname === '/auth' || u.pathname.startsWith('/auth/')) return fallback
  return u.pathname + u.search + u.hash
}
