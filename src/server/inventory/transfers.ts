/**
 * Inter-branch stock transfers (Task 14). IMMEDIATE: one transaction moves the goods; there is no pending / in-transit
 * state (documented limitation).
 *  - serial units: product_units.branch_id from -> to via relocateLockedUnits (status stays in_stock; only in_stock units
 *    may move) + one 'transferred' unit_event per unit;
 *  - quantity products: paired stock_movements of type 'transfer' (-qty at the source, +qty at the destination); the
 *    source on-hand is checked under the product FOR UPDATE lock, so it can never go below zero.
 *
 * Who: products.edit; a user WITHOUT branches.all may only SEND stock out of its own branch (source = its branch,
 * destination = any active branch); pulling stock in from another branch needs branches.all. The caller passes
 * `restrict` (BranchScope.restrict) and the rule is enforced here. Errors shown to a restricted user never reveal another
 * branch's quantities or unit statuses.
 *
 * Lock order (same as sales / purchases / adjustments, so nothing deadlocks):
 *   both branch rows FOR SHARE (id order) -> products (id order; FOR SHARE serial, FOR UPDATE quantity) -> doc number ->
 *   units FOR UPDATE (id order).
 * Numbers: nextDocNumber kind 'transfer' (TRF-00001), one company-wide sequence.
 */
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { logActivity } from '../audit'
import { type BranchFilter } from '../branch'
import { appTimezone, localDate, addDays } from '../dates'
import { schema, type Db } from '../db'
import { nextDocNumber } from '../docnumbers'
import { FieldErrors, NotFoundError, PolicyError, isUniqueViolation, zodPathErrors } from '../errors'
import { likePattern } from '../pagination'
import { formatSerialList, normalizeSerial, serialProblem } from '../purchases/serialInput'
import { onHandQty } from '../sales/sales'
import { STATUS_LABEL, lockUnitsForUpdate, relocateLockedUnits, type UnitStatus } from '../serials'
import { optionalText } from '../validation'
import { dateField } from '../purchases/schemas'

const NO_UQ = 'stock_transfers_company_no_uq'
const KEY_UQ = 'stock_transfers_company_idempotency_uq'
export const MAX_TRANSFER_SERIALS = 2000
export const MAX_TRANSFER_LINES = 200

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Reader = Pick<Db, 'select'>

export const transferSchema = z
  .object({
    fromBranchId: z.uuid('Choose the branch the goods leave from'),
    toBranchId: z.uuid('Choose the branch the goods go to'),
    date: dateField,
    note: optionalText(500),
    /** Serial units by serial number (scanned / typed, one per line or comma separated). */
    serials: z.array(z.string().max(256)).max(MAX_TRANSFER_SERIALS, `At most ${MAX_TRANSFER_SERIALS} serials per transfer`).default([]),
    lines: z
      .array(z.object({ productId: z.uuid('Choose a product'), qty: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(1_000_000) }))
      .max(MAX_TRANSFER_LINES)
      .default([]),
    idempotencyKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid request key')
      .nullish()
      .transform((v) => v || null),
  })
  .refine((d) => d.fromBranchId !== d.toBranchId, { message: 'Choose two different branches', path: ['toBranchId'] })

export type TransferInput = z.input<typeof transferSchema>
export type CreatedTransfer = { id: string; transferNo: string; units: number; qty: number; duplicate: boolean }

/** sha256 of the canonical request: branches, serials (sorted) and lines (sorted); date and note are not part of it. */
export function transferRequestHash(d: { fromBranchId: string; toBranchId: string; lines: { productId: string; qty: number }[] }, serials: readonly string[]): string {
  const lines = d.lines.map((l) => [l.productId, l.qty] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
  return createHash('sha256').update(JSON.stringify({ f: d.fromBranchId, t: d.toBranchId, s: [...serials].sort(), l: lines })).digest('hex')
}

const KEY_USED = 'This form was already used for another transfer. Reload the page and try again.'

/**
 * Resolve an idempotency key: null when unused; the first transfer when the same payload was saved with it; a friendly
 * error otherwise. A key used by a transfer the caller may not see (restricted user, other branches) is a plain conflict.
 */
async function byKey(db: Reader, companyId: string, key: string, hash: string, restrict: BranchFilter): Promise<CreatedTransfer | null> {
  const t = schema.stockTransfers
  const [row] = await db.select({ id: t.id, no: t.transferNo, hash: t.idempotencyHash, from: t.fromBranchId, to: t.toBranchId }).from(t).where(and(eq(t.companyId, companyId), eq(t.idempotencyKey, key)))
  if (!row) return null
  if (restrict && row.from !== restrict && row.to !== restrict) throw new FieldErrors({ _: KEY_USED }, KEY_USED)
  // A transfer saved before migration 0016 has no payload hash: it cannot be proven identical, so it is never replayed as a
  // duplicate; the user is told the form was already saved (nothing new is written).
  if (row.hash === null || row.hash !== hash) {
    const msg = `This form was already saved as ${row.no}; reload the page to start a new transfer.`
    throw new FieldErrors({ _: msg }, msg)
  }
  const items = await db.select({ unitId: schema.stockTransferItems.unitId, qty: schema.stockTransferItems.qty }).from(schema.stockTransferItems).where(and(eq(schema.stockTransferItems.companyId, companyId), eq(schema.stockTransferItems.transferId, row.id)))
  return { id: row.id, transferNo: row.no, units: items.filter((i) => i.unitId).length, qty: items.filter((i) => !i.unitId).reduce((a, i) => a + i.qty, 0), duplicate: true }
}

/**
 * Move stock between two ACTIVE branches of the company in one transaction. `ctx.restrict` (a restricted user's branch)
 * must be the source (send only). A double submit with the same idempotencyKey and payload returns the first transfer.
 */
export async function createStockTransfer(db: Db, companyId: string, userId: string, input: unknown, ctx: { restrict: BranchFilter }, now: Date = new Date()): Promise<CreatedTransfer> {
  const r = transferSchema.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  const d = r.data
  // Restricted users only send stock OUT of their own branch; pulling stock in needs branches.all.
  if (ctx.restrict && ctx.restrict !== d.fromBranchId) throw new PolicyError('You can only transfer stock out of your own branch.')
  const latest = addDays(localDate(appTimezone(), now), 1)
  if (d.date > latest) throw new FieldErrors({ date: `Date cannot be later than ${latest}.` })

  // ---- serials: normalise + validate (pure) ----
  const serials: string[] = []
  const seen = new Set<string>()
  const dups: string[] = []
  const bad: string[] = []
  for (const raw of d.serials.flatMap((x) => x.split(/[\s,;]+/))) {
    const s = normalizeSerial(raw)
    if (!s) continue
    if (serialProblem(s)) bad.push(s)
    else if (seen.has(s)) dups.push(s)
    else {
      seen.add(s)
      serials.push(s)
    }
  }
  if (bad.length) throw new FieldErrors({ serials: `Invalid serials: ${formatSerialList(bad)}` })
  if (dups.length) throw new FieldErrors({ serials: `Entered more than once: ${formatSerialList(dups)}` })
  const lineIds = d.lines.map((l) => l.productId)
  if (new Set(lineIds).size !== lineIds.length) throw new FieldErrors({ lines: 'A product appears twice: put the whole quantity on one line.' })
  if (!serials.length && !d.lines.length) throw new FieldErrors({ serials: 'Add at least one serial or one quantity line.' }, 'Nothing to transfer.')
  if (serials.length > MAX_TRANSFER_SERIALS) throw new FieldErrors({ serials: `At most ${MAX_TRANSFER_SERIALS} serials per transfer.` })

  const hash = transferRequestHash(d, serials)
  if (d.idempotencyKey) {
    const prior = await byKey(db, companyId, d.idempotencyKey, hash, ctx.restrict)
    if (prior) return prior
  }
  try {
    return await db.transaction((tx) => transferTx(tx, companyId, userId, d, serials, hash, ctx.restrict))
  } catch (e) {
    if (d.idempotencyKey && isUniqueViolation(e, KEY_UQ)) {
      const prior = await byKey(db, companyId, d.idempotencyKey, hash, ctx.restrict)
      if (prior) return prior
    }
    if (isUniqueViolation(e, NO_UQ)) throw new FieldErrors({ _: 'Could not allocate a transfer number. Please try again.' }, 'Could not allocate a transfer number. Please try again.')
    throw e
  }
}

async function transferTx(tx: Tx, companyId: string, userId: string, d: z.output<typeof transferSchema>, serials: string[], hash: string, restrict: BranchFilter): Promise<CreatedTransfer> {
  // Defence in depth for the shortage/serial messages below (they name the source branch): restricted = own branch only.
  if (restrict && restrict !== d.fromBranchId) throw new PolicyError('You can only transfer stock out of your own branch.')
  // 1. both branches, FOR SHARE in id order (a concurrent deactivation waits; a deactivated branch is refused)
  const b = schema.branches
  const branchRows = await tx
    .select({ id: b.id, name: b.name, active: b.active })
    .from(b)
    .where(and(eq(b.companyId, companyId), inArray(b.id, [d.fromBranchId, d.toBranchId])))
    .orderBy(asc(b.id))
    .for('share')
  const from = branchRows.find((x) => x.id === d.fromBranchId)
  const to = branchRows.find((x) => x.id === d.toBranchId)
  if (!from || !from.active) throw new FieldErrors({ fromBranchId: 'Branch not found' })
  if (!to || !to.active) throw new FieldErrors({ toBranchId: 'Branch not found' })

  // 2. serial pre-lookup (unlocked; the locked re-check below is authoritative)
  const u = schema.productUnits
  const found = new Map<string, { id: string; productId: string }>()
  for (let i = 0; i < serials.length; i += 1000) {
    const rows = await tx.select({ id: u.id, serialNo: u.serialNo, productId: u.productId }).from(u).where(and(eq(u.companyId, companyId), inArray(u.serialNo, serials.slice(i, i + 1000))))
    for (const r of rows) found.set(r.serialNo, { id: r.id, productId: r.productId })
  }
  const unknown = serials.filter((s) => !found.has(s))
  if (unknown.length) throw new FieldErrors({ serials: `Unknown serials (not in your records): ${formatSerialList(unknown)}` }, `Unknown serials: ${formatSerialList(unknown)}`)

  // 3. products in id order: FOR SHARE (serial), FOR UPDATE (quantity: serialises with sales / adjustments of it)
  const plainIds = new Set(d.lines.map((l) => l.productId))
  const productIds = [...new Set([...plainIds, ...[...found.values()].map((x) => x.productId)])].sort()
  const prods = new Map<string, { id: string; name: string; trackSerial: boolean }>()
  for (const id of productIds) {
    const [row] = await tx
      .select({ id: schema.products.id, name: schema.products.name, trackSerial: schema.products.trackSerial })
      .from(schema.products)
      .where(and(eq(schema.products.id, id), eq(schema.products.companyId, companyId)))
      .for(plainIds.has(id) ? 'update' : 'share')
    if (row) prods.set(id, row)
  }
  const lineErrs: Record<string, string> = {}
  d.lines.forEach((l, i) => {
    const p = prods.get(l.productId)
    if (!p) lineErrs[`lines.${i}.productId`] = 'Product not found'
    else if (p.trackSerial) lineErrs[`lines.${i}.productId`] = `${p.name} is serial-tracked: scan its serials instead.`
  })
  if (Object.keys(lineErrs).length) throw new FieldErrors(lineErrs, Object.values(lineErrs)[0])

  // 4. document number
  const transferNo = await nextDocNumber(tx, companyId, 'transfer')

  // 5. units FOR UPDATE (id order) and re-check under the lock: in the source branch (checked FIRST, so nothing is said
  //    about a unit of another branch) AND in stock
  const locked = await lockUnitsForUpdate(tx, companyId, [...found.values()].map((x) => x.id))
  const byId = new Map(locked.map((x) => [x.id, x]))
  const problems: string[] = []
  for (const s of serials) {
    const unit = byId.get(found.get(s)!.id)
    if (!unit) problems.push(`${s} was not found`)
    else if (unit.branchId !== from.id) problems.push(`${s} is not in ${from.name}`)
    else if (unit.status !== 'in_stock') problems.push(`${s} is ${STATUS_LABEL[unit.status as UnitStatus].toLowerCase()}`)
  }
  if (problems.length) {
    const msg = `Only units in stock at ${from.name} can be transferred: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}.`
    throw new FieldErrors({ serials: msg }, msg)
  }

  // 6. quantity: source on-hand under the product lock
  const onHand = await onHandQty(tx, companyId, from.id, [...plainIds])
  d.lines.forEach((l, i) => {
    const have = onHand.get(l.productId) ?? 0
    if (l.qty > have)
      // The source is always the actor's own branch when restricted (checked above), so the counts never describe a branch it cannot see.
      lineErrs[`lines.${i}.qty`] = have <= 0 ? `${prods.get(l.productId)!.name} is out of stock at ${from.name}.` : `Only ${have} of ${prods.get(l.productId)!.name} at ${from.name}.`
  })
  if (Object.keys(lineErrs).length) throw new FieldErrors(lineErrs, Object.values(lineErrs)[0])

  // 7. write
  const id = randomUUID()
  await tx.insert(schema.stockTransfers).values({ id, companyId, transferNo, fromBranchId: from.id, toBranchId: to.id, date: d.date, note: d.note, idempotencyKey: d.idempotencyKey, idempotencyHash: d.idempotencyKey ? hash : null, createdBy: userId })
  const unitItems = serials.map((s) => {
    const unit = byId.get(found.get(s)!.id)!
    return { id: randomUUID(), companyId, transferId: id, productId: unit.productId, unitId: unit.id, qty: 1 }
  })
  const lineItems = d.lines.map((l) => ({ id: randomUUID(), companyId, transferId: id, productId: l.productId, unitId: null, qty: l.qty }))
  const all = [...unitItems, ...lineItems]
  for (let i = 0; i < all.length; i += 500) await tx.insert(schema.stockTransferItems).values(all.slice(i, i + 500))
  await relocateLockedUnits(tx, {
    companyId,
    userId,
    fromBranchId: from.id,
    toBranchId: to.id,
    ref: { table: 'stock_transfer_items', id },
    meta: { transferNo, transferId: id },
    items: unitItems.map((it) => ({ unit: byId.get(it.unitId as string)!, refId: it.id })),
  })
  const moves = lineItems.flatMap((it) => [
    { companyId, branchId: from.id, productId: it.productId, type: 'transfer' as const, qtyChange: -it.qty, refTable: 'stock_transfer_items', refId: it.id, note: `${transferNo} to ${to.name}`, createdBy: userId },
    { companyId, branchId: to.id, productId: it.productId, type: 'transfer' as const, qtyChange: it.qty, refTable: 'stock_transfer_items', refId: it.id, note: `${transferNo} from ${from.name}`, createdBy: userId },
  ])
  for (let i = 0; i < moves.length; i += 500) await tx.insert(schema.stockMovements).values(moves.slice(i, i + 500))
  const qty = lineItems.reduce((a, x) => a + x.qty, 0)
  await logActivity(
    { companyId, userId, action: 'stock.transfer', entity: 'stock_transfer', entityId: id, after: { transferNo, from: from.name, fromBranchId: from.id, to: to.name, toBranchId: to.id, date: d.date, units: serials, lines: lineItems.map((x) => ({ productId: x.productId, product: prods.get(x.productId)?.name, qty: x.qty })) } },
    tx,
  )
  return { id, transferNo, units: unitItems.length, qty, duplicate: false }
}

// ------------------------------------------------------------------ reads

export type TransferFilter = { q?: string; from?: string; to?: string; limit: number; offset: number }

/** Transfers touching `branch` (as source or destination; null = all), newest first. */
export async function listStockTransfers(db: Reader, companyId: string, branch: BranchFilter, f: TransferFilter) {
  const t = schema.stockTransfers
  const where: SQL | undefined = and(
    eq(t.companyId, companyId),
    branch ? or(eq(t.fromBranchId, branch), eq(t.toBranchId, branch)) : undefined,
    f.q ? or(sql`${t.transferNo} ilike ${likePattern(f.q)}`, sql`${t.note} ilike ${likePattern(f.q)}`) : undefined,
    f.from ? sql`${t.date} >= ${f.from}` : undefined,
    f.to ? sql`${t.date} <= ${f.to}` : undefined,
  )
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: t.id,
        transferNo: t.transferNo,
        date: t.date,
        note: t.note,
        fromBranchId: t.fromBranchId,
        toBranchId: t.toBranchId,
        fromName: sql<string>`(select name from ${schema.branches} x where x.id = ${t.fromBranchId} and x.company_id = ${companyId})`,
        toName: sql<string>`(select name from ${schema.branches} x where x.id = ${t.toBranchId} and x.company_id = ${companyId})`,
        units: sql<number>`(select count(*)::int from ${schema.stockTransferItems} i where i.transfer_id = ${t.id} and i.unit_id is not null)`,
        qty: sql<number>`(select coalesce(sum(i.qty), 0)::int from ${schema.stockTransferItems} i where i.transfer_id = ${t.id} and i.unit_id is null)`,
        createdByName: schema.users.name,
        createdAt: t.createdAt,
      })
      .from(t)
      .leftJoin(schema.users, and(eq(schema.users.id, t.createdBy), eq(schema.users.companyId, companyId)))
      .where(where)
      .orderBy(desc(t.date), desc(t.createdAt), desc(t.id))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(t).where(where),
  ])
  return { rows: rows.map((r) => ({ ...r, units: Number(r.units), qty: Number(r.qty) })), total: Number(n) }
}

/** One transfer with its lines. `restrict` (a restricted user's branch) must be its source or destination, else NotFound. */
export async function getStockTransfer(db: Reader, companyId: string, restrict: BranchFilter, id: string) {
  const t = schema.stockTransfers
  const [head] = await db
    .select({
      transfer: t,
      fromName: sql<string>`(select name from ${schema.branches} x where x.id = ${t.fromBranchId} and x.company_id = ${companyId})`,
      fromCode: sql<string>`(select code from ${schema.branches} x where x.id = ${t.fromBranchId} and x.company_id = ${companyId})`,
      toName: sql<string>`(select name from ${schema.branches} x where x.id = ${t.toBranchId} and x.company_id = ${companyId})`,
      toCode: sql<string>`(select code from ${schema.branches} x where x.id = ${t.toBranchId} and x.company_id = ${companyId})`,
      createdByName: schema.users.name,
    })
    .from(t)
    .leftJoin(schema.users, and(eq(schema.users.id, t.createdBy), eq(schema.users.companyId, companyId)))
    .where(and(eq(t.id, id), eq(t.companyId, companyId), restrict ? or(eq(t.fromBranchId, restrict), eq(t.toBranchId, restrict)) : undefined))
  if (!head) throw new NotFoundError('Transfer')
  const it = schema.stockTransferItems
  const items = await db
    .select({ id: it.id, productId: it.productId, productName: schema.products.name, sku: schema.products.sku, unitId: it.unitId, serialNo: schema.productUnits.serialNo, qty: it.qty })
    .from(it)
    .innerJoin(schema.products, and(eq(schema.products.id, it.productId), eq(schema.products.companyId, companyId)))
    .leftJoin(schema.productUnits, and(eq(schema.productUnits.id, it.unitId), eq(schema.productUnits.companyId, companyId)))
    .where(and(eq(it.companyId, companyId), eq(it.transferId, id)))
    .orderBy(asc(schema.products.name), asc(schema.productUnits.serialNo))
  return { ...head.transfer, fromName: head.fromName, fromCode: head.fromCode, toName: head.toName, toCode: head.toCode, createdByName: head.createdByName, items }
}
