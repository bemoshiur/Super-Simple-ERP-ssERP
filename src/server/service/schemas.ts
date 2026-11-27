import { z } from 'zod'
import { optionalText } from '../validation'

export const openTicketSchema = z.object({
  issue: z.string().trim().min(3, 'Describe the problem (at least 3 characters)').max(1000, 'Must be at most 1000 characters'),
  notes: optionalText(2000),
})

export const TICKET_OUTCOMES = ['repaired', 'rejected', 'replaced', 'unrepairable'] as const
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number]

/** What each outcome does to the ticket and to the unit (the unit is in_service while a ticket is active). */
export const OUTCOME_EFFECT: Readonly<Record<TicketOutcome, { ticket: 'resolved' | 'closed' | 'rejected'; unit: 'sold' | 'in_stock' | 'damaged'; label: string; help: string }>> = {
  repaired: { ticket: 'resolved', unit: 'sold', label: 'Repaired: back to the customer', help: 'The unit goes back to the customer (sold). Its warranty dates are unchanged.' },
  rejected: { ticket: 'rejected', unit: 'sold', label: 'Claim rejected: returned as is', help: 'Not covered or no fault found. The unit goes back to the customer (sold).' },
  replaced: { ticket: 'closed', unit: 'in_stock', label: 'Replaced: unit returns to inventory', help: 'The unit goes back to stock and its sale/warranty link is cleared.' },
  unrepairable: { ticket: 'closed', unit: 'damaged', label: 'Unrepairable: mark damaged', help: 'The unit is marked damaged.' },
}

export const updateTicketSchema = z
  .object({
    status: z.enum(['in_progress']).optional(),
    notes: optionalText(2000).optional(),
  })
  .refine((v) => v.status !== undefined || v.notes !== undefined, { message: 'Nothing to change' })

export const closeTicketSchema = z.object({
  outcome: z.enum(TICKET_OUTCOMES, { message: 'Choose how the ticket ended' }),
  resolution: z.string().trim().min(2, 'Describe what was done (at least 2 characters)').max(1000, 'Must be at most 1000 characters'),
})
