import { z } from 'zod'
import { optionalText } from '../validation'
import { ADJUST_REASONS, MAX_ADJUST_QTY, UNIT_ADJUST_REASONS, parseSignedQty } from './pure'

/** Optional client idempotency key (one per form attempt). */
const idempotencyKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid request key')
  .nullish()
  .transform((v) => v || null)

const signedQty = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : parseSignedQty(v)
  if (n === null || !Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_ADJUST_QTY) {
    ctx.addIssue({ code: 'custom', message: 'Enter a whole number other than zero, e.g. -2 or 5' })
    return z.NEVER
  }
  return n
})

/** Non-serial quantity adjustment (+/-). */
export const qtyAdjustmentSchema = z.object({
  kind: z.literal('qty'),
  productId: z.uuid('Choose a product'),
  qtyChange: signedQty,
  reason: z.enum(ADJUST_REASONS, 'Choose a reason'),
  note: optionalText(500),
  idempotencyKey,
})

/** Serial unit marked damaged or lost (in_stock -> damaged). Identify the unit by id or by its exact serial. */
export const unitAdjustmentSchema = z
  .object({
    kind: z.literal('unit'),
    productId: z.uuid('Choose a product'),
    unitId: z.union([z.uuid(), z.literal(''), z.null()]).optional().transform((v) => v || null),
    serial: z.string().max(256).optional().transform((v) => (v ?? '').trim() || null),
    reason: z.enum(UNIT_ADJUST_REASONS, 'Choose damage or loss'),
    note: optionalText(500),
    idempotencyKey,
  })
  .refine((d) => d.unitId || d.serial, { message: 'Enter the serial number of the unit', path: ['serial'] })

export const adjustmentSchema = z.discriminatedUnion('kind', [qtyAdjustmentSchema, unitAdjustmentSchema])
export type AdjustmentInput = z.input<typeof adjustmentSchema>

const countedQty = z.union([z.string(), z.number(), z.null()]).optional().transform((v, ctx) => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const s = String(v).trim()
  if (!/^\d{1,9}$/.test(s) || Number(s) > MAX_ADJUST_QTY) {
    ctx.addIssue({ code: 'custom', message: 'Counted quantity must be a whole number of 0 or more' })
    return z.NEVER
  }
  return Number(s)
})

export const MAX_COUNT_PRODUCTS = 500
export const MAX_COUNT_SERIALS = 5000

/** A stock-take sheet as submitted: counted quantities for non-serial products, scanned serials for serial products. */
export const countSchema = z.object({
  lines: z
    .array(z.object({ productId: z.uuid(), counted: countedQty, /** The system qty the counter saw (apply refuses when stock moved since). */ system: z.number().int().optional() }))
    .max(MAX_COUNT_PRODUCTS, `At most ${MAX_COUNT_PRODUCTS} products per count`),
  /** Serial products included in the count (their in-stock units are expected). */
  serialProductIds: z.array(z.uuid()).max(MAX_COUNT_PRODUCTS).default([]),
  scanned: z.string().max(400_000).default(''),
})
export type CountInput = z.input<typeof countSchema>

export const applyCountSchema = z.object({
  lines: z
    .array(z.object({ productId: z.uuid(), counted: countedQty, system: z.number().int() }))
    .min(1, 'Nothing to apply')
    .max(MAX_COUNT_PRODUCTS),
  note: optionalText(500),
  idempotencyKey,
  /** Apply only the lines whose system qty still matches what the counter saw; moved ones are skipped and reported. */
  onlyUnchanged: z.boolean().optional().default(false),
})
export type ApplyCountInput = z.input<typeof applyCountSchema>

export const countSheetSchema = z.object({
  categoryId: z.union([z.uuid(), z.literal(''), z.null()]).optional().transform((v) => v || null),
  q: z.string().trim().max(100).optional().default(''),
  tracking: z.enum(['all', 'serial', 'plain']).optional().default('all'),
})
export type CountSheetInput = z.input<typeof countSheetSchema>
