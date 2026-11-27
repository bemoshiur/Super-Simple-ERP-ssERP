/**
 * STRUCTURAL branch-isolation guard (Task 14). Every exported function of the branch-scoped data-layer modules must be
 * listed below as:
 *  - 'scoped'  : takes the branch explicitly (a parameter named branch | restrict | branchId | scope, or ctx = WriteCtx /
 *                ReportContext) - checked against the real parameter list;
 *  - 'company' : deliberately company-wide, with the reason (catalog, accounts, serial uniqueness, ...);
 *  - 'pure'    : no database access at all;
 *  - 'internal': a building block whose callers pass the lock/branch rules (state machine helpers).
 * A NEW export that is not listed fails this test, so nobody can add an unscoped read without deciding (and reviewing) its
 * scope. See CONTRIBUTING.md ("Branch scope registry"). The behavioural proof lives in branches/isolation.db.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as accounts from './accounting/accounts'
import * as dues from './accounting/dues'
import * as entries from './accounting/entries'
import * as payments from './accounting/payments'
import * as dashboard from './dashboard'
import * as adjustments from './inventory/adjustments'
import * as count from './inventory/count'
import * as product from './inventory/product'
import * as transfers from './inventory/transfers'
import * as labels from './labels/labels'
import * as lookup from './lookup/lookup'
import * as ledger from './parties/ledger'
import * as purchaseImport from './purchases/import'
import * as purchases from './purchases/purchases'
import * as rcash from './reports/cashflow'
import * as rlookups from './reports/lookups'
import * as rprofit from './reports/profit'
import * as rregistry from './reports/registry'
import * as rsales from './reports/sales'
import * as rstock from './reports/stock'
import * as rwarranty from './reports/warranty'
import * as sales from './sales/sales'
import * as serials from './serials'
import * as tickets from './service/tickets'

type Kind = 'scoped' | `company: ${string}` | 'pure' | `internal: ${string}`
const S = 'scoped' as const
const P = 'pure' as const
const CATALOG = 'company: product catalog is shared by all branches' as const
const ACCOUNTS = 'company: accounts are company-level (ruling); payments carry the branch' as const

export const REGISTRY: Record<string, { mod: Record<string, unknown>; fns: Record<string, Kind> }> = {
  'purchases/purchases': {
    mod: purchases,
    fns: {
      existingSerials: 'company: serial numbers are unique per company', purchaseRequestHash: P, resolvePurchaseKey: 'company: idempotency keys are unique per company',
      createPurchase: S, listPurchases: S, getPurchase: S, listActiveAccounts: ACCOUNTS, searchProductsForPurchase: CATALOG, listVendorUnits: S, listVendorPayments: S, recordVendorPayment: S, createPurchaseReturn: S,
    },
  },
  'purchases/import': { mod: purchaseImport, fns: { previewSerialImport: 'company: dry run over the catalog and serial uniqueness, writes nothing', importSerialPurchase: S } },
  'sales/sales': {
    mod: sales,
    fns: {
      notInStockMessage: P, assertDateAllowed: P, saleRequestHash: P, productAverageCosts: 'company: average cost is a product attribute (keeps branch values additive)',
      onHandQty: S, createSale: S, lookupSerialForSale: S, searchProductsForSale: S, listSales: S, getSale: S, listSaleReturns: S, listCustomerPayments: S, listCustomerUnits: S,
      recordCustomerPayment: S, collectCustomerDue: S, createSaleReturn: S,
    },
  },
  'inventory/adjustments': { mod: adjustments, fns: { adjustStock: S, applyStockCount: S, listAdjustments: S } },
  'inventory/count': { mod: count, fns: { loadCountSheet: S, computeCountDiff: S, countDiffCsvRows: P } },
  'inventory/product': {
    mod: product,
    fns: { getProductProfile: CATALOG, priceHistory: CATALOG, productStock: S, listProductUnits: S, stockCard: S, stockCardHref: P, listProductPurchases: S, listProductSales: S },
  },
  'inventory/transfers': { mod: transfers, fns: { transferRequestHash: P, createStockTransfer: S, listStockTransfers: S, getStockTransfer: S } },
  'reports/sales': { mod: rsales, fns: { bucketSql: P, salesSeries: S, purchaseSeries: S, salesReport: S, purchaseReport: S, customerSalesReport: S, vendorPurchasesReport: S } },
  'reports/stock': { mod: rstock, fns: { onHandSql: S, lowStockPredicate: S, lowStockCount: S, stockValuation: S, stockRows: S, countStockRows: S, stockSummary: S, stockReport: S, lowStockReport: S } },
  'reports/profit': { mod: rprofit, fns: { productProfitRows: S, productProfitReport: S, loadProfitLoss: S, profitLossReport: S } },
  'reports/cashflow': { mod: rcash, fns: { loadCashFlow: S, cashFlowReport: S } },
  'reports/warranty': { mod: rwarranty, fns: { warrantyReport: S } },
  'reports/registry': { mod: rregistry, fns: { canOpenReport: P, reportByKey: P, parseReportParams: P, runReport: S, stripSensitive: P, reportToCsv: P, reportFileName: P } },
  'reports/lookups': { mod: rlookups, fns: { searchProductsForReport: CATALOG } },
  'lookup/lookup': {
    mod: lookup,
    fns: {
      canSeeProfit: P, searchSerials: S, findUnitIdBySerial: 'company: resolves a URL segment to an id only; the detail read enforces restrict',
      getUnitDetail: S, listWarrantyExpiring: S, getCustomerWarrantyPanel: S,
    },
  },
  'accounting/accounts': {
    mod: accounts,
    fns: { listAccountBalances: ACCOUNTS, totalBalance: P, getAccount: ACCOUNTS, createAccount: ACCOUNTS, updateAccount: ACCOUNTS, setAccountActive: ACCOUNTS, listActiveAccountOptions: ACCOUNTS, createTransfer: S },
  },
  'accounting/dues': { mod: dues, fns: { customerDues: S, vendorDuesSummary: S, vendorDueInvoices: S } },
  'accounting/payments': { mod: payments, fns: { listPayments: S, parsePaymentFilter: P, paymentCsvRows: P } },
  'accounting/entries': {
    mod: entries,
    fns: {
      createExpense: S, createIncome: S, updateExpense: S, updateIncome: S, voidEntry: S, listExpenses: S, listIncomes: S,
      incomeCategorySuggestions: 'company: category names are shared', listExpenseCategories: 'company: categories are shared', createExpenseCategory: 'company: categories are shared',
      renameExpenseCategory: 'company: categories are shared', setExpenseCategoryActive: 'company: categories are shared',
    },
  },
  dashboard: {
    mod: dashboard,
    fns: { appTimezone: P, emptyDashboard: P, lowStockCount: S, salesTotals: S, stockValue: S, dues: S, salesLast7Days: S, topProducts: S, loadDashboard: S },
  },
  'labels/labels': { mod: labels, fns: { loadLabelUnits: S } },
  'service/tickets': { mod: tickets, fns: { openServiceTicket: S, updateServiceTicket: S, closeServiceTicket: S, listServiceTickets: S } },
  'parties/ledger': { mod: ledger, fns: { computeLedger: P, getLedger: S } },
  serials: {
    mod: serials,
    fns: {
      canTransition: P, eventTypeFor: P,
      transitionUnit: 'internal: state machine step; callers check the branch (TransitionInput.branchId / moveTo)',
      lockUnitsForUpdate: 'internal: lock helper; callers check unit.branchId under the lock',
      transitionLockedUnits: 'internal: batch state change of units the caller already validated',
      relocateLockedUnits: 'internal: transfer helper; validates the source branch itself',
    },
  },
}

const SCOPE_PARAM = /\b(branch|restrict|branchId|scope|ctx)\b/
const params = (fn: unknown) => (String(fn).match(/^[^(]*\(([^)]*)\)/)?.[1] ?? '').replace(/\s+/g, ' ')
const isClass = (v: unknown) => typeof v === 'function' && /^class\b/.test(String(v))

describe('branch scope registry', () => {
  for (const [name, { mod, fns }] of Object.entries(REGISTRY)) {
    it(`${name}: every exported function is classified, and every 'scoped' one takes the branch`, () => {
      const exported = Object.entries(mod).filter(([, v]) => typeof v === 'function' && !isClass(v)).map(([k]) => k).sort()
      const unlisted = exported.filter((k) => !(k in fns))
      expect(unlisted, `${name}: add these exports to the branch scope registry (src/server/branch-scope-registry.test.ts)`).toEqual([])
      expect(Object.keys(fns).filter((k) => !exported.includes(k)), `${name}: stale registry entries`).toEqual([])
      for (const [k, kind] of Object.entries(fns)) {
        if (kind === 'scoped') expect(params(mod[k]), `${name}.${k} is 'scoped' but takes no branch/restrict/ctx/scope parameter`).toMatch(SCOPE_PARAM)
        if (kind.startsWith('company:') || kind.startsWith('internal:')) expect(kind.split(':')[1].trim().length, `${name}.${k}: give the reason`).toBeGreaterThan(10)
      }
    })
  }
})

/**
 * Every OTHER module under src/server, with the reason it needs no per-function registry. A NEW module that is in neither
 * REGISTRY nor this list fails the test below: decide whether its exports read/write branch-owned data (then add it to
 * REGISTRY) or not (then add it here with a reason).
 */
export const UNSCOPED_MODULES: Record<string, string> = {
  // server actions: they resolve the branch from the session (guardedBranch / branchScope) and call registered data-layer functions
  ...Object.fromEntries(
    ['account', 'accounting', 'activity', 'branches', 'catalog', 'guard', 'inventory', 'parties', 'purchaseImport', 'purchases', 'reports', 'sales', 'serials', 'settings', 'users'].map((m) => [
      `actions/${m}`,
      'server actions: take the branch from branchScope(session) and call the registered data layer',
    ]),
  ),
  'accounting/schemas': 'zod schemas only',
  'activity/activity': 'company-wide activity log / record history; the action enforces seesCompanyWide for multi-branch',
  'activity/diff': 'pure diff formatting',
  audit: 'activity_log writer (append only, called inside the caller transaction)',
  ...Object.fromEntries(['actions', 'client-ip', 'constants', 'current', 'login-throttle', 'password', 'public-paths', 'rate-limit', 'revoke', 'session', 'session-user'].map((m) => [`auth/${m}`, 'authentication: users and sessions are company-level'])),
  branch: 'the branch scope primitives themselves',
  'branches/branches': 'branch master data (company-level CRUD of branches)',
  'catalog/products': 'company: product catalog is shared by all branches',
  'catalog/schemas': 'zod schemas only',
  'catalog/sku': 'pure SKU helpers',
  'catalog/taxonomy': 'company: categories and brands are shared',
  'catalog/visibility': 'pure cost-visibility filter',
  company: 'company settings / identity',
  dates: 'pure date helpers',
  ...Object.fromEntries(['driver', 'index', 'schema/_common', 'schema/accounting', 'schema/catalog', 'schema/core', 'schema/identity', 'schema/index', 'schema/parties', 'schema/purchasing', 'schema/sales', 'schema/service', 'schema/transfers'].map((m) => [`db/${m}`, 'database driver and table definitions'])),
  'demo/seed': 'demo seeder: writes into the default branch explicitly through the registered data layer',
  docnumbers: 'document numbering is per company (one sequence per document type)',
  errors: 'error classes',
  health: 'health check (no business data)',
  history: 'record_history writer (append only, inside the caller transaction)',
  ...Object.fromEntries(['core', 'passwords', 'policy', 'roles', 'session-role', 'users'].map((m) => [`iam/${m}`, 'identity & access: users/roles are company-level; users.ts applies its own branch rule (actorOnlyBranch)'])),
  install: 'installer (runs before any company exists)',
  'install-env': 'installer environment helpers',
  'inventory/pure': 'pure inventory helpers',
  'inventory/schemas': 'zod schemas only',
  'labels/pure': 'pure label layout helpers',
  'lookup/links': 'pure link helpers',
  'lookup/pure': 'pure lookup helpers',
  'migrations-status': 'schema migration bookkeeping (no business data)',
  money: 'pure money helpers',
  pagination: 'pure pagination helpers',
  'parties/parties': 'company: vendors and customers are shared by all branches',
  'parties/schemas': 'zod schemas only',
  'purchases/importCsv': 'pure CSV parsing',
  'purchases/importForm': 'pure form parsing',
  'purchases/schemas': 'zod schemas only',
  'purchases/serialInput': 'pure serial input parsing',
  'purchases/totals': 'pure totals',
  rbac: 'permission catalog and checks',
  'reports/csv': 'pure CSV writer',
  'reports/csvResponse': 'HTTP response helper',
  'reports/pure': 'pure report math',
  'reports/types': 'types only',
  'sales/schemas': 'zod schemas only',
  'sales/totals': 'pure totals',
  'service/schemas': 'zod schemas only',
  'settings/pure': 'pure settings parsing',
  'settings/settings': 'company settings',
  validation: 'shared zod helpers',
}

describe('every server module is classified', () => {
  it('each non-test module under src/server is in REGISTRY or UNSCOPED_MODULES (with a reason)', async () => {
    const { readdirSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const root = join(import.meta.dirname)
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    const modules = walk(root)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
      .map((f) => relative(root, f).replace(/\\/g, '/').replace(/\.tsx?$/, ''))
    const unknown = modules.filter((m) => !(m in REGISTRY) && !(m in UNSCOPED_MODULES))
    expect(unknown, 'classify these modules in src/server/branch-scope-registry.test.ts (REGISTRY or UNSCOPED_MODULES)').toEqual([])
    const stale = Object.keys(UNSCOPED_MODULES).filter((m) => !modules.includes(m))
    expect(stale, 'stale UNSCOPED_MODULES entries').toEqual([])
    for (const m of Object.keys(UNSCOPED_MODULES)) expect(m in REGISTRY, `${m} is in both lists`).toBe(false)
    for (const [m, why] of Object.entries(UNSCOPED_MODULES)) expect(why.length, `${m}: give the reason`).toBeGreaterThan(8)
  })
})
