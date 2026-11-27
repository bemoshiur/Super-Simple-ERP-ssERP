/**
 * Serial unit state machine (the core integrity rule).
 *
 * Every physical unit is one product_units row. Its status may only change along TRANSITIONS, and every
 * change appends exactly one unit_events row in the same transaction. unit_events is append-only: no code
 * may UPDATE or DELETE it.
 *
 * Task 7+ extend this by ADDING transitions/event mappings only; existing ones are relied on by purchases.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { schema, type Db } from './db'
import { FieldErrors, NotFoundError } from './errors'

export const UNIT_STATUSES = ['in_stock', 'sold', 'returned_to_vendor', 'in_service', 'damaged'] as const
export type UnitStatus = (typeof UNIT_STATUSES)[number]
export type UnitEventType = (typeof schema.unitEventType.enumValues)[number]

/** Allowed status changes. `returned_to_vendor` is terminal. */
export const TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> = {
  in_stock: ['sold', 'returned_to_vendor', 'damaged', 'in_service'],
  sold: ['in_stock', 'in_service', 'damaged'], // customer return (restocked or damaged), warranty service
  in_service: ['in_stock', 'sold', 'damaged'],
  damaged: ['returned_to_vendor', 'in_stock'],
  returned_to_vendor: [],
}

export const STATUS_LABEL: Readonly<Record<UnitStatus, string>> = {
  in_stock: 'In stock',
  sold: 'Sold',
  returned_to_vendor: 'Returned to vendor',
  in_service: 'In service',
  damaged: 'Damaged',
}

/**
 * Single source of truth for "a unit is back in stock": it has no sale, no sold date and no warranty any more.
 * Applied by transitionUnit and transitionLockedUnits for EVERY transition whose target is in_stock (customer return,
 * replaced service ticket, damaged -> in_stock, ...), so a stock unit can never carry a stale sale pointer. Idempotent.
 */
export const IN_STOCK_RESET = { soldAt: null, warrantyStart: null, warrantyEnd: null, saleItemId: null } as const

export function canTransition(from: UnitStatus, to: UnitStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** Default event type recorded for a transition (callers may override with a more specific type). */
export function eventTypeFor(from: UnitStatus, to: UnitStatus): UnitEventType {
  if (to === 'sold') return from === 'in_service' ? 'returned_from_service' : 'sold'
  if (to === 'returned_to_vendor') return 'returned_to_vendor'
  if (to === 'in_service') return 'sent_to_service'
  if (from === 'sold') return 'sale_returned' // sold -> in_stock | damaged
  if (from === 'in_service' && to === 'in_stock') return 'returned_from_service'
  if (to === 'damaged') return 'marked_damaged'
  return 'status_changed'
}

/** Raised when a unit is not in a status that allows the requested change. Shown to the user as-is. */
export class UnitTransitionError extends FieldErrors {
  constructor(
    public serial: string,
    public from: UnitStatus,
    public to: UnitStatus,
  ) {
    const msg = `Unit ${serial} is ${STATUS_LABEL[from].toLowerCase()} and cannot be changed to ${STATUS_LABEL[to].toLowerCase()}.`
    super({ units: msg }, msg)
    this.name = 'UnitTransitionError'
  }
}

type Tx = Pick<Db, 'select' | 'update' | 'insert'>

export type TransitionInput = {
  companyId: string
  userId: string | null
  /** Identify the unit by id or by serial (exact, case-sensitive). */
  unitId?: string
  serial?: string
  to: UnitStatus
  /** Only allow the change from these statuses (narrower than TRANSITIONS), e.g. purchase returns accept in_stock only. */
  allowedFrom?: readonly UnitStatus[]
  /** (Task 14) The unit must currently be located in this branch (checked under the unit lock). */
  branchId?: string
  /** (Task 14) Move the unit to this branch with the status change (e.g. back in stock at the branch that took it in). */
  moveTo?: string
  ref?: { table: string; id: string } | null
  price?: string | null
  note?: string | null
  eventType?: UnitEventType
  meta?: Record<string, unknown> | null
}

export type TransitionResult = { unit: typeof schema.productUnits.$inferSelect; from: UnitStatus; eventId: string }

/**
 * Change one unit's status inside the caller's transaction:
 *  1. find the unit (company-scoped; another company's unit is "not found"),
 *  2. take the product row FOR SHARE (the trackSerial guard in catalog/products.ts relies on it),
 *  3. lock the unit FOR UPDATE and re-read its status,
 *  4. validate against TRANSITIONS (+ allowedFrom), update, append the unit_events row.
 * Lock order product -> unit matches purchase creation, so concurrent callers cannot deadlock on these two.
 */
export async function transitionUnit(tx: Tx, p: TransitionInput): Promise<TransitionResult> {
  const u = schema.productUnits
  if (!p.unitId && !p.serial) throw new Error('transitionUnit needs unitId or serial')
  const key = p.unitId ? eq(u.id, p.unitId) : eq(u.serialNo, p.serial as string)
  const [found] = await tx.select({ id: u.id, productId: u.productId }).from(u).where(and(eq(u.companyId, p.companyId), key))
  if (!found) throw new NotFoundError('Unit')

  await tx
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(eq(schema.products.id, found.productId), eq(schema.products.companyId, p.companyId)))
    .for('share')
  const [unit] = await tx.select().from(u).where(and(eq(u.id, found.id), eq(u.companyId, p.companyId))).for('update')
  if (!unit) throw new NotFoundError('Unit')

  const from = unit.status as UnitStatus
  if (!canTransition(from, p.to) || (p.allowedFrom && !p.allowedFrom.includes(from))) throw new UnitTransitionError(unit.serialNo, from, p.to)
  if (p.branchId && unit.branchId !== p.branchId) {
    const msg = `Unit ${unit.serialNo} is in another branch: it can only be changed from the branch it is in.`
    throw new FieldErrors({ units: msg }, msg)
  }

  const [updated] = await tx.update(u).set({ status: p.to, updatedAt: new Date(), ...(p.to === 'in_stock' ? IN_STOCK_RESET : {}), ...(p.moveTo ? { branchId: p.moveTo } : {}) }).where(and(eq(u.id, unit.id), eq(u.companyId, p.companyId))).returning()
  const [ev] = await tx
    .insert(schema.unitEvents)
    .values({
      companyId: p.companyId,
      unitId: unit.id,
      type: p.eventType ?? eventTypeFor(from, p.to),
      fromStatus: from,
      toStatus: p.to,
      refTable: p.ref?.table ?? null,
      refId: p.ref?.id ?? null,
      actorUserId: p.userId,
      price: p.price ?? null,
      note: p.note ?? null,
      meta: p.moveTo && p.moveTo !== unit.branchId ? { ...(p.meta ?? {}), fromBranchId: unit.branchId, toBranchId: p.moveTo } : (p.meta ?? null),
    })
    .returning({ id: schema.unitEvents.id })
  return { unit: updated, from, eventId: ev.id }
}

// ---------------------------------------------------------------- batched helpers (Task 7: sales / customer returns)

export type LockedUnit = typeof schema.productUnits.$inferSelect

/**
 * Lock several units FOR UPDATE in id order (deadlock-safe) and return them, company-scoped. Ids of another company
 * (or unknown ids) are simply missing from the result; the caller compares lengths.
 * CONTRACT: the caller must already hold the units' product rows (FOR SHARE or FOR UPDATE, sorted by id), so the lock
 * order is always product -> document number -> units, the same as transitionUnit().
 */
export async function lockUnitsForUpdate(tx: Pick<Db, 'select'>, companyId: string, unitIds: readonly string[]): Promise<LockedUnit[]> {
  const ids = [...new Set(unitIds)].sort()
  if (!ids.length) return []
  const u = schema.productUnits
  return tx.select().from(u).where(and(eq(u.companyId, companyId), inArray(u.id, ids))).orderBy(asc(u.id)).for('update')
}

export type BatchTransitionItem = {
  unit: LockedUnit
  ref?: { table: string; id: string } | null
  price?: string | null
  note?: string | null
  meta?: Record<string, unknown> | null
}

/**
 * Move several ALREADY LOCKED units (lockUnitsForUpdate) to `to`: validates every unit against TRANSITIONS (+ allowedFrom)
 * first, then runs ONE update (with optional extra column values `set`, identical for all units; SQL expressions allowed)
 * and ONE batched insert of unit_events (one row per unit). Throws UnitTransitionError for the first unit that may not
 * change, before writing anything. Returns the event ids in item order.
 */
export async function transitionLockedUnits(
  tx: Pick<Db, 'update' | 'insert'>,
  p: {
    companyId: string
    userId: string | null
    to: UnitStatus
    allowedFrom?: readonly UnitStatus[]
    eventType?: UnitEventType
    set?: Partial<Record<'soldAt' | 'warrantyStart' | 'warrantyEnd' | 'saleItemId' | 'branchId', unknown>>
    items: BatchTransitionItem[]
  },
): Promise<string[]> {
  if (!p.items.length) return []
  for (const it of p.items) {
    if (it.unit.companyId !== p.companyId) throw new NotFoundError('Unit')
    const from = it.unit.status as UnitStatus
    if (!canTransition(from, p.to) || (p.allowedFrom && !p.allowedFrom.includes(from))) throw new UnitTransitionError(it.unit.serialNo, from, p.to)
  }
  const u = schema.productUnits
  const ids = p.items.map((it) => it.unit.id)
  // Defence in depth: the UPDATE also requires an allowed current status, and must touch every unit.
  const fromStatuses = [...new Set(p.allowedFrom ?? p.items.map((it) => it.unit.status as UnitStatus))]
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000)
    const done = await tx
      .update(u)
      .set({ status: p.to, updatedAt: new Date(), ...(p.to === 'in_stock' ? IN_STOCK_RESET : {}), ...(p.set as object) })
      .where(and(eq(u.companyId, p.companyId), inArray(u.id, part), inArray(u.status, fromStatuses)))
      .returning({ id: u.id })
    if (done.length !== part.length) throw new Error(`transitionLockedUnits: expected ${part.length} units to change, changed ${done.length} (units must be locked first)`)
  }
  const rows = p.items.map((it) => ({
    companyId: p.companyId,
    unitId: it.unit.id,
    type: p.eventType ?? eventTypeFor(it.unit.status as UnitStatus, p.to),
    fromStatus: it.unit.status,
    toStatus: p.to,
    refTable: it.ref?.table ?? null,
    refId: it.ref?.id ?? null,
    actorUserId: p.userId,
    price: it.price ?? null,
    note: it.note ?? null,
    meta: it.meta ?? null,
  }))
  const out: string[] = []
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await tx.insert(schema.unitEvents).values(rows.slice(i, i + 500)).returning({ id: schema.unitEvents.id })
    out.push(...ins.map((r) => r.id))
  }
  return out
}

/**
 * (Task 14) Move ALREADY LOCKED in-stock units (lockUnitsForUpdate) from one branch to another. Not a status change:
 * status stays 'in_stock' (only in_stock units may move), and each unit gets one append-only unit_events row of type
 * 'transferred' (from/to status in_stock) with meta { fromBranchId, toBranchId, transferNo }. Validates every unit before
 * writing; the UPDATE re-checks status and branch and must touch every unit (defence in depth).
 */
export async function relocateLockedUnits(
  tx: Pick<Db, 'update' | 'insert'>,
  p: { companyId: string; userId: string | null; fromBranchId: string; toBranchId: string; ref?: { table: string; id: string }; meta?: Record<string, unknown>; items: { unit: LockedUnit; refId?: string }[] },
): Promise<void> {
  if (!p.items.length) return
  for (const it of p.items) {
    if (it.unit.companyId !== p.companyId) throw new NotFoundError('Unit')
    if (it.unit.status !== 'in_stock') {
      const msg = `Unit ${it.unit.serialNo} is ${STATUS_LABEL[it.unit.status as UnitStatus].toLowerCase()}: only units in stock can be transferred.`
      throw new FieldErrors({ units: msg }, msg)
    }
    if (it.unit.branchId !== p.fromBranchId) {
      const msg = `Unit ${it.unit.serialNo} is not in the source branch.`
      throw new FieldErrors({ units: msg }, msg)
    }
  }
  const u = schema.productUnits
  const ids = p.items.map((it) => it.unit.id)
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000)
    const done = await tx
      .update(u)
      .set({ branchId: p.toBranchId, updatedAt: new Date() })
      .where(and(eq(u.companyId, p.companyId), inArray(u.id, part), eq(u.status, 'in_stock'), eq(u.branchId, p.fromBranchId)))
      .returning({ id: u.id })
    if (done.length !== part.length) throw new Error(`relocateLockedUnits: expected ${part.length} units to move, moved ${done.length} (units must be locked first)`)
  }
  const rows = p.items.map((it) => ({
    companyId: p.companyId,
    unitId: it.unit.id,
    type: 'transferred' as const,
    fromStatus: 'in_stock' as const,
    toStatus: 'in_stock' as const,
    refTable: p.ref?.table ?? null,
    refId: it.refId ?? p.ref?.id ?? null,
    actorUserId: p.userId,
    meta: { ...(p.meta ?? {}), fromBranchId: p.fromBranchId, toBranchId: p.toBranchId },
  }))
  for (let i = 0; i < rows.length; i += 500) await tx.insert(schema.unitEvents).values(rows.slice(i, i + 500))
}
