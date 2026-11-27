/**
 * Login throttle shared by all server instances (login_attempts table), with the per-process in-memory limiter
 * (./rate-limit.ts) as a fallback when the database is unreachable (fail-open for availability, logged).
 *
 * Same limits as before: 5 failures / 15 min per email+IP, 20 / 15 min per email from any IP; when there is no
 * trusted proxy every client shares the 'direct' IP bucket, so only the per-email limit applies there.
 * Fixed windows: the first failure opens a 15-minute window; reaching the limit locks the key for 15 minutes.
 * Each failure is ONE atomic upsert (no read-modify-write race between instances). Old rows are swept opportunistically.
 */
import { createHmac } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { getDb, rowsOf, schema, type Db } from '../db'
import { safeLog } from '../errors'
import { getAuthSecret } from './constants'
import { DIRECT_BUCKET } from './client-ip'
import { MAX_FAILS, MAX_FAILS_PER_EMAIL, WINDOW_MS, emailLimiter, emailKey, loginKey, loginLimiter } from './rate-limit'

type Kind = 'email' | 'email_ip'
const WINDOW_SECONDS = Math.round(WINDOW_MS / 1000)
const SWEEP_PROBABILITY = 0.02

/** Purpose-bound subkey: AUTH_SECRET itself (which signs sessions) is never used directly as an HMAC key here. */
export const throttleSubkey = (secret: Uint8Array): Buffer => createHmac('sha256', secret).update('login-throttle').digest()

/** HMAC so the table never holds emails or IPs in clear (and keys cannot be precomputed without AUTH_SECRET). */
export function throttleKey(kind: Kind, key: string, secret: Uint8Array = getAuthSecret()): string {
  return createHmac('sha256', throttleSubkey(secret)).update(`${kind}:${key}`).digest('hex')
}

export type ThrottleStore = {
  isLocked(hash: string): Promise<boolean>
  fail(hash: string, kind: Kind, max: number): Promise<void>
  reset(hash: string): Promise<void>
}

export function dbThrottleStore(db: Db = getDb()): ThrottleStore {
  const t = schema.loginAttempts
  return {
    async isLocked(hash) {
      const res = await db.execute(sql`select 1 from ${t} where ${t.keyHash} = ${hash} and ${t.lockedUntil} > now() limit 1`)
      return rowsOf(res).length > 0
    },
    async fail(hash, kind, max) {
      const win = sql`make_interval(secs => ${WINDOW_SECONDS})`
      const expired = sql`login_attempts.window_start <= now() - ${win}`
      const nextCount = sql`(case when ${expired} then 1 else login_attempts.count + 1 end)`
      await db.execute(sql`
        insert into ${t} (key_hash, kind, count, window_start, locked_until)
        values (${hash}, ${kind}, 1, now(), case when 1 >= ${max} then now() + ${win} end)
        on conflict (key_hash) do update set
          count = ${nextCount},
          window_start = case when ${expired} then now() else login_attempts.window_start end,
          locked_until = case when ${nextCount} >= ${max} then now() + ${win} else login_attempts.locked_until end`)
      if (Math.random() < SWEEP_PROBABILITY) {
        await db.execute(sql`delete from ${t} where ${t.windowStart} < now() - interval '1 day' and (${t.lockedUntil} is null or ${t.lockedUntil} < now())`)
      }
    },
    async reset(hash) {
      await db.delete(t).where(eq(t.keyHash, hash))
    },
  }
}

const perIpApplies = (ip: string) => ip !== DIRECT_BUCKET

/**
 * Clear the per-email lockout of `email` (used by `npm run admin:reset`). Returns whether a row was removed. Rows keyed
 * by email + IP cannot be found without the IP (both are HMACed); they only block that one IP and expire with the window.
 */
export async function clearEmailLockout(email: string, db: Db = getDb(), secret: Uint8Array = getAuthSecret()): Promise<boolean> {
  const t = schema.loginAttempts
  const rows = await db.delete(t).where(eq(t.keyHash, throttleKey('email', emailKey(email), secret))).returning({ k: t.keyHash })
  return rows.length > 0
}

export type LoginThrottle = {
  isLimited(email: string, ip: string): Promise<boolean>
  recordFailure(email: string, ip: string): Promise<void>
  recordSuccess(email: string, ip: string): Promise<void>
}

/** Build a throttle over `store`; any store error falls back to the in-memory limiter for that call. */
export function createLoginThrottle(store: () => ThrottleStore, opts: { secret?: () => Uint8Array; onError?: (e: unknown) => void } = {}): LoginThrottle {
  const secret = opts.secret ?? getAuthSecret
  const onError = opts.onError ?? ((e: unknown) => safeLog('[auth] login throttle store unavailable; using in-memory fallback', e))
  const keys = (email: string, ip: string) => ({ email: throttleKey('email', emailKey(email), secret()), emailIp: throttleKey('email_ip', loginKey(email, ip), secret()) })
  return {
    async isLimited(email, ip) {
      try {
        const k = keys(email, ip)
        const s = store()
        return (perIpApplies(ip) && (await s.isLocked(k.emailIp))) || (await s.isLocked(k.email))
      } catch (e) {
        onError(e)
        return (perIpApplies(ip) && loginLimiter.isLimited(loginKey(email, ip))) || emailLimiter.isLimited(emailKey(email))
      }
    },
    async recordFailure(email, ip) {
      try {
        const k = keys(email, ip)
        const s = store()
        if (perIpApplies(ip)) await s.fail(k.emailIp, 'email_ip', MAX_FAILS)
        await s.fail(k.email, 'email', MAX_FAILS_PER_EMAIL)
      } catch (e) {
        onError(e)
        if (perIpApplies(ip)) loginLimiter.recordFailure(loginKey(email, ip))
        emailLimiter.recordFailure(emailKey(email))
      }
    },
    /** Success clears only the email+ip counter; the per-email counter keeps accumulating. */
    async recordSuccess(email, ip) {
      if (!perIpApplies(ip)) return
      try {
        await store().reset(keys(email, ip).emailIp)
      } catch (e) {
        onError(e)
        loginLimiter.reset(loginKey(email, ip))
      }
    },
  }
}

export const loginThrottle = createLoginThrottle(() => dbThrottleStore())
