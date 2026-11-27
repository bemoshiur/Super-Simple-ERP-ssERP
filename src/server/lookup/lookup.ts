/**
 * Serial lookup and unit history (read side). Every function takes (db, companyId, ...) with companyId from the session
 * only, and every table touched is filtered by it. Cost and profit are returned ONLY when `withCost` is true (the caller
 * passes canSeeProfit(session)); otherwise those fields are null/absent, so they can never reach a client component.
 *
 * Branches (Task 14): serial SEARCH is company-wide (to find where a unit is), but for a viewer restricted to one branch
 * (`restrict` set) a unit located elsewhere only shows its serial, status and branch; its detail page is refused with
 * UnitInOtherBranchError (which carries exactly those three facts). Warranty lists and the customer panel take a BranchFilter.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm'
import { branchCond, type BranchFilter } from '../branch'
import { addDays, appTimezone, localDate } from '../dates'
import { schema, type Db } from '../db'
import { NotFoundError } from '../errors'
import { fromMinor, toMinor } from '../money'
import { likePattern } from '../pagination'
import { can, type PermissionSubject } from '../rbac'
import { PROFIT_PERMISSIONS } from '../sales/sales'
import { lineProfit } from '../sales/totals'
import type { UnitStatus } from '../serials'
import { buildTimeline, normalizeSearchTerm, warrantyInfo, type RawTimelineEvent, type TimelineDoc, type TimelineEntry, type WarrantyInfo } from './pure'

type Reader = Pick<Db, 'select'>

/** Same rule as the sales pages: purchase cost and profit are shown with reports.view or sales.edit only. */
export const canSeeProfit = (s: PermissionSubject): boolean => PROFIT_PERMISSIONS.some((k) => can(s, k))

export const SEARCH_LIMIT = 20

// ------------------------------------------------------------------ search

export type SerialSummary = {
  id: string
  serialNo: string
  /** '' when the unit is outside the viewer's branch (only serial, status and branch are shown then). */
  productName: string
  status: UnitStatus
  location: string | null
  warrantyEnd: string | null
  branchId: string | null
  branchName: string | null
  /** false: the unit is in another branch than the restricted viewer's; details are hidden and its page is not available. */
  inScope: boolean
}
export type SerialSearchResult = {
  /** The normalised term that was searched. */
  query: string
  /** Set when exactly one unit matched (exact, case-insensitive-exact or a single partial hit): go straight to it. */
  redirectUnitId: string | null
  /** 'exact' | 'exact_ci' (differs only by letter case) | 'partial' | 'none' | 'empty' */
  match: 'exact' | 'exact_ci' | 'partial' | 'none' | 'empty'
  matches: SerialSummary[]
  /** More than SEARCH_LIMIT partial matches exist. */
  truncated: boolean
}

/**
 * Scan-friendly search. 1) exact (case-sensitive, matches the unique index), 2) if none: case-insensitive exact,
 * 3) if none: partial ILIKE with wildcards escaped, max 20. One hit at any step means redirect to that unit.
 */
export async function searchSerials(db: Reader, companyId: string, restrict: BranchFilter, raw: unknown): Promise<SerialSearchResult> {
  const query = normalizeSearchTerm(raw)
  if (!query) return { query, redirectUnitId: null, match: 'empty', matches: [], truncated: false }
  const u = schema.productUnits
  const base = () =>
    db
      .select({ id: u.id, serialNo: u.serialNo, productName: schema.products.name, status: u.status, location: u.location, warrantyEnd: u.warrantyEnd, branchId: u.branchId, branchName: schema.branches.name })
      .from(u)
      .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
      .leftJoin(schema.branches, and(eq(schema.branches.id, u.branchId), eq(schema.branches.companyId, companyId)))
  const mask = (r: Omit<SerialSummary, 'inScope'>): SerialSummary => (restrict && r.branchId !== restrict ? { ...r, productName: '', location: null, warrantyEnd: null, inScope: false } : { ...r, inScope: true })
  const done = (match: SerialSearchResult['match'], raw: Omit<SerialSummary, 'inScope'>[], truncated = false): SerialSearchResult => {
    const rows = raw.map(mask)
    return { query, match, matches: rows, truncated, redirectUnitId: rows.length === 1 && rows[0].inScope ? rows[0].id : null }
  }

  const exact = await base().where(and(eq(u.companyId, companyId), eq(u.serialNo, query))).limit(2)
  if (exact.length) return done('exact', exact)
  const ci = await base().where(and(eq(u.companyId, companyId), sql`lower(${u.serialNo}) = lower(${query})`)).orderBy(asc(u.serialNo)).limit(SEARCH_LIMIT)
  if (ci.length) return done('exact_ci', ci)
  const part = await base().where(and(eq(u.companyId, companyId), ilike(u.serialNo, likePattern(query)))).orderBy(asc(u.serialNo)).limit(SEARCH_LIMIT + 1)
  if (part.length) return done('partial', part.slice(0, SEARCH_LIMIT), part.length > SEARCH_LIMIT)
  return done('none', [])
}

/** Resolve a URL segment that is a serial (not a uuid) to a unit id: exact, then case-insensitive exact when unambiguous. */
export async function findUnitIdBySerial(db: Reader, companyId: string, raw: unknown): Promise<string | null> {
  const r = await searchSerials(db, companyId, null, raw)
  return (r.match === 'exact' || r.match === 'exact_ci') && r.matches.length === 1 ? r.matches[0].id : null
}

// ------------------------------------------------------------------ unit detail

export type UnitSaleLine = {
  saleItemId: string
  saleId: string
  invoiceNo: string
  date: string
  customerId: string | null
  customerName: string | null
  /** The line's price and its revenue after the invoice discount share. */
  salePrice: string
  netRevenue: string
  returned: boolean
  /** True for the invoice the unit is sold on right now. */
  current: boolean
  /** net revenue - cost, 0.00 when the line was returned. null unless withCost. */
  profit: string | null
}

export type UnitTicket = { id: string; ticketNo: string | null; status: string; issue: string; resolution: string | null; notes: string | null; outcome: string | null; underWarranty: boolean; openedAt: Date; closedAt: Date | null; openedByName: string | null; closedByName: string | null }

export type UnitDetail = {
  unit: { id: string; serialNo: string; status: UnitStatus; location: string | null; locationLabel: string; soldAt: Date | null; createdAt: Date; branchId: string | null; branchName: string | null }
  product: { id: string; name: string; sku: string; categoryName: string | null; brandName: string | null }
  vendor: { id: string; name: string } | null
  purchase: { id: string; invoiceNo: string; date: string } | null
  /** Net (discount-allocated) unit cost. null unless withCost. */
  cost: string | null
  /** The sale the unit is currently sold on (status sold / in_service); null otherwise. */
  currentSale: UnitSaleLine | null
  /** Every sale line this unit was ever on, newest first (resold units show all invoices). */
  sales: UnitSaleLine[]
  warranty: ({ start: string | null; end: string | null; months: number } & WarrantyInfo) | null
  flags: { returnedByCustomer: number; serviceTickets: number; inService: boolean; underWarrantyNow: boolean; returnedToVendor: boolean }
  tickets: UnitTicket[]
  activeTicketId: string | null
  timeline: TimelineEntry[]
  today: string
}

/** A restricted viewer opened a unit located in another branch: only these facts may be shown. */
export class UnitInOtherBranchError extends NotFoundError {
  constructor(
    public serialNo: string,
    public status: UnitStatus,
    public branchName: string | null,
  ) {
    super('Serial')
    this.name = 'UnitInOtherBranchError'
  }
}

const NOT_SOLD_LABEL: Record<UnitStatus, string> = { in_stock: 'In stock', sold: 'Sold', in_service: 'In service', damaged: 'Damaged', returned_to_vendor: 'Returned to vendor' }

export async function getUnitDetail(db: Reader, companyId: string, restrict: BranchFilter, ref: { id: string } | { serial: string }, opts: { withCost: boolean; today?: string; order?: 'asc' | 'desc' }): Promise<UnitDetail> {
  const u = schema.productUnits
  const key = 'id' in ref ? eq(u.id, ref.id) : eq(u.serialNo, ref.serial)
  const [row] = await db
    .select({
      unit: u,
      productName: schema.products.name,
      sku: schema.products.sku,
      categoryName: schema.categories.name,
      brandName: schema.brands.name,
      vendorId: schema.vendors.id,
      vendorName: schema.vendors.name,
      purchaseId: schema.purchases.id,
      purchaseInvoice: schema.purchases.invoiceNo,
      purchaseDate: schema.purchases.date,
      branchName: schema.branches.name,
    })
    .from(u)
    .leftJoin(schema.branches, and(eq(schema.branches.id, u.branchId), eq(schema.branches.companyId, companyId)))
    .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
    .leftJoin(schema.categories, and(eq(schema.categories.id, schema.products.categoryId), eq(schema.categories.companyId, companyId)))
    .leftJoin(schema.brands, and(eq(schema.brands.id, schema.products.brandId), eq(schema.brands.companyId, companyId)))
    .leftJoin(schema.vendors, and(eq(schema.vendors.id, u.vendorId), eq(schema.vendors.companyId, companyId)))
    .leftJoin(schema.purchaseItems, and(eq(schema.purchaseItems.id, u.purchaseItemId), eq(schema.purchaseItems.companyId, companyId)))
    .leftJoin(schema.purchases, and(eq(schema.purchases.id, schema.purchaseItems.purchaseId), eq(schema.purchases.companyId, companyId)))
    .where(and(eq(u.companyId, companyId), key))
  if (!row) throw new NotFoundError('Serial')
  const unit = row.unit
  const status = unit.status as UnitStatus
  if (restrict && unit.branchId !== restrict) throw new UnitInOtherBranchError(unit.serialNo, status, row.branchName)
  const today = opts.today ?? localDate(appTimezone())

  // ---- every sale line of this unit
  const si = schema.saleItems
  const sa = schema.sales
  const sri = schema.saleReturnItems
  const lines = await db
    .select({
      saleItemId: si.id,
      saleId: sa.id,
      invoiceNo: sa.invoiceNo,
      date: sa.date,
      createdAt: sa.createdAt,
      customerId: sa.customerId,
      customerName: schema.customers.name,
      saleBranchId: sa.branchId,
      unitPrice: si.unitPrice,
      netTotal: si.netTotal,
      cost: si.unitCostSnapshot,
      qty: si.qty,
      returnedCredit: sql<string | null>`(select sum(${sri.refundAmount})::text from ${sri} where ${sri.saleItemId} = ${si.id} and ${sri.unitId} = ${unit.id} and ${sri.companyId} = ${companyId})`,
    })
    .from(si)
    .innerJoin(sa, and(eq(sa.id, si.saleId), eq(sa.companyId, companyId)))
    .leftJoin(schema.customers, and(eq(schema.customers.id, sa.customerId), eq(schema.customers.companyId, companyId)))
    .where(and(eq(si.companyId, companyId), eq(si.unitId, unit.id)))
    .orderBy(desc(sa.date), desc(sa.createdAt), desc(si.id))
  const saleLines: UnitSaleLine[] = lines.map((l) => {
    const returned = l.returnedCredit !== null
    // Same formula as getSale(): (net - cost) minus what a return took back ((credit - cost)); a fully returned line nets to 0.
    const gross = lineProfit(l.netTotal, l.qty, l.cost)
    const back = returned ? toMinor(l.returnedCredit as string) - toMinor(l.cost) * l.qty : 0
    // A sale made by another branch (the unit was transferred since): a restricted viewer sees the invoice number only.
    const foreign = !!restrict && l.saleBranchId !== restrict
    return {
      saleItemId: l.saleItemId,
      saleId: l.saleId,
      invoiceNo: l.invoiceNo,
      date: l.date,
      customerId: foreign ? null : l.customerId,
      customerName: foreign ? null : l.customerName,
      salePrice: fromMinor(toMinor(l.unitPrice)),
      netRevenue: fromMinor(toMinor(l.netTotal)),
      returned,
      current: (status === 'sold' || status === 'in_service') && unit.saleItemId === l.saleItemId,
      profit: opts.withCost && !foreign ? fromMinor(gross - back) : null,
    }
  })
  const currentSale = saleLines.find((l) => l.current) ?? null

  // ---- tickets
  const t = schema.serviceTickets
  const openedBy = schema.users
  const tickets: UnitTicket[] = await db
    .select({ id: t.id, ticketNo: t.ticketNo, status: t.status, issue: t.issue, resolution: t.resolution, notes: t.notes, outcome: t.outcome, underWarranty: t.underWarranty, openedAt: t.openedAt, closedAt: t.closedAt, openedByName: openedBy.name, closedByName: sql<string | null>`(select name from ${schema.users} cu where cu.id = ${t.closedBy} and cu.company_id = ${companyId})` })
    .from(t)
    .leftJoin(openedBy, and(eq(openedBy.id, t.openedBy), eq(openedBy.companyId, companyId)))
    .where(and(eq(t.companyId, companyId), eq(t.unitId, unit.id)))
    .orderBy(desc(t.openedAt), desc(t.id))
  const active = tickets.find((x) => x.status === 'open' || x.status === 'in_progress') ?? null

  // ---- events (oldest first from SQL; buildTimeline orders again for the requested direction)
  const ev = schema.unitEvents
  const events = await db
    .select({ id: ev.id, type: ev.type, at: ev.createdAt, fromStatus: ev.fromStatus, toStatus: ev.toStatus, price: ev.price, note: ev.note, actorName: schema.users.name, refTable: ev.refTable, refId: ev.refId })
    .from(ev)
    .leftJoin(schema.users, and(eq(schema.users.id, ev.actorUserId), eq(schema.users.companyId, companyId)))
    .where(and(eq(ev.companyId, companyId), eq(ev.unitId, unit.id)))
    .orderBy(asc(ev.createdAt), asc(ev.id))
  const docs = await resolveEventDocs(db, companyId, events)
  const raw: RawTimelineEvent[] = events.map((e) => ({
    id: e.id,
    type: e.type,
    at: e.at,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    // purchase cost lives on 'purchased' / 'returned_to_vendor' events: only for roles that may see cost
    price: !opts.withCost && (e.type === 'purchased' || e.type === 'returned_to_vendor') ? null : e.price,
    note: e.note,
    actorName: e.actorName,
    doc: e.refTable && e.refId ? (docs.get(`${e.refTable}:${e.refId}`) ?? null) : null,
  }))

  const w = unit.warrantyStart || unit.warrantyEnd ? warrantyInfo(unit.warrantyEnd, today) : status === 'sold' ? warrantyInfo(null, today) : null
  const warranty = w ? { start: unit.warrantyStart, end: unit.warrantyEnd, months: unit.warrantyMonths, ...w } : null
  const customerLabel = currentSale ? (currentSale.customerName ?? 'Walk-in customer') : null
  return {
    unit: {
      id: unit.id,
      serialNo: unit.serialNo,
      status,
      location: unit.location,
      locationLabel: status === 'sold' ? `With customer${customerLabel ? ` (${customerLabel})` : ''}` : status === 'in_stock' ? (unit.location ? `In stock · ${unit.location}` : NOT_SOLD_LABEL[status]) : status === 'in_service' ? `In service${unit.location ? ` · ${unit.location}` : ''}` : NOT_SOLD_LABEL[status],
      soldAt: unit.soldAt,
      createdAt: unit.createdAt,
      branchId: unit.branchId,
      branchName: row.branchName,
    },
    product: { id: unit.productId, name: row.productName, sku: row.sku, categoryName: row.categoryName, brandName: row.brandName },
    vendor: row.vendorId ? { id: row.vendorId, name: row.vendorName as string } : null,
    purchase: row.purchaseId ? { id: row.purchaseId, invoiceNo: row.purchaseInvoice as string, date: row.purchaseDate as string } : null,
    cost: opts.withCost ? fromMinor(toMinor(unit.purchasePrice)) : null,
    currentSale,
    sales: saleLines,
    warranty,
    flags: {
      returnedByCustomer: events.filter((e) => e.type === 'sale_returned').length,
      serviceTickets: tickets.length,
      inService: status === 'in_service',
      underWarrantyNow: !!w && (w.state === 'active' || w.state === 'expires_today') && (status === 'sold' || status === 'in_service'),
      returnedToVendor: status === 'returned_to_vendor',
    },
    tickets,
    activeTicketId: active?.id ?? null,
    timeline: buildTimeline(raw, opts.order ?? 'asc'),
    today,
  }
}

type RefEvent = { refTable: string | null; refId: string | null }

/** Document links for unit_events refs (purchase line, sale line, return lines, ticket), company-scoped, one query per kind. */
async function resolveEventDocs(db: Reader, companyId: string, events: RefEvent[]): Promise<Map<string, TimelineDoc>> {
  const ids = (table: string) => [...new Set(events.filter((e) => e.refTable === table && e.refId).map((e) => e.refId as string))]
  const out = new Map<string, TimelineDoc>()
  const pi = ids('purchase_items')
  if (pi.length) {
    const rows = await db
      .select({ ref: schema.purchaseItems.id, id: schema.purchases.id, no: schema.purchases.invoiceNo })
      .from(schema.purchaseItems)
      .innerJoin(schema.purchases, and(eq(schema.purchases.id, schema.purchaseItems.purchaseId), eq(schema.purchases.companyId, companyId)))
      .where(and(eq(schema.purchaseItems.companyId, companyId), inArray(schema.purchaseItems.id, pi)))
    for (const r of rows) out.set(`purchase_items:${r.ref}`, { kind: 'purchase', id: r.id, label: r.no, href: `/purchases/${r.id}` })
  }
  const sitems = ids('sale_items')
  if (sitems.length) {
    const rows = await db
      .select({ ref: schema.saleItems.id, id: schema.sales.id, no: schema.sales.invoiceNo })
      .from(schema.saleItems)
      .innerJoin(schema.sales, and(eq(schema.sales.id, schema.saleItems.saleId), eq(schema.sales.companyId, companyId)))
      .where(and(eq(schema.saleItems.companyId, companyId), inArray(schema.saleItems.id, sitems)))
    for (const r of rows) out.set(`sale_items:${r.ref}`, { kind: 'sale', id: r.id, label: r.no, href: `/sales/${r.id}` })
  }
  const sri = ids('sale_return_items')
  if (sri.length) {
    const rows = await db
      .select({ ref: schema.saleReturnItems.id, saleId: schema.sales.id, invoiceNo: schema.sales.invoiceNo, returnNo: schema.saleReturns.returnNo, id: schema.saleReturns.id })
      .from(schema.saleReturnItems)
      .innerJoin(schema.saleReturns, and(eq(schema.saleReturns.id, schema.saleReturnItems.saleReturnId), eq(schema.saleReturns.companyId, companyId)))
      .innerJoin(schema.sales, and(eq(schema.sales.id, schema.saleReturns.saleId), eq(schema.sales.companyId, companyId)))
      .where(and(eq(schema.saleReturnItems.companyId, companyId), inArray(schema.saleReturnItems.id, sri)))
    for (const r of rows) out.set(`sale_return_items:${r.ref}`, { kind: 'sale_return', id: r.id, label: `${r.returnNo} (${r.invoiceNo})`, href: `/sales/${r.saleId}` })
  }
  const pri = ids('purchase_return_items')
  if (pri.length) {
    const rows = await db
      .select({ ref: schema.purchaseReturnItems.id, purchaseId: schema.purchases.id, invoiceNo: schema.purchases.invoiceNo, returnNo: schema.purchaseReturns.returnNo, id: schema.purchaseReturns.id })
      .from(schema.purchaseReturnItems)
      .innerJoin(schema.purchaseReturns, and(eq(schema.purchaseReturns.id, schema.purchaseReturnItems.purchaseReturnId), eq(schema.purchaseReturns.companyId, companyId)))
      .innerJoin(schema.purchases, and(eq(schema.purchases.id, schema.purchaseReturns.purchaseId), eq(schema.purchases.companyId, companyId)))
      .where(and(eq(schema.purchaseReturnItems.companyId, companyId), inArray(schema.purchaseReturnItems.id, pri)))
    for (const r of rows) out.set(`purchase_return_items:${r.ref}`, { kind: 'purchase_return', id: r.id, label: `${r.returnNo} (${r.invoiceNo})`, href: `/purchases/${r.purchaseId}` })
  }
  const tk = ids('service_tickets')
  if (tk.length) {
    const rows = await db
      .select({ id: schema.serviceTickets.id, no: schema.serviceTickets.ticketNo })
      .from(schema.serviceTickets)
      .where(and(eq(schema.serviceTickets.companyId, companyId), inArray(schema.serviceTickets.id, tk)))
    for (const r of rows) out.set(`service_tickets:${r.id}`, { kind: 'service_ticket', id: r.id, label: r.no ?? 'Service ticket', href: `/service?q=${encodeURIComponent(r.no ?? '')}` })
  }
  return out
}

// ------------------------------------------------------------------ warranty expiry (Task 9 report) and customer panel

export type WarrantyExpiringRow = {
  unitId: string
  serialNo: string
  productName: string
  customerId: string | null
  customerName: string | null
  customerPhone: string | null
  saleId: string | null
  invoiceNo: string | null
  warrantyEnd: string
  daysLeft: number
}

/**
 * Sold units whose warranty ends within the next `days` days (today through today + days, both inclusive), soonest first.
 * Units that are not currently sold (returned, in service, damaged) are not listed. `today` defaults to the shop-local date.
 */
export async function listWarrantyExpiring(db: Reader, companyId: string, branch: BranchFilter, days: number, opts: { today?: string; limit?: number } = {}): Promise<WarrantyExpiringRow[]> {
  const n = Math.min(Math.max(Math.trunc(Number(days)) || 0, 0), 3650)
  const today = opts.today ?? localDate(appTimezone())
  const end = addDays(today, n)
  const u = schema.productUnits
  const rows = await db
    .select({
      unitId: u.id,
      serialNo: u.serialNo,
      productName: schema.products.name,
      customerId: schema.customers.id,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      saleId: schema.sales.id,
      invoiceNo: schema.sales.invoiceNo,
      warrantyEnd: u.warrantyEnd,
      daysLeft: sql<number>`(${u.warrantyEnd}::date - ${today}::date)::int`,
    })
    .from(u)
    .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
    .leftJoin(schema.saleItems, and(eq(schema.saleItems.id, u.saleItemId), eq(schema.saleItems.companyId, companyId)))
    .leftJoin(schema.sales, and(eq(schema.sales.id, schema.saleItems.saleId), eq(schema.sales.companyId, companyId)))
    .leftJoin(schema.customers, and(eq(schema.customers.id, schema.sales.customerId), eq(schema.customers.companyId, companyId)))
    .where(and(eq(u.companyId, companyId), branchCond(u.branchId, branch), eq(u.status, 'sold'), gte(u.warrantyEnd, today), lte(u.warrantyEnd, end)))
    .orderBy(asc(u.warrantyEnd), asc(u.serialNo))
    .limit(Math.min(Math.max(opts.limit ?? 500, 1), 5000))
  return rows.map((r) => ({ ...r, warrantyEnd: r.warrantyEnd as string, daysLeft: Number(r.daysLeft) }))
}

export type CustomerWarrantyUnit = { unitId: string; serialNo: string; productName: string; status: UnitStatus; invoiceNo: string; saleId: string; warrantyStart: string | null; warrantyEnd: string | null; info: WarrantyInfo }
export type CustomerTicketRow = { id: string; ticketNo: string | null; status: string; issue: string; outcome: string | null; underWarranty: boolean; openedAt: Date; closedAt: Date | null; unitId: string; serialNo: string; productName: string }

/** A customer's warranty position (units currently with them) and their service tickets, newest first. */
export async function getCustomerWarrantyPanel(db: Reader, companyId: string, branch: BranchFilter, customerId: string, opts: { today?: string } = {}) {
  const today = opts.today ?? localDate(appTimezone())
  const u = schema.productUnits
  const unitRows = await db
    .select({ unitId: u.id, serialNo: u.serialNo, productName: schema.products.name, status: u.status, invoiceNo: schema.sales.invoiceNo, saleId: schema.sales.id, warrantyStart: u.warrantyStart, warrantyEnd: u.warrantyEnd })
    .from(u)
    .innerJoin(schema.saleItems, and(eq(schema.saleItems.id, u.saleItemId), eq(schema.saleItems.companyId, companyId)))
    .innerJoin(schema.sales, and(eq(schema.sales.id, schema.saleItems.saleId), eq(schema.sales.companyId, companyId), eq(schema.sales.customerId, customerId)))
    .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
    .where(and(eq(u.companyId, companyId), branchCond(u.branchId, branch), inArray(u.status, ['sold', 'in_service'])))
    .orderBy(asc(sql`${u.warrantyEnd} is null`), asc(u.warrantyEnd), asc(u.serialNo))
    .limit(200)
  const t = schema.serviceTickets
  const tickets = await db
    .select({ id: t.id, ticketNo: t.ticketNo, status: t.status, issue: t.issue, outcome: t.outcome, underWarranty: t.underWarranty, openedAt: t.openedAt, closedAt: t.closedAt, unitId: u.id, serialNo: u.serialNo, productName: schema.products.name })
    .from(t)
    .innerJoin(u, and(eq(u.id, t.unitId), eq(u.companyId, companyId)))
    .innerJoin(schema.products, and(eq(schema.products.id, u.productId), eq(schema.products.companyId, companyId)))
    .where(and(eq(t.companyId, companyId), branchCond(t.branchId, branch), eq(t.customerId, customerId)))
    .orderBy(desc(t.openedAt), desc(t.id))
    .limit(100)
  return {
    units: unitRows.map((r): CustomerWarrantyUnit => ({ ...r, status: r.status as UnitStatus, info: warrantyInfo(r.warrantyEnd, today) })),
    tickets,
  }
}
