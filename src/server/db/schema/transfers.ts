import { check, date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, id } from './_common'
import { branches, companyId } from './core'
import { users } from './identity'
import { products } from './catalog'
import { productUnits } from './purchasing'

/**
 * Inter-branch stock transfer (Task 14). Immediate: written in ONE transaction, there is no pending / in-transit state.
 * Serial lines move one unit (product_units.branch_id from -> to, status stays in_stock, unit_events 'transferred').
 * Quantity lines write a paired stock_movements 'transfer' (-qty at from, +qty at to).
 */
export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: id(),
    companyId: companyId(),
    /** Human number from doc_sequences kind 'transfer' (TRF-00001). */
    transferNo: text('transfer_no').notNull(),
    fromBranchId: uuid('from_branch_id')
      .notNull()
      .references(() => branches.id),
    toBranchId: uuid('to_branch_id')
      .notNull()
      .references(() => branches.id),
    date: date('date').notNull(),
    note: text('note'),
    idempotencyKey: text('idempotency_key'),
    /** sha256 of the canonical request (from, to, serials, lines) saved with the key: same key + different payload is rejected. */
    idempotencyHash: text('idempotency_hash'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stock_transfers_company_no_uq').on(t.companyId, t.transferNo),
    uniqueIndex('stock_transfers_company_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('stock_transfers_company_date_idx').on(t.companyId, t.date),
    index('stock_transfers_from_idx').on(t.companyId, t.fromBranchId),
    index('stock_transfers_to_idx').on(t.companyId, t.toBranchId),
    check('stock_transfers_distinct_branches', sql`${t.fromBranchId} <> ${t.toBranchId}`),
  ],
)

export const stockTransferItems = pgTable(
  'stock_transfer_items',
  {
    id: id(),
    companyId: companyId(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** Serial lines only (qty = 1). */
    unitId: uuid('unit_id').references(() => productUnits.id),
    qty: integer('qty').notNull(),
  },
  (t) => [index('stock_transfer_items_transfer_idx').on(t.transferId), index('stock_transfer_items_unit_idx').on(t.unitId), check('stock_transfer_items_qty_positive', sql`${t.qty} > 0`)],
)
