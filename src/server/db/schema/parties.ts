import { boolean, index, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, id, money, updatedAt } from './_common'
import { companyId } from './core'

const partyColumns = () => ({
  id: id(),
  companyId: companyId(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  openingBalance: money('opening_balance').notNull().default('0'),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const vendors = pgTable('vendors', partyColumns(), (t) => [
  index('vendors_company_name_idx').on(t.companyId, t.name),
  index('vendors_company_phone_idx').on(t.companyId, t.phone),
])

export const customers = pgTable('customers', partyColumns(), (t) => [
  index('customers_company_name_idx').on(t.companyId, t.name),
  index('customers_company_phone_idx').on(t.companyId, t.phone),
])
