import { boolean, integer, pgTable, text, uniqueIndex, uuid, primaryKey } from 'drizzle-orm/pg-core'
import { createdAt, id, updatedAt } from './_common'

export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Every business table uses this for its company_id column. */
export const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id)

export const branches = pgTable(
  'branches',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    /** Short code shown on lists/invoices (e.g. MAIN, DHK). Unique per company, upper-case. */
    code: text('code').notNull(),
    address: text('address'),
    phone: text('phone'),
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('branches_company_name_uq').on(t.companyId, t.name), uniqueIndex('branches_company_code_uq').on(t.companyId, t.code)],
)

/** Nullable branch FK for branch-scoped tables. */
export const branchId = () => uuid('branch_id').references(() => branches.id)

/** Key/value settings per company: installed, currency_symbol, invoice_prefix_sale, invoice_prefix_purchase, ... */
export const settings = pgTable(
  'settings',
  {
    companyId: companyId(),
    key: text('key').notNull(),
    value: text('value'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.key] })],
)

export type DocKind = 'sale' | 'purchase' | 'sale_return' | 'purchase_return' | 'service' | 'transfer'

/**
 * Per-company, per-kind document number counter. Increment atomically inside the
 * document's transaction:
 *   INSERT ... ON CONFLICT (company_id, kind) DO UPDATE SET next_value = doc_sequences.next_value + 1 RETURNING next_value - 1
 */
export const docSequences = pgTable(
  'doc_sequences',
  {
    companyId: companyId(),
    kind: text('kind').$type<DocKind>().notNull(),
    nextValue: integer('next_value').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.kind] })],
)

