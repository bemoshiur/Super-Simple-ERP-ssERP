/**
 * Smoke test for sales against a real, installed database:
 *   npx tsx scripts/smoke-sale.ts      (DATABASE_URL from env or .env.local)
 *
 * Inside ONE outer transaction that is always rolled back (the data functions nest as savepoints), it runs the brief's
 * example end to end: vendor "ABC Electronics" -> purchase of serial HIK123456789 @2000 -> sale to "Rahim" @2800 with a
 * partial payment -> due collection -> customer return with refund, and checks units, events, payments, profit and the
 * customer ledger at each step. Leaves no rows behind.
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
  const { getLedger } = await import('../src/server/parties/ledger')
  const { createPurchase } = await import('../src/server/purchases/purchases')
  const { createSale, getSale, recordCustomerPayment, createSaleReturn } = await import('../src/server/sales/sales')
  const db = getDb()
  const [company] = await db.select().from(schema.companies).limit(1)
  if (!company) throw new Error('No company found: run the installer first.')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.companyId, company.id)).limit(1)
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, company.id)).limit(1)
  if (!user || !account) throw new Error('Company has no user or account: run the installer first.')
  const tag = `SMOKE-${Date.now().toString(36).toUpperCase()}`
  const today = new Date().toISOString().slice(0, 10)
  const serial = `${tag}-HIK123456789`

  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as typeof db // nested db.transaction() calls become savepoints
      const wctx = { branchId: await defaultBranchId(t, company.id), restrict: null }
      const vendor = await createParty(t, company.id, user.id, 'vendor', { name: `${tag} ABC Electronics` })
      const rahim = await createParty(t, company.id, user.id, 'customer', { name: `${tag} Rahim` })
      const cam = await createProduct(t, company.id, user.id, { name: `${tag} HIK camera`, sku: `${tag}-HIK`, trackSerial: true, warrantyMonths: 12, salePrice: '2800' })
      await createPurchase(t, company.id, user.id, { vendorId: vendor.id, date: today, items: [{ productId: cam.id, qty: 1, unitCost: '2000', serials: [serial] }] }, wctx)

      const s = await createSale(t, company.id, user.id, { customerId: rahim.id, date: today, items: [{ serial, qty: 1, unitPrice: '2800' }], payments: [{ accountId: account.id, amount: '1800' }], expectedTotal: '2800.00' }, wctx)
      console.log(`created ${s.invoiceNo}`)
      check(s.total === '2800.00' && s.due === '1000.00', 'sale total 2800.00, due 1000.00')
      const [unit] = await tx.select().from(schema.productUnits).where(and(eq(schema.productUnits.companyId, company.id), eq(schema.productUnits.serialNo, serial)))
      check(unit.status === 'sold' && unit.warrantyStart === today && unit.warrantyEnd !== null, 'unit sold with a 12-month warranty from today')
      const events = await tx.select().from(schema.unitEvents).where(and(eq(schema.unitEvents.unitId, unit.id), eq(schema.unitEvents.type, 'sold')))
      check(events.length === 1 && events[0].price === '2800.00' && (events[0].meta as { customerId?: string }).customerId === rahim.id, 'one sold event with price and customer')
      const detail = await getSale(t, company.id, null, s.id)
      check(detail.profit === '800.00' && detail.items[0].unitCost === '2000.00', 'profit 800.00 from the 2000.00 cost snapshot')
      check((await getLedger(t, company.id, null, 'customer', rahim.id)).due === '1000.00', 'customer ledger due 1000.00')

      await recordCustomerPayment(t, company.id, user.id, s.id, { amount: '400', accountId: account.id, date: today }, wctx)
      check((await getLedger(t, company.id, null, 'customer', rahim.id)).due === '600.00', 'after collecting 400 the ledger due is 600.00')

      const r = await createSaleReturn(t, company.id, user.id, s.id, { items: [{ saleItemId: detail.items[0].id, qty: 1 }], date: today, refundAccountId: account.id }, wctx)
      check(r.credit === '2800.00' && r.refund === '2200.00' && r.due === '0.00', 'return credits 2800.00: clears the 600.00 due and refunds 2200.00')
      const [back] = await tx.select().from(schema.productUnits).where(eq(schema.productUnits.id, unit.id))
      check(back.status === 'in_stock' && back.warrantyEnd === null, 'unit back in stock, warranty cleared')
      const led = await getLedger(t, company.id, null, 'customer', rahim.id)
      check(led.billed === '2800.00' && led.returned === '2800.00' && led.paid === '0.00' && led.due === '0.00', 'customer ledger: billed 2800, returned 2800, net paid 0, due 0')
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
