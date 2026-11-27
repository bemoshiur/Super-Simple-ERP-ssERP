/**
 * Smoke test for purchase intake against a real, installed database:
 *   npx tsx scripts/smoke-purchase.ts      (DATABASE_URL from env or .env.local)
 *
 * Inside ONE outer transaction that is always rolled back (the data functions nest as savepoints), it creates a
 * vendor, a serial-tracked product and a non-serial product, records a purchase of 3 serials + 5 loose units with a
 * partial payment, and verifies units, unit_events, stock_movements, payment and due. Leaves no rows behind.
 */
import { loadEnvLocal } from './_env'
import { safeErrorInfo } from '../src/server/errors'

loadEnvLocal()

class Rollback extends Error {}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`)
  console.log(`ok - ${msg}`)
}

async function main() {
  const { getDb, schema, closeDb } = await import('../src/server/db')
  const { defaultBranchId } = await import('../src/server/branch')
  const { and, eq } = await import('drizzle-orm')
  const { createProduct } = await import('../src/server/catalog/products')
  const { createParty } = await import('../src/server/parties/parties')
  const { createPurchase } = await import('../src/server/purchases/purchases')
  const db = getDb()
  const [company] = await db.select().from(schema.companies).limit(1)
  if (!company) throw new Error('No company found: run the installer first.')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.companyId, company.id)).limit(1)
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, company.id)).limit(1)
  if (!user || !account) throw new Error('Company has no user or account: run the installer first.')
  const tag = `SMOKE-${Date.now().toString(36).toUpperCase()}`

  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as typeof db // nested db.transaction() calls become savepoints
      const wctx = { branchId: await defaultBranchId(t, company.id), restrict: null }
      const vendor = await createParty(t, company.id, user.id, 'vendor', { name: `${tag} vendor` })
      const phone = await createProduct(t, company.id, user.id, { name: `${tag} phone`, sku: `${tag}-P`, trackSerial: true, warrantyMonths: 6 })
      const loose = await createProduct(t, company.id, user.id, { name: `${tag} cable`, sku: `${tag}-C` })
      const serials = [1, 2, 3].map((i) => `${tag}-IMEI-${i}`)
      const p = await createPurchase(t, company.id, user.id, {
        vendorId: vendor.id,
        date: new Date().toISOString().slice(0, 10),
        items: [
          { productId: phone.id, qty: 3, unitCost: '1000.50', serials },
          { productId: loose.id, qty: 5, unitCost: '20' },
        ],
        discount: '1.50',
        paid: '1000',
        accountId: account.id,
        expectedTotal: '3100.00',
      }, wctx)
      console.log(`created ${p.invoiceNo}`)
      check(p.total === '3100.00' && p.due === '2100.00', 'total 3100.00 and due 2100.00')
      const units = await tx.select().from(schema.productUnits).where(and(eq(schema.productUnits.companyId, company.id), eq(schema.productUnits.productId, phone.id)))
      check(units.length === 3 && units.every((u) => u.status === 'in_stock' && u.vendorId === vendor.id && u.warrantyMonths === 6), '3 units in stock with vendor and warranty')
      const events = [] // sequential: one connection inside a transaction
      for (const u of units) events.push(await tx.select().from(schema.unitEvents).where(eq(schema.unitEvents.unitId, u.id)))
      check(events.every((e) => e.length === 1 && e[0].type === 'purchased'), 'one purchased event per unit')
      const moves = await tx.select().from(schema.stockMovements).where(eq(schema.stockMovements.productId, loose.id))
      check(moves.length === 1 && moves[0].qtyChange === 5, 'stock movement of +5 for the non-serial product')
      const pays = await tx.select().from(schema.payments).where(and(eq(schema.payments.refType, 'purchase'), eq(schema.payments.refId, p.id)))
      const [head] = await tx.select().from(schema.purchases).where(eq(schema.purchases.id, p.id))
      check(pays.length === 1 && pays[0].amount === '1000.00' && pays[0].direction === 'out' && head.status === 'partially_paid', 'payment row and partially_paid status')
      throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  console.log('OK (rolled back, nothing written)')
  await closeDb()
}

main().catch((e) => {
  console.error(safeErrorInfo(e))
  process.exit(1)
})
