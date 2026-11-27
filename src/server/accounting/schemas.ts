import { z } from 'zod'
import { dateField } from '../purchases/schemas'
import { moneyField, optionalText } from '../validation'

export const ACCOUNT_TYPES = ['cash', 'bank', 'mobile'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

const positiveMoney = moneyField().refine((v) => v !== '0.00', 'Enter an amount greater than zero')

/**
 * Account profile. NOTE: `active` is deliberately NOT part of this schema: an account is deactivated/reactivated only through
 * setAccountActive() (accounts.delete / accounts.edit), never through the generic edit form (same rule as Task 5 products).
 * Opening balance is signed (an overdrawn bank account opens negative).
 */
export const accountSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Must be at most 100 characters'),
  type: z.enum(ACCOUNT_TYPES, { error: 'Choose cash, bank or mobile' }),
  openingBalance: moneyField({ signed: true }).default('0.00'),
})
export type AccountInput = z.input<typeof accountSchema>

export const ACCOUNT_TRACKED = ['name', 'type', 'openingBalance'] as const

export const transferSchema = z
  .object({
    fromAccountId: z.uuid('Choose the source account'),
    toAccountId: z.uuid('Choose the destination account'),
    amount: positiveMoney,
    date: dateField,
    note: optionalText(500),
  })
  .refine((d) => d.fromAccountId !== d.toAccountId, { path: ['toAccountId'], message: 'Choose a different account to transfer to' })
export type TransferInput = z.input<typeof transferSchema>

export const expenseSchema = z.object({
  categoryId: z.union([z.uuid('Invalid category'), z.literal(''), z.null()]).optional().transform((v) => v || null),
  accountId: z.uuid('Choose an account'),
  amount: positiveMoney,
  date: dateField,
  note: optionalText(500),
})
export type ExpenseInput = z.input<typeof expenseSchema>

export const incomeSchema = z.object({
  /** Free text with suggestions from earlier entries (no separate categories table). */
  category: z
    .string()
    .trim()
    .max(80, 'Must be at most 80 characters')
    .nullish()
    .transform((v) => (v ? v.replace(/\s+/g, ' ') : null)),
  accountId: z.uuid('Choose an account'),
  amount: positiveMoney,
  date: dateField,
  note: optionalText(500),
})
export type IncomeInput = z.input<typeof incomeSchema>

/** Editing an entry never changes its cash effect: only the category/note. To fix an amount, date or account: void and re-enter. */
export const expenseEditSchema = z.object({ categoryId: expenseSchema.shape.categoryId, note: optionalText(500) })
export const incomeEditSchema = z.object({ category: incomeSchema.shape.category, note: optionalText(500) })

export const voidSchema = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(200, 'Must be at most 200 characters') })

export const expenseCategorySchema = z.object({ name: z.string().trim().min(1, 'Name is required').max(100, 'Must be at most 100 characters') })
