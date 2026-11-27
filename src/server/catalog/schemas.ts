import { z } from 'zod'
import { intField, moneyField, optionalId } from '../validation'

export const taxonSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Must be at most 100 characters'),
})
export type TaxonInput = z.input<typeof taxonSchema>

export const productSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'Must be at most 200 characters'),
  sku: z
    .string()
    .trim()
    .min(1, 'SKU is required')
    .max(64, 'Must be at most 64 characters')
    .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'Use letters, numbers and - _ . / only')
    .transform((s) => s.toUpperCase()),
  categoryId: optionalId,
  brandId: optionalId,
  trackSerial: z.boolean().default(false),
  warrantyMonths: intField(240, 'Warranty').default(0),
  purchasePrice: moneyField().default('0.00'),
  salePrice: moneyField().default('0.00'),
  lowStockThreshold: intField(1_000_000, 'Low-stock threshold').default(0),
})
export type ProductInput = z.input<typeof productSchema>
export type ProductData = z.output<typeof productSchema>

/** Fields whose changes are written to record_history. */
export const PRODUCT_TRACKED = ['purchasePrice', 'salePrice'] as const
