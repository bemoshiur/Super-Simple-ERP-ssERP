import { boolean, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, id, money, updatedAt } from './_common'
import { branchId, companyId } from './core'
import { users } from './identity'

export const categories = pgTable(
  'categories',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('categories_company_name_uq').on(t.companyId, sql`lower(${t.name})`)],
)

export const brands = pgTable(
  'brands',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('brands_company_name_uq').on(t.companyId, sql`lower(${t.name})`)],
)

export const products = pgTable(
  'products',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    brandId: uuid('brand_id').references(() => brands.id),
    trackSerial: boolean('track_serial').notNull().default(false),
    warrantyMonths: integer('warranty_months').notNull().default(0),
    purchasePrice: money('purchase_price').notNull().default('0'),
    salePrice: money('sale_price').notNull().default('0'),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_company_sku_uq').on(t.companyId, t.sku),
    index('products_company_name_idx').on(t.companyId, t.name),
    index('products_category_idx').on(t.categoryId),
    index('products_brand_idx').on(t.brandId),
  ],
)

export const stockMovementType = pgEnum('stock_movement_type', [
  'purchase',
  'sale',
  'sale_return',
  'purchase_return',
  'adjustment',
  /** Inter-branch transfer (Task 14): a paired -qty at the source branch and +qty at the destination. */
  'transfer',
])

/** Quantity ledger for NON-serial products. On-hand = sum(qty_change). Serial products use product_units. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    type: stockMovementType('type').notNull(),
    qtyChange: integer('qty_change').notNull(), // signed
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    /** clock_timestamp(), not now(): movements written in ONE transaction still order by when each was written (stock card). */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index('stock_movements_product_idx').on(t.companyId, t.productId),
    index('stock_movements_branch_product_idx').on(t.companyId, t.branchId, t.productId),
    index('stock_movements_ref_idx').on(t.refTable, t.refId),
    check('stock_movements_qty_nonzero', sql`${t.qtyChange} <> 0`),
  ],
)

/** Why stock was adjusted by hand (Task 12). Serial units only use damage / loss (unit -> damaged; there is no 'lost' status). */
export const stockAdjustmentReason = pgEnum('stock_adjustment_reason', ['count_correction', 'damage', 'loss', 'found', 'other'])
