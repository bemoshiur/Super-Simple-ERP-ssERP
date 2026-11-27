import { date, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, id, money, updatedAt } from './_common'
import { branchId, companyId } from './core'
import { users } from './identity'
import { products } from './catalog'
import { customers, vendors } from './parties'
import { productUnits, purchaseItems, purchases } from './purchasing'

export const saleStatus = pgEnum('sale_status', ['draft', 'completed', 'partially_paid', 'paid', 'returned', 'cancelled'])

export const sales = pgTable(
  'sales',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    invoiceNo: text('invoice_no').notNull(),
    customerId: uuid('customer_id').references(() => customers.id), // null = walk-in
    date: date('date').notNull(),
    subtotal: money('subtotal').notNull().default('0'),
    discount: money('discount').notNull().default('0'),
    total: money('total').notNull().default('0'),
    paid: money('paid').notNull().default('0'),
    due: money('due').notNull().default('0'),
    /** Credit from customer returns (sum of sale_returns.credit_total). due = max(0, total - returned_total - paid). */
    returnedTotal: money('returned_total').notNull().default('0'),
    status: saleStatus('status').notNull().default('completed'),
    note: text('note'),
    /** Client-generated key per save attempt: resubmitting the same key returns the existing invoice. */
    idempotencyKey: text('idempotency_key'),
    /** sha256 of the canonical request payload saved with the key: same key + different payload is rejected. */
    idempotencyHash: text('idempotency_hash'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sales_company_invoice_uq').on(t.companyId, t.invoiceNo),
    uniqueIndex('sales_company_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('sales_customer_idx').on(t.companyId, t.customerId),
    index('sales_company_date_idx').on(t.companyId, t.date),
    index('sales_company_branch_date_idx').on(t.companyId, t.branchId, t.date),
    check(
      'sales_amounts_nonneg',
      sql`${t.subtotal} >= 0 and ${t.discount} >= 0 and ${t.total} >= 0 and ${t.paid} >= 0 and ${t.due} >= 0 and ${t.returnedTotal} >= 0`,
    ),
  ],
)

export const saleItems = pgTable(
  'sale_items',
  {
    id: id(),
    companyId: companyId(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    qty: integer('qty').notNull().default(1),
    unitPrice: money('unit_price').notNull(),
    /** Purchase cost of the unit (or product cost for non-serial) at time of sale, for profit reports. */
    unitCostSnapshot: money('unit_cost_snapshot').notNull().default('0'),
    /** Set for serial-tracked items (qty = 1); null for non-serial. */
    unitId: uuid('unit_id').references(() => productUnits.id),
    /** Line revenue AFTER its share of the invoice discount (largest remainder); sums to sales.total. */
    netTotal: money('net_total').notNull().default('0'),
    /** Position on the invoice (0-based, entry order). */
    lineNo: integer('line_no').notNull().default(0),
  },
  (t) => [
    index('sale_items_sale_idx').on(t.saleId),
    index('sale_items_product_idx').on(t.productId),
    index('sale_items_unit_idx').on(t.unitId),
    check('sale_items_qty_positive', sql`${t.qty} > 0`),
    check('sale_items_amounts_nonneg', sql`${t.unitPrice} >= 0 and ${t.unitCostSnapshot} >= 0 and ${t.netTotal} >= 0`),
  ],
)

export const saleReturns = pgTable(
  'sale_returns',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    returnNo: text('return_no').notNull(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    customerId: uuid('customer_id').references(() => customers.id),
    date: date('date').notNull(),
    /** Value of the goods returned (net revenue of the returned units after discount allocation). */
    creditTotal: money('credit_total').notNull().default('0'),
    /** Cash refunded to the customer for this return (the part of the credit beyond the invoice due). */
    refundTotal: money('refund_total').notNull().default('0'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sale_returns_company_no_uq').on(t.companyId, t.returnNo),
    index('sale_returns_sale_idx').on(t.saleId),
    index('sale_returns_company_branch_date_idx').on(t.companyId, t.branchId, t.date),
  ],
)

export const saleReturnItems = pgTable(
  'sale_return_items',
  {
    id: id(),
    companyId: companyId(),
    saleReturnId: uuid('sale_return_id')
      .notNull()
      .references(() => saleReturns.id, { onDelete: 'cascade' }),
    saleItemId: uuid('sale_item_id')
      .notNull()
      .references(() => saleItems.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    unitId: uuid('unit_id').references(() => productUnits.id),
    qty: integer('qty').notNull().default(1),
    /** Credit for these returned units (their net revenue). */
    refundAmount: money('refund_amount').notNull(),
    /** Condition on return: 'in_stock' or 'damaged' (resulting unit status). */
    restock: text('restock').$type<'in_stock' | 'damaged'>().notNull().default('in_stock'),
  },
  (t) => [index('sale_return_items_return_idx').on(t.saleReturnId), index('sale_return_items_unit_idx').on(t.unitId)],
)

export const purchaseReturns = pgTable(
  'purchase_returns',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    returnNo: text('return_no').notNull(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    date: date('date').notNull(),
    creditTotal: money('credit_total').notNull().default('0'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('purchase_returns_company_no_uq').on(t.companyId, t.returnNo),
    index('purchase_returns_purchase_idx').on(t.purchaseId),
    index('purchase_returns_company_branch_date_idx').on(t.companyId, t.branchId, t.date),
  ],
)

export const purchaseReturnItems = pgTable(
  'purchase_return_items',
  {
    id: id(),
    companyId: companyId(),
    purchaseReturnId: uuid('purchase_return_id')
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: 'cascade' }),
    purchaseItemId: uuid('purchase_item_id')
      .notNull()
      .references(() => purchaseItems.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    unitId: uuid('unit_id').references(() => productUnits.id),
    qty: integer('qty').notNull().default(1),
    creditAmount: money('credit_amount').notNull(),
  },
  (t) => [
    index('purchase_return_items_return_idx').on(t.purchaseReturnId),
    index('purchase_return_items_unit_idx').on(t.unitId),
  ],
)
