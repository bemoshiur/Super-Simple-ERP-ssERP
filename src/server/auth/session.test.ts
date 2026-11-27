import { SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { getAuthSecret, safeNext } from './constants'
import { signSession, verifySession, type SessionPayload } from './session'

const secret = new TextEncoder().encode('a'.repeat(40))
const payload: SessionPayload = { uid: 'u1', cid: 'c1', bid: null, role: 'manager', adm: false, sv: 3, perms: ['sales.view', 'sales.create'] }

describe('session', () => {
  it('round-trips the payload', async () => {
    const t = await signSession(payload, secret)
    expect(await verifySession(t, secret)).toEqual(payload)
  })
  it('rejects tampered, wrong-secret, missing and expired tokens', async () => {
    const t = await signSession(payload, secret)
    expect(await verifySession(t.slice(0, -2) + 'xx', secret)).toBeNull()
    expect(await verifySession(t, new TextEncoder().encode('b'.repeat(40)))).toBeNull()
    expect(await verifySession(undefined, secret)).toBeNull()
    expect(await verifySession('garbage', secret)).toBeNull()
    const expired = await new SignJWT({ cid: 'c', bid: null, role: 'admin', adm: true, sv: 0, perms: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(secret)
    expect(await verifySession(expired, secret)).toBeNull()
  })
  it('rejects alg=none style tokens and malformed claims', async () => {
    const bad = await new SignJWT({ cid: 'c', bid: null, role: 'admin', adm: true, sv: 0, perms: 'nope' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setExpirationTime('1h')
      .sign(secret)
    expect(await verifySession(bad, secret)).toBeNull()
  })
})

describe('session claims', () => {
  it('rejects tokens missing sv/adm and oversized tokens', async () => {
    const t = await new SignJWT({ cid: 'c', bid: null, role: 'admin', perms: [] }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setExpirationTime('1h').sign(secret)
    expect(await verifySession(t, secret)).toBeNull()
    const many = Array.from({ length: 400 }, (_, i) => `module${i}.action`)
    await expect(signSession({ ...payload, perms: many }, secret)).rejects.toThrow(/too large/)
  })
})

describe('AUTH_SECRET', () => {
  const orig = process.env.AUTH_SECRET
  afterEach(() => {
    if (orig === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = orig
  })
  it('errors clearly when missing or short, lazily', () => {
    delete process.env.AUTH_SECRET
    expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is not set/)
    process.env.AUTH_SECRET = 'short'
    expect(() => getAuthSecret()).toThrow(/at least 32/)
    process.env.AUTH_SECRET = 'x'.repeat(32)
    expect(getAuthSecret()).toBeInstanceOf(Uint8Array)
  })
})

describe('safeNext', () => {
  it('only allows same-site relative paths', () => {
    expect(safeNext('/sales?x=1')).toBe('/sales?x=1')
    expect(safeNext('//evil.com')).toBe('/dashboard')
    expect(safeNext('https://evil.com')).toBe('/dashboard')
    expect(safeNext('/auth/login')).toBe('/dashboard')
    expect(safeNext(null)).toBe('/dashboard')
    for (const bad of ['/\t/evil.com', '/\\evil.com', '/%2F/evil', '/%2f%2fevil.com', 'javascript:alert(1)', '/ x', '/a\nb', '/auth', '/auth/x', '///evil.com', '/a\\b'])
      expect(safeNext(bad), bad).toBe('/dashboard')
    expect(safeNext('/sales/1?a=b#c')).toBe('/sales/1?a=b#c')
  })
})
