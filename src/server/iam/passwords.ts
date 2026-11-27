/** Server-only password helpers (CSPRNG). Kept out of policy.ts so client components can import the pure rules. */
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { passwordField } from './policy'

// No look-alikes (0/O, 1/l/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** Strong one-time password (16 chars from a 55-symbol alphabet, ~92 bits), CSPRNG. Shown once, never stored in clear. */
export function generatePassword(length = 16): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/**
 * Admin-set password: either type one (>= 10 chars) or ask the server to generate one.
 * Form values arrive as strings, so `generate` accepts 'on'/'true'.
 */
export const passwordChoiceSchema = z
  .object({
    password: z.string().optional(),
    generate: z.union([z.boolean(), z.string()]).optional(),
  })
  .transform((v, ctx) => {
    const generate = v.generate === true || v.generate === 'true' || v.generate === 'on'
    if (generate) return { generate: true as const, password: generatePassword() }
    const r = passwordField.safeParse(v.password ?? '')
    if (!r.success) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: r.error.issues[0]?.message ?? 'Invalid password' })
      return z.NEVER
    }
    return { generate: false as const, password: r.data }
  })
