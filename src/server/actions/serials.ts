'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { writeCtx } from '../branch'
import { getDb } from '../db'
import { closeServiceTicket, openServiceTicket, updateServiceTicket } from '../service/tickets'
import { guardedBranch, type ActionResult } from './guard'

const idSchema = z.uuid()

/** Open a warranty/service ticket on a sold unit and move it to in_service (serials.create). */
export async function openServiceTicketAction(unitId: string, input: unknown): Promise<ActionResult<{ id: string; ticketNo: string; underWarranty: boolean }>> {
  return guardedBranch('serials.create', async (s, b) => {
    const id = idSchema.parse(unitId)
    const r = await openServiceTicket(getDb(), s.cid, s.uid, id, input, writeCtx(b))
    revalidatePath('/serials', 'layout')
    revalidatePath('/service')
    revalidatePath('/customers', 'layout')
    return r
  })
}

/** Mark a ticket in progress / edit its notes (serials.edit). */
export async function updateServiceTicketAction(ticketId: string, input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  return guardedBranch('serials.edit', async (s, b) => {
    const r = await updateServiceTicket(getDb(), s.cid, s.uid, idSchema.parse(ticketId), input, { restrict: b.restrict })
    revalidatePath('/serials', 'layout')
    revalidatePath('/service')
    return r
  })
}

/** Finish a ticket with an outcome and return the unit to sold / stock / damaged (serials.edit). */
export async function closeServiceTicketAction(ticketId: string, input: unknown): Promise<ActionResult<{ id: string; status: string; outcome: string; unitStatus: string }>> {
  return guardedBranch('serials.edit', async (s, b) => {
    const r = await closeServiceTicket(getDb(), s.cid, s.uid, idSchema.parse(ticketId), input, { restrict: b.restrict })
    revalidatePath('/serials', 'layout')
    revalidatePath('/service')
    revalidatePath('/customers', 'layout')
    revalidatePath('/sales', 'layout')
    return r
  })
}
