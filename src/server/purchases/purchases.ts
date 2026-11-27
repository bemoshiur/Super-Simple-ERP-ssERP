/**
 * Purchases: invoice + serial intake, vendor payments, purchase returns. All functions take
 * (db, companyId, userId, ...) with companyId from the session only, and do every write in ONE transaction.
 *
 * Locking contract (see catalog/products.ts trackSerial guard and serials.ts):
 *  - product rows are taken FOR SHARE (sorted by id) before any product_units / stock_movements write;
 *  - a purchase row is taken FOR UPDATE before paid/due/returned_total change;
 *  - doc numbers come from nextDocNumber() inside the same transaction.
 *  - (Task 14) the write branch row is taken FOR SHARE first (resolveWriteBranch): goods are received into the ACTIVE
 *    branch; returns to the vendor leave from the active branch (serial units must be located there).
 */
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm'
import { logActivity } from '../audit'
import { assertPermits, branchCond, branchLabel, resolveWriteBranch, type BranchFilter, type WriteCtx } from '../branch'
import { schema, type Db } from '../db'
import { nextDocNumber } from '../docnumbers'
import { FieldErrors, NotFoundError, isUniqueViolation, zodPathErrors } from '../errors'
import { diffFields, writeHistory } from '../history'
import { fromMinor, toMinor } from '../money'
import { likePattern } from '../pagination'
import { onHandQty } from '../sales/sales'
import { returnCredit } from '../sales/totals'
import { transitionUnit } from '../serials'
import { purchaseReturnSchema, purchaseSchema, vendorPaymentSchema } from './schemas'
import { formatSerialList, normalizeSerial, serialProblem } from './serialInput'
import { computePurchaseTotals, settle, splitEvenly, type DisplayStatus } from './totals'

const SERIAL_UQ = 'product_units_company_serial_uq'
const INVOICE_UQ = 'purchases_company_invoice_uq'
const IDEM_UQ = 'purchases_company_idempotency_uq'
const RETURN_NO_UQ = 'purchase_returns_company_no_uq'
const NUMBER_CLASH = 'Could not allocate a document number (the numbering setting may clash with an existing number). Please try again.'
const CHUNK = 500
const RETURNABLE = ['in_stock'] as const

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** `source` is recorded in the activity log (e.g. 'import'). */
type Ctx = WriteCtx & { source?: string; /** Overrides the computed idempotency hash (the import hashes the uploaded file instead). */ requestHash?: string }

const chunks = <T>(arr: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))
const minorSum = (vals: string[]) => vals.reduce((a, v) => a + toMinor(v), 0)

function parseOrFieldErrors<T>(schemaLike: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import('zod').ZodError } }, input: unknown): T {
  const r = schemaLike.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  return r.data
}

async function assertAccount(tx: Pick<Db, 'select'>, companyId: string, accountId: string, field: string) {
  const [acc] = await tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true)))
  if (!acc) throw new FieldErrors({ [field]: 'Account not found' })
}

/** Serials (of this company) that already exist, from a candidate list. */
export async function existingSerials(db: Pick<Db, 'select'>, companyId: string, serials: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const part of chunks(serials, 1000)) {
    const rows = await db
      .select({ s: schema.productUnits.serialNo })
      .from(schema.productUnits)
      .where(and(eq(schema.productUnits.companyId, companyId), inArray(schema.productUnits.serialNo, part)))
    rows.forEach((r) => found.add(r.s))
  }
  return found
}

function existingSerialErrors(lineSerials: string[][], existing: Set<string>): FieldErrors | null {
  const errs: Record<string, string> = {}
  const all: string[] = []
  lineSerials.forEach((list, i) => {
    const dup = list.filter((s) => existing.has(s))
    if (dup.length) {
      errs[`items.${i}.serials`] = `Already recorded: ${formatSerialList(dup)}`
      all.push(...dup)
    }
  })
  if (!all.length) return null
  return new FieldErrors(errs, `${all.length} serial number${all.length === 1 ? ' is' : 's are'} already recorded in your stock: ${formatSerialList(all)}`)
}

export type CreatedPurchase = { id: string; invoiceNo: string; total: string; due: string; /** true when an idempotency key matched an invoice that already existed (nothing was written). */ duplicate: boolean }

type ParsedPurchase = ReturnType<typeof purchaseSchema.parse>

/** sha256 of the canonical request: vendor, date, amounts, account and the lines (product, cost, serials with their extras), order-insensitive. */
export function purchaseRequestHash(d: ParsedPurchase, lineSerials: string[][]): string {
  const lines = d.items
    .map((it, i) => {
      const rows = lineSerials[i].map((sn, j) => [sn, it.serialMeta?.[j]?.warrantyMonths ?? null, it.serialMeta?.[j]?.note ?? null])
      rows.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))
      return [it.productId, it.unitCost, it.qty, rows]
    })
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
  return createHash('sha256').update(JSON.stringify({ v: d.vendorId, d: d.date, n: d.note ?? null, l: lines, x: d.discount, p: d.paid, a: d.accountId ?? null })).digest('hex')
}

/** Resolve an idempotency key: null when unused; the existing invoice when saved with the same payload; a friendly error otherwise. */
export async function resolvePurchaseKey(db: Pick<Db, 'select'>, companyId: string, key: string, hash: string): Promise<CreatedPurchase | null> {
  const pu = schema.purchases
  const [row] = await db.select({ id: pu.id, invoiceNo: pu.invoiceNo, total: pu.total, due: pu.due, hash: pu.idempotencyHash }).from(pu).where(and(eq(pu.companyId, companyId), eq(pu.idempotencyKey, key)))
  if (!row) return null
  if (row.hash !== hash) {
    const msg = `This request was already saved as ${row.invoiceNo}; reload the page to start a new one.`
    throw new FieldErrors({ _: msg }, msg)
  }
  return { id: row.id, invoiceNo: row.invoiceNo, total: row.total, due: row.due, duplicate: true }
}

/**
 * Create a received purchase invoice. Server recomputes every amount from the lines; `expectedTotal` (what the
 * user saw) must match or the save is rejected. Serial products get one product_units row per serial (+ a
 * 'purchased' unit_event); non-serial products get a stock_movements row.
 */
export async function createPurchase(db: Db, companyId: string, userId: string, input: unknown, ctx: Ctx): Promise<CreatedPurchase> {
  const d = parseOrFieldErrors(purchaseSchema, input)
  const t = computePurchaseTotals({ items: d.items, discount: d.discount, paid: d.paid })
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
  const paidMinor = toMinor(totals.paid)
  if (paidMinor > 0 && !d.accountId) throw new FieldErrors({ accountId: 'Choose the account this payment was made from' })

  // ---- serials: normalise + validate (pure) ----
  const lineSerials = d.items.map((it) => it.serials.map(normalizeSerial).filter(Boolean))
  const errs: Record<string, string> = {}
  const firstLine = new Map<string, number>()
  const dupInInvoice: string[] = []
  lineSerials.forEach((list, i) => {
    const bad = list.filter((s) => serialProblem(s) !== null)
    if (bad.length) errs[`items.${i}.serials`] = `Invalid serial${bad.length === 1 ? '' : 's'} (1-${64} printable characters, no spaces): ${formatSerialList(bad)}`
    const dups: string[] = []
    for (const s of list) {
      if (firstLine.has(s)) dups.push(s)
      else firstLine.set(s, i)
    }
    if (dups.length) {
      errs[`items.${i}.serials`] ??= `Entered more than once in this invoice: ${formatSerialList(dups)}`
      dupInInvoice.push(...dups)
    }
  })
  if (Object.keys(errs).length) throw new FieldErrors(errs, dupInInvoice.length ? `Duplicate serials in this invoice: ${formatSerialList([...new Set(dupInInvoice)])}` : undefined)

  d.items.forEach((it, i) => {
    if (!it.serialMeta) return
    if (it.serialMeta.length !== it.serials.length || lineSerials[i].length !== it.serials.length) errs[`items.${i}.serials`] = 'Per-serial details must match the serial list one to one.'
  })
  if (Object.keys(errs).length) throw new FieldErrors(errs)

  const allSerials = lineSerials.flat()
  const hash = d.idempotencyKey ? (ctx.requestHash ?? purchaseRequestHash(d, lineSerials)) : null
  if (d.idempotencyKey && hash) {
    const existing = await resolvePurchaseKey(db, companyId, d.idempotencyKey, hash)
    if (existing) return existing
  }
  try {
    return await db.transaction(async (tx) => {
      const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
      const [vendor] = await tx
        .select({ id: schema.vendors.id, active: schema.vendors.active })
        .from(schema.vendors)
        .where(and(eq(schema.vendors.id, d.vendorId), eq(schema.vendors.companyId, companyId)))
      if (!vendor) throw new FieldErrors({ vendorId: 'Vendor not found' })
      if (!vendor.active) throw new FieldErrors({ vendorId: 'This vendor is deactivated. Restore it first.' })
      if (paidMinor > 0 && d.accountId) await assertAccount(tx, companyId, d.accountId, 'accountId')

      // Lock every product FOR SHARE (sorted: consistent lock order), so serial tracking cannot flip mid-flight.
      const ids = [...new Set(d.items.map((it) => it.productId))].sort()
      const prods = await tx
        .select({ id: schema.products.id, name: schema.products.name, trackSerial: schema.products.trackSerial, warrantyMonths: schema.products.warrantyMonths, active: schema.products.active })
        .from(schema.products)
        .where(and(eq(schema.products.companyId, companyId), inArray(schema.products.id, ids)))
        .orderBy(asc(schema.products.id))
        .for('share')
      const byId = new Map(prods.map((p) => [p.id, p]))
      const lineErrs: Record<string, string> = {}
      d.items.forEach((it, i) => {
        const p = byId.get(it.productId)
        if (!p) lineErrs[`items.${i}.productId`] = 'Product not found'
        else if (!p.active) lineErrs[`items.${i}.productId`] = `${p.name} is deactivated`
        else if (p.trackSerial && lineSerials[i].length !== it.qty)
          lineErrs[`items.${i}.serials`] = `${p.name} is serial-tracked: enter exactly ${it.qty} serial${it.qty === 1 ? '' : 's'} (${lineSerials[i].length} entered).`
        else if (!p.trackSerial && lineSerials[i].length > 0) lineErrs[`items.${i}.serials`] = `${p.name} does not track serials; remove the serial numbers.`
      })
      if (Object.keys(lineErrs).length) throw new FieldErrors(lineErrs)

      // UX pre-check (the unique index below is the real, race-proof guard).
      const dupErr = existingSerialErrors(lineSerials, await existingSerials(tx, companyId, allSerials))
      if (dupErr) throw dupErr

      const s = settle({ total: totals.total, returned: '0', paid: totals.paid })
      const invoiceNo = await nextDocNumber(tx, companyId, 'purchase')
      const purchaseId = randomUUID()
      await tx.insert(schema.purchases).values({
        id: purchaseId,
        companyId,
        branchId,
        invoiceNo,
        vendorId: vendor.id,
        date: d.date,
        subtotal: totals.subtotal,
        discount: totals.discount,
        total: totals.total,
        paid: totals.paid,
        due: s.due,
        status: s.status,
        note: d.note,
        idempotencyKey: d.idempotencyKey ?? null,
        idempotencyHash: hash,
        createdBy: userId,
      })
      const itemIds = d.items.map(() => randomUUID())
      for (const part of chunks(d.items.map((it, i) => ({ id: itemIds[i], companyId, purchaseId, productId: it.productId, qty: it.qty, unitCost: it.unitCost, netTotal: totals.netLines[i] }))))
        await tx.insert(schema.purchaseItems).values(part)

      const units: (typeof schema.productUnits.$inferInsert)[] = []
      const events: (typeof schema.unitEvents.$inferInsert)[] = []
      const moves: (typeof schema.stockMovements.$inferInsert)[] = []
      d.items.forEach((it, i) => {
        const p = byId.get(it.productId)!
        if (p.trackSerial) {
          // NET unit cost: the line's discount-allocated total split exactly over its units (see totals.ts).
          const costs = splitEvenly(toMinor(totals.netLines[i]), it.qty).map(fromMinor)
          lineSerials[i].forEach((serialNo, j) => {
            const unitId = randomUUID()
            const extra = it.serialMeta?.[j]
            units.push({ id: unitId, companyId, branchId, productId: p.id, serialNo, purchaseItemId: itemIds[i], vendorId: vendor.id, purchasePrice: costs[j], status: 'in_stock', warrantyMonths: extra?.warrantyMonths ?? p.warrantyMonths })
            events.push({ companyId, unitId, type: 'purchased', fromStatus: null, toStatus: 'in_stock', refTable: 'purchase_items', refId: itemIds[i], actorUserId: userId, price: costs[j], meta: { invoiceNo, grossUnitCost: it.unitCost, ...(extra?.note ? { note: extra.note } : {}) } })
          })
        } else {
          moves.push({ companyId, branchId, productId: p.id, type: 'purchase', qtyChange: it.qty, refTable: 'purchase_items', refId: itemIds[i], note: invoiceNo, createdBy: userId })
        }
      })
      for (const part of chunks(units)) await tx.insert(schema.productUnits).values(part)
      for (const part of chunks(events)) await tx.insert(schema.unitEvents).values(part)
      for (const part of chunks(moves)) await tx.insert(schema.stockMovements).values(part)

      if (paidMinor > 0 && d.accountId)
        await tx.insert(schema.payments).values({ companyId, branchId, direction: 'out', accountId: d.accountId, partyType: 'vendor', partyId: vendor.id, refType: 'purchase', refId: purchaseId, amount: totals.paid, date: d.date, note: `Paid with purchase ${invoiceNo}`, createdBy: userId })

      await logActivity(
        { companyId, userId, action: 'purchase.create', entity: 'purchase', entityId: purchaseId, after: { invoiceNo, vendorId: vendor.id, date: d.date, subtotal: totals.subtotal, discount: totals.discount, total: totals.total, paid: totals.paid, due: s.due, lines: d.items.length, units: units.length, ...(ctx.source ? { source: ctx.source } : {}) } },
        tx,
      )
      return { id: purchaseId, invoiceNo, total: totals.total, due: s.due, duplicate: false }
    })
  } catch (e) {
    // A resubmit racing the first attempt can fail on the serial/key unique index: return the winner when the payload matches.
    if (d.idempotencyKey && hash && (isUniqueViolation(e, IDEM_UQ) || isUniqueViolation(e, SERIAL_UQ) || e instanceof FieldErrors)) {
      const existing = await resolvePurchaseKey(db, companyId, d.idempotencyKey, hash)
      if (existing) return existing
    }
    if (isUniqueViolation(e, SERIAL_UQ)) {
      // Lost a race with another invoice (or a pre-check gap): report exactly which serials now exist.
      const dupErr = existingSerialErrors(lineSerials, await existingSerials(db, companyId, allSerials))
      throw dupErr ?? new FieldErrors({ items: 'Some serial numbers were just recorded by another invoice. Check them and save again.' }, 'Some serial numbers were just recorded by another invoice.')
    }
    if (isUniqueViolation(e, INVOICE_UQ)) throw new FieldErrors({ _: NUMBER_CLASH }, NUMBER_CLASH)
    throw e
  }
}

// ------------------------------------------------------------------ reads

export type PurchaseListFilter = { q?: string; vendorId?: string; from?: string; to?: string; dueOnly?: boolean; status?: DisplayStatus; limit: number; offset: number }

/** SQL twin of displayStatus() in totals.ts. */
function statusWhere(st: DisplayStatus | undefined) {
  const pu = schema.purchases
  if (st === 'returned') return sql`${pu.returnedTotal} > 0 and ${pu.total} - ${pu.returnedTotal} <= 0`
  const notReturned = sql`not (${pu.returnedTotal} > 0 and ${pu.total} - ${pu.returnedTotal} <= 0)`
  if (st === 'paid') return sql`${notReturned} and ${pu.due} = 0`
  if (st === 'partially_paid') return sql`${pu.due} > 0 and ${pu.paid} > 0`
  if (st === 'unpaid') return sql`${pu.due} > 0 and ${pu.paid} = 0`
  return undefined
}

export async function listPurchases(db: Db, companyId: string, branch: BranchFilter, f: PurchaseListFilter) {
  const pu = schema.purchases
  const v = schema.vendors
  const where = and(
    eq(pu.companyId, companyId),
    branchCond(pu.branchId, branch),
    f.q ? or(ilike(pu.invoiceNo, likePattern(f.q)), ilike(v.name, likePattern(f.q))) : undefined,
    f.vendorId ? eq(pu.vendorId, f.vendorId) : undefined,
    f.from ? gte(pu.date, f.from) : undefined,
    f.to ? lte(pu.date, f.to) : undefined,
    f.dueOnly ? gt(pu.due, '0') : undefined,
    statusWhere(f.status),
  )
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ id: pu.id, invoiceNo: pu.invoiceNo, date: pu.date, vendorId: pu.vendorId, vendorName: v.name, total: pu.total, paid: pu.paid, due: pu.due, returnedTotal: pu.returnedTotal, status: pu.status, branchId: pu.branchId, branchName: schema.branches.name })
      .from(pu)
      .innerJoin(v, and(eq(v.id, pu.vendorId), eq(v.companyId, companyId)))
      .leftJoin(schema.branches, and(eq(schema.branches.id, pu.branchId), eq(schema.branches.companyId, companyId)))
      .where(where)
      .orderBy(desc(pu.date), desc(pu.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count() }).from(pu).innerJoin(v, and(eq(v.id, pu.vendorId), eq(v.companyId, companyId))).where(where),
  ])
  return { rows, total: Number(n) }
}

export type PurchaseDetail = Awaited<ReturnType<typeof getPurchase>>

/** Full invoice view (company-scoped: another company's id is NotFound; with `restrict`, another branch's too). */
export async function getPurchase(db: Db, companyId: string, restrict: BranchFilter, id: string) {
  const pu = schema.purchases
  const [head] = await db
    .select({ purchase: pu, vendorName: schema.vendors.name, vendorPhone: schema.vendors.phone, vendorAddress: schema.vendors.address, createdByName: schema.users.name, branchName: schema.branches.name, branchCode: schema.branches.code })
    .from(pu)
    .innerJoin(schema.vendors, and(eq(schema.vendors.id, pu.vendorId), eq(schema.vendors.companyId, companyId)))
    .leftJoin(schema.users, and(eq(schema.users.id, pu.createdBy), eq(schema.users.companyId, companyId)))
    .leftJoin(schema.branches, and(eq(schema.branches.id, pu.branchId), eq(schema.branches.companyId, companyId)))
    .where(and(eq(pu.id, id), eq(pu.companyId, companyId), branchCond(pu.branchId, restrict)))
  if (!head) throw new NotFoundError('Purchase')
  const pi = schema.purchaseItems
  const [items, units, payments, returns, returnItems] = await Promise.all([
    db
      .select({ id: pi.id, productId: pi.productId, productName: schema.products.name, sku: schema.products.sku, trackSerial: schema.products.trackSerial, qty: pi.qty, unitCost: pi.unitCost, netTotal: pi.netTotal })
      .from(pi)
      .innerJoin(schema.products, and(eq(schema.products.id, pi.productId), eq(schema.products.companyId, companyId)))
      .where(and(eq(pi.purchaseId, id), eq(pi.companyId, companyId)))
      .orderBy(asc(schema.products.name), asc(pi.id)),
    db
      .select({ id: schema.productUnits.id, itemId: schema.productUnits.purchaseItemId, serialNo: schema.productUnits.serialNo, status: schema.productUnits.status, purchasePrice: schema.productUnits.purchasePrice, branchId: schema.productUnits.branchId })
      .from(schema.productUnits)
      .innerJoin(pi, and(eq(pi.id, schema.productUnits.purchaseItemId), eq(pi.companyId, companyId)))
      .where(and(eq(schema.productUnits.companyId, companyId), eq(pi.purchaseId, id)))
      .orderBy(asc(schema.productUnits.serialNo)),
    db
      .select({ id: schema.payments.id, direction: schema.payments.direction, amount: schema.payments.amount, date: schema.payments.date, method: schema.payments.method, note: schema.payments.note, accountName: schema.accounts.name, createdAt: schema.payments.createdAt })
      .from(schema.payments)
      .innerJoin(schema.accounts, and(eq(schema.accounts.id, schema.payments.accountId), eq(schema.accounts.companyId, companyId)))
      .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.refType, 'purchase'), eq(schema.payments.refId, id)))
      .orderBy(asc(schema.payments.date), asc(schema.payments.createdAt)),
    db
      .select()
      .from(schema.purchaseReturns)
      .where(and(eq(schema.purchaseReturns.companyId, companyId), eq(schema.purchaseReturns.purchaseId, id)))
      .orderBy(asc(schema.purchaseReturns.createdAt)),
    db
      .select({ returnId: schema.purchaseReturnItems.purchaseReturnId, purchaseItemId: schema.purchaseReturnItems.purchaseItemId, unitId: schema.purchaseReturnItems.unitId, qty: schema.purchaseReturnItems.qty, serialNo: schema.productUnits.serialNo, productId: schema.purchaseReturnItems.productId, productName: schema.products.name, creditAmount: schema.purchaseReturnItems.creditAmount })
      .from(schema.purchaseReturnItems)
      .innerJoin(schema.purchaseReturns, and(eq(schema.purchaseReturns.id, schema.purchaseReturnItems.purchaseReturnId), eq(schema.purchaseReturns.companyId, companyId)))
      .innerJoin(schema.products, and(eq(schema.products.id, schema.purchaseReturnItems.productId), eq(schema.products.companyId, companyId)))
      .leftJoin(schema.productUnits, and(eq(schema.productUnits.id, schema.purchaseReturnItems.unitId), eq(schema.productUnits.companyId, companyId)))
      .where(and(eq(schema.purchaseReturns.companyId, companyId), eq(schema.purchaseReturns.purchaseId, id)))
      .orderBy(asc(schema.productUnits.serialNo)),
  ])
  return {
    ...head.purchase,
    vendorName: head.vendorName,
    vendorPhone: head.vendorPhone,
    vendorAddress: head.vendorAddress,
    createdByName: head.createdByName,
    branchName: head.branchName,
    branchCode: head.branchCode,
    items: items.map((it) => ({
      ...it,
      lineTotal: fromMinor(toMinor(it.unitCost) * it.qty),
      units: units.filter((u) => u.itemId === it.id),
      /** Non-serial qty already returned to the vendor from this line. */
      returnedQty: returnItems.filter((x) => x.purchaseItemId === it.id && x.unitId === null).reduce((a, x) => a + x.qty, 0),
    })),
    payments,
    returns: returns.map((r) => ({ ...r, items: returnItems.filter((x) => x.returnId === r.id) })),
  }
}

/** Active accounts for payment selects. */
export async function listActiveAccounts(db: Db, companyId: string) {
  return db
    .select({ id: schema.accounts.id, name: schema.accounts.name, type: schema.accounts.type })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true)))
    .orderBy(asc(schema.accounts.name))
}

export type PurchaseProductOption = { value: string; label: string; description?: string; trackSerial: boolean; unitCost: string }

/** Product picker for the purchase form: active products only, max 20. */
export async function searchProductsForPurchase(db: Db, companyId: string, q: string): Promise<PurchaseProductOption[]> {
  const p = schema.products
  const term = q.trim().slice(0, 100)
  const rows = await db
    .select({ id: p.id, name: p.name, sku: p.sku, trackSerial: p.trackSerial, purchasePrice: p.purchasePrice })
    .from(p)
    .where(and(eq(p.companyId, companyId), eq(p.active, true), term ? or(ilike(p.name, likePattern(term)), ilike(p.sku, likePattern(term))) : undefined))
    .orderBy(asc(p.name))
    .limit(20)
  return rows.map((r) => ({ value: r.id, label: r.name, description: `${r.sku}${r.trackSerial ? ' · serial-tracked' : ''}`, trackSerial: r.trackSerial, unitCost: r.purchasePrice }))
}

/** Units supplied by a vendor (newest first), for the vendor detail page. */
export async function listVendorUnits(db: Db, companyId: string, branch: BranchFilter, vendorId: string, limit = 100) {
  const u = schema.productUnits
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({ id: u.id, serialNo: u.serialNo, status: u.status, purchasePrice: u.purchasePrice, productName: schema.products.name, purchaseId: schema.purchases.id, invoiceNo: schema.purchases.invoiceNo, date: schema.purchases.date })
      .from(u)
      .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
      .leftJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, u.purchaseItemId), eq(schema.purchaseItems.companyId, companyId)))
      .leftJoin(schema.purchases, and(eq(schema.purchases.id, schema.purchaseItems.purchaseId), eq(schema.purchases.companyId, companyId)))
      .where(and(eq(u.companyId, companyId), branchCond(u.branchId, branch), eq(u.vendorId, vendorId)))
      .orderBy(desc(u.createdAt), asc(u.serialNo))
      .limit(limit),
    db.select({ n: count() }).from(u).where(and(eq(u.companyId, companyId), branchCond(u.branchId, branch), eq(u.vendorId, vendorId))),
  ])
  return { rows, total: Number(n) }
}

/** Payments to (out) and refunds from (in) a vendor: naming the vendor or referencing one of its purchases. */
export async function listVendorPayments(db: Db, companyId: string, branch: BranchFilter, vendorId: string, limit = 100) {
  const pay = schema.payments
  const pu = schema.purchases
  return db
    .select({ id: pay.id, direction: pay.direction, amount: pay.amount, date: pay.date, method: pay.method, note: pay.note, accountName: schema.accounts.name, refType: pay.refType, purchaseId: pu.id, invoiceNo: pu.invoiceNo })
    .from(pay)
    .innerJoin(schema.accounts, and(eq(schema.accounts.id, pay.accountId), eq(schema.accounts.companyId, companyId)))
    .leftJoin(pu, and(eq(pay.refType, 'purchase'), eq(pu.id, pay.refId), eq(pu.companyId, companyId)))
    .where(and(eq(pay.companyId, companyId), branchCond(pay.branchId, branch), sql`(${pay.partyType} = 'vendor' and ${pay.partyId} = ${vendorId} or ${pu.vendorId} = ${vendorId})`))
    .orderBy(desc(pay.date), desc(pay.createdAt))
    .limit(limit)
}

// ------------------------------------------------------------------ vendor payment

const SETTLE_TRACKED = ['paid', 'due', 'returnedTotal', 'status'] as const

async function lockPurchase(tx: Tx, companyId: string, id: string) {
  const [pu] = await tx.select().from(schema.purchases).where(and(eq(schema.purchases.id, id), eq(schema.purchases.companyId, companyId))).for('update')
  if (!pu) throw new NotFoundError('Purchase')
  if (pu.status === 'draft' || pu.status === 'cancelled') throw new FieldErrors({ _: `This purchase is ${pu.status}.` }, `This purchase is ${pu.status}.`)
  return pu
}

/** Payments and returns cannot be dated before the invoice they belong to. */
function assertNotBefore(date: string, pu: { date: string; invoiceNo: string }) {
  if (date < pu.date) throw new FieldErrors({ date: `Date cannot be before the purchase date (${pu.date}).` })
}

/** Pay (part of) one invoice's due. Cannot exceed the due. Row-locks the purchase, so concurrent payments cannot overpay. */
export async function recordVendorPayment(db: Db, companyId: string, userId: string, purchaseId: string, input: unknown, ctx: Ctx) {
  const d = parseOrFieldErrors(vendorPaymentSchema, input)
  return db.transaction(async (tx) => {
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    const pu = await lockPurchase(tx, companyId, purchaseId)
    assertPermits(ctx.restrict, pu.branchId, 'Purchase')
    assertNotBefore(d.date, pu)
    const amount = toMinor(d.amount)
    const due = toMinor(pu.due)
    if (due === 0) throw new FieldErrors({ amount: 'This invoice has nothing due.' }, 'This invoice has nothing due.')
    if (amount > due) throw new FieldErrors({ amount: `Amount cannot be more than the due (${pu.due}).` })
    await assertAccount(tx, companyId, d.accountId, 'accountId')
    const [payment] = await tx
      .insert(schema.payments)
      .values({ companyId, branchId, direction: 'out', accountId: d.accountId, partyType: 'vendor', partyId: pu.vendorId, refType: 'purchase', refId: pu.id, amount: d.amount, method: d.method, date: d.date, note: d.note, createdBy: userId })
      .returning({ id: schema.payments.id })
    const paid = fromMinor(toMinor(pu.paid) + amount)
    const s = settle({ total: pu.total, returned: pu.returnedTotal, paid })
    const [after] = await tx.update(schema.purchases).set({ paid, due: s.due, status: s.status, updatedAt: new Date() }).where(and(eq(schema.purchases.id, pu.id), eq(schema.purchases.companyId, companyId))).returning()
    await writeHistory(tx, { companyId, userId, entity: 'purchase', entityId: pu.id, diff: diffFields(pu, after, SETTLE_TRACKED) })
    await logActivity({ companyId, userId, action: 'purchase.payment', entity: 'purchase', entityId: pu.id, before: { paid: pu.paid, due: pu.due }, after: { paymentId: payment.id, amount: d.amount, paid, due: s.due } }, tx)
    return { paymentId: payment.id, paid, due: s.due }
  })
}

// ------------------------------------------------------------------ purchase return

/**
 * Return selected serial units of a purchase to the vendor.
 * Rules (documented in the Task 6 report):
 *  - only units of THIS purchase that are in_stock; each goes in_stock -> returned_to_vendor via transitionUnit;
 *  - credit = sum of the units' NET costs (product_units.purchase_price, which already carries the unit's exact share
 *    of the invoice discount), so returning every unit of an invoice credits exactly its total. The min() against
 *    (total - returned so far) is only a defensive guard for legacy rows;
 *  - credit first reduces the invoice due; anything beyond the due is vendor credit, which may be taken as a cash
 *    refund now (payments row direction 'in', ref purchase) up to that excess, or left as an advance on the vendor ledger.
 */
export async function createPurchaseReturn(db: Db, companyId: string, userId: string, purchaseId: string, input: unknown, ctx: Ctx) {
  const d = parseOrFieldErrors(purchaseReturnSchema, input)
  const unitIds = [...new Set(d.unitIds)].sort()
  if (unitIds.length !== d.unitIds.length) throw new FieldErrors({ unitIds: 'A unit was selected twice.' })
  try {
    return await returnTx(db, companyId, userId, purchaseId, d, unitIds, ctx)
  } catch (e) {
    if (isUniqueViolation(e, RETURN_NO_UQ)) throw new FieldErrors({ _: NUMBER_CLASH }, NUMBER_CLASH)
    throw e
  }
}

async function returnTx(db: Db, companyId: string, userId: string, purchaseId: string, d: ReturnType<typeof purchaseReturnSchema.parse>, unitIds: string[], ctx: Ctx) {
  return db.transaction(async (tx) => {
    // Goods leave from the ACTIVE branch: serial units must be located there, loose stock is checked there.
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    const pu = await lockPurchase(tx, companyId, purchaseId)
    assertPermits(ctx.restrict, pu.branchId, 'Purchase')
    assertNotBefore(d.date, pu)
    const u = schema.productUnits
    const units = unitIds.length
      ? await tx
          .select({ id: u.id, serialNo: u.serialNo, productId: u.productId, purchaseItemId: u.purchaseItemId, purchasePrice: u.purchasePrice, status: u.status, branchId: u.branchId })
          .from(u)
          .innerJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, u.purchaseItemId), eq(schema.purchaseItems.companyId, companyId)))
          .where(and(eq(u.companyId, companyId), eq(schema.purchaseItems.purchaseId, pu.id), inArray(u.id, unitIds)))
          .orderBy(asc(u.id))
      : []
    if (units.length !== unitIds.length) throw new FieldErrors({ unitIds: 'Some selected units are not part of this purchase.' })
    const blocked = units.filter((x) => !(RETURNABLE as readonly string[]).includes(x.status))
    if (blocked.length) throw new FieldErrors({ unitIds: `Only units in stock can be returned. Not in stock: ${formatSerialList(blocked.map((x) => x.serialNo))}` })
    const elsewhere = units.filter((x) => x.branchId !== branchId)
    if (elsewhere.length) {
      const b = await branchLabel(tx, companyId, elsewhere[0].branchId)
      const msg = `Only units in this branch can be returned from here. ${formatSerialList(elsewhere.map((x) => x.serialNo))} ${elsewhere.length === 1 ? 'is' : 'are'} in ${b?.name ?? 'another branch'}; transfer ${elsewhere.length === 1 ? 'it' : 'them'} first.`
      throw new FieldErrors({ unitIds: msg }, msg)
    }

    // ---- non-serial lines (Task 12) ----
    const pi = schema.purchaseItems
    const lineIds = d.lines.map((l) => l.purchaseItemId)
    if (new Set(lineIds).size !== lineIds.length) throw new FieldErrors({ lines: 'A line was selected twice.' })
    const items = lineIds.length
      ? await tx.select({ id: pi.id, productId: pi.productId, qty: pi.qty, netTotal: pi.netTotal }).from(pi).where(and(eq(pi.companyId, companyId), eq(pi.purchaseId, pu.id), inArray(pi.id, lineIds)))
      : []
    if (items.length !== lineIds.length) throw new FieldErrors({ lines: 'Some selected lines are not part of this purchase.' }, 'Some selected lines are not part of this purchase.')
    const itemById = new Map(items.map((x) => [x.id, x]))

    // Products in id order: FOR UPDATE for loose stock leaving (serialises with sales and adjustments of the same product,
    // so on-hand can never go below zero), FOR SHARE for serial products (transitionUnit re-takes it; units are locked after).
    const plainIds = new Set(items.map((x) => x.productId))
    const prodIds = [...new Set([...plainIds, ...units.map((x) => x.productId)])].sort()
    const prods = new Map<string, { id: string; name: string; trackSerial: boolean }>()
    for (const id of prodIds) {
      const [row] = await tx
        .select({ id: schema.products.id, name: schema.products.name, trackSerial: schema.products.trackSerial })
        .from(schema.products)
        .where(and(eq(schema.products.id, id), eq(schema.products.companyId, companyId)))
        .for(plainIds.has(id) ? 'update' : 'share')
      if (row) prods.set(id, row)
    }
    const lineErrs: Record<string, string> = {}
    const pri = schema.purchaseReturnItems
    const returnedRows = lineIds.length
      ? await tx
          .select({ itemId: pri.purchaseItemId, qty: sql<string>`coalesce(sum(${pri.qty}), 0)::text` })
          .from(pri)
          .where(and(eq(pri.companyId, companyId), inArray(pri.purchaseItemId, lineIds), sql`${pri.unitId} is null`))
          .groupBy(pri.purchaseItemId)
      : []
    const lineReturned = new Map(returnedRows.map((r) => [r.itemId, Number(r.qty)]))
    const want = new Map<string, number>()
    d.lines.forEach((l, i) => {
      const it = itemById.get(l.purchaseItemId)!
      const pr = prods.get(it.productId)
      if (!pr) lineErrs[`lines.${i}.qty`] = 'Product not found'
      else if (pr.trackSerial) lineErrs[`lines.${i}.qty`] = `${pr.name} is serial-tracked: select its units instead.`
      else {
        const avail = it.qty - (lineReturned.get(it.id) ?? 0)
        if (l.qty > avail) lineErrs[`lines.${i}.qty`] = avail <= 0 ? `Everything on this ${pr.name} line was already returned.` : `At most ${avail} of ${pr.name} can be returned on this line.`
      }
      want.set(it.productId, (want.get(it.productId) ?? 0) + l.qty)
    })
    if (Object.keys(lineErrs).length) throw new FieldErrors(lineErrs, Object.values(lineErrs)[0])
    // Stock sufficiency under the product lock: you cannot return what you have already sold.
    const onHand = await onHandQty(tx, companyId, branchId, [...want.keys()])
    d.lines.forEach((l, i) => {
      const it = itemById.get(l.purchaseItemId)!
      const have = onHand.get(it.productId) ?? 0
      const name = prods.get(it.productId)!.name
      if ((want.get(it.productId) ?? 0) > have) lineErrs[`lines.${i}.qty`] = have <= 0 ? `${name} is out of stock: units already sold cannot be returned.` : `Only ${have} of ${name} in stock: units already sold cannot be returned.`
    })
    if (Object.keys(lineErrs).length) throw new FieldErrors(lineErrs, Object.values(lineErrs)[0])
    // Credit per line at its NET cost: the line's net_total split exactly over its qty (splitEvenly), shares consumed in
    // order, so returning every unit of a line (in any number of steps) credits exactly the line's net total.
    const lineCredits = d.lines.map((l) => {
      const it = itemById.get(l.purchaseItemId)!
      return returnCredit(toMinor(it.netTotal), it.qty, lineReturned.get(it.id) ?? 0, l.qty)
    })

    const gross = minorSum(units.map((x) => x.purchasePrice)) + lineCredits.reduce((a, b) => a + b, 0)
    const total = toMinor(pu.total)
    const returnedBefore = toMinor(pu.returnedTotal)
    const credit = Math.min(gross, Math.max(0, total - returnedBefore))
    const returnedAfter = returnedBefore + credit
    const paidBefore = toMinor(pu.paid)
    const refundable = Math.max(0, returnedAfter + paidBefore - total)
    const refund = toMinor(d.refundAmount)
    if (refund > refundable)
      throw new FieldErrors({ refundAmount: refundable === 0 ? 'Nothing to refund: this return only reduces what you owe on the invoice.' : `At most ${fromMinor(refundable)} can be refunded for this return.` })
    if (refund > 0) {
      if (!d.refundAccountId) throw new FieldErrors({ refundAccountId: 'Choose the account the refund was received into' })
      await assertAccount(tx, companyId, d.refundAccountId, 'refundAccountId')
    }

    const returnNo = await nextDocNumber(tx, companyId, 'purchase_return')
    const returnId = randomUUID()
    await tx.insert(schema.purchaseReturns).values({ id: returnId, companyId, branchId, returnNo, purchaseId: pu.id, vendorId: pu.vendorId, date: d.date, creditTotal: fromMinor(credit), note: d.note, createdBy: userId })
    const itemRows = units.map((x) => ({ id: randomUUID(), companyId, purchaseReturnId: returnId, purchaseItemId: x.purchaseItemId as string, productId: x.productId, unitId: x.id, qty: 1, creditAmount: x.purchasePrice }))
    const lineRows = d.lines.map((l, i) => ({ id: randomUUID(), companyId, purchaseReturnId: returnId, purchaseItemId: l.purchaseItemId, productId: itemById.get(l.purchaseItemId)!.productId, unitId: null, qty: l.qty, creditAmount: fromMinor(lineCredits[i]) }))
    for (const part of chunks([...itemRows, ...lineRows])) await tx.insert(schema.purchaseReturnItems).values(part)
    const moves = lineRows.map((r) => ({ companyId, branchId, productId: r.productId, type: 'purchase_return' as const, qtyChange: -r.qty, refTable: 'purchase_return_items', refId: r.id, note: returnNo, createdBy: userId }))
    for (const part of chunks(moves)) await tx.insert(schema.stockMovements).values(part)
    for (const [i, x] of units.entries())
      await transitionUnit(tx, { companyId, userId, unitId: x.id, to: 'returned_to_vendor', allowedFrom: RETURNABLE, ref: { table: 'purchase_return_items', id: itemRows[i].id }, price: x.purchasePrice, note: d.note, meta: { returnNo, invoiceNo: pu.invoiceNo } })

    if (refund > 0 && d.refundAccountId)
      await tx.insert(schema.payments).values({ companyId, branchId, direction: 'in', accountId: d.refundAccountId, partyType: 'vendor', partyId: pu.vendorId, refType: 'purchase', refId: pu.id, amount: fromMinor(refund), date: d.date, note: `Refund for return ${returnNo}`, createdBy: userId })

    const paid = fromMinor(paidBefore - refund)
    const s = settle({ total: pu.total, returned: fromMinor(returnedAfter), paid })
    const [after] = await tx
      .update(schema.purchases)
      .set({ returnedTotal: fromMinor(returnedAfter), paid, due: s.due, status: s.status, updatedAt: new Date() })
      .where(and(eq(schema.purchases.id, pu.id), eq(schema.purchases.companyId, companyId)))
      .returning()
    await writeHistory(tx, { companyId, userId, entity: 'purchase', entityId: pu.id, diff: diffFields(pu, after, SETTLE_TRACKED) })
    await logActivity(
      { companyId, userId, action: 'purchase.return', entity: 'purchase_return', entityId: returnId, before: { paid: pu.paid, due: pu.due, returnedTotal: pu.returnedTotal }, after: { returnNo, purchaseId: pu.id, units: units.map((x) => x.serialNo), lines: lineRows.map((r) => ({ productId: r.productId, product: prods.get(r.productId)?.name, qty: r.qty, credit: r.creditAmount })), credit: fromMinor(credit), refund: fromMinor(refund), paid, due: s.due } },
      tx,
    )
    return { id: returnId, returnNo, credit: fromMinor(credit), refund: fromMinor(refund), due: s.due, vendorCredit: s.excess }
  })
}
