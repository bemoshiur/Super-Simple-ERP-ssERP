import { boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createdAt, id, updatedAt } from './_common'
import { branchId, companyId } from './core'
import { users } from './identity'
import { customers } from './parties'
import { productUnits } from './purchasing'
import { sales } from './sales'

export const serviceTicketStatus = pgEnum('service_ticket_status', ['open', 'in_progress', 'resolved', 'closed', 'rejected'])

/**
 * Warranty/service tickets. open/in_progress are the ACTIVE states (at most one active ticket per unit, enforced by
 * the partial unique index); resolved/closed/rejected are final. The unit sits in status 'in_service' while a ticket is active.
 */
export const serviceTickets = pgTable(
  'service_tickets',
  {
    id: id(),
    companyId: companyId(),
    branchId: branchId(),
    /** Human number from doc_sequences kind 'service' (SVC-00001). */
    ticketNo: text('ticket_no'),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => productUnits.id),
    customerId: uuid('customer_id').references(() => customers.id),
    status: serviceTicketStatus('status').notNull().default('open'),
    issue: text('issue').notNull(),
    resolution: text('resolution'),
    notes: text('notes'),
    /** The sale line/invoice the unit was sold on when the ticket was opened. */
    saleId: uuid('sale_id').references(() => sales.id),
    /** Whether warranty_end covered the open date (app time zone) at the moment the ticket was opened. */
    underWarranty: boolean('under_warranty').notNull().default(false),
    /** repaired | replaced | unrepairable | rejected (set when the ticket is finished). */
    outcome: text('outcome'),
    openedBy: uuid('opened_by').references(() => users.id),
    closedBy: uuid('closed_by').references(() => users.id),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('service_tickets_company_status_idx').on(t.companyId, t.status),
    index('service_tickets_company_branch_status_idx').on(t.companyId, t.branchId, t.status),
    index('service_tickets_unit_idx').on(t.unitId),
    index('service_tickets_customer_idx').on(t.customerId),
    uniqueIndex('service_tickets_company_no_uq').on(t.companyId, t.ticketNo),
    uniqueIndex('service_tickets_one_active_per_unit_uq').on(t.unitId).where(sql`${t.status} in ('open', 'in_progress')`),
  ],
)
