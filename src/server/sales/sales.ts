/**
 * Sales: scan-first invoices, customer payments / due collection, customer returns and refunds. All functions take
 * (db, companyId, userId, ...) with companyId from the session only, and do every write in ONE transaction.
 *
 * Locking contract (deadlock-safe; same order as purchases and transitionUnit):
 *  1. product rows, sorted by id: FOR SHARE for serial-tracked products, FOR UPDATE for non-serial products being sold.
 *     FOR UPDATE on a non-serial product serialises every sale of that product, so the on-hand check
 *     (sum of stock_movements) and the 'sale' movement cannot interleave: two sales of the last unit -> exactly one wins.
 *     (FOR SHARE would not be enough: two sellers could both read on-hand = 1 and both insert -1.)
 *  2. the document-number row (nextDocNumber),
 *  3. unit rows FOR UPDATE in id order (lockUnitsForUpdate), re-checked under the lock.
 *  Payments / returns first take the sale row FOR UPDATE, then (returns) products FOR SHARE -> doc number -> units.
 *  0. (Task 14) before all of these, the write branch row FOR SHARE (resolveWriteBranch).
 *
 * Branches (Task 14): a sale is written to the ACTIVE branch (ctx.branchId, from the session scope); a serial unit can only
 * be sold from the branch it is in, and non-serial on-hand is per branch. Reads take an explicit BranchFilter.
 */
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lte, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { logActivity } from '../audit'
import { assertPermits, branchCond, branchLabel, resolveWriteBranch, type BranchFilter, type WriteCtx } from '../branch'
import { addDays, appTimezone, localDate } from '../dates'
import { schema, type Db } from '../db'
import { nextDocNumber } from '../docnumbers'
import { FieldErrors, NotFoundError, isUniqueViolation, zodPathErrors } from '../errors'
import { diffFields, writeHistory } from '../history'
import { fromMinor, toMinor } from '../money'
import { likePattern } from '../pagination'
import { formatSerialList, normalizeSerial, serialProblem } from '../purchases/serialInput'
import type { DisplayStatus } from '../purchases/totals'
import { STATUS_LABEL, lockUnitsForUpdate, transitionLockedUnits, type LockedUnit, type UnitStatus } from '../serials'
import { customerPaymentSchema, saleReturnSchema, saleSchema } from './schemas'
import { allocateOldestFirst, averageUnitCost, computeSaleTotals, lineProfit, returnCredit, settleSale } from './totals'

const INVOICE_UQ = 'sales_company_invoice_uq'
const IDEM_UQ = 'sales_company_idempotency_uq'
const RETURN_NO_UQ = 'sale_returns_company_no_uq'
const NUMBER_CLASH = 'Could not allocate a document number (the numbering setting may clash with an existing number). Please try again.'
const INACTIVE_DOCS = ['draft', 'cancelled'] as const
const CHUNK = 500

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Ctx = WriteCtx
type Reader = Pick<Db, 'select'>

const chunks = <T>(arr: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

function parseOrFieldErrors<T>(schemaLike: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import('zod').ZodError } }, input: unknown): T {
  const r = schemaLike.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  return r.data
}

async function assertAccount(tx: Reader, companyId: string, accountId: string, field: string) {
  const [acc] = await tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true)))
  if (!acc) throw new FieldErrors({ [field]: 'Account not found' })
}

/** "Serial X is not in stock: it is sold." / "... it is unknown ..." (status null = no such serial in this company). */
export function notInStockMessage(serial: string, status: UnitStatus | null): string {
  return status === null ? `Serial ${serial} is not in stock: it is unknown (no such serial in your stock records).` : `Serial ${serial} is not in stock: it is ${STATUS_LABEL[status].toLowerCase()}.`
}

/** "Serial X is in <Branch>; transfer it first." for an in-stock unit located in another branch. */
async function otherBranchMessage(db: Reader, companyId: string, serial: string, unitBranch: string | null): Promise<string> {
  const b = await branchLabel(db, companyId, unitBranch)
  return `Serial ${serial} is in ${b ? b.name : 'another branch'}; transfer it to this branch first.`
}

/** Can this session see costs and profit? Owners/managers (reports.view or sales.edit) can; plain sellers cannot. */
export const PROFIT_PERMISSIONS = ['reports.view', 'sales.edit'] as const

/** Sales, payments and returns may be dated at most one day ahead of today in the shop's time zone (APP_TIMEZONE). */
export function assertDateAllowed(date: string, now: Date = new Date()) {
  const latest = addDays(localDate(appTimezone(), now), 1)
  if (date > latest) throw new FieldErrors({ date: `Date cannot be later than ${latest}.` }, `Date cannot be later than ${latest}.`)
}

// ------------------------------------------------------------------ cost

/**
 * Average unit cost per NON-serial product (Task 7 ruling): sum(purchase_items.net_total) / sum(qty) over the product's
 * purchase lines on non-draft/non-cancelled purchases, minus purchase returns (credit and qty), rounded half up to the
 * minor unit; falls back to products.purchase_price when there is no usable purchase history. Values are numeric strings.
 */
export async function productAverageCosts(db: Reader, companyId: string, productIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(productIds)]
  const out = new Map<string, string>()
  if (!ids.length) return out
  const pi = schema.purchaseItems
  const pu = schema.purchases
  const pri = schema.purchaseReturnItems
  const [prods, bought, returned] = [
    await db.select({ id: schema.products.id, fallback: schema.products.purchasePrice }).from(schema.products).where(and(eq(schema.products.companyId, companyId), inArray(schema.products.id, ids))),
    await db
      .select({ productId: pi.productId, net: sql<string>`coalesce(sum(${pi.netTotal}), 0)::text`, qty: sql<string>`coalesce(sum(${pi.qty}), 0)::text` })
      .from(pi)
      .innerJoin(pu, and(eq(pu.id, pi.purchaseId), eq(pu.companyId, companyId)))
      .where(and(eq(pi.companyId, companyId), inArray(pi.productId, ids), notInArray(pu.status, [...INACTIVE_DOCS])))
      .groupBy(pi.productId),
    await db
      .select({ productId: pri.productId, net: sql<string>`coalesce(sum(${pri.creditAmount}), 0)::text`, qty: sql<string>`coalesce(sum(${pri.qty}), 0)::text` })
      .from(pri)
      .where(and(eq(pri.companyId, companyId), inArray(pri.productId, ids)))
      .groupBy(pri.productId),
  ]
  for (const p of prods) {
    const b = bought.find((x) => x.productId === p.id)
    const r = returned.find((x) => x.productId === p.id)
    const net = toMinor(b?.net ?? '0') - toMinor(r?.net ?? '0')
    const qty = Number(b?.qty ?? 0) - Number(r?.qty ?? 0)
    out.set(p.id, fromMinor(averageUnitCost(net, qty, toMinor(p.fallback))))
  }
  return out
}

/** On-hand quantity of NON-serial products: sum(stock_movements.qty_change) in one branch (null = all branches). */
export async function onHandQty(db: Reader, companyId: string, branch: BranchFilter, productIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)]
  const out = new Map<string, number>(ids.map((id) => [id, 0]))
  if (!ids.length) return out
  const m = schema.stockMovements
  const rows = await db
    .select({ productId: m.productId, qty: sql<string>`coalesce(sum(${m.qtyChange}), 0)::text` })
    .from(m)
    .where(and(eq(m.companyId, companyId), branchCond(m.branchId, branch), inArray(m.productId, ids)))
    .groupBy(m.productId)
  for (const r of rows) out.set(r.productId, Number(r.qty))
  return out
}

// ------------------------------------------------------------------ create

export type CreatedSale = { id: string; invoiceNo: string; total: string; paid: string; due: string; duplicate: boolean }

/**
 * sha256 of the canonical request: customer, lines sorted by (serial|productId, qty, price), discount, payments sorted
 * by (account, amount). Amounts are the parsed "1250.50" strings, so formatting differences do not matter.
 */
export function saleRequestHash(d: { customerId: string | null; discount: string; items: { qty: number; unitPrice: string; productId: string | null }[]; payments: { accountId: string; amount: string }[] }, lineSerial: (string | null)[]): string {
  const lines = d.items.map((it, i) => [lineSerial[i] !== null ? `s:${lineSerial[i]}` : `p:${it.productId}`, it.qty, it.unitPrice] as const).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
  const pays = d.payments.map((p) => [p.accountId, p.amount] as const).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
  return createHash('sha256').update(JSON.stringify({ c: d.customerId ?? null, l: lines, d: d.discount, p: pays })).digest('hex')
}

/**
 * Resolve an idempotency key: null when unused; the existing sale (duplicate: true) when it was saved with the same
 * payload; a friendly error when the same key comes with a different payload (a stale form edited after saving).
 */
async function resolveKey(db: Reader, companyId: string, key: string, hash: string): Promise<CreatedSale | null> {
  const sa = schema.sales
  const [row] = await db.select({ id: sa.id, invoiceNo: sa.invoiceNo, total: sa.total, paid: sa.paid, due: sa.due, hash: sa.idempotencyHash }).from(sa).where(and(eq(sa.companyId, companyId), eq(sa.idempotencyKey, key)))
  if (!row) return null
  if (row.hash !== hash) {
    const msg = `This form was already saved as ${row.invoiceNo}; reload the page to start a new sale.`
    throw new FieldErrors({ _: msg }, msg)
  }
  const { hash: _h, ...rest } = row
  void _h
  return { ...rest, duplicate: true }
}

/**
 * Create a completed sale invoice. The server recomputes every amount; `expectedTotal` (what the user saw) must match.
 * Serial lines: the unit is looked up by (company, serial), must be in_stock, is locked FOR UPDATE, moves to 'sold' with a
 * unit_events('sold') row {price = net revenue of the unit, meta: saleId, customerId, invoiceNo, unitPrice}, and gets
 * sold_at / warranty_start (= sale date) / warranty_end (= start + unit warranty months, null when 0 months).
 * Non-serial lines: on-hand check under the product FOR UPDATE lock, then a 'sale' stock movement (-qty).
 * Payments: one payments row (in, ref sale) per payment; sum = paid. A walk-in sale (no customer) must be fully paid.
 * Idempotency: a resubmitted `idempotencyKey` returns the existing invoice (duplicate: true) and writes nothing.
 */
export async function createSale(db: Db, companyId: string, userId: string, input: unknown, ctx: Ctx): Promise<CreatedSale> {
  const d = parseOrFieldErrors(saleSchema, input)
  const t = computeSaleTotals({ items: d.items, discount: d.discount, payments: d.payments.map((p) => p.amount) })
  if (!t.ok) throw new FieldErrors(t.errors)
  const totals = t.totals
  if (d.expectedTotal !== undefined && String(d.expectedTotal).trim() !== '') {
    let expected: number | null
    try {
      expected = toMinor(typeof d.expectedTotal === 'string' ? d.expectedTotal.trim() : d.expectedTotal)
    } catch {
      expected = null
    }
    if (expected !== toMinor(totals.total))
      throw new FieldErrors({ total: `The invoice total is ${totals.total}, not ${String(d.expectedTotal)}. Review the lines and save again.` }, 'The totals you saw do not match the items. Nothing was saved.')
  }
  assertDateAllowed(d.date)
  if (!d.customerId && toMinor(totals.due) > 0)
    throw new FieldErrors({ customerId: 'A walk-in sale must be paid in full. Choose a customer to leave an amount due.' }, 'A walk-in sale must be paid in full. Choose a customer to leave an amount due.')

  // ---- serial lines: normalise + validate (pure) ----
  const lineSerial = d.items.map((it) => (it.serial ? normalizeSerial(it.serial) : null))
  const errs: Record<string, string> = {}
  const seen = new Map<string, number>()
  lineSerial.forEach((s, i) => {
    if (s === null) return
    if (serialProblem(s)) errs[`items.${i}.serial`] = `Invalid serial: ${s.slice(0, 80)}`
    else if (seen.has(s)) errs[`items.${i}.serial`] = `Serial ${s} is already on this invoice (line ${(seen.get(s) as number) + 1}).`
    else seen.set(s, i)
  })
  if (Object.keys(errs).length) throw new FieldErrors(errs)
  const serials = [...seen.keys()]

  const hash = saleRequestHash(d, lineSerial)
  if (d.idempotencyKey) {
    const existing = await resolveKey(db, companyId, d.idempotencyKey, hash)
    if (existing) return existing
  }

  try {
    return await db.transaction((tx) => saleTx(tx, companyId, userId, d, totals, lineSerial, serials, hash, ctx))
  } catch (e) {
    // A resubmit racing the first attempt can fail on the unit lock (unit now sold) or on the key itself: return the
    // winner when the payload matches (resolveKey throws the friendly conflict error when it does not).
    if (d.idempotencyKey && (e instanceof FieldErrors || isUniqueViolation(e, IDEM_UQ))) {
      const existing = await resolveKey(db, companyId, d.idempotencyKey, hash)
      if (existing) return existing
    }
    if (isUniqueViolation(e, INVOICE_UQ)) throw new FieldErrors({ _: NUMBER_CLASH }, NUMBER_CLASH)
    throw e
  }
}

type ParsedSale = ReturnType<typeof saleSchema.parse>
type SaleTotalsOk = Extract<ReturnType<typeof computeSaleTotals>, { ok: true }>['totals']

async function saleTx(tx: Tx, companyId: string, userId: string, d: ParsedSale, totals: SaleTotalsOk, lineSerial: (string | null)[], serials: string[], hash: string, ctx: Ctx): Promise<CreatedSale> {
  const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
  // ---- customer and accounts (company-scoped, active) ----
  let customer: { id: string; name: string } | null = null
  if (d.customerId) {
    const [c] = await tx.select({ id: schema.customers.id, name: schema.customers.name, active: schema.customers.active }).from(schema.customers).where(and(eq(schema.customers.id, d.customerId), eq(schema.customers.companyId, companyId)))
    if (!c) throw new FieldErrors({ customerId: 'Customer not found' })
    if (!c.active) throw new FieldErrors({ customerId: 'This customer is deactivated. Restore it first.' })
    customer = { id: c.id, name: c.name }
  }
  if (d.payments.length) {
    const accIds = [...new Set(d.payments.map((p) => p.accountId))]
    const accs = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true), inArray(schema.accounts.id, accIds)))
    const ok = new Set(accs.map((a) => a.id))
    const accErrs: Record<string, string> = {}
    d.payments.forEach((p, i) => {
      if (!ok.has(p.accountId)) accErrs[`payments.${i}.accountId`] = 'Account not found'
    })
    if (Object.keys(accErrs).length) throw new FieldErrors(accErrs)
  }

  // ---- serial pre-lookup (unlocked; the locked re-check below is authoritative) ----
  const u = schema.productUnits
  const found = new Map<string, { id: string; productId: string; status: UnitStatus; branchId: string | null }>()
  for (const part of chunks(serials, 1000)) {
    const rows = await tx.select({ id: u.id, serialNo: u.serialNo, productId: u.productId, status: u.status, branchId: u.branchId }).from(u).where(and(eq(u.companyId, companyId), inArray(u.serialNo, part)))
    rows.forEach((r) => found.set(r.serialNo, { id: r.id, productId: r.productId, status: r.status as UnitStatus, branchId: r.branchId }))
  }
  const serialErrs: Record<string, string> = {}
  const bad: string[] = []
  for (const [i, s] of lineSerial.entries()) {
    if (s === null) continue
    const f = found.get(s)
    if (!f || f.status !== 'in_stock') {
      serialErrs[`items.${i}.serial`] = notInStockMessage(s, f?.status ?? null)
      bad.push(s)
    } else if (f.branchId !== branchId) {
      serialErrs[`items.${i}.serial`] = await otherBranchMessage(tx, companyId, s, f.branchId)
      bad.push(s)
    }
  }
  if (bad.length) throw new FieldErrors(serialErrs, bad.length === 1 ? (Object.values(serialErrs)[0] as string) : `These serials are not in stock: ${formatSerialList(bad)}`)

  // ---- lock products in id order: FOR SHARE (serial) / FOR UPDATE (non-serial) ----
  const lineProduct = d.items.map((it, i) => (lineSerial[i] !== null ? found.get(lineSerial[i] as string)!.productId : (it.productId as string)))
  const productIds = [...new Set(lineProduct)].sort()
  const p = schema.products
  const pre = await tx.select({ id: p.id, trackSerial: p.trackSerial }).from(p).where(and(eq(p.companyId, companyId), inArray(p.id, productIds)))
  const preMode = new Map(pre.map((r) => [r.id, r.trackSerial]))
  const prods = new Map<string, { id: string; name: string; trackSerial: boolean; active: boolean }>()
  for (const id of productIds) {
    if (!preMode.has(id)) continue
    const [row] = await tx
      .select({ id: p.id, name: p.name, trackSerial: p.trackSerial, active: p.active })
      .from(p)
      .where(and(eq(p.id, id), eq(p.companyId, companyId)))
      .for(preMode.get(id) ? 'share' : 'update')
    if (!row) continue
    if (row.trackSerial !== preMode.get(id)) throw new FieldErrors({ _: 'A product changed while saving. Please try again.' }, 'A product changed while saving. Please try again.')
    prods.set(id, row)
  }
  const lineErrs: Record<string, string> = {}
  d.items.forEach((_, i) => {
    const pr = prods.get(lineProduct[i])
    const key = lineSerial[i] !== null ? `items.${i}.serial` : `items.${i}.productId`
    if (!pr) lineErrs[key] = 'Product not found'
    else if (!pr.active) lineErrs[key] = `${pr.name} is deactivated. Restore it first.`
    else if (lineSerial[i] === null && pr.trackSerial) lineErrs[key] = `${pr.name} is serial-tracked: scan its serial number instead.`
  })
  if (Object.keys(lineErrs).length) throw new FieldErrors(lineErrs)

  // A concurrent resubmit of the same attempt may have committed while we waited for the product locks.
  if (d.idempotencyKey) {
    const existing = await resolveKey(tx, companyId, d.idempotencyKey, hash)
    if (existing) return existing
  }

  const invoiceNo = await nextDocNumber(tx, companyId, 'sale')

  // ---- lock units FOR UPDATE (id order) and re-check: the loser of a double-sell race stops here ----
  const unitIds = serials.map((s) => found.get(s)!.id)
  const locked = await lockUnitsForUpdate(tx, companyId, unitIds)
  const byId = new Map<string, LockedUnit>(locked.map((x) => [x.id, x]))
  const raceErrs: Record<string, string> = {}
  const lost: string[] = []
  lineSerial.forEach((s, i) => {
    if (s === null) return
    const unit = byId.get(found.get(s)!.id)
    if (!unit || unit.status !== 'in_stock' || unit.branchId !== branchId) {
      raceErrs[`items.${i}.serial`] = unit && unit.status === 'in_stock' ? `Serial ${s} was moved to another branch while saving. Please try again.` : notInStockMessage(s, (unit?.status as UnitStatus | undefined) ?? null)
      lost.push(s)
    }
  })
  if (lost.length) throw new FieldErrors(raceErrs, lost.length === 1 ? (Object.values(raceErrs)[0] as string) : `These serials are not in stock: ${formatSerialList(lost)}`)

  // ---- non-serial stock check (under the product FOR UPDATE lock) ----
  const want = new Map<string, number>()
  d.items.forEach((it, i) => {
    if (lineSerial[i] === null) want.set(lineProduct[i], (want.get(lineProduct[i]) ?? 0) + it.qty)
  })
  const onHand = await onHandQty(tx, companyId, branchId, [...want.keys()])
  const stockErrs: Record<string, string> = {}
  d.items.forEach((_, i) => {
    if (lineSerial[i] !== null) return
    const pid = lineProduct[i]
    const have = onHand.get(pid) ?? 0
    if ((want.get(pid) ?? 0) > have) stockErrs[`items.${i}.qty`] = have <= 0 ? `${prods.get(pid)!.name} is out of stock.` : `Only ${have} of ${prods.get(pid)!.name} in stock.`
  })
  if (Object.keys(stockErrs).length) throw new FieldErrors(stockErrs, 'Not enough stock for some items.')
  const avgCost = await productAverageCosts(tx, companyId, [...want.keys()])

  // ---- write ----
  const s = settleSale({ total: totals.total, returned: '0', paid: totals.paid })
  const saleId = randomUUID()
  await tx.insert(schema.sales).values({
    id: saleId,
    companyId,
    branchId,
    invoiceNo,
    customerId: customer?.id ?? null,
    date: d.date,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    paid: totals.paid,
    due: s.due,
    returnedTotal: '0',
    status: s.status,
    note: d.note,
    idempotencyKey: d.idempotencyKey ?? null,
    idempotencyHash: d.idempotencyKey ? hash : null,
    createdBy: userId,
  })
  const itemRows = d.items.map((it, i) => {
    const unit = lineSerial[i] !== null ? byId.get(found.get(lineSerial[i] as string)!.id)! : null
    return {
      id: randomUUID(),
      companyId,
      saleId,
      productId: lineProduct[i],
      qty: it.qty,
      unitPrice: it.unitPrice,
      unitCostSnapshot: unit ? unit.purchasePrice : (avgCost.get(lineProduct[i]) ?? '0.00'),
      unitId: unit?.id ?? null,
      netTotal: totals.netLines[i],
      lineNo: i,
    }
  })
  for (const part of chunks(itemRows)) await tx.insert(schema.saleItems).values(part)

  const sold = itemRows.filter((r) => r.unitId)
  await transitionLockedUnits(tx, {
    companyId,
    userId,
    to: 'sold',
    allowedFrom: ['in_stock'],
    eventType: 'sold',
    set: {
      soldAt: new Date(),
      warrantyStart: d.date,
      warrantyEnd: sql`case when ${u.warrantyMonths} > 0 then (${d.date}::date + make_interval(months => ${u.warrantyMonths}))::date else null end`,
      // Each unit points at the line it is sold on (returns must come through exactly that line).
      saleItemId: sold.length ? sql`case ${u.id} ${sql.join(sold.map((r) => sql`when ${r.unitId}::uuid then ${r.id}::uuid`), sql` `)} end` : null,
    },
    items: sold.map((r) => ({
      unit: byId.get(r.unitId as string)!,
      ref: { table: 'sale_items', id: r.id },
      price: r.netTotal,
      meta: { saleId, invoiceNo, customerId: customer?.id ?? null, unitPrice: r.unitPrice },
    })),
  })
  const moves = itemRows.filter((r) => !r.unitId).map((r) => ({ companyId, branchId, productId: r.productId, type: 'sale' as const, qtyChange: -r.qty, refTable: 'sale_items', refId: r.id, note: invoiceNo, createdBy: userId }))
  for (const part of chunks(moves)) await tx.insert(schema.stockMovements).values(part)

  if (d.payments.length)
    await tx.insert(schema.payments).values(
      d.payments.map((pay) => ({
        companyId,
        branchId,
        direction: 'in' as const,
        accountId: pay.accountId,
        partyType: customer ? ('customer' as const) : null,
        partyId: customer?.id ?? null,
        refType: 'sale' as const,
        refId: saleId,
        amount: pay.amount,
        method: pay.method,
        date: d.date,
        note: `Received with sale ${invoiceNo}`,
        createdBy: userId,
      })),
    )

  await logActivity(
    { companyId, userId, action: 'sale.create', entity: 'sale', entityId: saleId, after: { invoiceNo, customerId: customer?.id ?? null, date: d.date, subtotal: totals.subtotal, discount: totals.discount, total: totals.total, paid: totals.paid, due: s.due, lines: d.items.length, units: sold.length, serials } },
    tx,
  )
  return { id: saleId, invoiceNo, total: totals.total, paid: totals.paid, due: s.due, duplicate: false }
}

// ------------------------------------------------------------------ POS lookups

export type SerialLookup = { unitId: string; serial: string; productId: string; productName: string; sku: string; salePrice: string; warrantyMonths: number; cost?: string }

/** Scan lookup for the POS: the in-stock unit with this exact serial, or a clear reason why it cannot be sold. */
export async function lookupSerialForSale(db: Reader, companyId: string, branchId: string | null, rawSerial: string, opts: { withCost?: boolean } = {}): Promise<{ ok: true; unit: SerialLookup } | { ok: false; error: string }> {
  const serial = normalizeSerial(String(rawSerial ?? ''))
  if (!serial || serialProblem(serial)) return { ok: false, error: 'Scan or type a valid serial / IMEI.' }
  if (!branchId) return { ok: false, error: 'Choose a branch in the top bar first: "All branches" is for viewing only.' }
  const u = schema.productUnits
  const p = schema.products
  const [row] = await db
    .select({ id: u.id, serialNo: u.serialNo, status: u.status, branchId: u.branchId, warrantyMonths: u.warrantyMonths, purchasePrice: u.purchasePrice, productId: p.id, name: p.name, sku: p.sku, salePrice: p.salePrice, active: p.active })
    .from(u)
    .innerJoin(p, and(eq(p.id, u.productId), eq(p.companyId, companyId)))
    .where(and(eq(u.companyId, companyId), eq(u.serialNo, serial)))
  if (!row || row.status !== 'in_stock') return { ok: false, error: notInStockMessage(serial, (row?.status as UnitStatus | undefined) ?? null) }
  if (row.branchId !== branchId) return { ok: false, error: await otherBranchMessage(db, companyId, serial, row.branchId) }
  if (!row.active) return { ok: false, error: `${row.name} is deactivated. Restore it before selling.` }
  return { ok: true, unit: { unitId: row.id, serial: row.serialNo, productId: row.productId, productName: row.name, sku: row.sku, salePrice: row.salePrice, warrantyMonths: row.warrantyMonths, ...(opts.withCost ? { cost: row.purchasePrice } : {}) } }
}

export type SaleProductOption = { value: string; label: string; description?: string; salePrice: string; onHand: number; cost?: string }

/** Non-serial product picker for the POS (serial products are added by scanning): active only, with on-hand qty. */
export async function searchProductsForSale(db: Reader, companyId: string, branch: BranchFilter, q: string, opts: { withCost?: boolean } = {}): Promise<SaleProductOption[]> {
  const p = schema.products
  const term = q.trim().slice(0, 100)
  const rows = await db
    .select({ id: p.id, name: p.name, sku: p.sku, salePrice: p.salePrice })
    .from(p)
    .where(and(eq(p.companyId, companyId), eq(p.active, true), eq(p.trackSerial, false), term ? or(ilike(p.name, likePattern(term)), ilike(p.sku, likePattern(term))) : undefined))
    .orderBy(asc(p.name))
    .limit(20)
  const ids = rows.map((r) => r.id)
  const [onHand, costs] = [await onHandQty(db, companyId, branch, ids), opts.withCost ? await productAverageCosts(db, companyId, ids) : null]
  return rows.map((r) => {
    const n = onHand.get(r.id) ?? 0
    return { value: r.id, label: r.name, description: `${r.sku} · ${n > 0 ? `${n} in stock` : 'out of stock'}`, salePrice: r.salePrice, onHand: n, ...(costs ? { cost: costs.get(r.id) } : {}) }
  })
}

// ------------------------------------------------------------------ reads

export type SaleListFilter = { q?: string; customerId?: string; from?: string; to?: string; dueOnly?: boolean; status?: DisplayStatus; limit: number; offset: number }

/** SQL twin of displayStatus() (purchases/totals.ts) for sales. */
function statusWhere(st: DisplayStatus | undefined): SQL | undefined {
  const sa = schema.sales
  if (st === 'returned') return sql`${sa.returnedTotal} > 0 and ${sa.total} - ${sa.returnedTotal} <= 0`
  const notReturned = sql`not (${sa.returnedTotal} > 0 and ${sa.total} - ${sa.returnedTotal} <= 0)`
  if (st === 'paid') return sql`${notReturned} and ${sa.due} = 0`
  if (st === 'partially_paid') return sql`${sa.due} > 0 and ${sa.paid} > 0`
  if (st === 'unpaid') return sql`${sa.due} > 0 and ${sa.paid} = 0`
  return undefined
}

/** Invoice list (search: invoice no, customer name/phone or a sold serial), with a totals row over the whole filtered set. */
export async function listSales(db: Db, companyId: string, branch: BranchFilter, f: SaleListFilter) {
  const sa = schema.sales
  const c = schema.customers
  const term = f.q ? likePattern(f.q) : null
  const where = and(
    eq(sa.companyId, companyId),
    branchCond(sa.branchId, branch),
    notInArray(sa.status, [...INACTIVE_DOCS]),
    term
      ? or(
          ilike(sa.invoiceNo, term),
          ilike(c.name, term),
          ilike(c.phone, term),
          sql`exists (select 1 from ${schema.saleItems} si join ${schema.productUnits} pu on pu.id = si.unit_id and pu.company_id = ${companyId} where si.sale_id = ${sa.id} and si.company_id = ${companyId} and pu.serial_no ilike ${term})`,
        )
      : undefined,
    f.customerId ? eq(sa.customerId, f.customerId) : undefined,
    f.from ? gte(sa.date, f.from) : undefined,
    f.to ? lte(sa.date, f.to) : undefined,
    f.dueOnly ? gt(sa.due, '0') : undefined,
    statusWhere(f.status),
  )
  const join = and(eq(c.id, sa.customerId), eq(c.companyId, companyId))
  const [rows, [agg]] = await Promise.all([
    db
      .select({ id: sa.id, invoiceNo: sa.invoiceNo, date: sa.date, customerId: sa.customerId, customerName: c.name, total: sa.total, paid: sa.paid, due: sa.due, returnedTotal: sa.returnedTotal, status: sa.status, branchId: sa.branchId, branchName: schema.branches.name })
      .from(sa)
      .leftJoin(c, join)
      .leftJoin(schema.branches, and(eq(schema.branches.id, sa.branchId), eq(schema.branches.companyId, companyId)))
      .where(where)
      .orderBy(desc(sa.date), desc(sa.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db
      .select({
        n: count(),
        total: sql<string>`coalesce(sum(${sa.total}), 0)::text`,
        returned: sql<string>`coalesce(sum(${sa.returnedTotal}), 0)::text`,
        paid: sql<string>`coalesce(sum(${sa.paid}), 0)::text`,
        due: sql<string>`coalesce(sum(${sa.due}), 0)::text`,
      })
      .from(sa)
      .leftJoin(c, join)
      .where(where),
  ])
  return { rows, total: Number(agg.n), sums: { total: fromMinor(toMinor(agg.total)), returned: fromMinor(toMinor(agg.returned)), paid: fromMinor(toMinor(agg.paid)), due: fromMinor(toMinor(agg.due)) } }
}

export type SaleDetail = Awaited<ReturnType<typeof getSale>>

/**
 * Full invoice view (company-scoped: another company's id is NotFound; with `restrict` set, another branch's invoice is
 * NotFound too). Queries run sequentially (safe on a tx too).
 */
export async function getSale(db: Reader, companyId: string, restrict: BranchFilter, id: string) {
  const sa = schema.sales
  const c = schema.customers
  const [head] = await db
    .select({ sale: sa, customerName: c.name, customerPhone: c.phone, customerAddress: c.address, createdByName: schema.users.name, branchName: schema.branches.name, branchCode: schema.branches.code, branchAddress: schema.branches.address, branchPhone: schema.branches.phone })
    .from(sa)
    .leftJoin(c, and(eq(c.id, sa.customerId), eq(c.companyId, companyId)))
    .leftJoin(schema.users, and(eq(schema.users.id, sa.createdBy), eq(schema.users.companyId, companyId)))
    .leftJoin(schema.branches, and(eq(schema.branches.id, sa.branchId), eq(schema.branches.companyId, companyId)))
    .where(and(eq(sa.id, id), eq(sa.companyId, companyId), branchCond(sa.branchId, restrict)))
  if (!head) throw new NotFoundError('Sale')
  const si = schema.saleItems
  const u = schema.productUnits
  const items = await db
    .select({
      id: si.id,
      productId: si.productId,
      productName: schema.products.name,
      sku: schema.products.sku,
      productWarrantyMonths: schema.products.warrantyMonths,
      qty: si.qty,
      unitPrice: si.unitPrice,
      unitCost: si.unitCostSnapshot,
      netTotal: si.netTotal,
      unitId: si.unitId,
      serialNo: u.serialNo,
      unitStatus: u.status,
      warrantyMonths: u.warrantyMonths,
      warrantyStart: u.warrantyStart,
      warrantyEnd: u.warrantyEnd,
    })
    .from(si)
    .innerJoin(schema.products, and(eq(schema.products.id, si.productId), eq(schema.products.companyId, companyId)))
    .leftJoin(u, and(eq(u.id, si.unitId), eq(u.companyId, companyId)))
    .where(and(eq(si.saleId, id), eq(si.companyId, companyId)))
    .orderBy(asc(si.lineNo), asc(si.id))
  const sri = schema.saleReturnItems
  const sr = schema.saleReturns
  const returnedRows = await db
    .select({ saleItemId: sri.saleItemId, qty: sql<string>`coalesce(sum(${sri.qty}), 0)::text`, credit: sql<string>`coalesce(sum(${sri.refundAmount}), 0)::text` })
    .from(sri)
    .innerJoin(sr, and(eq(sr.id, sri.saleReturnId), eq(sr.saleId, id), eq(sr.companyId, companyId)))
    .where(eq(sri.companyId, companyId))
    .groupBy(sri.saleItemId)
  const payments = await db
    .select({ id: schema.payments.id, direction: schema.payments.direction, amount: schema.payments.amount, date: schema.payments.date, method: schema.payments.method, note: schema.payments.note, accountName: schema.accounts.name, createdAt: schema.payments.createdAt })
    .from(schema.payments)
    .innerJoin(schema.accounts, and(eq(schema.accounts.id, schema.payments.accountId), eq(schema.accounts.companyId, companyId)))
    .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.refType, 'sale'), eq(schema.payments.refId, id)))
    .orderBy(asc(schema.payments.date), asc(schema.payments.createdAt))
  const returns = await db.select().from(sr).where(and(eq(sr.companyId, companyId), eq(sr.saleId, id))).orderBy(asc(sr.createdAt))
  const returnItems = await db
    .select({ returnId: sri.saleReturnId, saleItemId: sri.saleItemId, qty: sri.qty, credit: sri.refundAmount, restock: sri.restock, serialNo: u.serialNo, productName: schema.products.name })
    .from(sri)
    .innerJoin(sr, and(eq(sr.id, sri.saleReturnId), eq(sr.companyId, companyId)))
    .innerJoin(schema.products, and(eq(schema.products.id, sri.productId), eq(schema.products.companyId, companyId)))
    .leftJoin(u, and(eq(u.id, sri.unitId), eq(u.companyId, companyId)))
    .where(and(eq(sr.companyId, companyId), eq(sr.saleId, id)))
    .orderBy(asc(u.serialNo))

  const retBy = new Map(returnedRows.map((r) => [r.saleItemId, { qty: Number(r.qty), credit: r.credit }]))
  const full = items.map((it) => {
    const r = retBy.get(it.id)
    return { ...it, lineTotal: fromMinor(toMinor(it.unitPrice) * it.qty), returnedQty: r?.qty ?? 0, returnedCredit: fromMinor(toMinor(r?.credit ?? '0')), profit: fromMinor(lineProfit(it.netTotal, it.qty, it.unitCost)) }
  })
  // Profit after returns: sum(net - qty*cost) over lines, minus (credit - qty*cost) of every returned quantity.
  const costOf = new Map(items.map((it) => [it.id, it.unitCost]))
  const grossProfit = full.reduce((a, it) => a + toMinor(it.profit), 0)
  const returnedProfit = returnItems.reduce((a, r) => a + toMinor(r.credit) - toMinor(costOf.get(r.saleItemId) ?? '0') * r.qty, 0)
  const cost = items.reduce((a, it) => a + toMinor(it.unitCost) * it.qty, 0)
  return {
    ...head.sale,
    customerName: head.customerName,
    customerPhone: head.customerPhone,
    customerAddress: head.customerAddress,
    createdByName: head.createdByName,
    branchName: head.branchName,
    branchCode: head.branchCode,
    branchAddress: head.branchAddress,
    branchPhone: head.branchPhone,
    items: full,
    payments,
    returns: returns.map((r) => ({ ...r, items: returnItems.filter((x) => x.returnId === r.id) })),
    cost: fromMinor(cost),
    profit: fromMinor(grossProfit - returnedProfit),
  }
}

export type SaleReturnFilter = { q?: string; from?: string; to?: string; limit: number; offset: number }

/** Customer returns list (search: return no, invoice no, customer). */
export async function listSaleReturns(db: Db, companyId: string, branch: BranchFilter, f: SaleReturnFilter) {
  const sr = schema.saleReturns
  const sa = schema.sales
  const c = schema.customers
  const term = f.q ? likePattern(f.q) : null
  const where = and(eq(sr.companyId, companyId), branchCond(sr.branchId, branch), term ? or(ilike(sr.returnNo, term), ilike(sa.invoiceNo, term), ilike(c.name, term)) : undefined, f.from ? gte(sr.date, f.from) : undefined, f.to ? lte(sr.date, f.to) : undefined)
  const base = () =>
    db
      .select({
        id: sr.id,
        returnNo: sr.returnNo,
        date: sr.date,
        saleId: sa.id,
        invoiceNo: sa.invoiceNo,
        customerId: sr.customerId,
        customerName: c.name,
        creditTotal: sr.creditTotal,
        refundTotal: sr.refundTotal,
        units: sql<number>`(select coalesce(sum(qty), 0)::int from ${schema.saleReturnItems} x where x.sale_return_id = ${sr.id})`,
        note: sr.note,
      })
      .from(sr)
      .innerJoin(sa, and(eq(sa.id, sr.saleId), eq(sa.companyId, companyId)))
      .leftJoin(c, and(eq(c.id, sr.customerId), eq(c.companyId, companyId)))
  const [rows, [agg]] = await Promise.all([
    base().where(where).orderBy(desc(sr.date), desc(sr.createdAt)).limit(f.limit).offset(f.offset),
    db
      .select({ n: count(), credit: sql<string>`coalesce(sum(${sr.creditTotal}), 0)::text`, refund: sql<string>`coalesce(sum(${sr.refundTotal}), 0)::text` })
      .from(sr)
      .innerJoin(sa, and(eq(sa.id, sr.saleId), eq(sa.companyId, companyId)))
      .leftJoin(c, and(eq(c.id, sr.customerId), eq(c.companyId, companyId)))
      .where(where),
  ])
  return { rows, total: Number(agg.n), sums: { credit: fromMinor(toMinor(agg.credit)), refund: fromMinor(toMinor(agg.refund)) } }
}

/** Receipts from (in) and refunds to (out) a customer: naming the customer or referencing one of its sales. */
export async function listCustomerPayments(db: Db, companyId: string, branch: BranchFilter, customerId: string, limit = 100) {
  const pay = schema.payments
  const sa = schema.sales
  return db
    .select({ id: pay.id, direction: pay.direction, amount: pay.amount, date: pay.date, method: pay.method, note: pay.note, accountName: schema.accounts.name, saleId: sa.id, invoiceNo: sa.invoiceNo })
    .from(pay)
    .innerJoin(schema.accounts, and(eq(schema.accounts.id, pay.accountId), eq(schema.accounts.companyId, companyId)))
    .leftJoin(sa, and(eq(pay.refType, 'sale'), eq(sa.id, pay.refId), eq(sa.companyId, companyId)))
    .where(and(eq(pay.companyId, companyId), branchCond(pay.branchId, branch), sql`(${pay.partyType} = 'customer' and ${pay.partyId} = ${customerId} or ${sa.customerId} = ${customerId})`))
    .orderBy(desc(pay.date), desc(pay.createdAt))
    .limit(limit)
}

/** Serial units sold to a customer (newest sale first), with the unit's current status and warranty. */
export async function listCustomerUnits(db: Db, companyId: string, branch: BranchFilter, customerId: string, limit = 200) {
  const si = schema.saleItems
  const sa = schema.sales
  const u = schema.productUnits
  const where = and(eq(sa.companyId, companyId), branchCond(sa.branchId, branch), eq(sa.customerId, customerId), notInArray(sa.status, [...INACTIVE_DOCS]))
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: si.id,
        unitId: u.id,
        serialNo: u.serialNo,
        status: u.status,
        warrantyEnd: u.warrantyEnd,
        /** true while the unit is still sold on this customer's line (false once returned, or resold to someone else). */
        current: sql<boolean>`coalesce(${u.saleItemId} = ${si.id}, false)`,
        productName: schema.products.name,
        saleId: sa.id,
        invoiceNo: sa.invoiceNo,
        date: sa.date,
        price: si.unitPrice,
      })
      .from(si)
      .innerJoin(sa, and(eq(sa.id, si.saleId), eq(sa.companyId, companyId)))
      .innerJoin(u, and(eq(u.id, si.unitId), eq(u.companyId, companyId)))
      .innerJoin(schema.products, and(eq(schema.products.id, si.productId), eq(schema.products.companyId, companyId)))
      .where(where)
      .orderBy(desc(sa.date), desc(sa.createdAt), asc(u.serialNo))
      .limit(limit),
    db.select({ n: count() }).from(si).innerJoin(sa, and(eq(sa.id, si.saleId), eq(sa.companyId, companyId))).where(and(where, sql`${si.unitId} is not null`)),
  ])
  return { rows, total: Number(n) }
}

// ------------------------------------------------------------------ customer payment / due collection

const SETTLE_TRACKED = ['paid', 'due', 'returnedTotal', 'status'] as const

async function lockSale(tx: Tx, companyId: string, id: string) {
  const [sa] = await tx.select().from(schema.sales).where(and(eq(schema.sales.id, id), eq(schema.sales.companyId, companyId))).for('update')
  if (!sa) throw new NotFoundError('Sale')
  if (sa.status === 'draft' || sa.status === 'cancelled') throw new FieldErrors({ _: `This sale is ${sa.status}.` }, `This sale is ${sa.status}.`)
  return sa
}

/** Payments and returns cannot be dated before the invoice they belong to. */
function assertNotBefore(date: string, sa: { date: string }) {
  if (date < sa.date) throw new FieldErrors({ date: `Date cannot be before the sale date (${sa.date}).` })
}

/** Collect (part of) one invoice's due. Cannot exceed the due. Row-locks the sale, so concurrent payments cannot overpay. */
export async function recordCustomerPayment(db: Db, companyId: string, userId: string, saleId: string, input: unknown, ctx: Ctx) {
  const d = parseOrFieldErrors(customerPaymentSchema, input)
  return db.transaction(async (tx) => {
    assertDateAllowed(d.date)
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    const sa = await lockSale(tx, companyId, saleId)
    assertPermits(ctx.restrict, sa.branchId, 'Sale')
    assertNotBefore(d.date, sa)
    const amount = toMinor(d.amount)
    const due = toMinor(sa.due)
    if (due === 0) throw new FieldErrors({ amount: 'This invoice has nothing due.' }, 'This invoice has nothing due.')
    if (amount > due) throw new FieldErrors({ amount: `Amount cannot be more than the due (${sa.due}).` })
    await assertAccount(tx, companyId, d.accountId, 'accountId')
    const [payment] = await tx
      .insert(schema.payments)
      .values({ companyId, branchId, direction: 'in', accountId: d.accountId, partyType: sa.customerId ? 'customer' : null, partyId: sa.customerId, refType: 'sale', refId: sa.id, amount: d.amount, method: d.method, date: d.date, note: d.note, createdBy: userId })
      .returning({ id: schema.payments.id })
    const paid = fromMinor(toMinor(sa.paid) + amount)
    const s = settleSale({ total: sa.total, returned: sa.returnedTotal, paid })
    const [after] = await tx.update(schema.sales).set({ paid, due: s.due, status: s.status, updatedAt: new Date() }).where(and(eq(schema.sales.id, sa.id), eq(schema.sales.companyId, companyId))).returning()
    await writeHistory(tx, { companyId, userId, entity: 'sale', entityId: sa.id, diff: diffFields(sa, after, SETTLE_TRACKED) })
    await logActivity({ companyId, userId, action: 'sale.payment', entity: 'sale', entityId: sa.id, before: { paid: sa.paid, due: sa.due }, after: { paymentId: payment.id, amount: d.amount, paid, due: s.due } }, tx)
    return { paymentId: payment.id, paid, due: s.due }
  })
}

/**
 * Customer-level collection: apply one amount to the customer's unpaid invoices OLDEST FIRST (by date, then creation).
 * Only invoices dated on or before the payment date are eligible. Locks those sale rows FOR UPDATE in id order, then
 * writes one payments row per invoice touched. The amount cannot exceed the eligible total due.
 */
export async function collectCustomerDue(db: Db, companyId: string, userId: string, customerId: string, input: unknown, ctx: Ctx) {
  const d = parseOrFieldErrors(customerPaymentSchema, input)
  assertDateAllowed(d.date)
  return db.transaction(async (tx) => {
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    const [c] = await tx.select({ id: schema.customers.id }).from(schema.customers).where(and(eq(schema.customers.id, customerId), eq(schema.customers.companyId, companyId)))
    if (!c) throw new NotFoundError('Customer')
    const sa = schema.sales
    // Only the invoices of the branch the money is collected at (the dues the user sees for this branch).
    const open = await tx
      .select()
      .from(sa)
      .where(and(eq(sa.companyId, companyId), eq(sa.branchId, branchId), eq(sa.customerId, customerId), gt(sa.due, '0'), notInArray(sa.status, [...INACTIVE_DOCS])))
      .orderBy(asc(sa.id))
      .for('update')
    const eligible = open.filter((x) => x.date <= d.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)))
    const totalDue = eligible.reduce((a, x) => a + toMinor(x.due), 0)
    const amount = toMinor(d.amount)
    if (totalDue === 0) throw new FieldErrors({ amount: 'This customer has nothing due in this branch on invoices dated on or before this date.' }, 'Nothing due.')
    if (amount > totalDue) throw new FieldErrors({ amount: `Amount cannot be more than the total due (${fromMinor(totalDue)}).` })
    await assertAccount(tx, companyId, d.accountId, 'accountId')
    const allocs = allocateOldestFirst(
      eligible.map((x) => ({ id: x.id, dueMinor: toMinor(x.due) })),
      amount,
    )
    const out: { saleId: string; invoiceNo: string; amount: string; due: string }[] = []
    for (const a of allocs) {
      const before = eligible.find((x) => x.id === a.id)!
      const amt = fromMinor(a.amountMinor)
      await tx.insert(schema.payments).values({ companyId, branchId, direction: 'in', accountId: d.accountId, partyType: 'customer', partyId: customerId, refType: 'sale', refId: before.id, amount: amt, method: d.method, date: d.date, note: d.note ?? 'Due collection', createdBy: userId })
      const paid = fromMinor(toMinor(before.paid) + a.amountMinor)
      const s = settleSale({ total: before.total, returned: before.returnedTotal, paid })
      const [after] = await tx.update(sa).set({ paid, due: s.due, status: s.status, updatedAt: new Date() }).where(and(eq(sa.id, before.id), eq(sa.companyId, companyId))).returning()
      await writeHistory(tx, { companyId, userId, entity: 'sale', entityId: before.id, diff: diffFields(before, after, SETTLE_TRACKED) })
      out.push({ saleId: before.id, invoiceNo: before.invoiceNo, amount: amt, due: s.due })
    }
    await logActivity({ companyId, userId, action: 'customer.collect', entity: 'customer', entityId: customerId, after: { amount: d.amount, accountId: d.accountId, date: d.date, allocations: out } }, tx)
    return { allocations: out, remainingDue: fromMinor(totalDue - amount) }
  })
}

// ------------------------------------------------------------------ customer return / refund

/**
 * Return lines/units of a sale.
 * Rules:
 *  - serial lines: the unit must currently be 'sold' and this invoice's line must not have been returned already
 *    (sale_items.unit_id link + returned qty), so a unit resold on a later invoice can only be returned on that one;
 *    it goes sold -> in_stock (or damaged) with a unit_events('sale_returned') row, and its sold_at/warranty are cleared;
 *  - non-serial lines: qty <= sold - already returned; a 'sale_return' stock movement (+qty) puts it back in stock;
 *  - credit = the returned units' NET revenue (line net_total split exactly with splitEvenly, consumed in order), so
 *    returning everything credits exactly the invoice total;
 *  - the credit first reduces the invoice due; the rest (credit beyond the due) is refunded in cash NOW as a payments
 *    row direction 'out', ref sale, from `refundAccountId` (required when there is something to refund).
 */
export async function createSaleReturn(db: Db, companyId: string, userId: string, saleId: string, input: unknown, ctx: Ctx) {
  const d = parseOrFieldErrors(saleReturnSchema, input)
  const ids = d.items.map((x) => x.saleItemId)
  if (new Set(ids).size !== ids.length) throw new FieldErrors({ items: 'An item was selected twice.' })
  try {
    return await db.transaction((tx) => saleReturnTx(tx, companyId, userId, saleId, d, ctx))
  } catch (e) {
    if (isUniqueViolation(e, RETURN_NO_UQ)) throw new FieldErrors({ _: NUMBER_CLASH }, NUMBER_CLASH)
    throw e
  }
}

async function saleReturnTx(tx: Tx, companyId: string, userId: string, saleId: string, d: ReturnType<typeof saleReturnSchema.parse>, ctx: Ctx) {
  assertDateAllowed(d.date)
  // Goods come back into the ACTIVE branch (it may differ from the sale's branch for a branches.all user; logged below).
  const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
  const sa = await lockSale(tx, companyId, saleId)
  assertPermits(ctx.restrict, sa.branchId, 'Sale')
  assertNotBefore(d.date, sa)
  const si = schema.saleItems
  const ids = d.items.map((x) => x.saleItemId)
  const items = await tx.select().from(si).where(and(eq(si.companyId, companyId), eq(si.saleId, sa.id), inArray(si.id, ids)))
  if (items.length !== ids.length) throw new FieldErrors({ items: 'Some selected items are not part of this invoice.' })
  const byItem = new Map(items.map((x) => [x.id, x]))
  const sri = schema.saleReturnItems
  const prev = await tx
    .select({ saleItemId: sri.saleItemId, qty: sql<string>`coalesce(sum(${sri.qty}), 0)::text` })
    .from(sri)
    .where(and(eq(sri.companyId, companyId), inArray(sri.saleItemId, ids)))
    .groupBy(sri.saleItemId)
  const already = new Map(prev.map((r) => [r.saleItemId, Number(r.qty)]))
  const errs: Record<string, string> = {}
  d.items.forEach((x, i) => {
    const it = byItem.get(x.saleItemId)!
    const left = it.qty - (already.get(it.id) ?? 0)
    if (left <= 0) errs[`items.${i}.qty`] = 'Already returned.'
    else if (x.qty > left) errs[`items.${i}.qty`] = `At most ${left} can be returned.`
    if (!it.unitId && x.restock === 'damaged') errs[`items.${i}.restock`] = 'Only serial units can be marked damaged; loose stock goes back to stock.'
  })
  if (Object.keys(errs).length) throw new FieldErrors(errs)

  // Lock order: (sale row) -> products FOR SHARE (sorted) -> document number -> units FOR UPDATE (id order).
  const productIds = [...new Set(items.map((x) => x.productId))].sort()
  await tx
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), inArray(schema.products.id, productIds)))
    .orderBy(asc(schema.products.id))
    .for('share')
  const returnNo = await nextDocNumber(tx, companyId, 'sale_return')
  const unitIds = items.filter((x) => x.unitId).map((x) => x.unitId as string)
  const locked = new Map((await lockUnitsForUpdate(tx, companyId, unitIds)).map((x) => [x.id, x]))
  const unitErrs: Record<string, string> = {}
  d.items.forEach((x, i) => {
    const it = byItem.get(x.saleItemId)!
    if (!it.unitId) return
    const unit = locked.get(it.unitId)
    if (!unit) unitErrs[`items.${i}.qty`] = 'Unit not found.'
    else if (unit.status !== 'sold') unitErrs[`items.${i}.qty`] = `Unit ${unit.serialNo} is ${STATUS_LABEL[unit.status as UnitStatus].toLowerCase()}, not sold: it cannot be returned on this invoice.`
    // Positive link, read under the unit lock: the unit must currently be sold on THIS invoice line (a unit that left
    // this sale by any route and was resold elsewhere points at its newer line).
    else if (unit.saleItemId !== it.id) unitErrs[`items.${i}.qty`] = `Unit ${unit.serialNo} is no longer sold on this invoice: it cannot be returned here.`
  })
  if (Object.keys(unitErrs).length) throw new FieldErrors(unitErrs, Object.values(unitErrs).join(' '))

  const lines = d.items.map((x) => {
    const it = byItem.get(x.saleItemId)!
    return { x, it, credit: returnCredit(toMinor(it.netTotal), it.qty, already.get(it.id) ?? 0, x.qty) }
  })
  const gross = lines.reduce((a, l) => a + l.credit, 0)
  const total = toMinor(sa.total)
  const returnedBefore = toMinor(sa.returnedTotal)
  const credit = Math.min(gross, Math.max(0, total - returnedBefore)) // defensive: cannot happen with exact net shares
  const returnedAfter = returnedBefore + credit
  const paidBefore = toMinor(sa.paid)
  const refund = Math.max(0, returnedAfter + paidBefore - total)
  if (refund > 0) {
    if (!d.refundAccountId) throw new FieldErrors({ refundAccountId: `Choose the account the ${fromMinor(refund)} refund is paid from.` })
    await assertAccount(tx, companyId, d.refundAccountId, 'refundAccountId')
  }

  const returnId = randomUUID()
  await tx.insert(schema.saleReturns).values({ id: returnId, companyId, branchId, returnNo, saleId: sa.id, customerId: sa.customerId, date: d.date, creditTotal: fromMinor(credit), refundTotal: fromMinor(refund), note: d.note, createdBy: userId })
  const rows = lines.map((l) => ({ id: randomUUID(), companyId, saleReturnId: returnId, saleItemId: l.it.id, productId: l.it.productId, unitId: l.it.unitId, qty: l.x.qty, refundAmount: fromMinor(l.credit), restock: l.it.unitId ? l.x.restock : ('in_stock' as const) }))
  for (const part of chunks(rows)) await tx.insert(sri).values(part)

  for (const to of ['in_stock', 'damaged'] as const) {
    const group = rows.filter((r) => r.unitId && r.restock === to)
    await transitionLockedUnits(tx, {
      companyId,
      userId,
      to,
      allowedFrom: ['sold'],
      eventType: 'sale_returned',
      set: { soldAt: null, warrantyStart: null, warrantyEnd: null, saleItemId: null, branchId },
      items: group.map((r) => ({ unit: locked.get(r.unitId as string)!, ref: { table: 'sale_return_items', id: r.id }, price: r.refundAmount, note: d.note, meta: { returnNo, saleId: sa.id, invoiceNo: sa.invoiceNo, customerId: sa.customerId, restock: to } })),
    })
  }
  const moves = rows.filter((r) => !r.unitId).map((r) => ({ companyId, branchId, productId: r.productId, type: 'sale_return' as const, qtyChange: r.qty, refTable: 'sale_return_items', refId: r.id, note: returnNo, createdBy: userId }))
  for (const part of chunks(moves)) await tx.insert(schema.stockMovements).values(part)

  if (refund > 0 && d.refundAccountId)
    await tx.insert(schema.payments).values({ companyId, branchId, direction: 'out', accountId: d.refundAccountId, partyType: sa.customerId ? 'customer' : null, partyId: sa.customerId, refType: 'sale', refId: sa.id, amount: fromMinor(refund), method: d.refundMethod, date: d.date, note: `Refund for return ${returnNo}`, createdBy: userId })

  const paid = fromMinor(paidBefore - refund)
  const s = settleSale({ total: sa.total, returned: fromMinor(returnedAfter), paid })
  const [after] = await tx
    .update(schema.sales)
    .set({ returnedTotal: fromMinor(returnedAfter), paid, due: s.due, status: s.status, updatedAt: new Date() })
    .where(and(eq(schema.sales.id, sa.id), eq(schema.sales.companyId, companyId)))
    .returning()
  await writeHistory(tx, { companyId, userId, entity: 'sale', entityId: sa.id, diff: diffFields(sa, after, SETTLE_TRACKED) })
  await logActivity(
    {
      companyId,
      userId,
      action: 'sale.return',
      entity: 'sale_return',
      entityId: returnId,
      before: { paid: sa.paid, due: sa.due, returnedTotal: sa.returnedTotal },
      after: { returnNo, saleId: sa.id, branchId, ...(sa.branchId !== branchId ? { saleBranchId: sa.branchId, crossBranch: true } : {}), items: rows.map((r) => ({ saleItemId: r.saleItemId, qty: r.qty, credit: r.refundAmount, restock: r.restock })), credit: fromMinor(credit), refund: fromMinor(refund), paid, due: s.due },
    },
    tx,
  )
  return { id: returnId, returnNo, credit: fromMinor(credit), refund: fromMinor(refund), due: s.due }
}
