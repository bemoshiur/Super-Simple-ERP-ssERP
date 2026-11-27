/** Pure validation for company settings (shared by the server schema, the print pages and unit tests). */
import { z } from 'zod'

/**
 * A logo URL that is safe to put in <img src>: absolute https:// (no credentials) or a same-origin path like
 * "/uploads/logo.png". Everything else (javascript:, data:, http:, protocol-relative //host, backslashes) is refused.
 * Returns the normalised URL or null.
 */
export function safeLogoUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v || v.length > 500) return null
  if (/[\u0000-\u001f\u007f\s\\"'<>]/.test(v)) return null
  if (v.startsWith('/')) {
    if (v.startsWith('//')) return null
    try {
      const u = new URL(v, 'http://localhost')
      return u.origin === 'http://localhost' ? u.pathname + u.search : null
    } catch {
      return null
    }
  }
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Document-number prefix: 1..10 of A-Z 0-9 - _, upper-cased, and NOT ending in a digit. Numbers are prefix + a counter that never
 * repeats per kind; with a non-digit last character, prefix+number is unambiguous, so changing a prefix can never produce a number
 * that collides with one issued under an earlier prefix (the unique index on the number stays safe). New prefixes apply to new
 * documents only; existing numbers are never rewritten.
 */
export const docPrefixField = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(
    z
      .string()
      .min(1, 'Prefix is required')
      .max(10, 'At most 10 characters')
      .regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, - and _ only')
      .regex(/[^0-9]$/, 'Must not end with a digit (e.g. INV- or INV)'),
  )

/** 1..5 visible characters, e.g. ৳, Tk, $, BDT. */
export const currencySymbolField = z
  .string()
  .trim()
  .min(1, 'Currency symbol is required')
  .refine((s) => [...s].length <= 5, 'At most 5 characters')
  .refine((s) => !/[\u0000-\u001f\u007f<>]/.test(s), 'Contains characters that are not allowed')

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .transform((s) => s || null)
    .nullable()
    .optional()
    .transform((v) => v ?? null)

export const settingsSchema = z.object({
  companyName: z.string().trim().min(1, 'Company name is required').max(120, 'Must be at most 120 characters'),
  companyAddress: optionalText(300),
  companyPhone: optionalText(40),
  companyEmail: z
    .string()
    .trim()
    .max(254)
    .refine((s) => s === '' || z.email().safeParse(s).success, 'Enter a valid email address')
    .transform((s) => s.toLowerCase() || null)
    .optional()
    .transform((v) => v ?? null),
  currencySymbol: currencySymbolField,
  invoiceFooter: optionalText(500),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((s) => s === '' || safeLogoUrl(s) !== null, 'Use an https:// address or a path starting with /')
    .transform((s) => (s === '' ? null : safeLogoUrl(s)))
    .optional()
    .transform((v) => v ?? null),
  prefixSale: docPrefixField,
  prefixPurchase: docPrefixField,
  prefixSaleReturn: docPrefixField,
  prefixPurchaseReturn: docPrefixField,
  prefixService: docPrefixField,
})
export type SettingsInput = z.input<typeof settingsSchema>
export type SettingsData = z.output<typeof settingsSchema>
