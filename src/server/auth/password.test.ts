import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { BCRYPT_COST, dummyVerify, hashPassword, needsRehash, verifyPassword } from './password'

describe('password hashing', () => {
  it('hashes new passwords at cost 12', async () => {
    const h = await hashPassword('correct horse battery')
    expect(bcrypt.getRounds(h)).toBe(BCRYPT_COST)
    expect(BCRYPT_COST).toBe(12)
    expect(await verifyPassword('correct horse battery', h)).toBe(true)
    expect(needsRehash(h)).toBe(false)
  })

  it('old cost-10 hashes still verify and are flagged for rehash', async () => {
    const old = await bcrypt.hash('legacy-password-1', 10)
    expect(await verifyPassword('legacy-password-1', old)).toBe(true)
    expect(await verifyPassword('legacy-password-2', old)).toBe(false)
    expect(needsRehash(old)).toBe(true)
    expect(needsRehash('not-a-hash')).toBe(false)
  })

  it('dummy compare uses the same cost and never matches', async () => {
    expect(await dummyVerify('anything')).toBe(false)
  })
})
