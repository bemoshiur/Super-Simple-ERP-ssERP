import { z } from 'zod'
import { moneyField, optionalText } from '../validation'

const phone = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.replace(/\s+/g, ' ') : null))
  .refine((v) => v === null || /^\+?[\d০-৯][\d০-৯\s\-()]{4,19}$/.test(v), 'Enter a valid phone number, e.g. 01711-234567 or +8801711234567')

const email = z
  .string()
  .trim()
  .max(254, 'Email is too long')
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || z.email().safeParse(v).success, 'Enter a valid email address')

export const partySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'Must be at most 200 characters'),
  phone,
  email,
  address: optionalText(500),
  /** Signed: positive = they owe us (customer) / we owe them (vendor); negative = advance/credit. */
  openingBalance: moneyField({ signed: true }).default('0.00'),
  notes: optionalText(1000),
})
export type PartyInput = z.input<typeof partySchema>
export type PartyData = z.output<typeof partySchema>

export const PARTY_TRACKED = ['name', 'phone', 'email', 'address', 'openingBalance'] as const
