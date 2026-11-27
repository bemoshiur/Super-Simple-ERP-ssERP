/**
 * Manual stock adjustments and stock-take (count) apply. Functions take (db, companyId, userId, input) with companyId
 * from the session only; every write runs in ONE transaction.
 *
 * Locking (same order as sales / purchases, so nothing can deadlock):
 *  - non-serial: the product row FOR UPDATE (sorted by id when several), then the on-hand check (sum of stock_movements)
 *    and the 'adjustment' movement. A sale of the same product also takes it FOR UPDATE, so "on-hand never below zero"
 *    holds under any interleaving.
 *  - serial: transitionUnit() (product FOR SHARE -> unit FOR UPDATE), in_stock -> damaged only.
 * Branches (Task 14): adjustments apply to the ACTIVE branch only (its on-hand; serial units located there). The branch row is
 * taken FOR SHARE first (resolveWriteBranch), before the product lock.
 * Idempotency: an optional client key per form attempt. A double submit returns the first adjustment (duplicate: true).
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm'
import { logActivity } from '../audit'
import { branchCond, branchLabel, resolveWriteBranch, type BranchFilter, type WriteCtx } from '../branch'
import { schema, type Db } from '../db'
import { FieldErrors, isUniqueViolation, zodPathErrors } from '../errors'
import { writeHistory } from '../history'
import { fromMinor, toMinor } from '../money'
import { normalizeSerial } from '../purchases/serialInput'
import { onHandQty, productAverageCosts } from '../sales/sales'
import { UnitTransitionError, transitionUnit } from '../serials'
import { ADJUST_REASON_LABEL, adjustmentProblem, type AdjustReason } from './pure'
import { adjustmentSchema, applyCountSchema } from './schemas'

const KEY_UQ = 'stock_adjustments_company_idempotency_uq'
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Ctx = WriteCtx

export type AdjustmentResult = { id: string; productId: string; qtyChange: number; onHand: number; duplicate: boolean }

function parseOrFieldErrors<T>(s: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import('zod').ZodError } }, input: unknown): T {
  const r = s.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  return r.data
}

async function byKey(db: Pick<Db, 'select'>, companyId: string, key: string) {
  const [row] = await db.select().from(schema.stockAdjustments).where(and(eq(schema.stockAdjustments.companyId, companyId), eq(schema.stockAdjustments.idempotencyKey, key)))
  return row ?? null
}

async function replay(db: Pick<Db, 'select'>, companyId: string, key: string | null, productId: string): Promise<AdjustmentResult | null> {
  if (!key) return null
  const row = await byKey(db, companyId, key)
  if (!row) return null
  if (row.productId !== productId) throw new FieldErrors({ _: 'This form was already used for another adjustment. Reload the page and try again.' }, 'This form was already used for another adjustment. Reload the page and try again.')
  const onHand = (await onHandQty(db, companyId, row.branchId, [productId])).get(productId) ?? 0
  return { id: row.id, productId, qtyChange: row.qtyChange, onHand, duplicate: true }
}

const movementNote = (reason: AdjustReason, note: string | null) => `${ADJUST_REASON_LABEL[reason]}${note ? `: ${note}` : ''}`

/**
 * Write one non-serial adjustment (row + 'adjustment' movement + history). The caller holds the product FOR UPDATE and
 * passes the on-hand it read under that lock. Valued at the product's average net cost (productAverageCosts).
 */
async function writeQtyAdjustment(
  tx: Tx,
  p: { companyId: string; userId: string; branchId: string; product: { id: string; name: string }; onHand: number; qtyChange: number; reason: AdjustReason; note: string | null; idempotencyKey: string | null },
) {
  const problem = adjustmentProblem({ reason: p.reason, qtyChange: p.qtyChange, onHand: p.onHand, productName: p.product.name })
  if (problem) throw new FieldErrors({ qtyChange: problem }, problem)
  const unitCost = (await productAverageCosts(tx, p.companyId, [p.product.id])).get(p.product.id) ?? '0.00'
  const value = fromMinor(toMinor(unitCost) * p.qtyChange)
  const id = randomUUID()
  await tx.insert(schema.stockAdjustments).values({ id, companyId: p.companyId, branchId: p.branchId, productId: p.product.id, qtyChange: p.qtyChange, reason: p.reason, note: p.note, unitCost, value, idempotencyKey: p.idempotencyKey, createdBy: p.userId })
  await tx.insert(schema.stockMovements).values({ companyId: p.companyId, branchId: p.branchId, productId: p.product.id, type: 'adjustment', qtyChange: p.qtyChange, refTable: 'stock_adjustments', refId: id, note: movementNote(p.reason, p.note), createdBy: p.userId })
  const after = p.onHand + p.qtyChange
  await writeHistory(tx, { companyId: p.companyId, userId: p.userId, entity: 'product', entityId: p.product.id, diff: { onHand: { from: p.onHand, to: after } } })
  return { id, after, unitCost, value }
}

async function lockProductForUpdate(tx: Tx, companyId: string, productId: string) {
  const p = schema.products
  const [row] = await tx.select({ id: p.id, name: p.name, trackSerial: p.trackSerial }).from(p).where(and(eq(p.id, productId), eq(p.companyId, companyId))).for('update')
  return row ?? null
}

/**
 * Adjust stock by hand (products.edit):
 *  - kind 'qty' (non-serial): +/- qty with a reason; a reduction can never take on-hand below zero;
 *  - kind 'unit' (serial): one in-stock unit marked damaged (reason damage) or lost (reason loss; there is no 'lost'
 *    status, so the unit becomes damaged and the event note/meta say "Lost").
 */
export async function adjustStock(db: Db, companyId: string, userId: string, input: unknown, ctx: Ctx): Promise<AdjustmentResult> {
  const d = parseOrFieldErrors(adjustmentSchema, input)
  const key = d.idempotencyKey
  const early = await replay(db, companyId, key, d.productId)
  if (early) return early
  try {
    return await db.transaction(async (tx) => {
      const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
      if (d.kind === 'qty') {
        const product = await lockProductForUpdate(tx, companyId, d.productId)
        if (!product) throw new FieldErrors({ productId: 'Product not found' })
        if (product.trackSerial) throw new FieldErrors({ productId: `${product.name} is serial-tracked: mark individual units as damaged or lost instead.` })
        // A concurrent double submit waited for the product lock above: return the first one.
        const again = await replay(tx, companyId, key, d.productId)
        if (again) return again
        const onHand = (await onHandQty(tx, companyId, branchId, [product.id])).get(product.id) ?? 0
        const w = await writeQtyAdjustment(tx, { companyId, userId, branchId, product, onHand, qtyChange: d.qtyChange, reason: d.reason, note: d.note, idempotencyKey: key })
        await logActivity({ companyId, userId, action: 'stock.adjust', entity: 'stock_adjustment', entityId: w.id, before: { onHand }, after: { productId: product.id, product: product.name, qtyChange: d.qtyChange, reason: d.reason, note: d.note, onHand: w.after, unitCost: w.unitCost, value: w.value } }, tx)
        return { id: w.id, productId: product.id, qtyChange: d.qtyChange, onHand: w.after, duplicate: false }
      }

      // ---- serial unit: damaged / lost ----
      const u = schema.productUnits
      const [found] = await tx
        .select({ id: u.id, productId: u.productId, serialNo: u.serialNo, branchId: u.branchId })
        .from(u)
        .where(and(eq(u.companyId, companyId), d.unitId ? eq(u.id, d.unitId) : eq(u.serialNo, normalizeSerial(d.serial ?? ''))))
      if (!found || found.productId !== d.productId) throw new FieldErrors({ serial: d.serial ? `Serial ${d.serial} is not a unit of this product.` : 'Unit not found' })
      if (found.branchId !== branchId) {
        const b = await branchLabel(tx, companyId, found.branchId)
        const msg = `Serial ${found.serialNo} is in ${b?.name ?? 'another branch'}: it can only be adjusted from that branch.`
        throw new FieldErrors({ serial: msg }, msg)
      }
      const [product] = await tx.select({ id: schema.products.id, name: schema.products.name, trackSerial: schema.products.trackSerial }).from(schema.products).where(and(eq(schema.products.id, d.productId), eq(schema.products.companyId, companyId)))
      if (!product?.trackSerial) throw new FieldErrors({ productId: 'Product not found' })
      const id = randomUUID()
      const label = d.reason === 'loss' ? 'Lost' : 'Damaged'
      const r = await transitionUnit(tx, {
        companyId,
        userId,
        unitId: found.id,
        to: 'damaged',
        allowedFrom: ['in_stock'],
        branchId,
        eventType: 'marked_damaged',
        ref: { table: 'stock_adjustments', id },
        note: d.note ? `${label}: ${d.note}` : label,
        meta: { reason: d.reason, adjustmentId: id },
      })
      const unitCost = r.unit.purchasePrice
      await tx.insert(schema.stockAdjustments).values({ id, companyId, branchId, productId: product.id, unitId: found.id, qtyChange: -1, reason: d.reason, note: d.note, unitCost, value: fromMinor(-toMinor(unitCost)), idempotencyKey: key, createdBy: userId })
      const onHand = await inStockCount(tx, companyId, branchId, product.id)
      await logActivity({ companyId, userId, action: 'stock.adjust_unit', entity: 'stock_adjustment', entityId: id, before: { status: r.from }, after: { productId: product.id, product: product.name, unitId: found.id, serial: found.serialNo, status: 'damaged', reason: d.reason, note: d.note, unitCost } }, tx)
      return { id, productId: product.id, qtyChange: -1, onHand, duplicate: false }
    })
  } catch (e) {
    // Lost a double-submit race (key unique index, or the unit was already moved by the first submit): return the first.
    if (key && (isUniqueViolation(e, KEY_UQ) || e instanceof UnitTransitionError)) {
      const again = await replay(db, companyId, key, d.productId)
      if (again) return again
    }
    if (isUniqueViolation(e, KEY_UQ)) throw new FieldErrors({ _: 'This form was already submitted. Reload the page.' }, 'This form was already submitted. Reload the page.')
    throw e
  }
}

async function inStockCount(db: Pick<Db, 'select'>, companyId: string, branchId: string, productId: string): Promise<number> {
  const u = schema.productUnits
  const rows = await db.select({ id: u.id }).from(u).where(and(eq(u.companyId, companyId), eq(u.branchId, branchId), eq(u.productId, productId), eq(u.status, 'in_stock')))
  return rows.length
}

// ------------------------------------------------------------------ stock-take apply

export type ApplyCountResult = {
  applied: { productId: string; name: string; from: number; to: number; qtyChange: number; adjustmentId: string }[]
  /** onlyUnchanged: lines not applied because stock moved since the count (expected = what the counter saw). */
  skipped: { productId: string; name: string; expected: number; now: number }[]
  duplicate: boolean
}

/**
 * Apply a stock-take for NON-serial products in one transaction: every counted product with counted != on-hand gets a
 * 'count_correction' adjustment of (counted - on-hand). Each line carries the system quantity the counter saw; if stock
 * moved since (a sale, a purchase...), nothing is applied and the user is asked to recount. Serial discrepancies are never
 * changed here (report only).
 */
export async function applyStockCount(db: Db, companyId: string, userId: string, input: unknown, ctx: Ctx): Promise<ApplyCountResult> {
  const d = parseOrFieldErrors(applyCountSchema, input)
  const lines = d.lines.filter((l) => l.counted !== null)
  if (!lines.length) throw new FieldErrors({ lines: 'Enter at least one counted quantity.' }, 'Enter at least one counted quantity.')
  const ids = [...new Set(lines.map((l) => l.productId))].sort()
  if (ids.length !== lines.length) throw new FieldErrors({ lines: 'A product appears twice in this count.' })
  const key = d.idempotencyKey
  const prior = async (r: Pick<Db, 'select'>): Promise<ApplyCountResult | null> => {
    if (!key) return null
    const sa = schema.stockAdjustments
    const rows = await r.select({ id: sa.id, productId: sa.productId, qtyChange: sa.qtyChange }).from(sa).where(and(eq(sa.companyId, companyId), like(sa.idempotencyKey, `${key.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`)))
    if (!rows.length) return null
    return { applied: rows.map((x) => ({ productId: x.productId, name: '', from: 0, to: 0, qtyChange: x.qtyChange, adjustmentId: x.id })), skipped: [], duplicate: true }
  }
  const early = await prior(db)
  if (early) return early
  try {
    return await db.transaction(async (tx) => {
      const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
      const p = schema.products
      const prods = await tx.select({ id: p.id, name: p.name, trackSerial: p.trackSerial }).from(p).where(and(eq(p.companyId, companyId), inArray(p.id, ids))).orderBy(asc(p.id)).for('update')
      if (prods.length !== ids.length) throw new FieldErrors({ lines: 'Some products were not found.' }, 'Some products were not found.')
      const serial = prods.filter((x) => x.trackSerial)
      if (serial.length) throw new FieldErrors({ lines: `Serial products cannot be adjusted by quantity: ${serial.map((x) => x.name).join(', ')}` })
      const again = await prior(tx)
      if (again) return again
      const onHand = await onHandQty(tx, companyId, branchId, ids)
      const byId = new Map(prods.map((x) => [x.id, x]))
      const moved = lines.filter((l) => (onHand.get(l.productId) ?? 0) !== l.system)
      const skipped = d.onlyUnchanged ? moved.map((l) => ({ productId: l.productId, name: byId.get(l.productId)!.name, expected: l.system, now: onHand.get(l.productId) ?? 0 })) : []
      if (moved.length && !d.onlyUnchanged) {
        const msg = `Stock changed since the count for: ${moved.map((l) => `${byId.get(l.productId)!.name} (was ${l.system}, now ${onHand.get(l.productId) ?? 0})`).join('; ')}. Reload the sheet and recount these products.`
        throw new FieldErrors({ lines: msg }, msg)
      }
      const applied: ApplyCountResult['applied'] = []
      for (const l of lines) {
        if (skipped.some((x) => x.productId === l.productId)) continue
        const have = onHand.get(l.productId) ?? 0
        const diff = (l.counted as number) - have
        if (diff === 0) continue
        const product = byId.get(l.productId)!
        const w = await writeQtyAdjustment(tx, { companyId, userId, branchId, product, onHand: have, qtyChange: diff, reason: 'count_correction', note: d.note ?? 'Stock count', idempotencyKey: key ? `${key}:${product.id}` : null })
        applied.push({ productId: product.id, name: product.name, from: have, to: w.after, qtyChange: diff, adjustmentId: w.id })
      }
      await logActivity({ companyId, userId, action: 'stock.count_apply', entity: 'stock_count', entityId: null, after: { branchId, counted: lines.length, adjusted: applied.length, skipped: skipped.map((x) => x.name), note: d.note, changes: applied.map((a) => ({ product: a.name, from: a.from, to: a.to })) } }, tx)
      return { applied, skipped, duplicate: false }
    })
  } catch (e) {
    if (key && isUniqueViolation(e, KEY_UQ)) {
      const again = await prior(db)
      if (again) return again
    }
    throw e
  }
}

// ------------------------------------------------------------------ reads

export type AdjustmentRow = { id: string; createdAt: Date; qtyChange: number; reason: AdjustReason; note: string | null; unitCost: string; value: string; serialNo: string | null; unitId: string | null; byName: string | null }

/** A product's adjustments in a branch (null = all), newest first. Cost fields: caller strips them without profit visibility. */
export async function listAdjustments(db: Pick<Db, 'select'>, companyId: string, branch: BranchFilter, productId: string, limit = 50): Promise<AdjustmentRow[]> {
  const sa = schema.stockAdjustments
  const rows = await db
    .select({ id: sa.id, createdAt: sa.createdAt, qtyChange: sa.qtyChange, reason: sa.reason, note: sa.note, unitCost: sa.unitCost, value: sa.value, serialNo: schema.productUnits.serialNo, unitId: sa.unitId, byName: schema.users.name })
    .from(sa)
    .leftJoin(schema.productUnits, and(eq(schema.productUnits.id, sa.unitId), eq(schema.productUnits.companyId, companyId)))
    .leftJoin(schema.users, and(eq(schema.users.id, sa.createdBy), eq(schema.users.companyId, companyId)))
    .where(and(eq(sa.companyId, companyId), branchCond(sa.branchId, branch), eq(sa.productId, productId)))
    .orderBy(desc(sa.createdAt), desc(sa.id))
    .limit(limit)
  return rows
}
