/**
 * Demo data for ONE company, created ONLY through the real data-layer functions (createPurchase, createSale, returns,
 * payments, expenses, incomes, transfers, service tickets), so every invariant holds and the books are consistent:
 * cash flow reconciles, stock is never negative, serial histories are real. Deterministic: the same names, serials,
 * prices and quantities every time, with dates relative to "today" in the shop's time zone.
 *
 * Runs in ONE transaction (all or nothing). Idempotent: the company setting `demo_seeded` is written at the end and a
 * second run does nothing. Refuses a company that already has business data unless `force` is set.
 */
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { createAccount } from '../accounting/accounts'
import { createExpense, createIncome, listExpenseCategories } from '../accounting/entries'
import { createTransfer } from '../accounting/accounts'
import { logActivity } from '../audit'
import { createProduct } from '../catalog/products'
import { createTaxon } from '../catalog/taxonomy'
import { defaultBranchId } from '../branch'
import { schema, type Db } from '../db'
import { addDays, appTimezone, localDate } from '../dates'
import { createParty } from '../parties/parties'
import { createPurchase, createPurchaseReturn, recordVendorPayment } from '../purchases/purchases'
import { createSale, createSaleReturn, getSale, recordCustomerPayment } from '../sales/sales'
import { openServiceTicket } from '../service/tickets'

export const DEMO_SETTING = 'demo_seeded'
export const DEMO_ACCOUNTS = [
  { name: 'Demo Cash', type: 'cash', openingBalance: '150000' },
  { name: 'Demo Bank', type: 'bank', openingBalance: '400000' },
  { name: 'Demo bKash', type: 'mobile', openingBalance: '20000' },
] as const

export class DemoRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoRefusedError'
  }
}

export type DemoArgs = { force: boolean; withUsers: boolean; yes: boolean; help: boolean; unknown: string[] }
export function parseDemoArgs(argv: readonly string[]): DemoArgs {
  const out: DemoArgs = { force: false, withUsers: false, yes: false, help: false, unknown: [] }
  for (const a of argv) {
    if (a === '--force') out.force = true
    else if (a === '--with-users') out.withUsers = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--help' || a === '-h') out.help = true
    else out.unknown.push(a)
  }
  return out
}

// ------------------------------------------------------------------ target guard (pure)

export type DbTarget = { host: string; database: string; local: boolean }

/** Host and database of a connection string, WITHOUT credentials. Unparseable input is treated as remote (the safe side). */
/**
 * Where DATABASE_URL points, without credentials. libpq rules: a `?host=` query parameter overrides the URL host (that is how
 * socket and multi-host URLs are written); a URL with no host at all falls back to PGHOST, and only when PGHOST is unset too
 * does it mean the local default socket.
 */
export function describeTarget(url: string | undefined, env: Record<string, string | undefined> = process.env): DbTarget {
  try {
    const u = new URL(url ?? '')
    const query = u.searchParams.get('host') ?? ''
    const raw = decodeURIComponent(query || u.hostname || env.PGHOST || '')
    const host = raw.replace(/^\[|\]$/g, '')
    const hosts = host.split(',').map((h) => h.trim().replace(/^\[|\]$/g, ''))
    const isLocal = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('/')
    const local = host === '' ? !env.PGHOST : hosts.every(isLocal)
    return { host: host || '(local socket)', database: decodeURIComponent(u.pathname.replace(/^\//, '')) || '(default)', local }
  } catch {
    return { host: '(unreadable)', database: '(unknown)', local: false }
  }
}

export type TargetVerdict = { action: 'proceed' } | { action: 'confirm' } | { action: 'refuse'; message: string }

/**
 * A remote database (anything but localhost / 127.0.0.1 / ::1) or NODE_ENV=production needs an explicit --yes. Without it:
 * an interactive terminal is asked to confirm, anything else (CI, pipes, cron) is refused.
 */
export function evaluateTarget(target: DbTarget, o: { nodeEnv?: string; yes: boolean; interactive: boolean }): TargetVerdict {
  const risky = !target.local || o.nodeEnv === 'production'
  if (!risky || o.yes) return { action: 'proceed' }
  if (o.interactive) return { action: 'confirm' }
  return { action: 'refuse', message: `The target database is ${target.host}/${target.database}${o.nodeEnv === 'production' ? ' and NODE_ENV=production' : ''}, not a local development database. Demo data would be written into it. Re-run with --yes if that is really what you want.` }
}

// ------------------------------------------------------------------ the data

type P = { sku: string; name: string; category: string; brand: string; serial: boolean; warranty: number; buy: string; sell: string; low: number }
export const DEMO_PRODUCTS: readonly P[] = [
  { sku: 'CAM-HIK-2MP', name: 'Hikvision 2MP Bullet Camera', category: 'CCTV Cameras', brand: 'Hikvision', serial: true, warranty: 12, buy: '2000', sell: '2800', low: 2 },
  { sku: 'CAM-DAH-5MP', name: 'Dahua 5MP Dome Camera', category: 'CCTV Cameras', brand: 'Dahua', serial: true, warranty: 12, buy: '3200', sell: '4300', low: 2 },
  { sku: 'DVR-HIK-4CH', name: 'Hikvision 4-Channel DVR', category: 'DVR / NVR', brand: 'Hikvision', serial: true, warranty: 12, buy: '4500', sell: '5900', low: 1 },
  { sku: 'DVR-DAH-8CH', name: 'Dahua 8-Channel DVR', category: 'DVR / NVR', brand: 'Dahua', serial: true, warranty: 12, buy: '6800', sell: '8500', low: 2 },
  { sku: 'PHN-REDMI-13C', name: 'Xiaomi Redmi 13C 4/128GB', category: 'Mobile Phones', brand: 'Xiaomi', serial: true, warranty: 12, buy: '12500', sell: '14500', low: 2 },
  { sku: 'PHN-SAM-A15', name: 'Samsung Galaxy A15 6/128GB', category: 'Mobile Phones', brand: 'Samsung', serial: true, warranty: 12, buy: '18500', sell: '21000', low: 1 },
  { sku: 'PHN-SYM-Z60', name: 'Symphony Z60 Feature+Smart', category: 'Mobile Phones', brand: 'Symphony', serial: true, warranty: 6, buy: '4200', sell: '5200', low: 2 },
  { sku: 'RTR-TPL-C6', name: 'TP-Link Archer C6 AC1200 Router', category: 'Networking', brand: 'TP-Link', serial: true, warranty: 12, buy: '1850', sell: '2500', low: 2 },
  { sku: 'RTR-TND-N300', name: 'Tenda N300 Wi-Fi Router', category: 'Networking', brand: 'Tenda', serial: true, warranty: 6, buy: '780', sell: '1100', low: 3 },
  { sku: 'CBL-CAT6-M', name: 'CAT6 UTP Cable (per metre)', category: 'Cables & Accessories', brand: 'Generic', serial: false, warranty: 0, buy: '28', sell: '40', low: 50 },
  { sku: 'CBL-HDMI-15', name: 'HDMI Cable 1.5 m', category: 'Cables & Accessories', brand: 'Generic', serial: false, warranty: 0, buy: '85', sell: '150', low: 10 },
  { sku: 'ACC-PSU-12V', name: '12V 2A Power Adapter', category: 'Cables & Accessories', brand: 'Generic', serial: false, warranty: 0, buy: '220', sell: '350', low: 5 },
]
export const DEMO_SKUS = DEMO_PRODUCTS.map((p) => p.sku)
export const DEMO_VENDORS = ['ABC Electronics', 'Dhaka Network House', 'Smart Mobile Wholesale'] as const
export const DEMO_CUSTOMERS = ['Rahim', 'Karim Uddin', 'Nusrat Jahan', 'Tanvir Hossain', 'সুমাইয়া আক্তার', 'Green Valley School'] as const
/** The brief's example. */
export const BRIEF_SERIAL = 'HIK123456789'

/** Deterministic serials: prefix + zero-padded counter. */
const serials = (prefix: string, from: number, n: number, pad = 0) => Array.from({ length: n }, (_, i) => `${prefix}${String(from + i).padStart(pad, '0')}`)

export type DemoSummary = {
  products: number
  vendors: number
  customers: number
  purchases: number
  sales: number
  units: number
  customerReturns: number
  vendorReturns: number
  serviceTickets: number
  expenses: number
  incomes: number
  transfers: number
  briefSerial: string
  briefInvoices: { purchase: string; sale: string }
}
export type DemoResult = { status: 'seeded'; summary: DemoSummary } | { status: 'already_seeded' }

export type DemoOptions = { force?: boolean; /** YYYY-MM-DD; default today in the shop's time zone. Tests pin it. */ today?: string; log?: (message: string) => void }

/**
 * Business data the company already has. Anything here means "this is not an empty, freshly installed company":
 * products, parties, invoices, expenses, incomes, payments (receipts, transfers), service tickets, stock movements and
 * adjustments, and any account with a non-zero opening balance.
 */
export async function businessDataCounts(db: Pick<Db, 'select'>, companyId: string) {
  type T = typeof schema.products | typeof schema.vendors | typeof schema.customers | typeof schema.purchases | typeof schema.sales | typeof schema.expenses | typeof schema.incomes | typeof schema.payments | typeof schema.serviceTickets | typeof schema.stockMovements | typeof schema.stockAdjustments
  const c = async (t: T) => Number((await db.select({ n: count() }).from(t).where(eq(t.companyId, companyId)))[0].n)
  const openings = Number((await db.select({ n: count() }).from(schema.accounts).where(and(eq(schema.accounts.companyId, companyId), ne(schema.accounts.openingBalance, '0')))) [0].n)
  return {
    products: await c(schema.products),
    vendors: await c(schema.vendors),
    customers: await c(schema.customers),
    purchases: await c(schema.purchases),
    sales: await c(schema.sales),
    expenses: await c(schema.expenses),
    incomes: await c(schema.incomes),
    payments: await c(schema.payments),
    'service tickets': await c(schema.serviceTickets),
    'stock movements': await c(schema.stockMovements),
    'stock adjustments': await c(schema.stockAdjustments),
    'accounts with an opening balance': openings,
  }
}

export async function seedDemo(db: Db, companyId: string, userId: string, opts: DemoOptions = {}): Promise<DemoResult> {
  const log = opts.log ?? (() => {})
  const marker = await db.select({ v: schema.settings.value }).from(schema.settings).where(and(eq(schema.settings.companyId, companyId), eq(schema.settings.key, DEMO_SETTING)))
  if (marker.length && !opts.force) return { status: 'already_seeded' }

  const have = await businessDataCounts(db, companyId)
  const occupied = Object.entries(have).filter(([, n]) => n > 0)
  if (occupied.length && !opts.force)
    throw new DemoRefusedError(`This company already has data (${occupied.map(([k, n]) => `${n} ${k}`).join(', ')}). Demo data is meant for an empty, freshly installed company. Use --force only if you really want to add the demo records to it.`)
  if (opts.force) {
    const clash = await db.select({ sku: schema.products.sku }).from(schema.products).where(and(eq(schema.products.companyId, companyId), inArray(schema.products.sku, DEMO_SKUS)))
    if (clash.length) throw new DemoRefusedError(`Cannot add the demo data: these product SKUs already exist: ${clash.map((c) => c.sku).join(', ')}. Nothing was changed.`)
    // Category / brand names are unique per company (case-insensitive): refuse cleanly instead of failing on the unique index.
    const lower = (xs: Iterable<string>) => [...new Set([...xs].map((x) => x.toLowerCase()))]
    const cats = lower(DEMO_PRODUCTS.map((p) => p.category))
    const brands = lower(DEMO_PRODUCTS.map((p) => p.brand))
    const takenCats = await db.select({ name: schema.categories.name }).from(schema.categories).where(and(eq(schema.categories.companyId, companyId), inArray(sql`lower(${schema.categories.name})`, cats)))
    const takenBrands = await db.select({ name: schema.brands.name }).from(schema.brands).where(and(eq(schema.brands.companyId, companyId), inArray(sql`lower(${schema.brands.name})`, brands)))
    if (takenCats.length || takenBrands.length)
      throw new DemoRefusedError(
        `Cannot add the demo data: ${[takenCats.length ? `categories ${takenCats.map((c) => c.name).join(', ')}` : '', takenBrands.length ? `brands ${takenBrands.map((b) => b.name).join(', ')}` : ''].filter(Boolean).join(' and ')} already exist. Rename them first. Nothing was changed.`,
      )
  }

  const today = opts.today ?? localDate(appTimezone())
  const d = (daysAgo: number) => addDays(today, -daysAgo)

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db // nested db.transaction() calls become savepoints: one outer transaction, all or nothing
    const cid = companyId
    // Every demo document goes to the company's default (Main) branch, explicitly.
    const wctx = { branchId: await defaultBranchId(t, cid), restrict: null }
    const uid = userId

    // ---- accounts: dedicated DEMO accounts with their own opening balances ("owner capital"), so existing accounts and their
    // balances are never touched (--force on a real company must not change real money) and no demo account goes negative.
    const existing = await t.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.companyId, cid))
    const taken = DEMO_ACCOUNTS.filter((a) => existing.some((e) => e.name.toLowerCase() === a.name.toLowerCase()))
    if (taken.length) throw new DemoRefusedError(`These account names already exist: ${taken.map((a) => a.name).join(', ')}. Rename them first. Nothing was changed.`)
    const cash = await createAccount(t, cid, uid, DEMO_ACCOUNTS[0])
    const bank = await createAccount(t, cid, uid, DEMO_ACCOUNTS[1])
    const bkash = await createAccount(t, cid, uid, DEMO_ACCOUNTS[2])

    // ---- catalogue
    const cats = new Map<string, string>()
    const brands = new Map<string, string>()
    for (const p of DEMO_PRODUCTS) {
      if (!cats.has(p.category)) cats.set(p.category, (await createTaxon(t, cid, uid, 'category', { name: p.category })).id)
      if (!brands.has(p.brand)) brands.set(p.brand, (await createTaxon(t, cid, uid, 'brand', { name: p.brand })).id)
    }
    const prod: Record<string, { id: string }> = {}
    for (const p of DEMO_PRODUCTS) {
      prod[p.sku] = await createProduct(t, cid, uid, { name: p.name, sku: p.sku, categoryId: cats.get(p.category), brandId: brands.get(p.brand), trackSerial: p.serial, warrantyMonths: p.warranty, purchasePrice: p.buy, salePrice: p.sell, lowStockThreshold: p.low })
    }

    // ---- parties
    const phones = ['01711-000101', '01811-000102', '01911-000103']
    const vendors: { id: string }[] = []
    for (const [i, name] of DEMO_VENDORS.entries()) vendors.push(await createParty(t, cid, uid, 'vendor', { name, phone: phones[i], address: ['Islampur, Dhaka', 'Elephant Road, Dhaka', 'Chawkbazar, Chattogram'][i] }))
    const [vAbc, vDnh, vSmw] = vendors
    const customers: Record<string, { id: string }> = {}
    for (const [i, name] of DEMO_CUSTOMERS.entries()) customers[name] = await createParty(t, cid, uid, 'customer', { name, phone: `01${3 + (i % 6)}1-00020${i}`, address: i === 5 ? 'Green Valley, Savar' : null })
    const rahim = customers['Rahim']

    // ---- purchases (dates are days ago)
    const buy = (vendorId: string, daysAgo: number, items: { sku: string; qty: number; cost?: string; serials?: string[] }[], extra: { discount?: string; paid?: string; accountId?: string; note?: string } = {}) =>
      createPurchase(t, cid, uid, { vendorId, date: d(daysAgo), note: extra.note, discount: extra.discount, paid: extra.paid, accountId: extra.accountId, items: items.map((i) => ({ productId: prod[i.sku].id, qty: i.qty, unitCost: i.cost ?? DEMO_PRODUCTS.find((p) => p.sku === i.sku)!.buy, serials: i.serials ?? [] })) }, wctx)
    const hik = serials('HIK', 123456789, 12)
    const pur1 = await buy(vAbc.id, 45, [{ sku: 'CAM-HIK-2MP', qty: 12, serials: hik }, { sku: 'DVR-HIK-4CH', qty: 4, serials: serials('HDVR-2026-', 1, 4, 4) }], { paid: '42000', accountId: bank.id, note: 'Vendor bill ABC-2231' })
    await buy(vAbc.id, 42, [{ sku: 'CBL-HDMI-15', qty: 50 }, { sku: 'ACC-PSU-12V', qty: 20 }], { note: 'On credit' })
    const pur3 = await buy(
      vDnh.id,
      38,
      [
        { sku: 'CAM-DAH-5MP', qty: 6, serials: serials('DAH5-', 1001, 6) },
        { sku: 'DVR-DAH-8CH', qty: 3, serials: serials('DDVR8-', 501, 3) },
        { sku: 'RTR-TPL-C6', qty: 8, serials: serials('TPC6-', 70001, 8) },
        { sku: 'RTR-TND-N300', qty: 10, serials: serials('TND3-', 90001, 10) },
        { sku: 'CBL-CAT6-M', qty: 300 },
      ],
      { discount: '1000', paid: '30000', accountId: cash.id, note: 'Part payment, balance later' },
    )
    const imei = (start: number, n: number) => serials('35678901', start, n, 7) // 15-digit, IMEI-shaped
    const pur4 = await buy(
      vSmw.id,
      34,
      [
        { sku: 'PHN-REDMI-13C', qty: 8, serials: imei(2340001, 8) },
        { sku: 'PHN-SAM-A15', qty: 4, serials: imei(2350001, 4) },
        { sku: 'PHN-SYM-Z60', qty: 6, serials: imei(2360001, 6) },
      ],
      { discount: '2500', paid: '150000', accountId: bank.id, note: 'Festival offer: discount on the invoice' },
    )
    await recordVendorPayment(t, cid, uid, pur3.id, { amount: '20000', accountId: bank.id, date: d(20), note: 'Second instalment' }, wctx)

    // ---- sales
    const sell = (customerId: string | null, daysAgo: number, items: ({ serial: string } | { sku: string; qty: number })[], extra: { discount?: string; pay?: [string, string][] } = {}) =>
      createSale(t, cid, uid, {
        customerId,
        date: d(daysAgo),
        discount: extra.discount,
        items: items.map((i) => ('serial' in i ? { serial: i.serial, qty: 1, unitPrice: pickPrice(i.serial) } : { productId: prod[i.sku].id, qty: i.qty, unitPrice: DEMO_PRODUCTS.find((p) => p.sku === i.sku)!.sell })),
        payments: (extra.pay ?? []).map(([accountId, amount]) => ({ accountId, amount })),
      }, wctx)
    const prefixToSku: [string, string][] = [['HIK', 'CAM-HIK-2MP'], ['HDVR-', 'DVR-HIK-4CH'], ['DAH5-', 'CAM-DAH-5MP'], ['DDVR8-', 'DVR-DAH-8CH'], ['TPC6-', 'RTR-TPL-C6'], ['TND3-', 'RTR-TND-N300']]
    const skuOfSerial = (s: string) => {
      if (s.startsWith('35678901')) return s.startsWith('356789012340') ? 'PHN-REDMI-13C' : s.startsWith('356789012350') ? 'PHN-SAM-A15' : 'PHN-SYM-Z60'
      return prefixToSku.find(([p]) => s.startsWith(p))![1]
    }
    const pickPrice = (s: string) => DEMO_PRODUCTS.find((p) => p.sku === skuOfSerial(s))!.sell

    const cat = serials('DAH5-', 1001, 6)
    const ddvr = serials('DDVR8-', 501, 3)
    const hdvr = serials('HDVR-2026-', 1, 4, 4)
    const red = imei(2340001, 8)
    const sam = imei(2350001, 4)
    const sym = imei(2360001, 6)
    const tpc = serials('TPC6-', 70001, 8)
    const tnd = serials('TND3-', 90001, 10)

    // The brief's example: ABC Electronics -> HIK123456789 @2000 -> Rahim @2800 (part paid now, the rest later)
    const s1 = await sell(rahim.id, 28, [{ serial: BRIEF_SERIAL }], { pay: [[cash.id, '1800']] })
    const s2 = await sell(customers['Karim Uddin'].id, 26, [{ serial: hik[1] }, { serial: hik[2] }, { serial: hik[3] }, { serial: hdvr[0] }, { sku: 'ACC-PSU-12V', qty: 3 }], { discount: '350', pay: [[bank.id, '10000']] })
    await sell(null, 22, [{ serial: red[0] }, { sku: 'CBL-HDMI-15', qty: 2 }], { pay: [[cash.id, '14800']] })
    await sell(customers['Nusrat Jahan'].id, 18, [{ serial: sam[0] }], { pay: [[bkash.id, '21000']] })
    await sell(customers['Tanvir Hossain'].id, 14, [{ serial: ddvr[0] }, { serial: cat[0] }, { serial: cat[1] }, { serial: cat[2] }, { serial: cat[3] }], { pay: [[cash.id, '15000']] })
    await sell(customers['সুমাইয়া আক্তার'].id, 9, [{ serial: sym[0] }, { serial: sym[1] }, { serial: tnd[0] }, { serial: tpc[0] }], { pay: [[cash.id, '4000'], [bkash.id, '10000']] })
    await sell(customers['Green Valley School'].id, 4, [...hik.slice(4, 10).map((serial) => ({ serial })), { sku: 'CBL-CAT6-M', qty: 100 }, { serial: hdvr[1] }], { pay: [[bank.id, '10000']] })

    // a customer return (Karim sends one camera back; the credit reduces his due) and a vendor return (a faulty Symphony)
    const karimSale = await getSale(t, cid, null, s2.id)
    const camLine = karimSale.items.find((i) => i.serialNo === hik[1])
    if (!camLine) throw new Error('demo seed: sale line for the returned camera not found')
    await createSaleReturn(t, cid, uid, s2.id, { items: [{ saleItemId: camLine.id, qty: 1 }], date: d(3), note: 'Customer changed the order' }, wctx)
    const [faulty] = await t.select({ id: schema.productUnits.id }).from(schema.productUnits).where(and(eq(schema.productUnits.companyId, cid), eq(schema.productUnits.serialNo, sym[5])))
    await createPurchaseReturn(t, cid, uid, pur4.id, { unitIds: [faulty.id], date: d(10), note: 'Dead on arrival: credit note from the vendor' }, wctx)

    // collections
    await recordCustomerPayment(t, cid, uid, s1.id, { amount: '400', accountId: cash.id, date: d(5), note: 'Part of the balance' }, wctx)
    await recordCustomerPayment(t, cid, uid, s2.id, { amount: '2000', accountId: bank.id, date: d(2) }, wctx)

    // a service ticket: Nusrat's Samsung has a screen fault (left open: the unit is "in service")
    const [samUnit] = await t.select({ id: schema.productUnits.id }).from(schema.productUnits).where(and(eq(schema.productUnits.companyId, cid), eq(schema.productUnits.serialNo, sam[0])))
    await openServiceTicket(t, cid, uid, samUnit.id, { issue: 'Screen flickers after two weeks (warranty claim)', notes: 'Customer will collect after repair' }, wctx)

    // ---- expenses, other income, transfers
    const cats2 = await listExpenseCategories(t, cid, 'all')
    const catId = (name: string) => cats2.find((c) => c.name === name)?.id ?? null
    const expenses: [string, string, number, string, string][] = [
      ['Rent', '25000', 30, bank.id, 'Shop rent'],
      ['Salary', '18000', 28, cash.id, 'Staff salary'],
      ['Utilities', '3200', 20, cash.id, 'Electricity and internet'],
      ['Transport', '1500', 12, cash.id, 'Delivery to Chattogram'],
      ['Marketing', '2000', 8, bkash.id, 'Facebook boost'],
      ['Maintenance', '800', 3, cash.id, 'AC service'],
    ]
    for (const [cname, amount, ago, accountId, note] of expenses) await createExpense(t, cid, uid, { categoryId: catId(cname), accountId, amount, date: d(ago), note }, wctx)
    const incomes: [string, string, number, string, string][] = [
      ['Bank interest', '1250', 25, bank.id, 'Quarterly interest'],
      ['Commission', '3000', 11, bkash.id, 'bKash agent commission'],
      ['Scrap sale', '800', 6, cash.id, 'Old packaging sold'],
    ]
    for (const [category, amount, ago, accountId, note] of incomes) await createIncome(t, cid, uid, { category, accountId, amount, date: d(ago), note }, wctx)
    const transfers: [string, string, string, number, string][] = [
      [cash.id, bank.id, '30000', 27, 'Deposit to bank'],
      [bank.id, bkash.id, '10000', 16, 'Top up bKash'],
      [bkash.id, cash.id, '5000', 7, 'Cash out'],
    ]
    for (const [from, to, amount, ago, note] of transfers) await createTransfer(t, cid, uid, { fromAccountId: from, toAccountId: to, amount, date: d(ago), note }, wctx)

    // ---- marker (last: only a fully seeded company is "demo seeded")
    await tx
      .insert(schema.settings)
      .values({ companyId: cid, key: DEMO_SETTING, value: today })
      .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value: today } })
    const [unitCount] = await tx.select({ n: count() }).from(schema.productUnits).where(eq(schema.productUnits.companyId, cid))
    const summary: DemoSummary = {
      products: DEMO_PRODUCTS.length,
      vendors: DEMO_VENDORS.length,
      customers: DEMO_CUSTOMERS.length,
      purchases: 4,
      sales: 7,
      units: Number(unitCount.n),
      customerReturns: 1,
      vendorReturns: 1,
      serviceTickets: 1,
      expenses: expenses.length,
      incomes: incomes.length,
      transfers: transfers.length,
      briefSerial: BRIEF_SERIAL,
      briefInvoices: { purchase: pur1.invoiceNo, sale: s1.invoiceNo },
    }
    await logActivity({ companyId: cid, userId: uid, action: 'demo.seed', entity: 'company', entityId: cid, after: { ...summary } }, tx)
    log(`Demo data created: ${summary.purchases} purchases, ${summary.sales} sales, ${summary.units} serial units.`)
    return { status: 'seeded', summary } as DemoResult
  })
}
