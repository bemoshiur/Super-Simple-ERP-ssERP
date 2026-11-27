/**
 * Task 14 branch isolation matrix. Two branches of ONE company (Main and Dhaka), each with its own purchase, sale,
 * customer return, vendor return, payments, expense, income, adjustment and service ticket, all written through the real
 * data layer. A salesman of Dhaka (no branches.all) must not see ANY of Main's data through ANY branch-scoped read: every
 * list / detail / report / export / dashboard function is called with the restricted scope and its whole JSON output is
 * searched for Main's markers (invoice numbers, serials, notes, party names, document ids). Failing to scope a function
 * fails this test. Aggregates are also checked with the reconciliation property: All branches = Main + Dhaka.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

type Sess = { uid: string; cid: string; bid: null; role: string; adm: boolean; sv: number; perms: string[] }
const st = vi.hoisted(() => ({ session: null as null | Sess, cookie: undefined as string | undefined }))
vi.mock('../auth/current', async () => {
  const { requirePermission } = await import('../rbac')
  return { authorize: async (key: never) => requirePermission(st.session, key), getSession: async () => st.session, getSessionUser: async () => (st.session ? { session: st.session, name: 'x', email: 'x' } : null) }
})
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (n === 'sserp_branch' && st.cookie !== undefined ? { value: st.cookie } : undefined), set: () => {} }) }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})
beforeEach(async () => {
  await resetData()
  st.session = null
  st.cookie = undefined
})

const NOW = new Date('2026-11-27T06:00:00Z')
const TODAY = '2026-11-27'

/** Company A with Main + Dhaka (+ an empty Ctg), shared products, per-branch docs, and users per branch. */
async function world() {
  const { a } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb, schema } = await import('../db')
  const db = getDb()
  const { createBranch } = await import('./branches')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase, recordVendorPayment, createPurchaseReturn } = await import('../purchases/purchases')
  const { createSale, createSaleReturn, recordCustomerPayment, getSale } = await import('../sales/sales')
  const { createExpense, createIncome } = await import('../accounting/entries')
  const { adjustStock } = await import('../inventory/adjustments')
  const { openServiceTicket } = await import('../service/tickets')
  const { mainBranchId } = await import('@/test/seed')
  const main = await mainBranchId(a.cid)
  const dhaka = (await createBranch(db, a.cid, a.uid, { name: 'Dhaka', code: 'dhk', address: 'Road 1', phone: '017' })).id
  const ctg = (await createBranch(db, a.cid, a.uid, { name: 'Ctg', code: 'CTG' })).id
  const cam = await createProduct(db, a.cid, a.uid, { name: 'HIK Camera', sku: 'HIK-1', trackSerial: true, warrantyMonths: 1, purchasePrice: '1000', salePrice: '1500', lowStockThreshold: 100 })
  const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1', purchasePrice: '10', salePrice: '25', lowStockThreshold: 100 })
  const [cash] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, a.cid), eq(schema.accounts.name, 'Cash')))
  const [cat] = await db.select().from(schema.expenseCategories).where(eq(schema.expenseCategories.companyId, a.cid)).limit(1)

  const docs = async (tag: 'MAINX' | 'DHAKAX', branchId: string, f: number) => {
    const ctx = { branchId, restrict: null }
    const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: `Vendor-${tag}` })
    const customer = await createParty(db, a.cid, a.uid, 'customer', { name: `Cust-${tag}`, phone: f === 1 ? "01711-000001" : "01711-000002" })
    const serials = [1, 2, 3, 4].map((n) => `${tag}SN-${n}`)
    const pu = await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: '2026-11-20', note: `PNOTE-${tag}`, items: [{ productId: cam.id, qty: 4, unitCost: String(1000 * f), serials }, { productId: cable.id, qty: 10 * f, unitCost: '10', serials: [] }], paid: '100', accountId: cash.id }, ctx)
    const sa = await createSale(db, a.cid, a.uid, { customerId: customer.id, date: '2026-11-21', items: [{ serial: serials[0], qty: 1, unitPrice: String(1500 * f) }, { serial: serials[1], qty: 1, unitPrice: String(1500 * f) }, { productId: cable.id, qty: 2, unitPrice: '25' }], payments: [{ accountId: cash.id, amount: '500' }] }, ctx)
    const detail = await getSale(db, a.cid, null, sa.id)
    const cableLine = detail.items.find((i) => i.productId === cable.id)!
    const sr = await createSaleReturn(db, a.cid, a.uid, sa.id, { items: [{ saleItemId: cableLine.id, qty: 1 }], date: '2026-11-22', note: `SRNOTE-${tag}` }, ctx)
    await recordCustomerPayment(db, a.cid, a.uid, sa.id, { amount: String(10 * f), accountId: cash.id, date: '2026-11-22', note: `CPAY-${tag}` }, ctx)
    await recordVendorPayment(db, a.cid, a.uid, pu.id, { amount: String(5 * f), accountId: cash.id, date: '2026-11-22', note: `VPAY-${tag}` }, ctx)
    const [u4] = await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.companyId, a.cid), eq(schema.productUnits.serialNo, serials[3])))
    const pr = await createPurchaseReturn(db, a.cid, a.uid, pu.id, { unitIds: [u4.id], date: '2026-11-22', note: `PRNOTE-${tag}` }, ctx)
    const exp = await createExpense(db, a.cid, a.uid, { categoryId: cat.id, accountId: cash.id, amount: String(7 * f), date: '2026-11-23', note: `EXP-${tag}` }, ctx)
    const inc = await createIncome(db, a.cid, a.uid, { category: `INCCAT-${tag}`, accountId: cash.id, amount: String(3 * f), date: '2026-11-23', note: `INC-${tag}` }, ctx)
    const adj = await adjustStock(db, a.cid, a.uid, { kind: 'qty', productId: cable.id, qtyChange: -1, reason: 'damage', note: `ADJ-${tag}` }, ctx)
    const [u1] = await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.companyId, a.cid), eq(schema.productUnits.serialNo, serials[0])))
    const tk = await openServiceTicket(db, a.cid, a.uid, u1.id, { issue: `ISSUE-${tag}` }, ctx)
    const [u3] = await db.select().from(schema.productUnits).where(and(eq(schema.productUnits.companyId, a.cid), eq(schema.productUnits.serialNo, serials[2])))
    return { tag, vendor, customer, serials, pu, sa, sr, pr, exp, inc, adj, tk, units: { u1, u3, u4 }, markers: [pu.invoiceNo, sa.invoiceNo, sr.returnNo, pr.returnNo, tk.ticketNo, ...serials, `Vendor-${tag}`, `Cust-${tag}`, `EXP-${tag}`, `INC-${tag}`, `INCCAT-${tag}`, `ADJ-${tag}`, `ISSUE-${tag}`, `CPAY-${tag}`, `VPAY-${tag}`, `SRNOTE-${tag}`, `PRNOTE-${tag}`, `PNOTE-${tag}`, pu.id, sa.id, exp.id, inc.id, tk.id, u1.id, u3.id, u4.id] }
  }
  const M = await docs('MAINX', main, 1)
  const D = await docs('DHAKAX', dhaka, 2)

  // users: a Dhaka salesman (restricted) and a manager (branches.all), both real rows so branchScope reads their branch
  const { hashPassword } = await import('../auth/password')
  const roles = await db.select().from(schema.roles).where(eq(schema.roles.companyId, a.cid))
  const role = (n: string) => roles.find((r) => r.name === n)!.id
  const passwordHash = await hashPassword('password-1234')
  const [salesman] = await db.insert(schema.users).values({ companyId: a.cid, branchId: dhaka, roleId: role('salesman'), name: 'S', email: 's@x.test', passwordHash }).returning()
  const [manager] = await db.insert(schema.users).values({ companyId: a.cid, branchId: main, roleId: role('manager'), name: 'M', email: 'm@x.test', passwordHash }).returning()
  const perms = async (n: string) => (await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, role(n)))).map((r) => r.permission)
  const sessOf = (uid: string, roleName: string, p: string[]): Sess => ({ uid, cid: a.cid, bid: null, role: roleName, adm: false, sv: 0, perms: p })
  const salesmanS = sessOf(salesman.id, 'salesman', await perms('salesman'))
  const managerS = sessOf(manager.id, 'manager', await perms('manager'))
  // a "reports clerk" in Dhaka: wide read permissions, no branches.all (exercises every report/route as restricted)
  const [clerk] = await db.insert(schema.users).values({ companyId: a.cid, branchId: dhaka, roleId: role('salesman'), name: 'C', email: 'c@x.test', passwordHash }).returning()
  const clerkS = sessOf(clerk.id, 'clerk', ['reports.view', 'accounts.view', 'sales.view', 'sales.edit', 'sales.create', 'purchases.view', 'purchases.edit', 'products.view', 'products.edit', 'serials.view', 'serials.edit', 'serials.create', 'customers.view', 'vendors.view'])
  return { db, schema, a, main, dhaka, ctg, cam, cable, cash, M, D, salesmanS, managerS, clerkS }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x))
function expectNoLeak(label: string, value: unknown, markers: string[]) {
  const s = json(value)
  const hit = markers.filter((m) => m && s.includes(m))
  expect(hit, `${label} leaked ${hit.join(', ')}`).toEqual([])
}

describe('branch scope resolution', () => {
  it('restricted user: own branch only, any cookie ignored; branches.all: validated cookie, "all", fallback to home', async () => {
    const w = await world()
    const { resolveBranchScope } = await import('../branch')
    for (const cookie of [undefined, w.main, 'all', 'garbage', w.ctg]) {
      const s = await resolveBranchScope(w.db, w.salesmanS, cookie)
      expect(s).toMatchObject({ all: false, home: w.dhaka, filter: w.dhaka, restrict: w.dhaka, active: w.dhaka, multi: true })
    }
    const m = (c?: string) => resolveBranchScope(w.db, w.managerS, c)
    expect(await m()).toMatchObject({ all: true, home: w.main, filter: w.main, restrict: null, active: w.main })
    expect(await m(w.dhaka)).toMatchObject({ filter: w.dhaka, active: w.dhaka, restrict: null })
    expect(await m(w.dhaka.toUpperCase())).toMatchObject({ filter: w.dhaka })
    expect(await m('all')).toMatchObject({ filter: null, active: null, restrict: null })
    expect(await m('not-a-uuid')).toMatchObject({ filter: w.main })
    // another company's branch id (forged) -> home
    const foreign = (await w.db.select().from(w.schema.branches)).find((b) => b.companyId !== w.a.cid)!
    expect(await m(foreign.id)).toMatchObject({ filter: w.main })
    // a deactivated branch -> home
    await w.db.update(w.schema.branches).set({ active: false }).where(eq(w.schema.branches.id, w.ctg))
    expect(await m(w.ctg)).toMatchObject({ filter: w.main })
    const { requireWriteBranch } = await import('../branch')
    expect(() => requireWriteBranch({ active: null })).toThrow(/Choose a branch/)
  })
})

describe('isolation matrix: a Dhaka salesman/clerk never sees Main data', () => {
  it('every branch-scoped read, detail, report, export and dashboard function', async () => {
    const w = await world()
    const { db, a, dhaka, cam, cable, M, D } = w
    const { resolveBranchScope } = await import('../branch')
    const scope = await resolveBranchScope(db, w.clerkS, w.main) // forged cookie: ignored
    expect(scope.filter).toBe(dhaka)
    const B = scope.filter
    const R = scope.restrict
    const mk = M.markers
    const sales = await import('../sales/sales')
    const pur = await import('../purchases/purchases')
    const inv = await import('../inventory/product')
    const adj = await import('../inventory/adjustments')
    const count = await import('../inventory/count')
    const lookup = await import('../lookup/lookup')
    const svc = await import('../service/tickets')
    const dues = await import('../accounting/dues')
    const pay = await import('../accounting/payments')
    const ent = await import('../accounting/entries')
    const ledger = await import('../parties/ledger')
    const stock = await import('../reports/stock')
    const profit = await import('../reports/profit')
    const dash = await import('../dashboard')
    const reg = await import('../reports/registry')
    const labels = await import('../labels/labels')
    const transfers = await import('../inventory/transfers')
    const { NotFoundError } = await import('../errors')
    const page = { limit: 100, offset: 0 }

    // a transfer Main -> Ctg that Dhaka must not see either
    const tr = await transfers.createStockTransfer(db, a.cid, a.uid, { fromBranchId: w.main, toBranchId: w.ctg, date: '2026-11-24', note: 'TRNOTE-MAINX', serials: [], lines: [{ productId: cable.id, qty: 1 }] }, await (await import('@/test/seed')).mainCtx(a.cid))
    mk.push(tr.transferNo, tr.id, 'TRNOTE-MAINX')

    const reads: Record<string, () => Promise<unknown>> = {
      listSales: () => sales.listSales(db, a.cid, B, page),
      listSalesByMainCustomer: () => sales.listSales(db, a.cid, B, { ...page, customerId: M.customer.id }),
      listSaleReturns: () => sales.listSaleReturns(db, a.cid, B, page),
      listCustomerPayments: () => sales.listCustomerPayments(db, a.cid, B, M.customer.id),
      listCustomerUnits: () => sales.listCustomerUnits(db, a.cid, B, M.customer.id),
      onHandQty: () => sales.onHandQty(db, a.cid, B, [cable.id]),
      searchProductsForSale: () => sales.searchProductsForSale(db, a.cid, B, '', { withCost: true }),
      listPurchases: () => pur.listPurchases(db, a.cid, B, page),
      listVendorUnits: () => pur.listVendorUnits(db, a.cid, B, M.vendor.id),
      listVendorPayments: () => pur.listVendorPayments(db, a.cid, B, M.vendor.id),
      productStock: () => inv.productStock(db, a.cid, B, cam.id),
      listProductUnits: () => inv.listProductUnits(db, a.cid, B, cam.id, { ...page, withCost: true }),
      stockCard: () => inv.stockCard(db, a.cid, B, cable.id, page),
      listProductPurchases: () => inv.listProductPurchases(db, a.cid, B, cam.id, page),
      listProductSales: () => inv.listProductSales(db, a.cid, B, cam.id, page),
      listAdjustments: () => adj.listAdjustments(db, a.cid, B, cable.id),
      loadCountSheet: () => count.loadCountSheet(db, a.cid, B, {}),
      computeCountDiff: () => count.computeCountDiff(db, a.cid, B, { lines: [{ productId: cable.id, counted: 1 }], serialProductIds: [cam.id], scanned: [...M.serials, ...D.serials].join('\n') }),
      listWarrantyExpiring: () => lookup.listWarrantyExpiring(db, a.cid, B, 90, { today: TODAY }),
      getCustomerWarrantyPanel: () => lookup.getCustomerWarrantyPanel(db, a.cid, B, M.customer.id, { today: TODAY }),
      listServiceTickets: () => svc.listServiceTickets(db, a.cid, B, { ...page }),
      customerDues: () => dues.customerDues(db, a.cid, B, { today: TODAY, ...page }),
      vendorDuesSummary: () => dues.vendorDuesSummary(db, a.cid, B, { today: TODAY, ...page }),
      vendorDueInvoices: () => dues.vendorDueInvoices(db, a.cid, B, { today: TODAY, ...page }),
      listPayments: () => pay.listPayments(db, a.cid, B, { ...page }),
      listExpenses: () => ent.listExpenses(db, a.cid, B, { ...page, status: 'all' }),
      listIncomes: () => ent.listIncomes(db, a.cid, B, { ...page, status: 'all' }),
      ledgerOfMainCustomer: () => ledger.getLedger(db, a.cid, B, 'customer', M.customer.id),
      ledgerOfMainVendor: () => ledger.getLedger(db, a.cid, B, 'vendor', M.vendor.id),
      stockRows: () => stock.stockRows({ db, companyId: a.cid, branch: B, limit: 100 }, {}),
      productProfitRows: () => profit.productProfitRows(db, a.cid, B, { from: '2026-11-01', to: '2026-11-30', limit: 100 }),
      labelsInStock: () => labels.loadLabelUnits(db, a.cid, scope, { source: 'stock', sku: null, layout: 'a4', barcode: false }),
      labelsByIds: () => labels.loadLabelUnits(db, a.cid, scope, { source: 'ids', ids: [M.units.u3.id, D.units.u3.id], layout: 'a4', barcode: false, tooMany: false }),
      listStockTransfers: () => transfers.listStockTransfers(db, a.cid, B, page),
      searchSerialsMasked: () => lookup.searchSerials(db, a.cid, R, 'MAINXSN').then((r) => ({ ...r, matches: r.matches.map((m) => ({ ...m, serialNo: m.inScope ? m.serialNo : '(masked)', id: m.inScope ? m.id : '(masked)' })) })),
    }
    // every report, through the registry (same path as the page and the CSV route)
    for (const def of reg.REPORTS) reads[`report:${def.key}`] = () => reg.runReport(db, { ...w.clerkS }, B, def.key, { from: '2026-11-01', to: '2026-11-30', days: '90' }, { now: NOW }).then((x) => ({ result: x.result, csv: reg.reportToCsv(x.result) }))
    reads.dashboard = () => dash.loadDashboard(a.cid, B, { sales: true, inventory: true, accounts: true })

    const positives: Record<string, string> = { listSales: D.sa.invoiceNo, listPurchases: D.pu.invoiceNo, listSaleReturns: D.sr.returnNo, listServiceTickets: D.tk.ticketNo, listExpenses: 'EXP-DHAKAX', listIncomes: 'INC-DHAKAX', listPayments: D.sa.invoiceNo, listAdjustments: 'ADJ-DHAKAX', listProductUnits: D.serials[2], listWarrantyExpiring: D.serials[1], 'report:warranty': D.serials[1], 'report:customer-sales': 'Cust-DHAKAX', 'report:vendor-purchases': 'Vendor-DHAKAX', vendorDueInvoices: D.pu.invoiceNo, customerDues: 'Cust-DHAKAX' }
    // the count diff echoes the serials the user typed (Main's among them), but nothing else about them
    const typed = new Set(M.serials)
    for (const [name, fn] of Object.entries(reads)) {
      const out = await fn()
      expectNoLeak(name, out, name === 'computeCountDiff' ? mk.filter((m) => !typed.has(m)) : mk)
      if (positives[name]) expect(json(out), `${name} should list Dhaka data`).toContain(positives[name])
    }

    // searchSerials: Main units are found but masked (serial, status and branch only, no redirect, not in scope)
    const found = await lookup.searchSerials(db, a.cid, R, M.serials[2])
    expect(found.redirectUnitId).toBeNull()
    expect(found.matches[0]).toMatchObject({ inScope: false, productName: '', branchName: 'Main', status: 'in_stock', warrantyEnd: null, location: null })

    // detail reads of Main documents are NotFound for the restricted scope
    const details: Record<string, () => Promise<unknown>> = {
      getSale: () => sales.getSale(db, a.cid, R, M.sa.id),
      getPurchase: () => pur.getPurchase(db, a.cid, R, M.pu.id),
      getUnitDetail: () => lookup.getUnitDetail(db, a.cid, R, { id: M.units.u3.id }, { withCost: true }),
      getStockTransfer: () => transfers.getStockTransfer(db, a.cid, R, tr.id),
      labelsOfMainPurchase: () => labels.loadLabelUnits(db, a.cid, scope, { source: 'purchase', purchaseId: M.pu.id, valid: true, layout: 'a4', barcode: false }),
    }
    for (const [name, fn] of Object.entries(details)) await expect(fn(), name).rejects.toBeInstanceOf(NotFoundError)
    const e = await lookup.getUnitDetail(db, a.cid, R, { id: M.units.u3.id }, { withCost: true }).catch((x) => x)
    expect(e).toMatchObject({ name: 'UnitInOtherBranchError', serialNo: M.serials[2], status: 'in_stock', branchName: 'Main' })
    // ... while Dhaka's own documents open
    await expect(sales.getSale(db, a.cid, R, D.sa.id)).resolves.toMatchObject({ invoiceNo: D.sa.invoiceNo, branchName: 'Dhaka', branchCode: 'DHK' })
    await expect(lookup.getUnitDetail(db, a.cid, R, { id: D.units.u3.id }, { withCost: false })).resolves.toMatchObject({ unit: { branchName: 'Dhaka' } })
  })

  it('CSV routes and the dashboard page run with the session scope (forged cookie ignored)', async () => {
    const w = await world()
    st.session = w.clerkS
    st.cookie = w.main // forged: the clerk has no branches.all
    const rep = await import('../../app/(admin)/reports/[key]/csv/route')
    const payCsv = await import('../../app/(admin)/payments/csv/route')
    for (const key of ['sales', 'customer-sales', 'vendor-purchases', 'warranty', 'stock', 'low-stock', 'product-profit', 'profit-loss', 'cash-flow', 'purchases']) {
      const res = await rep.GET(new Request(`http://x/reports/${key}/csv?from=2026-11-01&to=2026-11-30&days=90`), { params: Promise.resolve({ key }) })
      expect(res.status, key).toBe(200)
      expectNoLeak(`csv:${key}`, await res.text(), w.M.markers)
    }
    const p = await payCsv.GET(new Request('http://x/payments/csv'))
    const text = await p.text()
    expectNoLeak('csv:payments', text, w.M.markers)
    expect(text).toContain(w.D.sa.invoiceNo)
    // history drawer: another branch's document history is refused; product history hides per-branch on-hand changes
    const hist = await import('../actions/activity')
    expect(await hist.getRecordHistoryAction('sale', w.M.sa.id)).toMatchObject({ ok: false })
    expect(await hist.getRecordHistoryAction('purchase', w.M.pu.id)).toMatchObject({ ok: false })
    expect(await hist.getRecordHistoryAction('expense', w.M.exp.id)).toMatchObject({ ok: false })
    expect(await hist.getRecordHistoryAction('sale', w.D.sa.id)).toMatchObject({ ok: true })
    // shared records' history spans every branch: needs branches.all in a multi-branch company
    expect(await hist.getRecordHistoryAction('product', w.cable.id)).toMatchObject({ ok: false, error: expect.stringMatching(/All branches/) })
    expect(await hist.getRecordHistoryAction('customer', w.D.customer.id)).toMatchObject({ ok: false })
    // the activity log too
    const Act = (await import('../../app/(admin)/activity/page')).default as (p: { searchParams: Promise<object> }) => Promise<unknown>
    const NoAccess = (await import('@/components/ui/NoAccess')).default
    st.session = { ...w.clerkS, perms: [...w.clerkS.perms, 'activity.view'] }
    expect(JSON.stringify(((await Act({ searchParams: Promise.resolve({}) })) as { props: { children: { type: unknown }[] } }).props.children.map((c) => (c as { type: unknown }).type === NoAccess))).toContain('true')
    st.session = { ...w.managerS, perms: [...w.managerS.perms, 'activity.view'] }
    expect(await hist.getRecordHistoryAction('product', w.cable.id)).toMatchObject({ ok: true })
    st.session = w.clerkS
    // dashboard page: the server component computes the restricted scope itself
    const Dash = (await import('../../app/(admin)/dashboard/page')).default
    const tree = await Dash()
    const seen = new WeakSet()
    const flat = JSON.stringify(tree, (k, v) => (k === '_owner' || k === '_store' || k === '_debugInfo' || k === '_debugStack' || k === '_debugTask' ? undefined : typeof v === 'object' && v !== null ? (seen.has(v) ? undefined : (seen.add(v), v)) : v))
    expectNoLeak('dashboard page', flat, w.M.markers)
  })
})

describe('reconciliation: All branches = sum of every branch', () => {
  it('sales, purchases, stock value, P&L, product profit, cash flow closing, dues, ledgers, dashboard', async () => {
    const w = await world()
    const { db, a, main, dhaka, ctg } = w
    const { fromMinor, toMinor } = await import('../money')
    const add = (...xs: string[]) => fromMinor(xs.reduce((s, x) => s + toMinor(x), 0))
    const rsales = await import('../reports/sales')
    const stock = await import('../reports/stock')
    const profit = await import('../reports/profit')
    const cf = await import('../reports/cashflow')
    const dues = await import('../accounting/dues')
    const dash = await import('../dashboard')
    const ledger = await import('../parties/ledger')
    const P = { from: '2026-11-01', to: '2026-11-30' }
    const branches = [main, dhaka, ctg] as const
    const each = async <T>(fn: (b: string | null) => Promise<T>) => ({ all: await fn(null), parts: await Promise.all(branches.map((b) => fn(b))) })

    const sumSeries = (rows: { net: string; sales: string; returns: string }[]) => ({ net: add(...rows.map((r) => r.net)), sales: add(...rows.map((r) => r.sales)), returns: add(...rows.map((r) => r.returns)) })
    for (const series of [rsales.salesSeries, rsales.purchaseSeries]) {
      const r = await each(async (b) => sumSeries(await series(db, a.cid, b, { ...P, group: 'month' })))
      expect(r.all).toEqual({ net: add(...r.parts.map((x) => x.net)), sales: add(...r.parts.map((x) => x.sales)), returns: add(...r.parts.map((x) => x.returns)) })
      expect(r.parts[0].sales).not.toBe(r.all.sales) // Main alone is not everything
    }
    const sv = await each((b) => stock.stockValuation(db, a.cid, b))
    expect(sv.all).toBe(add(...sv.parts))
    expect(toMinor(sv.parts[0])).toBeGreaterThan(0)
    expect(toMinor(sv.parts[1])).toBeGreaterThan(0)
    const pl = await each((b) => profit.loadProfitLoss(db, a.cid, b, P))
    for (const k of ['revenue', 'netCogs', 'totalCost', 'grossProfit', 'totalExpenses', 'totalOtherIncome', 'netProfit', 'stockAdjustments', 'salesReturns'] as const) expect(pl.all[k], k).toBe(add(...pl.parts.map((x) => x[k])))
    const pp = await each(async (b) => (await profit.productProfitRows(db, a.cid, b, { ...P, limit: 100 })).totals)
    for (const k of ['revenue', 'netRevenue', 'netCost', 'profit'] as const) expect(pp.all[k], k).toBe(add(...pp.parts.map((x) => x[k])))
    const flow = await each(async (b) => (await cf.loadCashFlow(db, a.cid, b, P)).flow.totals)
    for (const k of ['opening', 'inflow', 'outflow', 'closing'] as const) expect(flow.all[k], k).toBe(add(...flow.parts.map((x) => x[k])))
    expect((await cf.loadCashFlow(db, a.cid, null, P)).recon?.ok).toBe(true)
    const cd = await each(async (b) => (await dues.customerDues(db, a.cid, b, { today: TODAY, limit: 100, offset: 0 })).totals.total)
    expect(cd.all).toBe(add(...cd.parts))
    const vd = await each(async (b) => (await dues.vendorDuesSummary(db, a.cid, b, { today: TODAY, limit: 100, offset: 0 })).totals.total)
    expect(vd.all).toBe(add(...vd.parts))
    for (const [kind, id] of [['customer', w.M.customer.id], ['vendor', w.D.vendor.id]] as const) {
      const l = await each((b) => ledger.getLedger(db, a.cid, b, kind, id))
      for (const k of ['opening', 'billed', 'returned', 'paid', 'due'] as const) expect(l.all[k], `${kind}.${k}`).toBe(add(...l.parts.map((x) => x[k])))
    }
    const d = await each(async (b) => (await dash.loadDashboard(a.cid, b, { sales: true, inventory: true, accounts: true })).data)
    for (const k of ['stockValue', 'customerDue', 'vendorDue'] as const) expect(d.all[k], k).toBe(add(...d.parts.map((x) => x[k])))
  })
})

describe('writes stay in the active branch', () => {
  it('a unit located in another branch cannot be sold, adjusted or returned to the vendor from here; loose stock is per branch', async () => {
    const w = await world()
    const { db, a, dhaka, cable, M, cash } = w
    const sales = await import('../sales/sales')
    const ctx = { branchId: dhaka, restrict: dhaka }
    await expect(sales.createSale(db, a.cid, a.uid, { customerId: null, date: '2026-11-25', items: [{ serial: M.serials[2], qty: 1, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '1' }] }, ctx)).rejects.toThrow(`Serial ${M.serials[2]} is in Main; transfer it to this branch first.`)
    expect(await sales.lookupSerialForSale(db, a.cid, dhaka, M.serials[2])).toEqual({ ok: false, error: `Serial ${M.serials[2]} is in Main; transfer it to this branch first.` })
    expect(await sales.lookupSerialForSale(db, a.cid, null, M.serials[2])).toMatchObject({ ok: false, error: expect.stringMatching(/Choose a branch/) })
    const { adjustStock } = await import('../inventory/adjustments')
    await expect(adjustStock(db, a.cid, a.uid, { kind: 'unit', productId: w.cam.id, serial: M.serials[2], reason: 'damage' }, ctx)).rejects.toThrow(/is in Main/)
    // Dhaka has 20 - 2 + 1 - 1 = 18 cables; Main 10 - 2 + 1 - 1 = 8: Dhaka cannot sell 19
    expect((await sales.onHandQty(db, a.cid, dhaka, [cable.id])).get(cable.id)).toBe(18)
    await expect(sales.createSale(db, a.cid, a.uid, { customerId: null, date: '2026-11-25', items: [{ productId: cable.id, qty: 19, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '19' }] }, ctx)).rejects.toMatchObject({ fields: { 'items.0.qty': 'Only 18 of Cable in stock.' } })
    // restricted user: Main's documents are out of reach for payments and returns
    await expect(sales.recordCustomerPayment(db, a.cid, a.uid, M.sa.id, { amount: '1', accountId: cash.id, date: '2026-11-25' }, ctx)).rejects.toMatchObject({ name: 'NotFoundError' })
    const detail = await sales.getSale(db, a.cid, null, M.sa.id)
    await expect(sales.createSaleReturn(db, a.cid, a.uid, M.sa.id, { items: [{ saleItemId: detail.items[0].id, qty: 1 }], date: '2026-11-25' }, ctx)).rejects.toMatchObject({ name: 'NotFoundError' })
    const pur = await import('../purchases/purchases')
    await expect(pur.recordVendorPayment(db, a.cid, a.uid, M.pu.id, { amount: '1', accountId: cash.id, date: '2026-11-25' }, ctx)).rejects.toMatchObject({ name: 'NotFoundError' })
    const ent = await import('../accounting/entries')
    await expect(ent.voidEntry(db, a.cid, a.uid, 'expense', M.exp.id, { reason: 'nope' }, ctx)).rejects.toMatchObject({ name: 'NotFoundError' })
    const svc = await import('../service/tickets')
    await expect(svc.closeServiceTicket(db, a.cid, a.uid, M.tk.id, { outcome: 'repaired', resolution: 'done' }, ctx)).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(svc.openServiceTicket(db, a.cid, a.uid, w.M.units.u1.id, { issue: 'abc' }, ctx)).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('a branches.all user returns a Main sale while working in Dhaka: goods restock into Dhaka, logged as cross-branch', async () => {
    const w = await world()
    const { db, a, dhaka, M, schema } = w
    const sales = await import('../sales/sales')
    const detail = await sales.getSale(db, a.cid, null, M.sa.id)
    const line = detail.items.find((i) => i.serialNo === M.serials[1])!
    const r = await sales.createSaleReturn(db, a.cid, a.uid, M.sa.id, { items: [{ saleItemId: line.id, qty: 1 }], date: '2026-11-25' }, { branchId: dhaka, restrict: null })
    const [unit] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, M.serials[1]))
    expect(unit).toMatchObject({ status: 'in_stock', branchId: dhaka })
    const [ret] = await db.select().from(schema.saleReturns).where(eq(schema.saleReturns.returnNo, r.returnNo))
    expect(ret.branchId).toBe(dhaka)
    const [log] = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.action, 'sale.return'), eq(schema.activityLog.entityId, r.id)))
    expect(log.after).toMatchObject({ crossBranch: true, saleBranchId: w.main, branchId: dhaka })
  })

  it('"All branches" refuses writes; actions take the branch from the session, never from the client', async () => {
    const w = await world()
    const { db, a, M, cash, schema } = w
    // manager chooses "All": creating a sale is refused
    st.session = w.managerS
    st.cookie = 'all'
    const acts = await import('../actions/sales')
    const r = await acts.createSaleAction({ customerId: null, date: '2026-11-25', items: [{ productId: w.cable.id, qty: 1, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '1' }] })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Choose a branch/) })
    // salesman with a forged Main cookie (and a branchId smuggled in the payload) still sells in Dhaka
    st.session = w.salesmanS
    st.cookie = w.main
    const ok = await acts.createSaleAction({ customerId: null, branchId: w.main, date: '2026-11-25', items: [{ productId: w.cable.id, qty: 1, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '1' }] } as never)
    expect(ok.ok).toBe(true)
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, (ok as { data: { id: string } }).data.id))
    expect(sale.branchId).toBe(w.dhaka)
    // ... and cannot sell a Main unit
    const bad = await acts.createSaleAction({ customerId: null, date: '2026-11-25', items: [{ serial: M.serials[2], qty: 1, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '1' }] })
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/is in Main/) })
    // the selector action is branches.all-only and validates the value
    const br = await import('../actions/branches')
    expect(await br.setActiveBranchAction(w.main)).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    st.session = w.managerS
    expect(await br.setActiveBranchAction('11111111-1111-4111-8111-111111111111')).toMatchObject({ ok: false })
    expect(await br.setActiveBranchAction(w.dhaka)).toMatchObject({ ok: true, data: { value: w.dhaka } })
    expect(await br.setActiveBranchAction('all')).toMatchObject({ ok: true })
    void a
  })
})

describe('inter-branch transfers', () => {
  it('moves serial units and quantity atomically, with events, paired movements and a number; history and stock follow', async () => {
    const w = await world()
    const { db, a, main, dhaka, cable, M, schema } = w
    const tr = await import('../inventory/transfers')
    const sales = await import('../sales/sales')
    const r = await tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: [M.serials[2]], lines: [{ productId: cable.id, qty: 3 }], note: 'shelf' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(r).toMatchObject({ transferNo: 'TRF-00001', units: 1, qty: 3, duplicate: false })
    const [unit] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, M.serials[2]))
    expect(unit).toMatchObject({ status: 'in_stock', branchId: dhaka })
    const ev = await db.select().from(schema.unitEvents).where(and(eq(schema.unitEvents.unitId, unit.id), eq(schema.unitEvents.type, 'transferred')))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ fromStatus: 'in_stock', toStatus: 'in_stock', meta: { fromBranchId: main, toBranchId: dhaka, transferNo: 'TRF-00001' } })
    expect((await sales.onHandQty(db, a.cid, main, [cable.id])).get(cable.id)).toBe(5)
    expect((await sales.onHandQty(db, a.cid, dhaka, [cable.id])).get(cable.id)).toBe(21)
    expect((await sales.onHandQty(db, a.cid, null, [cable.id])).get(cable.id)).toBe(26) // company total unchanged
    // now sellable in Dhaka, not in Main
    expect((await sales.lookupSerialForSale(db, a.cid, dhaka, M.serials[2])).ok).toBe(true)
    expect((await sales.lookupSerialForSale(db, a.cid, main, M.serials[2])).ok).toBe(false)
    const d = await tr.getStockTransfer(db, a.cid, dhaka, r.id)
    expect(d).toMatchObject({ fromName: 'Main', toName: 'Dhaka', items: expect.arrayContaining([expect.objectContaining({ serialNo: M.serials[2] }), expect.objectContaining({ qty: 3, unitId: null })]) })
    // the stock card of each branch shows its half, linked to the transfer
    const { stockCard } = await import('../inventory/product')
    const cardD = await stockCard(db, a.cid, dhaka, cable.id, { limit: 5, offset: 0 })
    expect(cardD.rows[0]).toMatchObject({ type: 'transfer', qtyChange: 3, balance: 21, doc: { kind: 'transfer', label: 'TRF-00001' } })
    // idempotent resubmit
    const again = await tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: [], lines: [{ productId: cable.id, qty: 1 }], idempotencyKey: 'key-12345678' }, await (await import('@/test/seed')).mainCtx(a.cid))
    expect(await tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: [], lines: [{ productId: cable.id, qty: 1 }], idempotencyKey: 'key-12345678' }, await (await import('@/test/seed')).mainCtx(a.cid))).toMatchObject({ id: again.id, duplicate: true })
    // same key, different payload -> friendly refusal, nothing written
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: [], lines: [{ productId: cable.id, qty: 2 }], idempotencyKey: 'key-12345678' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already saved as TRF-00002/)
    // a transfer saved before migration 0016 (NULL payload hash) is never replayed as a duplicate: friendly refusal, nothing written
    await db.update(schema.stockTransfers).set({ idempotencyHash: null }).where(eq(schema.stockTransfers.id, again.id))
    const count0 = (await db.select().from(schema.stockTransfers)).length
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: [], lines: [{ productId: cable.id, qty: 1 }], idempotencyKey: 'key-12345678' }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toThrow(/already saved as TRF-00002/)
    expect((await db.select().from(schema.stockTransfers)).length).toBe(count0)
    // the key of a Main -> Dhaka transfer seen by a Ctg-restricted user: plain conflict, no transfer number disclosed
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: w.ctg, toBranchId: dhaka, date: '2026-11-25', serials: [], lines: [{ productId: cable.id, qty: 1 }], idempotencyKey: 'key-12345678' }, { restrict: w.ctg })).rejects.toThrow('This form was already used for another transfer. Reload the page and try again.')
  })

  it('atomic: any bad serial or short line leaves nothing behind; source never negative; rules on who may transfer', async () => {
    const w = await world()
    const { db, a, main, dhaka, ctg, cable, M, D, schema } = w
    const tr = await import('../inventory/transfers')
    const snapshot = async () => ({
      units: await db.select({ id: schema.productUnits.id, b: schema.productUnits.branchId, s: schema.productUnits.status }).from(schema.productUnits).orderBy(schema.productUnits.id),
      moves: (await db.select().from(schema.stockMovements)).length,
      transfers: (await db.select().from(schema.stockTransfers)).length,
      events: (await db.select().from(schema.unitEvents)).length,
      seq: await db.select().from(schema.docSequences).orderBy(schema.docSequences.kind),
    })
    const before = await snapshot()
    const tries = [
      { serials: [M.serials[2], 'NOPE-1'], lines: [] }, // unknown serial
      { serials: [M.serials[2], M.serials[1]], lines: [] }, // second one is sold
      { serials: [M.serials[2], D.serials[2]], lines: [] }, // second one is in another branch
      { serials: [M.serials[2]], lines: [{ productId: cable.id, qty: 9 }] }, // Main has only 8 cables
      { serials: [M.serials[2]], lines: [{ productId: w.cam.id, qty: 1 }] }, // serial product by quantity
    ]
    for (const x of tries) await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', ...x }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ name: 'FieldErrors' })
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: main, date: '2026-11-25', serials: [M.serials[2]] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ name: 'FieldErrors' })
    // restricted Dhaka user: may only SEND from Dhaka. Main -> Ctg and the pull Main -> Dhaka are refused
    for (const to of [ctg, dhaka]) await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: to, date: '2026-11-25', serials: [M.serials[2]], lines: [{ productId: cable.id, qty: 1 }] }, { restrict: dhaka })).rejects.toMatchObject({ name: 'PolicyError', message: 'You can only transfer stock out of your own branch.' })
    // errors to a restricted sender reveal nothing about other branches: an off-branch unit is "not in Dhaka" (no status),
    // a short line names only the actor's own (source) branch
    const offBranch = (await tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: dhaka, toBranchId: main, date: '2026-11-25', serials: [D.serials[2], M.serials[1]] }, { restrict: dhaka }).catch((e: Error) => e)) as Error
    expect(offBranch.message).toContain(`${M.serials[1]} is not in Dhaka`)
    expect(offBranch.message).not.toMatch(/sold/i)
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: dhaka, toBranchId: main, date: '2026-11-25', lines: [{ productId: cable.id, qty: 999 }] }, { restrict: dhaka })).rejects.toMatchObject({ fields: { 'lines.0.qty': expect.stringMatching(/^Only \d+ of Cable at Dhaka\.$/) } })
    expect(await snapshot()).toEqual(before) // nothing at all was written, not even a document number
    // a send Dhaka -> Main is fine
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: dhaka, toBranchId: main, date: '2026-11-25', serials: [D.serials[2]] }, { restrict: dhaka })).resolves.toMatchObject({ units: 1 })
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: dhaka, toBranchId: ctg, date: '2026-11-25', lines: [{ productId: cable.id, qty: 18 }] }, { restrict: dhaka })).resolves.toMatchObject({ qty: 18 })
    const sales = await import('../sales/sales')
    expect((await sales.onHandQty(db, a.cid, dhaka, [cable.id])).get(cable.id)).toBe(0)
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: dhaka, toBranchId: ctg, date: '2026-11-25', lines: [{ productId: cable.id, qty: 1 }] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { 'lines.0.qty': 'Cable is out of stock at Dhaka.' } })
    // a deactivated branch can neither send nor receive
    await db.update(schema.branches).set({ active: false }).where(eq(schema.branches.id, ctg))
    await expect(tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: ctg, date: '2026-11-25', serials: [M.serials[2]] }, await (await import('@/test/seed')).mainCtx(a.cid))).rejects.toMatchObject({ fields: { toBranchId: 'Branch not found' } })
  })

  it('concurrency: transfer vs sale of the same unit, transfer vs transfer, and quantity races: exactly one wins, never negative', async () => {
    const w = await world()
    const { db, a, main, dhaka, ctg, cable, M, cash, schema } = w
    const tr = await import('../inventory/transfers')
    const sales = await import('../sales/sales')
    for (let round = 0; round < 3; round++) {
      const sn = round === 0 ? M.serials[2] : `RACE-${round}`
      if (round > 0) {
        const { createPurchase } = await import('../purchases/purchases')
        await createPurchase(db, a.cid, a.uid, { vendorId: M.vendor.id, date: '2026-11-24', items: [{ productId: w.cam.id, qty: 1, unitCost: '100', serials: [sn] }] }, { branchId: main, restrict: null })
      }
      const results = await Promise.allSettled([
        tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: [sn] }, await (await import('@/test/seed')).mainCtx(a.cid)),
        sales.createSale(db, a.cid, a.uid, { customerId: null, date: '2026-11-25', items: [{ serial: sn, qty: 1, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '1' }] }, { branchId: main, restrict: null }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const [u] = await db.select().from(schema.productUnits).where(eq(schema.productUnits.serialNo, sn))
      if (results[0].status === 'fulfilled') expect(u).toMatchObject({ status: 'in_stock', branchId: dhaka })
      else expect(u).toMatchObject({ status: 'sold', branchId: main })
    }
    // transfer vs transfer of the same unit to two branches
    const { createPurchase } = await import('../purchases/purchases')
    await createPurchase(db, a.cid, a.uid, { vendorId: M.vendor.id, date: '2026-11-24', items: [{ productId: w.cam.id, qty: 1, unitCost: '100', serials: ['TT-1'] }] }, { branchId: main, restrict: null })
    const tt = await Promise.allSettled([
      tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', serials: ['TT-1'] }, await (await import('@/test/seed')).mainCtx(a.cid)),
      tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: ctg, date: '2026-11-25', serials: ['TT-1'] }, await (await import('@/test/seed')).mainCtx(a.cid)),
    ])
    expect(tt.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await db.select().from(schema.unitEvents).innerJoin(schema.productUnits, eq(schema.productUnits.id, schema.unitEvents.unitId)).where(and(eq(schema.productUnits.serialNo, 'TT-1'), eq(schema.unitEvents.type, 'transferred')))).length).toBe(1)
    // quantity: Main holds 8 cables; five concurrent transfers of 3 -> at most 2 succeed, Main never below zero
    const q = await Promise.allSettled(Array.from({ length: 5 }, async (_, i) => tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: i % 2 ? dhaka : ctg, date: '2026-11-25', lines: [{ productId: cable.id, qty: 3 }] }, await (await import('@/test/seed')).mainCtx(a.cid))))
    expect(q.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect((await sales.onHandQty(db, a.cid, main, [cable.id])).get(cable.id)).toBe(2)
    // and a sale racing a transfer of the last loose units
    const race = await Promise.allSettled([
      tr.createStockTransfer(db, a.cid, a.uid, { fromBranchId: main, toBranchId: dhaka, date: '2026-11-25', lines: [{ productId: cable.id, qty: 2 }] }, await (await import('@/test/seed')).mainCtx(a.cid)),
      sales.createSale(db, a.cid, a.uid, { customerId: null, date: '2026-11-25', items: [{ productId: cable.id, qty: 2, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '2' }] }, { branchId: main, restrict: null }),
    ])
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await sales.onHandQty(db, a.cid, main, [cable.id])).get(cable.id)).toBe(0)
  })
})

describe('fail closed', () => {
  it('a restricted user without an active branch gets nothing; a user cannot be reactivated into an inactive branch', async () => {
    const w = await world()
    const { db, a, ctg, schema } = w
    const users = await import('../iam/users')
    const br = await import('./branches')
    const { resolveBranchScope } = await import('../branch')
    const roles = await db.select().from(schema.roles).where(eq(schema.roles.companyId, a.cid))
    const salesmanRole = roles.find((r) => r.name === 'salesman')!.id
    const admin = { companyId: a.cid, userId: a.uid }
    const u = await users.createUser(db, admin, { name: 'U', email: 'u@x.test', roleId: salesmanRole, branchId: ctg, generate: true })
    // deactivate U, then its (now empty) branch, then try to bring U back: refused
    await users.setUserActive(db, admin, u.id, false)
    await br.setBranchActive(db, a.cid, a.uid, ctg, false)
    await expect(users.setUserActive(db, admin, u.id, true)).rejects.toThrow(/branch is inactive/)
    expect((await db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0].active).toBe(false)
    // a restricted session whose branch is inactive or unset: no scope at all (never Main)
    const sub = { uid: u.id, cid: a.cid, adm: false, perms: ['sales.view'] }
    await expect(resolveBranchScope(db, sub, null)).rejects.toThrow('Your branch is inactive or not assigned; ask an administrator.')
    await db.update(schema.users).set({ branchId: null }).where(eq(schema.users.id, u.id))
    await expect(resolveBranchScope(db, sub, null)).rejects.toThrow(/inactive or not assigned/)
    // ... and as an IAM actor (restricted HR without a branch) it can manage nobody
    const { createRole } = await import('../iam/roles')
    const hrRole = await createRole(db, admin, { name: 'HR2', permissions: ['users.view', 'users.edit', 'users.create', 'sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create'] })
    const [hr] = await db.insert(schema.users).values({ companyId: a.cid, branchId: null, roleId: hrRole.id, name: 'HR', email: 'hr2@x.test', passwordHash: 'x' }).returning()
    await expect(users.createUser(db, { companyId: a.cid, userId: hr.id }, { name: 'N', email: 'n9@x.test', roleId: salesmanRole, generate: true })).rejects.toThrow(/inactive or not assigned/)
  })
})

describe('branch management', () => {
  it('Main cannot be deactivated; a branch holding stock, tickets or users is refused with the reasons; empty one can; writes then refused', async () => {
    const w = await world()
    const { db, a, main, dhaka, ctg, schema, cash } = w
    const br = await import('./branches')
    await expect(br.setBranchActive(db, a.cid, a.uid, main, false)).rejects.toThrow(/main branch and cannot be deactivated/)
    const e = (await br.setBranchActive(db, a.cid, a.uid, dhaka, false).catch((x: Error) => x)) as Error
    expect(e.message).toMatch(/serial unit.* in stock/)
    expect(e.message).toMatch(/in service/)
    expect(e.message).toMatch(/quantity stock is held here: Cable/)
    expect(e.message).toMatch(/service ticket/)
    expect(e.message).toMatch(/user.* assigned/)
    // empty branch: ok, then no write can target it and the selector falls back
    await expect(br.setBranchActive(db, a.cid, a.uid, ctg, false)).resolves.toMatchObject({ active: false })
    const sales = await import('../sales/sales')
    await expect(sales.createSale(db, a.cid, a.uid, { customerId: null, date: '2026-11-25', items: [{ productId: w.cable.id, qty: 1, unitPrice: '1' }], payments: [{ accountId: cash.id, amount: '1' }] }, { branchId: ctg, restrict: null })).rejects.toMatchObject({ name: 'PolicyError' })
    await expect(br.setBranchActive(db, a.cid, a.uid, ctg, true)).resolves.toMatchObject({ active: true })
    // validation: code format, unique name/code, non-empty rename of Main
    await expect(br.createBranch(db, a.cid, a.uid, { name: 'Dhaka', code: 'X1' })).rejects.toMatchObject({ fields: { name: expect.any(String) } })
    await expect(br.createBranch(db, a.cid, a.uid, { name: 'Other', code: 'DHK' })).rejects.toMatchObject({ fields: { code: expect.any(String) } })
    await expect(br.createBranch(db, a.cid, a.uid, { name: 'Other', code: 'bad code!' })).rejects.toMatchObject({ fields: { code: expect.any(String) } })
    await expect(br.updateBranch(db, a.cid, a.uid, main, { name: '  ', code: 'MAIN' })).rejects.toMatchObject({ fields: { name: expect.any(String) } })
    await expect(br.updateBranch(db, a.cid, a.uid, main, { name: 'Head office', code: 'HQ' })).resolves.toMatchObject({ name: 'Head office', code: 'HQ', isDefault: true })
    const list = await br.listBranchesAdmin(db, a.cid)
    expect(list.map((b) => b.code)).toEqual(['HQ', 'CTG', 'DHK'])
    expect(list.find((b) => b.code === 'DHK')).toMatchObject({ unitsInStock: 1, users: 2 })
    void schema
  })

  it('users: branch must be active and of the company; a restricted actor only manages / assigns its own branch; branch change signs out', async () => {
    const w = await world()
    const { db, a, main, dhaka, ctg, schema } = w
    const users = await import('../iam/users')
    const roles = await db.select().from(schema.roles).where(eq(schema.roles.companyId, a.cid))
    const salesmanRole = roles.find((r) => r.name === 'salesman')!.id
    // a Dhaka user-admin WITHOUT branches.all
    const { createRole } = await import('../iam/roles')
    const ua = await createRole(db, { companyId: a.cid, userId: a.uid }, { name: 'Branch HR', permissions: ['users.view', 'users.create', 'users.edit', 'sales.view', 'sales.create', 'customers.view', 'customers.create', 'serials.view', 'serials.create'] })
    const [hr] = await db.insert(schema.users).values({ companyId: a.cid, branchId: dhaka, roleId: ua.id, name: 'HR', email: 'hr@x.test', passwordHash: 'x' }).returning()
    const actor = { companyId: a.cid, userId: hr.id }
    const c1 = await users.createUser(db, actor, { name: 'N1', email: 'n1@x.test', roleId: salesmanRole, generate: true })
    expect((await db.select().from(schema.users).where(eq(schema.users.id, c1.id)))[0].branchId).toBe(dhaka)
    await expect(users.createUser(db, actor, { name: 'N2', email: 'n2@x.test', roleId: salesmanRole, branchId: main, generate: true })).rejects.toThrow(/own branch/)
    // cannot see / edit a Main user
    const [mainUser] = await db.select().from(schema.users).where(and(eq(schema.users.companyId, a.cid), eq(schema.users.email, 'm@x.test')))
    await expect(users.updateUser(db, actor, mainUser.id, { name: 'x', email: 'm@x.test', roleId: mainUser.roleId })).rejects.toMatchObject({ name: 'NotFoundError' })
    expect((await users.listUsers(db, a.cid, { branchId: dhaka, limit: 50, offset: 0 })).rows.every((u) => u.branchId === dhaka)).toBe(true)
    // admin moves a user to Ctg: session revoked; an inactive branch is refused
    const before = (await db.select().from(schema.users).where(eq(schema.users.id, c1.id)))[0].sessionVersion
    await expect(users.updateUser(db, { companyId: a.cid, userId: a.uid }, c1.id, { name: 'N1', email: 'n1@x.test', roleId: salesmanRole, branchId: ctg })).resolves.toMatchObject({ signedOut: true })
    expect((await db.select().from(schema.users).where(eq(schema.users.id, c1.id)))[0].sessionVersion).toBe(before + 1)
    await db.update(schema.branches).set({ active: false }).where(eq(schema.branches.id, ctg))
    await expect(users.updateUser(db, { companyId: a.cid, userId: a.uid }, c1.id, { name: 'N1', email: 'n1@x.test', roleId: salesmanRole, branchId: main })).resolves.toBeTruthy()
    await expect(users.updateUser(db, { companyId: a.cid, userId: a.uid }, c1.id, { name: 'N1', email: 'n1@x.test', roleId: salesmanRole, branchId: ctg })).rejects.toMatchObject({ fields: { branchId: 'Branch not found' } })
  })
})

describe('no branch UI noise for a single-branch company', () => {
  it('pages hide branch columns and the shell hides the selector until a second active branch exists', async () => {
    const { a } = await (await import('@/test/seed')).seedTwoCompanies()
    const { getDb } = await import('../db')
    const db = getDb()
    const { resolveBranchScope, shellBranch } = await import('../branch')
    st.session = { uid: a.uid, cid: a.cid, bid: null, role: 'admin', adm: true, sv: 0, perms: [] }
    st.cookie = 'all' // even "all" means nothing with one branch
    const single = await resolveBranchScope(db, st.session, 'all')
    expect(single).toMatchObject({ multi: false, filter: single.home, active: single.home })
    expect(shellBranch(single)).toMatchObject({ multi: false, canSwitch: false })
    const props = async (path: string) => {
      const Page = (await import(path)).default as (p: { searchParams: Promise<object> }) => Promise<{ props: { children: unknown } }>
      const tree = await Page({ searchParams: Promise.resolve({}) })
      const found: Record<string, unknown>[] = []
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object' || !('props' in n)) return
        const p = (n as { props: Record<string, unknown> }).props
        if ('showBranch' in p) found.push(p)
        walk(p.children)
      }
      walk(tree)
      return found[0]
    }
    expect(await props('../../app/(admin)/sales/page')).toMatchObject({ showBranch: false })
    expect(await props('../../app/(admin)/purchases/page')).toMatchObject({ showBranch: false })
    // a second branch appears: the "All branches" view shows the branch column, a single-branch view does not
    const { createBranch } = await import('./branches')
    const other = await createBranch(db, a.cid, a.uid, { name: 'Dhaka', code: 'DHK' })
    const multi = await resolveBranchScope(db, st.session, 'all')
    expect(shellBranch(multi)).toMatchObject({ multi: true, canSwitch: true, value: 'all' })
    expect(await props('../../app/(admin)/sales/page')).toMatchObject({ showBranch: true })
    st.cookie = other.id
    expect(await props('../../app/(admin)/purchases/page')).toMatchObject({ showBranch: false })
    // a restricted user in a multi-branch company: never a selector, only its branch name
    const { mainBranchId } = await import('@/test/seed')
    expect(shellBranch(await resolveBranchScope(db, { uid: a.uid, cid: a.cid, adm: false, perms: ['sales.view'] }, 'all'))).toMatchObject({ multi: true, canSwitch: false, options: [{ id: await mainBranchId(a.cid) }] })
  })
})
