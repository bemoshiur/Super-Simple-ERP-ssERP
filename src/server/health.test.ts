import { describe, expect, it, vi } from 'vitest'
import { createDbHealth } from './health'

describe('createDbHealth', () => {
  it('caches the result within the TTL and re-checks after it', async () => {
    let t = 0
    const check = vi.fn().mockResolvedValue(undefined)
    const up = createDbHealth(check, { ttlMs: 5000, now: () => t })
    expect(await up()).toBe(true)
    t = 4999
    expect(await up()).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    t = 5000
    await up()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight check between concurrent callers', async () => {
    let release!: () => void
    const check = vi.fn(() => new Promise<void>((r) => (release = r)))
    const up = createDbHealth(check, { now: () => 0 })
    const all = Promise.all([up(), up(), up()])
    release()
    expect(await all).toEqual([true, true, true])
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('reports down on failure or timeout and caches that too', async () => {
    const t = 0
    const check = vi.fn().mockRejectedValue(new Error('secret host'))
    const up = createDbHealth(check, { now: () => t })
    expect(await up()).toBe(false)
    expect(await up()).toBe(false)
    expect(check).toHaveBeenCalledTimes(1)
    const slow = createDbHealth(() => new Promise<void>(() => {}), { timeoutMs: 10, now: () => t })
    expect(await slow()).toBe(false)
  })

  it('does not start new checks while a timed-out one is still hung, and resumes after it settles', async () => {
    let t = 0
    let release!: () => void
    const check = vi.fn(() => new Promise<void>((r) => (release = r)))
    const up = createDbHealth(check, { ttlMs: 5000, timeoutMs: 10, now: () => t })
    expect(await up()).toBe(false) // timed out
    for (let i = 0; i < 4; i++) {
      t += 6000 // TTL expired each time
      expect(await up()).toBe(false)
    }
    expect(check).toHaveBeenCalledTimes(1)
    release() // late settle clears the pending flag
    await new Promise((r) => setTimeout(r, 0))
    t += 6000
    const next = up()
    expect(check).toHaveBeenCalledTimes(2)
    release()
    expect(await next).toBe(true)
  })
})
