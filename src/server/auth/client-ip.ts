import { isIP } from 'node:net'

/**
 * Client IP for rate limiting. Proxy headers are client-controlled unless a trusted proxy sets them, so
 * they are honoured ONLY when the deployment declares it sits behind one: TRUSTED_PROXY=true, or running on
 * Vercel (VERCEL is set). Otherwise every caller shares one constant 'direct' bucket (fail-safe: spoofing
 * headers cannot mint fresh rate-limit keys).
 *
 * Trust assumption when enabled: exactly one trusted proxy that sets x-real-ip or appends the real peer
 * address as the RIGHTMOST x-forwarded-for entry. Never trust the leftmost hop: the client controls it.
 * Header values must be valid IP literals (node:net isIP) or they are ignored.
 */
export const DIRECT_BUCKET = 'direct'

export function proxyTrusted(env: Record<string, string | undefined> = process.env): boolean {
  return env.TRUSTED_PROXY === 'true' || Boolean(env.VERCEL)
}

export function clientIpFrom(get: (name: string) => string | null | undefined, env: Record<string, string | undefined> = process.env): string {
  if (!proxyTrusted(env)) return DIRECT_BUCKET
  const real = get('x-real-ip')?.trim()
  if (real && isIP(real)) return real
  const parts = (get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const last = parts[parts.length - 1]
  return last && isIP(last) ? last : DIRECT_BUCKET
}
