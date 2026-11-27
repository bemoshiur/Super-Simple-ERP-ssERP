import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DIRECT_BUCKET } from './client-ip'
import { createLoginThrottle, throttleKey, type ThrottleStore } from './login-throttle'
import { emailLimiter, emailKey, loginLimiter, loginKey } from './rate-limit'

const secret = () => new TextEncoder().encode('x'.repeat(40))

/** In-memory fake of the DB store with the same fixed-window semantics. */
function fakeStore() {
  const rows = new Map<string, { count: number; locked: boolean }>()
  const store: ThrottleStore = {
    isLocked: async (h) => rows.get(h)?.locked ?? false,
    fail: async (h, _k, max) => {
      const r = rows.get(h) ?? { count: 0, locked: false }
      r.count++
      if (r.count >= max) r.locked = true
      rows.set(h, r)
    },
    reset: async (h) => void rows.delete(h),
  }
  return { store, rows }
}

describe('login throttle', () => {
  it('hashes keys (no email or IP in clear) and separates kinds', () => {
    const h = throttleKey('email', 'e:a@b.c', secret())
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain('a@b.c')
    expect(throttleKey('email_ip', 'e:a@b.c', secret())).not.toBe(h)
  })

  it('keys use a purpose-bound subkey, not AUTH_SECRET directly', () => {
    const s = secret()
    const direct = createHmac('sha256', s).update('email:e:a@b.c').digest('hex')
    const sub = createHmac('sha256', createHmac('sha256', s).update('login-throttle').digest()).update('email:e:a@b.c').digest('hex')
    expect(throttleKey('email', 'e:a@b.c', s)).toBe(sub)
    expect(throttleKey('email', 'e:a@b.c', s)).not.toBe(direct)
  })

  it('5 per email+ip, 20 per email; success clears only email+ip', async () => {
    const { store } = fakeStore()
    const t = createLoginThrottle(() => store, { secret })
    for (let i = 0; i < 5; i++) await t.recordFailure('a@x.test', '1.1.1.1')
    expect(await t.isLimited('a@x.test', '1.1.1.1')).toBe(true)
    expect(await t.isLimited('a@x.test', '2.2.2.2')).toBe(false)
    for (let ip = 3; ip < 18; ip++) await t.recordFailure('a@x.test', `9.9.9.${ip}`)
    expect(await t.isLimited('a@x.test', '8.8.8.8')).toBe(true) // 20 per email from anywhere
    const fresh = fakeStore()
    const t2 = createLoginThrottle(() => fresh.store, { secret })
    for (let i = 0; i < 4; i++) await t2.recordFailure('b@x.test', '1.1.1.1')
    await t2.recordSuccess('b@x.test', '1.1.1.1')
    expect(fresh.rows.size).toBe(1) // only the per-email row remains
  })

  it('direct bucket: only the per-email limit applies', async () => {
    const { store, rows } = fakeStore()
    const t = createLoginThrottle(() => store, { secret })
    for (let i = 0; i < 6; i++) await t.recordFailure('c@x.test', DIRECT_BUCKET)
    expect(rows.size).toBe(1)
    expect(await t.isLimited('c@x.test', DIRECT_BUCKET)).toBe(false)
  })

  it('falls back to the in-memory limiter (and logs) when the store fails', async () => {
    const onError = vi.fn()
    const broken: ThrottleStore = { isLocked: () => Promise.reject(new Error('db down')), fail: () => Promise.reject(new Error('db down')), reset: () => Promise.reject(new Error('db down')) }
    const t = createLoginThrottle(() => broken, { secret, onError })
    const email = 'fallback@x.test'
    for (let i = 0; i < 5; i++) await t.recordFailure(email, '4.4.4.4')
    expect(await t.isLimited(email, '4.4.4.4')).toBe(true)
    expect(onError).toHaveBeenCalled()
    expect(loginLimiter.isLimited(loginKey(email, '4.4.4.4'))).toBe(true)
    await t.recordSuccess(email, '4.4.4.4')
    expect(loginLimiter.isLimited(loginKey(email, '4.4.4.4'))).toBe(false)
    emailLimiter.reset(emailKey(email))
  })
})
