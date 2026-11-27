import { numeric, timestamp, uuid } from 'drizzle-orm/pg-core'

export const id = () => uuid('id').primaryKey().defaultRandom()

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** numeric(14,2) money column. Values are strings; use src/server/money.ts. */
export const money = (name: string) => numeric(name, { precision: 14, scale: 2 })
