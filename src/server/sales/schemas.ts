import { z } from 'zod'
import { dateField, MAX_LINES_PER_INVOICE } from '../purchases/schemas'
import { MAX_UNITS_PER_INVOICE } from '../purchases/serialInput'
import { intField, moneyField, optionalId, optionalText } from '../validation'

export const MAX_PAYMENTS_PER_SALE = 5

/**
 * One sale line. Either a scanned serial (the unit's product comes from the unit; qty is always 1) or a non-serial
 * product with a quantity. The price is per unit and editable (>= 0); the server never trusts client totals.
 */
export const saleItemSchema = z
  .object({
    serial: z.string().max(256).optional().nullable(),
    productId: optionalId,
    qty: intField(MAX_UNITS_PER_INVOICE, 'Quantity').refine((n) => n >= 1, 'Quantity must be at least 1'),
    unitPrice: moneyField(),
  })
  .superRefine((it, ctx) => {
    const hasSerial = !!it.serial && it.serial.trim() !== ''
    if (hasSerial === !!it.productId) ctx.addIssue({ code: 'custom', path: ['productId'], message: 'Scan a serial or choose a product' })
    if (hasSerial && it.qty !== 1) ctx.addIssue({ code: 'custom', path: ['qty'], message: 'A serial line is always quantity 1' })
  })

export const salePaymentSchema = z.object({
  accountId: z.uuid('Choose an account'),
  amount: moneyField().refine((v) => v !== '0.00', 'Enter an amount greater than zero'),
  method: optionalText(50),
})

export const saleSchema = z
  .object({
    /** null / '' = walk-in customer (only allowed when nothing is left due). */
    customerId: optionalId,
    date: dateField,
    note: optionalText(500),
    items: z.array(saleItemSchema).min(1, 'Add at least one item').max(MAX_LINES_PER_INVOICE, `At most ${MAX_LINES_PER_INVOICE} lines per invoice`),
    discount: moneyField().default('0.00'),
    payments: z.array(salePaymentSchema).max(MAX_PAYMENTS_PER_SALE, `At most ${MAX_PAYMENTS_PER_SALE} payments per invoice`).default([]),
    /** The total the user saw. If given and different from the server's own calculation, the save is rejected. Never stored. */
    expectedTotal: z.union([z.string(), z.number()]).optional(),
    /** Client-generated UUID per save attempt. Resubmitting the same key returns the invoice already created. */
    idempotencyKey: z.uuid('Invalid request key').optional().nullable(),
  })
  .superRefine((d, ctx) => {
    const units = d.items.reduce((a, it) => a + it.qty, 0)
    if (units > MAX_UNITS_PER_INVOICE) ctx.addIssue({ code: 'custom', path: ['items'], message: `At most ${MAX_UNITS_PER_INVOICE} units per invoice (this one has ${units}).` })
  })
export type SaleInput = z.input<typeof saleSchema>

export const customerPaymentSchema = z.object({
  amount: moneyField().refine((v) => v !== '0.00', 'Enter an amount greater than zero'),
  accountId: z.uuid('Choose an account'),
  date: dateField,
  method: optionalText(50),
  note: optionalText(500),
})
export type CustomerPaymentInput = z.input<typeof customerPaymentSchema>

export const saleReturnSchema = z.object({
  items: z
    .array(
      z.object({
        saleItemId: z.uuid(),
        qty: intField(MAX_UNITS_PER_INVOICE, 'Quantity').refine((n) => n >= 1, 'Quantity must be at least 1'),
        /** Serial units only: put back in stock (default) or mark damaged. Non-serial returns always go back to stock. */
        restock: z.enum(['in_stock', 'damaged']).default('in_stock'),
      }),
    )
    .min(1, 'Select at least one item to return')
    .max(MAX_LINES_PER_INVOICE),
  date: dateField,
  note: optionalText(500),
  /** Account the cash refund is paid from. Required when the return creates a refund (credit beyond the invoice due). */
  refundAccountId: optionalId,
  refundMethod: optionalText(50),
})
export type SaleReturnInput = z.input<typeof saleReturnSchema>
