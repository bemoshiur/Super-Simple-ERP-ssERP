import { z } from 'zod'
import { fromMinor, toMinor } from './money'

/** numeric(14,2) upper bound in minor units: 999,999,999,999.99 */
export const MAX_MINOR = 99_999_999_999_999

/** Money input (string from a form, or number): exact parse via toMinor (lakh grouping accepted), output "1250.50". Empty = 0.00. */
export function moneyField(opts: { signed?: boolean } = {}) {
  return z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = typeof v === 'number' ? v : v.trim()
    if (s === '') return '0.00'
    let minor: number
    try {
      minor = toMinor(s)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid amount, e.g. 1250.50 or 12,50,000' })
      return z.NEVER
    }
    if (!opts.signed && minor < 0) {
      ctx.addIssue({ code: 'custom', message: 'Amount cannot be negative' })
      return z.NEVER
    }
    if (Math.abs(minor) > MAX_MINOR) {
      ctx.addIssue({ code: 'custom', message: 'Amount is too large' })
      return z.NEVER
    }
    return fromMinor(minor)
  })
}

/** Non-negative whole number from a form string or number. Empty = 0. */
export function intField(max: number, label = 'Value') {
  return z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = String(v).trim()
    if (s === '') return 0
    if (!/^\d{1,9}$/.test(s) || Number(s) > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be a whole number from 0 to ${max}` })
      return z.NEVER
    }
    return Number(s)
  })
}

/** Trimmed optional text: '' / null / undefined become null. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .nullish()
    .transform((v) => (v ? v : null))
}

/** Optional uuid reference: '' / null / undefined become null. */
export const optionalId = z
  .union([z.uuid('Invalid selection'), z.literal(''), z.null()])
  .optional()
  .transform((v) => v || null)
