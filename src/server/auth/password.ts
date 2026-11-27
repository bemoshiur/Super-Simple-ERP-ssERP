import bcrypt from 'bcryptjs'

/** bcrypt work factor for new hashes. Hashes made with a lower cost (10, before v0.1.0) still verify and are upgraded on login. */
export const BCRYPT_COST = 12
// Valid bcrypt hash (same cost) of an unused string; compared against when the email is unknown to flatten timing.
const DUMMY_HASH = '$2b$12$9eRrMjKjtWy/Xa1x8ynreeprY1Y6rHEvvD2Hr/9gOq0bRjp8p2nOK'

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_COST)
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash)
/** True when `hash` was made with a lower work factor than BCRYPT_COST (rehash it after a successful login). */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST
  } catch {
    return false
  }
}
export async function dummyVerify(plain: string): Promise<false> {
  await bcrypt.compare(plain, DUMMY_HASH)
  return false
}
