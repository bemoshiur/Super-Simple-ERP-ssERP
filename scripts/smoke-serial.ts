/**
 * Smoke test for serial lookup against a real, installed database:
 *   npx tsx scripts/smoke-serial.ts          (DATABASE_URL from env or .env.local) rolls everything back
 *   npx tsx scripts/smoke-serial.ts --keep   keeps the demo rows (ABC Electronics, HIK123456789, Rahim) for browsing
 *
 * Runs the brief's example (vendor ABC Electronics -> HIK123456789 @2000 -> sold to Rahim @2800) and asserts the 8
 * facts the serial page must show, then opens a service ticket and checks the unit history and the profit gate.
 */
import { loadEnvLocal } from './_env'
import { safeErrorInfo } from '../src/server/errors'

loadEnvLocal()
const KEEP = process.argv.includes('--keep')

class Rollback extends Error {}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`)
  console.log(`ok - ${msg}`)
}

async function main() {
  const { getDb, schema, closeDb } = await import('../src/server/db')
  const { defaultBranchId } = await import('../src/server/branch')
  const { eq } = await import('drizzle-orm')
  const { createProduct } = await import('../src/server/catalog/products')
  const { createParty } = await import('../src/server/parties/parties')
  const { createPurchase } = await import('../src/server/purchases/purchases')
  const { createSale } = await import('../src/server/sales/sales')
  const { getUnitDetail, searchSerials } = await import('../src/server/lookup/lookup')
  const { openServiceTicket, closeServiceTicket } = await import('../src/server/service/tickets')
  const db = getDb()
  const [company] = await db.select().from(schema.companies).limit(1)
  if (!company) throw new Error('No company found: run the installer first.')
  const [user] = await db.select().from(schema.users).where(eq(schema.users.companyId, company.id)).limit(1)
  const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, company.id)).limit(1)
  if (!user || !account) throw new Error('Company has no user or account: run the installer first.')
  const today = new Date().toISOString().slice(0, 10)
  const serial = KEEP ? 'HIK123456789' : `SMOKE-${Date.now().toString(36).toUpperCase()}-HIK123456789`

  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as typeof db
      const wctx = { branchId: await defaultBranchId(t, company.id), restrict: null }
      const vendor = await createParty(t, company.id, user.id, 'vendor', { name: 'ABC Electronics' })
      const rahim = await createParty(t, company.id, user.id, 'customer', { name: 'Rahim' })
      const cam = await createProduct(t, company.id, user.id, { name: 'HIK Camera', sku: `HIK-${Date.now().toString(36).toUpperCase()}`, trackSerial: true, warrantyMonths: 12, salePrice: '2800' })
      const p = await createPurchase(t, company.id, user.id, { vendorId: vendor.id, date: today, items: [{ productId: cam.id, qty: 1, unitCost: '2000', serials: [serial] }] }, wctx)
      const s = await createSale(t, company.id, user.id, { customerId: rahim.id, date: today, items: [{ serial, qty: 1, unitPrice: '2800' }], payments: [{ accountId: account.id, amount: '1800' }], expectedTotal: '2800.00' }, wctx)

      const found = await searchSerials(t, company.id, null, `  ${serial.slice(0, -3)}`)
      check(found.match === 'partial' && found.redirectUnitId !== null, 'a partial scan finds the unit')
      const id = found.redirectUnitId as string
      const d = await getUnitDetail(t, company.id, null, { id }, { withCost: true })
      check(d.vendor?.name === 'ABC Electronics' && d.vendor.id === vendor.id, '1. vendor (linked)')
      check(d.unit.serialNo === serial, '2. serial')
      check(d.cost === '2000.00', '3. purchase cost 2000.00')
      check(d.currentSale?.customerName === 'Rahim' && d.currentSale.customerId === rahim.id, '4. sold to Rahim (linked)')
      check(d.currentSale?.salePrice === '2800.00', '5. sale price 2800.00')
      check(d.purchase?.invoiceNo === p.invoiceNo && d.purchase.date === today, '6. purchase invoice and date')
      check(d.currentSale?.invoiceNo === s.invoiceNo && d.currentSale.date === today, '7. sale invoice and date')
      check(d.currentSale?.profit === '800.00' && d.warranty?.state === 'active' && d.warranty.days >= 364, '8. profit 800.00 and warranty countdown')
      check(d.timeline.map((e) => e.type).join() === 'purchased,sold', 'timeline: purchased, sold')
      const hidden = await getUnitDetail(t, company.id, null, { id }, { withCost: false })
      check(hidden.cost === null && hidden.currentSale?.profit === null && !JSON.stringify(hidden).includes('2000.00'), 'cost and profit are absent without the profit permission')

      const tk = await openServiceTicket(t, company.id, user.id, id, { issue: 'No image output', notes: 'Customer reports no picture on one channel' }, wctx)
      check(tk.underWarranty, 'service ticket opened in warranty')
      check((await getUnitDetail(t, company.id, null, { id }, { withCost: true })).unit.status === 'in_service', 'unit is in service')
      await closeServiceTicket(t, company.id, user.id, tk.id, { outcome: 'repaired', resolution: 'Replaced the power board' }, wctx)
      const after = await getUnitDetail(t, company.id, null, { id }, { withCost: true })
      check(after.unit.status === 'sold' && after.timeline.map((e) => e.type).join() === 'purchased,sold,sent_to_service,returned_from_service', 'repaired: back to sold, 4-step timeline')
      if (!KEEP) throw new Rollback()
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }
  console.log(KEEP ? 'OK (demo rows kept)' : 'OK (rolled back, nothing written)')
  await closeDb()
}

main().catch((e) => {
  console.error(safeErrorInfo(e))
  process.exit(1)
})
