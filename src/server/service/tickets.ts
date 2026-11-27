/**
 * Warranty / service tickets. A ticket is opened on a SOLD unit; opening moves the unit sold -> in_service through the
 * state machine helpers (never a raw status update) and appends a 'sent_to_service' unit_event that references the ticket.
 * Finishing a ticket moves it in_service -> sold | in_stock | damaged with a matching event.
 *
 * The unit's sale_item_id pointer is NOT touched while it is in service, so after a repair (back to 'sold') a customer
 * return through the original invoice still works. Only the 'replaced' outcome (back to stock) clears the sale link
 * and warranty, exactly like a customer return does.
 *
 * Lock order is the same as sales: product FOR SHARE -> document number -> unit FOR UPDATE -> ticket row
 * (Task 14: the branch row FOR SHARE first).
 *
 * Branches (Task 14): a ticket belongs to the branch that took the unit in (the ACTIVE branch); opening it moves the unit
 * to that branch (it is physically at its service desk). A user restricted to one branch can only open tickets for units
 * located in that branch, and only see / update / finish that branch's tickets.
 */
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { logActivity } from '../audit'
import { assertPermits, branchCond, resolveWriteBranch, type BranchFilter, type WriteCtx } from '../branch'
import { appTimezone, localDate } from '../dates'
import { schema, type Db } from '../db'
import { nextDocNumber } from '../docnumbers'
import { FieldErrors, NotFoundError, isUniqueViolation, zodPathErrors } from '../errors'
import { isUnderWarranty } from '../lookup/pure'
import { likePattern } from '../pagination'
import { STATUS_LABEL, lockUnitsForUpdate, transitionLockedUnits, type UnitStatus } from '../serials'
import { OUTCOME_EFFECT, closeTicketSchema, openTicketSchema, updateTicketSchema } from './schemas'

const ACTIVE = ['open', 'in_progress'] as const
const ACTIVE_UQ = 'service_tickets_one_active_per_unit_uq'
type Ctx = WriteCtx

function parse<T>(s: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import('zod').ZodError } }, input: unknown): T {
  const r = s.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  return r.data
}

const fail = (msg: string, field = '_') => new FieldErrors({ [field]: msg }, msg)

async function activeTicketNo(tx: Pick<Db, 'select'>, companyId: string, unitId: string): Promise<string | null> {
  const [t] = await tx
    .select({ no: schema.serviceTickets.ticketNo })
    .from(schema.serviceTickets)
    .where(and(eq(schema.serviceTickets.companyId, companyId), eq(schema.serviceTickets.unitId, unitId), inArray(schema.serviceTickets.status, [...ACTIVE])))
  return t?.no ?? null
}

/** Why this unit cannot take a ticket, in the user's words. */
async function cannotOpenMessage(tx: Pick<Db, 'select'>, companyId: string, unit: { id: string; serialNo: string; status: string }): Promise<string> {
  const st = unit.status as UnitStatus
  if (st === 'in_service') {
    const no = await activeTicketNo(tx, companyId, unit.id)
    return `${unit.serialNo} is already in service${no ? ` (ticket ${no})` : ''}. Finish that ticket first.`
  }
  if (st === 'in_stock') return `${unit.serialNo} has not been sold, so it has no warranty to claim. Only sold units can be sent for service.`
  return `${unit.serialNo} is ${STATUS_LABEL[st].toLowerCase()} and cannot be sent for service.`
}

export async function openServiceTicket(db: Db, companyId: string, userId: string, unitId: string, input: unknown, ctx: Ctx) {
  const d = parse(openTicketSchema, input)
  const u = schema.productUnits
  const [pre] = await db.select({ id: u.id, productId: u.productId, branchId: u.branchId }).from(u).where(and(eq(u.id, unitId), eq(u.companyId, companyId)))
  if (!pre) throw new NotFoundError('Serial')
  assertPermits(ctx.restrict, pre.branchId, 'Serial')
  try {
    return await db.transaction(async (tx) => {
      const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
      await tx.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, pre.productId), eq(schema.products.companyId, companyId))).for('share')
      const ticketNo = await nextDocNumber(tx, companyId, 'service')
      const [unit] = await lockUnitsForUpdate(tx, companyId, [pre.id])
      if (!unit) throw new NotFoundError('Serial')
      assertPermits(ctx.restrict, unit.branchId, 'Serial')
      if (unit.status !== 'sold') throw fail(await cannotOpenMessage(tx, companyId, unit))

      // The sale this unit is currently sold on (pointer set by the sale, kept while in service).
      let sale: { id: string; invoiceNo: string; customerId: string | null } | null = null
      if (unit.saleItemId) {
        const [s] = await tx
          .select({ id: schema.sales.id, invoiceNo: schema.sales.invoiceNo, customerId: schema.sales.customerId })
          .from(schema.saleItems)
          .innerJoin(schema.sales, and(eq(schema.sales.id, schema.saleItems.saleId), eq(schema.sales.companyId, companyId)))
          .where(and(eq(schema.saleItems.id, unit.saleItemId), eq(schema.saleItems.companyId, companyId)))
        sale = s ?? null
      }
      const underWarranty = isUnderWarranty(unit.warrantyEnd, localDate(appTimezone()))
      const [ticket] = await tx
        .insert(schema.serviceTickets)
        .values({ companyId, branchId, ticketNo, unitId: unit.id, customerId: sale?.customerId ?? null, saleId: sale?.id ?? null, status: 'open', issue: d.issue, notes: d.notes, underWarranty, openedBy: userId })
        .returning({ id: schema.serviceTickets.id })
      await transitionLockedUnits(tx, {
        companyId,
        userId,
        to: 'in_service',
        allowedFrom: ['sold'],
        eventType: 'sent_to_service',
        set: { branchId },
        items: [{ unit, ref: { table: 'service_tickets', id: ticket.id }, note: d.issue, meta: { ticketNo, underWarranty, saleId: sale?.id ?? null, invoiceNo: sale?.invoiceNo ?? null, customerId: sale?.customerId ?? null, ...(unit.branchId !== branchId ? { fromBranchId: unit.branchId, toBranchId: branchId } : {}) } }],
      })
      await logActivity({ companyId, userId, action: 'service.open', entity: 'service_ticket', entityId: ticket.id, after: { ticketNo, unitId: unit.id, serialNo: unit.serialNo, underWarranty, issue: d.issue } }, tx)
      return { id: ticket.id, ticketNo, underWarranty }
    })
  } catch (e) {
    if (isUniqueViolation(e, ACTIVE_UQ)) throw fail('This unit already has an open service ticket.')
    throw e
  }
}

/** open -> in_progress and/or edit the notes of an ACTIVE ticket. */
export async function updateServiceTicket(db: Db, companyId: string, userId: string, ticketId: string, input: unknown, ctx: Pick<WriteCtx, 'restrict'>) {
  const d = parse(updateTicketSchema, input)
  const t = schema.serviceTickets
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(t).where(and(eq(t.id, ticketId), eq(t.companyId, companyId))).for('update')
    if (!cur) throw new NotFoundError('Service ticket')
    assertPermits(ctx.restrict, cur.branchId, 'Service ticket')
    if (!(ACTIVE as readonly string[]).includes(cur.status)) throw fail(`Ticket ${cur.ticketNo ?? ''} is already ${cur.status}.`.replace('  ', ' '))
    const set: Partial<typeof t.$inferInsert> = { updatedAt: new Date() }
    if (d.status) {
      if (cur.status !== 'open') throw fail(`Ticket ${cur.ticketNo ?? ''} is already in progress.`.replace('  ', ' '))
      set.status = d.status
    }
    if (d.notes !== undefined) set.notes = d.notes
    const [after] = await tx.update(t).set(set).where(and(eq(t.id, cur.id), eq(t.companyId, companyId))).returning({ id: t.id, status: t.status })
    await logActivity({ companyId, userId, action: 'service.update', entity: 'service_ticket', entityId: cur.id, before: { status: cur.status, notes: cur.notes }, after: { status: after.status, notes: d.notes ?? cur.notes } }, tx)
    return { id: after.id, status: after.status }
  })
}

/** Finish an active ticket with an outcome: moves the unit in_service -> sold | in_stock | damaged and writes the event. */
export async function closeServiceTicket(db: Db, companyId: string, userId: string, ticketId: string, input: unknown, ctx: Pick<WriteCtx, 'restrict'>) {
  const d = parse(closeTicketSchema, input)
  const eff = OUTCOME_EFFECT[d.outcome]
  const t = schema.serviceTickets
  const u = schema.productUnits
  const [pre] = await db
    .select({ id: t.id, unitId: t.unitId, productId: u.productId, branchId: t.branchId })
    .from(t)
    .innerJoin(u, and(eq(u.id, t.unitId), eq(u.companyId, companyId)))
    .where(and(eq(t.id, ticketId), eq(t.companyId, companyId)))
  if (!pre) throw new NotFoundError('Service ticket')
  assertPermits(ctx.restrict, pre.branchId, 'Service ticket')
  return db.transaction(async (tx) => {
    await tx.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, pre.productId), eq(schema.products.companyId, companyId))).for('share')
    const [unit] = await lockUnitsForUpdate(tx, companyId, [pre.unitId])
    const [cur] = await tx.select().from(t).where(and(eq(t.id, pre.id), eq(t.companyId, companyId))).for('update')
    if (!unit || !cur) throw new NotFoundError('Service ticket')
    if (!(ACTIVE as readonly string[]).includes(cur.status)) throw fail(`Ticket ${cur.ticketNo ?? ''} is already ${cur.status}.`.replace('  ', ' '))
    if (unit.status !== 'in_service') throw fail(`${unit.serialNo} is ${STATUS_LABEL[unit.status as UnitStatus].toLowerCase()}, not in service, so this ticket cannot be finished here.`)
    await transitionLockedUnits(tx, {
      companyId,
      userId,
      to: eff.unit,
      allowedFrom: ['in_service'],
      eventType: eff.unit === 'damaged' ? 'marked_damaged' : 'returned_from_service',
      // Back to stock is cleared by the state machine itself. An unrepairable unit is no longer with the customer
      // and cannot be returned through the invoice (only 'sold' units can), so its stale sale link is cleared too.
      set: eff.unit === 'damaged' ? { soldAt: null, warrantyStart: null, warrantyEnd: null, saleItemId: null } : undefined,
      items: [{ unit, ref: { table: 'service_tickets', id: cur.id }, note: d.resolution, meta: { ticketNo: cur.ticketNo, outcome: d.outcome } }],
    })
    const [after] = await tx
      .update(t)
      .set({ status: eff.ticket, outcome: d.outcome, resolution: d.resolution, closedAt: new Date(), closedBy: userId, updatedAt: new Date() })
      .where(and(eq(t.id, cur.id), eq(t.companyId, companyId)))
      .returning({ id: t.id, status: t.status })
    await logActivity({ companyId, userId, action: 'service.close', entity: 'service_ticket', entityId: cur.id, before: { status: cur.status }, after: { status: after.status, outcome: d.outcome, unitStatus: eff.unit, resolution: d.resolution } }, tx)
    return { id: after.id, status: after.status, outcome: d.outcome, unitStatus: eff.unit }
  })
}

// ------------------------------------------------------------------ list

export type TicketFilter = { q?: string; /** 'active' | one status | undefined = all */ status?: string; limit: number; offset: number }
const STATUSES = ['open', 'in_progress', 'resolved', 'closed', 'rejected'] as const

export async function listServiceTickets(db: Pick<Db, 'select'>, companyId: string, branch: BranchFilter, f: TicketFilter) {
  const t = schema.serviceTickets
  const u = schema.productUnits
  const c = schema.customers
  const term = f.q ? likePattern(f.q) : null
  const statusCond: SQL | undefined = f.status === 'active' ? inArray(t.status, [...ACTIVE]) : (STATUSES as readonly string[]).includes(f.status ?? '') ? eq(t.status, f.status as (typeof STATUSES)[number]) : undefined
  const where = and(eq(t.companyId, companyId), branchCond(t.branchId, branch), statusCond, term ? or(ilike(u.serialNo, term), ilike(c.name, term), ilike(c.phone, term), ilike(t.ticketNo, term), ilike(schema.products.name, term)) : undefined)
  const base = () =>
    db
      .select({
        id: t.id,
        ticketNo: t.ticketNo,
        status: t.status,
        issue: t.issue,
        outcome: t.outcome,
        underWarranty: t.underWarranty,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        unitId: u.id,
        serialNo: u.serialNo,
        productName: schema.products.name,
        customerId: c.id,
        customerName: c.name,
        customerPhone: c.phone,
      })
      .from(t)
      .innerJoin(u, and(eq(u.id, t.unitId), eq(u.companyId, companyId)))
      .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
      .leftJoin(c, and(eq(c.id, t.customerId), eq(c.companyId, companyId)))
  const [rows, [agg]] = await Promise.all([
    base().where(where).orderBy(sql`(${t.status} in ('open','in_progress')) desc`, desc(t.openedAt), desc(t.id)).limit(f.limit).offset(f.offset),
    db
      .select({ n: count() })
      .from(t)
      .innerJoin(u, and(eq(u.id, t.unitId), eq(u.companyId, companyId)))
      .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
      .leftJoin(c, and(eq(c.id, t.customerId), eq(c.companyId, companyId)))
      .where(where),
  ])
  const byStatus = await db.select({ status: t.status, n: count() }).from(t).where(and(eq(t.companyId, companyId), branchCond(t.branchId, branch))).groupBy(t.status).orderBy(asc(t.status))
  return { rows, total: Number(agg.n), counts: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])) as Record<string, number> }
}
