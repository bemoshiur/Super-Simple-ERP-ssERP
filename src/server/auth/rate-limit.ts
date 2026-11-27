/**
 * FALLBACK ONLY: the login throttle is DB-backed and shared across instances (./login-throttle.ts, table login_attempts);
 * this in-memory limiter is used when the database is unreachable, and its constants/keys are shared with it.
 *
 * In-memory login rate limiter (sliding window). Per-process only (not shared across serverless
 * instances) - a best-effort brake, not a guarantee. Memory is bounded: expired keys are swept
 * periodically and the map is hard-capped. Under cap pressure expired entries go first, then the OLDEST
 * entries that are not currently limited (so a flood of random keys can neither lock out legitimate new
 * keys nor evict counters that are actively blocking someone). Only if every entry is limited-and-unexpired
 * is the oldest evicted anyway. New keys are never refused.
 */
import { DIRECT_BUCKET } from './client-ip'

export const MAX_FAILS = 5 // per email+ip
export const MAX_FAILS_PER_EMAIL = 20 // per email, any ip (stops distributed guessing)
export const WINDOW_MS = 15 * 60 * 1000
export const MAX_KEYS = 10_000
const SWEEP_EVERY_MS = 60 * 1000
const FORCED_SWEEP_EVERY_MS = 1000 // under cap pressure, sweep for expired entries at most once a second

export class RateLimiter {
  private fails = new Map<string, number[]>()
  private lastSweep = 0
  constructor(
    private max = MAX_FAILS,
    private windowMs = WINDOW_MS,
    private maxKeys = MAX_KEYS,
  ) {}

  get size() {
    return this.fails.size
  }

  private recent(key: string, now: number) {
    const list = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length) this.fails.set(key, list)
    else this.fails.delete(key)
    return list
  }

  private sweep(now: number) {
    const every = this.fails.size >= this.maxKeys ? FORCED_SWEEP_EVERY_MS : SWEEP_EVERY_MS
    if (now - this.lastSweep < every) return
    this.lastSweep = now
    for (const [k, list] of this.fails) {
      if (!list.some((t) => now - t < this.windowMs)) this.fails.delete(k)
    }
  }

  /** Make room for one new key: oldest non-limited entry first, else the oldest entry. */
  private evictOne(now: number) {
    let fallback: string | undefined
    for (const [k, list] of this.fails) {
      fallback ??= k
      if (list.filter((t) => now - t < this.windowMs).length < this.max) {
        this.fails.delete(k)
        return
      }
    }
    if (fallback !== undefined) this.fails.delete(fallback)
  }

  isLimited(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max
  }

  recordFailure(key: string, now = Date.now()) {
    this.sweep(now)
    if (!this.fails.has(key)) while (this.fails.size >= this.maxKeys) this.evictOne(now)
    const list = this.recent(key, now)
    list.push(now)
    this.fails.set(key, list)
  }

  reset(key: string) {
    this.fails.delete(key)
  }
}

const normEmail = (email: string) => email.trim().toLowerCase()
export const loginKey = (email: string, ip: string) => `${normEmail(email)}|${ip}`
export const emailKey = (email: string) => `e:${normEmail(email)}`

/** Two limiters: strict per email+ip, looser per email alone. */
export const loginLimiter = new RateLimiter(MAX_FAILS)
export const emailLimiter = new RateLimiter(MAX_FAILS_PER_EMAIL)

/**
 * With no trusted proxy every client shares the DIRECT_BUCKET "ip", so a per-email+ip limit would be a
 * global lockout lever. For that bucket only the per-email limiter applies.
 */
const perIpApplies = (ip: string) => ip !== DIRECT_BUCKET

export function loginIsLimited(email: string, ip: string, now = Date.now()) {
  return (perIpApplies(ip) && loginLimiter.isLimited(loginKey(email, ip), now)) || emailLimiter.isLimited(emailKey(email), now)
}
export function loginRecordFailure(email: string, ip: string, now = Date.now()) {
  if (perIpApplies(ip)) loginLimiter.recordFailure(loginKey(email, ip), now)
  emailLimiter.recordFailure(emailKey(email), now)
}
/** Success clears only the email+ip counter; the per-email counter must keep accumulating. */
export function loginRecordSuccess(email: string, ip: string) {
  if (perIpApplies(ip)) loginLimiter.reset(loginKey(email, ip))
}
