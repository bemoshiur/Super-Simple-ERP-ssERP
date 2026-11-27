import { boolean, check, date, index, pgEnum, pgTable, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, id, money, updatedAt } from './_common'
import { branchId, companyId } from './core'
import { users } from './identity'

export const accountType = pgEnum('account_type', ['cash', 'bank', 'mobile'])
export const paymentDirection = pgEnum('payment_direction', ['in', 'out'])
export const partyType = pgEnum('party_type', ['customer', 'vendor'])
export const paymentRefType = pgEnum('payment_ref_type', ['sale', 'purchase', 'expense', 'income', 'manual', 'transfer'])

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    companyId: companyId(),
    type: accountType('type').notNull(),
    name: text('name').notNull(),
    openingBalance: money('opening_balance').notNull().default('0'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('accounts_company_name_uq').on(t.companyId, t.name)],
)

export const payments = pgTable(
  'payments',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    direction: paymentDirection('direction').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    partyType: partyType('party_type'),
    partyId: uuid('party_id'), // customers.id or vendors.id depending on party_type
    refType: paymentRefType('ref_type').notNull(),
    refId: uuid('ref_id'),
    amount: money('amount').notNull(),
    method: text('method'),
    date: date('date').notNull(),
    note: text('note'),
    /**
     * Set on the reversing row written when an income/expense is voided: it points at the original payment and has the
     * opposite direction and the same amount, so balances stay append-only and exact. Payments are never deleted.
     */
    reversesPaymentId: uuid('reverses_payment_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_company_date_idx').on(t.companyId, t.date),
    index('payments_company_branch_date_idx').on(t.companyId, t.branchId, t.date),
    index('payments_ref_idx').on(t.companyId, t.refType, t.refId),
    index('payments_party_idx').on(t.companyId, t.partyType, t.partyId),
    index('payments_account_idx').on(t.accountId),
    index('payments_company_account_date_idx').on(t.companyId, t.accountId, t.date),
    check('payments_amount_positive', sql`${t.amount} > 0`),
  ],
)

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('expense_categories_company_name_uq').on(t.companyId, t.name)],
)

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    categoryId: uuid('category_id').references(() => expenseCategories.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amount: money('amount').notNull(),
    date: date('date').notNull(),
    note: text('note'),
    /** Voided entries stay in the table (audit) but are excluded from P&L and category totals; a reversing payment undoes the cash effect. */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('expenses_company_date_idx').on(t.companyId, t.date), index('expenses_company_branch_date_idx').on(t.companyId, t.branchId, t.date), index('expenses_category_idx').on(t.categoryId)],
)

export const incomes = pgTable(
  'incomes',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    category: text('category'),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amount: money('amount').notNull(),
    date: date('date').notNull(),
    note: text('note'),
    /** Voided entries stay in the table (audit) but are excluded from P&L and category totals; a reversing payment undoes the cash effect. */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidReason: text('void_reason'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('incomes_company_date_idx').on(t.companyId, t.date), index('incomes_company_branch_date_idx').on(t.companyId, t.branchId, t.date)],
)
