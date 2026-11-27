import { describe, expect, it } from 'vitest'
import { DIRECT_BUCKET } from './client-ip'
import { RateLimiter, WINDOW_MS, emailLimiter, loginIsLimited, loginKey, loginLimiter, loginRecordFailure, loginRecordSuccess } from './rate-limit'

describe('RateLimiter', () => {
  it('blocks after 5 failures within the window', () => {
    const rl = new RateLimiter()
    for (let i = 0; i < 4; i++) rl.recordFailure('k', 1000 + i)
    expect(rl.isLimited('k', 2000)).toBe(false)
    rl.recordFailure('k', 1004)
    expect(rl.isLimited('k', 2000)).toBe(true)
  })
  it('expires after the window and resets on success', () => {
    const rl = new RateLimiter()
    for (let i = 0; i < 5; i++) rl.recordFailure('k', 0)
    expect(rl.isLimited('k', WINDOW_MS - 1)).toBe(true)
    expect(rl.isLimited('k', WINDOW_MS + 1)).toBe(false)
    for (let i = 0; i < 5; i++) rl.recordFailure('k', 0)
    rl.reset('k')
    expect(rl.isLimited('k', 1)).toBe(false)
  })
  it('keys are per email+ip, case-insensitive on email', () => {
    expect(loginKey(' A@B.com ', '1.1.1.1')).toBe('a@b.com|1.1.1.1')
    const rl = new RateLimiter()
    for (let i = 0; i < 5; i++) rl.recordFailure(loginKey('a@b.com', '1.1.1.1'), 0)
    expect(rl.isLimited(loginKey('a@b.com', '2.2.2.2'), 1)).toBe(false)
  })
})

describe('capped map', () => {
  it('never exceeds maxKeys', () => {
    const rl = new RateLimiter(5, 1000, 100)
    for (let i = 0; i < 500; i++) rl.recordFailure('k' + i, 0)
    expect(rl.size).toBeLessThanOrEqual(100)
    rl.recordFailure('late', 100_000)
    expect(rl.size).toBe(1)
  })
  it('evicts expired entries first, keeping active ones', () => {
    const rl = new RateLimiter(2, 1000, 3)
    rl.recordFailure('a', 0)
    rl.recordFailure('b', 900)
    rl.recordFailure('c', 900)
    rl.recordFailure('d', 1500) // a expired
    expect(rl.size).toBe(3)
    expect(rl.isLimited('d', 1500)).toBe(false)
  })
  it('under cap pressure evicts oldest NON-limited entries and keeps limited ones', () => {
    const rl = new RateLimiter(2, 10_000, 3)
    rl.recordFailure('limited', 1)
    rl.recordFailure('limited', 2)
    rl.recordFailure('x', 3)
    rl.recordFailure('y', 4)
    rl.recordFailure('new', 5) // evicts x (oldest non-limited), not 'limited'
    expect(rl.size).toBe(3)
    expect(rl.isLimited('limited', 6)).toBe(true)
    expect(rl.isLimited('new', 6)).toBe(false)
  })
  it('if everything is limited and unexpired, evicts the oldest rather than refusing new keys', () => {
    const rl = new RateLimiter(1, 10_000, 2)
    rl.recordFailure('a', 1)
    rl.recordFailure('b', 2)
    rl.recordFailure('c', 3)
    expect(rl.size).toBe(2)
    expect(rl.isLimited('c', 4)).toBe(true)
    expect(rl.isLimited('a', 4)).toBe(false)
  })
})

describe('flood resistance', () => {
  it('20k random emails neither block a legitimate new login nor release an already-limited key', () => {
    for (let i = 0; i < 20; i++) loginRecordFailure('victim@x.com', '10.1.1.1', 1)
    expect(loginIsLimited('victim@x.com', '10.1.1.1', 2)).toBe(true)
    for (let i = 0; i < 20_000; i++) loginRecordFailure(`rnd${i}@x.com`, '203.0.113.9', 10 + i)
    expect(loginIsLimited('legit@x.com', '198.51.100.7', 30_000)).toBe(false)
    expect(loginIsLimited('victim@x.com', '10.1.1.1', 30_000)).toBe(true)
    expect(loginLimiter.size).toBeLessThanOrEqual(10_000)
    expect(emailLimiter.size).toBeLessThanOrEqual(10_000)
  })
})

describe('direct (no trusted proxy) bucket', () => {
  it('skips the per-email+ip limit: other users are not locked out, per-email limit still applies', () => {
    for (let i = 0; i < 6; i++) loginRecordFailure(`d${i}@x.com`, DIRECT_BUCKET, 1)
    for (let i = 0; i < 10; i++) loginRecordFailure('same@x.com', DIRECT_BUCKET, 1)
    expect(loginIsLimited('same@x.com', DIRECT_BUCKET, 2)).toBe(false) // 10 < 20
    expect(loginIsLimited('fresh@x.com', DIRECT_BUCKET, 2)).toBe(false)
    for (let i = 0; i < 10; i++) loginRecordFailure('same@x.com', DIRECT_BUCKET, 1)
    expect(loginIsLimited('same@x.com', DIRECT_BUCKET, 2)).toBe(true) // 20 reached
    expect(loginLimiter.isLimited(loginKey('same@x.com', DIRECT_BUCKET), 2)).toBe(false)
  })
})

describe('combined login limits', () => {
  it('per-email limit applies across IPs; success keeps email counter', () => {
    loginLimiter.reset('x')
    for (let i = 0; i < 20; i++) loginRecordFailure('v@x.com', `10.0.0.${i}`, 1)
    expect(loginIsLimited('v@x.com', '9.9.9.9', 2)).toBe(true)
    expect(loginIsLimited('other@x.com', '9.9.9.9', 2)).toBe(false)
    loginRecordSuccess('v@x.com', '9.9.9.9')
    expect(emailLimiter.isLimited('e:v@x.com', 2)).toBe(true)
  })
  it('per email+ip limit is 5', () => {
    for (let i = 0; i < 5; i++) loginRecordFailure('w@x.com', '1.1.1.1', 1)
    expect(loginIsLimited('w@x.com', '1.1.1.1', 2)).toBe(true)
    expect(loginIsLimited('w@x.com', '2.2.2.2', 2)).toBe(false)
  })
})
