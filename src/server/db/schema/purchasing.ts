import { date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, id, money, updatedAt } from './_common'
import { branchId, companyId } from './core'
import { users } from './identity'
import { products, stockAdjustmentReason } from './catalog'
import { vendors } from './parties'

export const purchaseStatus = pgEnum('purchase_status', ['draft', 'received', 'partially_paid', 'paid', 'cancelled'])

/** Serial lifecycle. Every change must also append a unit_events row. */
export const unitStatus = pgEnum('unit_status', ['in_stock', 'sold', 'returned_to_vendor', 'in_service', 'damaged'])

export const unitEventType = pgEnum('unit_event_type', [
  'purchased',
  'sold',
  'sale_returned',
  'returned_to_vendor',
  'sent_to_service',
  'returned_from_service',
  'marked_damaged',
  'status_changed',
  'note',
  /** Unit moved to another branch (Task 14): status unchanged (in_stock), meta {fromBranchId, toBranchId, transferNo}. */
  'transferred',
])

export const purchases = pgTable(
  'purchases',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    invoiceNo: text('invoice_no').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    date: date('date').notNull(),
    subtotal: money('subtotal').notNull().default('0'),
    discount: money('discount').notNull().default('0'),
    total: money('total').notNull().default('0'),
    paid: money('paid').notNull().default('0'),
    due: money('due').notNull().default('0'),
    /** Credit from purchase returns (sum of purchase_returns.credit_total). due = max(0, total - returned_total - paid). */
    returnedTotal: money('returned_total').notNull().default('0'),
    status: purchaseStatus('status').notNull().default('received'),
    note: text('note'),
    /** Optional client key per save attempt (bulk serial import): resubmitting the same key returns the existing invoice. */
    idempotencyKey: text('idempotency_key'),
    /** sha256 of the canonical request payload saved with the key: same key + different payload is rejected. */
    idempotencyHash: text('idempotency_hash'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('purchases_company_invoice_uq').on(t.companyId, t.invoiceNo),
    uniqueIndex('purchases_company_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('purchases_vendor_idx').on(t.companyId, t.vendorId),
    index('purchases_company_date_idx').on(t.companyId, t.date),
    index('purchases_company_branch_date_idx').on(t.companyId, t.branchId, t.date),
    check(
      'purchases_amounts_nonneg',
      sql`${t.subtotal} >= 0 and ${t.discount} >= 0 and ${t.total} >= 0 and ${t.paid} >= 0 and ${t.due} >= 0 and ${t.returnedTotal} >= 0`,
    ),
  ],
)

export const purchaseItems = pgTable(
  'purchase_items',
  {
    id: id(),
    companyId: companyId(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    qty: integer('qty').notNull(),
    unitCost: money('unit_cost').notNull(),
    /**
     * Line total AFTER its share of the invoice discount (see purchases/totals.ts allocateDiscount).
     * Sum over an invoice's lines == purchases.total. Net unit cost (COGS) = net_total split by splitEvenly().
     */
    netTotal: money('net_total').notNull().default('0'),
  },
  (t) => [
    index('purchase_items_purchase_idx').on(t.purchaseId),
    index('purchase_items_product_idx').on(t.productId),
    check('purchase_items_qty_positive', sql`${t.qty} > 0`),
  ],
)

/** One row per physical unit (serial/IMEI). Stock of a serial product = count(status = 'in_stock'). */
export const productUnits = pgTable(
  'product_units',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    serialNo: text('serial_no').notNull(),
    purchaseItemId: uuid('purchase_item_id').references(() => purchaseItems.id),
    vendorId: uuid('vendor_id').references(() => vendors.id),
    purchasePrice: money('purchase_price').notNull(),
    status: unitStatus('status').notNull().default('in_stock'),
    warrantyMonths: integer('warranty_months').notNull().default(0),
    location: text('location'),
    /** Set when the unit is sold (cleared on customer return). Warranty runs warranty_start..warranty_end (null end = no warranty). */
    soldAt: timestamp('sold_at', { withTimezone: true }),
    warrantyStart: date('warranty_start'),
    warrantyEnd: date('warranty_end'),
    /**
     * The sale_items line this unit is currently sold on (set by a sale under the unit lock, cleared by a customer return).
     * A return must come through exactly this line. No FK here to avoid a schema import cycle (sale_items -> product_units).
     */
    saleItemId: uuid('sale_item_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('product_units_company_serial_uq').on(t.companyId, t.serialNo),
    // Serial lookup: case-insensitive exact match and lower(serial) prefix LIKE (text_pattern_ops works under any collation).
    index('product_units_company_serial_lower_idx').on(t.companyId, sql`lower(${t.serialNo}) text_pattern_ops`),
    index('product_units_company_status_idx').on(t.companyId, t.status),
    index('product_units_product_status_idx').on(t.companyId, t.productId, t.status),
    index('product_units_branch_product_status_idx').on(t.companyId, t.branchId, t.productId, t.status),
    index('product_units_purchase_item_idx').on(t.purchaseItemId),
    index('product_units_vendor_idx').on(t.vendorId),
  ],
)

/** Append-only. Never UPDATE or DELETE rows from application code. */
export const unitEvents = pgTable(
  'unit_events',
  {
    id: id(),
    companyId: companyId(),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => productUnits.id),
    type: unitEventType('type').notNull(),
    fromStatus: unitStatus('from_status'),
    toStatus: unitStatus('to_status'),
    refTable: text('ref_table'),
    refId: uuid('ref_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    price: money('price'),
    note: text('note'),
    meta: jsonb('meta'),
    /** clock_timestamp(), not now(): events written in ONE transaction must still order by when each was written. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index('unit_events_unit_idx').on(t.unitId, t.createdAt),
    index('unit_events_company_idx').on(t.companyId, t.createdAt),
    index('unit_events_ref_idx').on(t.refTable, t.refId),
  ],
)

/**
 * Manual stock adjustments (header + audit record; defined here next to product_units for the unit FK). Non-serial: one 'adjustment' stock_movements row with the same
 * signed qty (ref_table 'stock_adjustments'). Serial: one unit moved in_stock -> damaged (unit_events ref 'stock_adjustments'),
 * qty_change = -1. unit_cost is the net cost at the time (average cost / the unit's purchase price), value = qty_change x unit_cost.
 * idempotency_key: optional client key; a double submit returns the first adjustment instead of adjusting twice.
 */
export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** Serial adjustments only. */
    unitId: uuid('unit_id').references(() => productUnits.id, { onDelete: 'restrict' }),
    qtyChange: integer('qty_change').notNull(),
    reason: stockAdjustmentReason('reason').notNull(),
    note: text('note'),
    unitCost: money('unit_cost').notNull().default('0'),
    value: money('value').notNull().default('0'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('stock_adjustments_product_idx').on(t.companyId, t.productId, t.createdAt),
    index('stock_adjustments_branch_idx').on(t.companyId, t.branchId, t.createdAt),
    uniqueIndex('stock_adjustments_company_idempotency_uq').on(t.companyId, t.idempotencyKey),
    check('stock_adjustments_qty_nonzero', sql`${t.qtyChange} <> 0`),
  ],
)
