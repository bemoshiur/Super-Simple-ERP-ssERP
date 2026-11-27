import { z } from 'zod'
import { intField, moneyField, optionalId, optionalText } from '../validation'
import { MAX_UNITS_PER_INVOICE } from './serialInput'

export const MAX_LINES_PER_INVOICE = 200
/** Warranty override ceiling for an imported unit (10 years). */
export const MAX_WARRANTY_MONTHS = 120

/** YYYY-MM-DD that is a real calendar date between 2000 and 2100. */
export const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31'
  }, 'Enter a valid date')

export const purchaseItemSchema = z.object({
  productId: z.uuid('Choose a product'),
  qty: intField(MAX_UNITS_PER_INVOICE, 'Quantity').refine((n) => n >= 1, 'Quantity must be at least 1'),
  unitCost: moneyField(),
  /** Raw serials (normalised and validated on the server; the form sends its parsed list). Required for serial-tracked products. */
  serials: z.array(z.string().max(256)).max(MAX_UNITS_PER_INVOICE).default([]),
  /**
   * Optional per-serial extras, aligned by index with `serials` (the bulk import sends them): a warranty override in months
   * (null = the product's own warranty) and a free-text note (kept on the unit's 'purchased' event).
   */
  serialMeta: z
    .array(z.object({ warrantyMonths: z.number().int().min(0).max(MAX_WARRANTY_MONTHS).nullable().default(null), note: z.string().trim().max(200).nullable().default(null) }))
    .max(MAX_UNITS_PER_INVOICE)
    .optional(),
})

export const purchaseSchema = z
  .object({
    vendorId: z.uuid('Choose a vendor'),
    date: dateField,
    note: optionalText(500),
    items: z.array(purchaseItemSchema).min(1, 'Add at least one item').max(MAX_LINES_PER_INVOICE, `At most ${MAX_LINES_PER_INVOICE} lines per invoice`),
    discount: moneyField().default('0.00'),
    paid: moneyField().default('0.00'),
    accountId: optionalId,
    /** The total the user saw. If given and different from the server's own calculation, the save is rejected. Never stored. */
    expectedTotal: z.union([z.string(), z.number()]).optional(),
    /** Client-generated UUID per save attempt (the bulk import sets it). Resubmitting the same key returns the invoice already created. */
    idempotencyKey: z.uuid('Invalid request key').optional().nullable(),
  })
  .superRefine((d, ctx) => {
    const units = d.items.reduce((a, it) => a + it.qty, 0)
    if (units > MAX_UNITS_PER_INVOICE) ctx.addIssue({ code: 'custom', path: ['items'], message: `At most ${MAX_UNITS_PER_INVOICE} units per invoice (this one has ${units}). Split it into several invoices.` })
  })
export type PurchaseInput = z.input<typeof purchaseSchema>

export const vendorPaymentSchema = z.object({
  amount: moneyField().refine((v) => v !== '0.00', 'Enter an amount greater than zero'),
  accountId: z.uuid('Choose an account'),
  date: dateField,
  method: optionalText(50),
  note: optionalText(500),
})
export type VendorPaymentInput = z.input<typeof vendorPaymentSchema>

export const purchaseReturnSchema = z
  .object({
    /** Serial units to return (in stock, of this purchase). */
    unitIds: z.array(z.uuid()).max(MAX_UNITS_PER_INVOICE).default([]),
    /** Non-serial lines to return: qty <= received - already returned on that line (and on hand must stay >= 0). */
    lines: z
      .array(z.object({ purchaseItemId: z.uuid(), qty: intField(MAX_UNITS_PER_INVOICE, 'Quantity').refine((n) => n >= 1, 'Quantity must be at least 1') }))
      .max(MAX_LINES_PER_INVOICE)
      .default([]),
    date: dateField,
    note: optionalText(500),
    /** Cash received back from the vendor now (optional). Only allowed up to the vendor credit this return creates. */
    refundAmount: moneyField().default('0.00'),
    refundAccountId: optionalId,
  })
  .refine((d) => d.unitIds.length + d.lines.length > 0, { message: 'Select at least one unit or quantity to return', path: ['unitIds'] })
export type PurchaseReturnInput = z.input<typeof purchaseReturnSchema>
