import { isValidElement, type ReactNode } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetData, setupTestDb, type TestDb } from '@/test/db-harness'

// Inject the session through the seams the actions and pages use (authorize / getSession). Real DB, real RBAC check.
type Sess = { uid: string; cid: string; bid: null; role: string; adm: boolean; sv: number; perms: string[] }
const st = vi.hoisted(() => ({ session: null as null | Sess }))
vi.mock('../auth/current', async () => {
  const { requirePermission } = await import('../rbac')
  return { authorize: async (key: never) => requirePermission(st.session, key), getSession: async () => st.session, getSessionUser: async () => null }
})
vi.mock('@/server/auth/current', async () => {
  const { requirePermission } = await import('../rbac')
  return { authorize: async (key: never) => requirePermission(st.session, key), getSession: async () => st.session, getSessionUser: async () => null }
})
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
  notFound: () => {
    throw new Error('notFound')
  },
  useRouter: () => ({}),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

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
})

const D = '2026-11-26'

async function seed() {
  const { a, b } = await (await import('@/test/seed')).seedTwoCompanies()
  const { getDb } = await import('../db')
  const { createProduct } = await import('../catalog/products')
  const { createParty } = await import('../parties/parties')
  const { createPurchase } = await import('../purchases/purchases')
  const db = getDb()
  const cable = await createProduct(db, a.cid, a.uid, { name: 'Cable', sku: 'CB-1', purchasePrice: '40' })
  const cam = await createProduct(db, a.cid, a.uid, { name: 'Camera', sku: 'CM-1', trackSerial: true })
  const vendor = await createParty(db, a.cid, a.uid, 'vendor', { name: 'V' })
  await createPurchase(db, a.cid, a.uid, { vendorId: vendor.id, date: D, items: [{ productId: cable.id, qty: 5, unitCost: '41.37', serials: [] }, { productId: cam.id, qty: 1, unitCost: '1234.56', serials: ['CAM-1'] }] }, await (await import('@/test/seed')).mainCtx(a.cid))
  const as = (perms: string[], who: 'a' | 'b' = 'a') => (st.session = { uid: who === 'a' ? a.uid : b.uid, cid: who === 'a' ? a.cid : b.cid, bid: null, role: 'custom', adm: false, sv: 0, perms })
  return { a, b, db, cable, cam, as }
}

/** Every string in a server-rendered element tree (children and string props), without invoking components. */
function strings(node: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => strings(n, out))
  else if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>
    for (const [k, v] of Object.entries(props)) {
      if (k === 'children') strings(v as ReactNode, out)
      else if (typeof v === 'string') out.push(v)
      else if (isValidElement(v)) strings(v, out)
    }
  }
  return out
}

describe('inventory actions: permissions and company scope', () => {
  it('view-only cannot adjust, count or apply; products.edit can; no session -> sign in', async () => {
    const { cable, cam, as } = await seed()
    const inv = await import('./inventory')
    const qty = { kind: 'qty', productId: cable.id, qtyChange: '-1', reason: 'damage' }
    as(['products.view', 'reports.view', 'sales.edit'])
    for (const r of [await inv.adjustStockAction(qty), await inv.loadCountSheetAction({}), await inv.countDiffAction({ lines: [] }), await inv.applyCountAction({ lines: [{ productId: cable.id, counted: '1', system: 5 }] })]) {
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) })
    }
    st.session = null
    expect(await inv.adjustStockAction(qty)).toMatchObject({ ok: false, error: expect.stringMatching(/sign in/) })
    as(['products.edit'])
    expect(await inv.adjustStockAction(qty)).toMatchObject({ ok: true, data: { onHand: 4 } })
    expect(await inv.adjustStockAction({ kind: 'unit', productId: cam.id, serial: 'CAM-1', reason: 'loss' })).toMatchObject({ ok: true, data: { onHand: 0 } })
    const sheet = await inv.loadCountSheetAction({})
    expect(sheet).toMatchObject({ ok: true })
    expect(JSON.stringify(sheet)).not.toMatch(/41\.37|1234\.56|unitCost/) // no costs on the count sheet
    expect(await inv.applyCountAction({ lines: [{ productId: cable.id, counted: '6', system: 4 }] })).toMatchObject({ ok: true, data: { applied: [{ qtyChange: 2 }] } })
    // invalid input -> friendly field errors, no SQL leaks
    expect(await inv.adjustStockAction({ kind: 'qty', productId: 'nope', qtyChange: 'x', reason: 'damage' })).toMatchObject({ ok: false, fieldErrors: expect.any(Object) })
  })

  it("company B's session with company A's ids gets not-found errors and changes nothing", async () => {
    const { db, a, cable, cam, as } = await seed()
    const inv = await import('./inventory')
    as(['products.edit'], 'b')
    expect(await inv.adjustStockAction({ kind: 'qty', productId: cable.id, qtyChange: '1', reason: 'found' })).toMatchObject({ ok: false, fieldErrors: { productId: 'Product not found' } })
    expect(await inv.adjustStockAction({ kind: 'unit', productId: cam.id, serial: 'CAM-1', reason: 'damage' })).toMatchObject({ ok: false })
    expect(await inv.countDiffAction({ lines: [{ productId: cable.id, counted: '1' }] })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
    expect(await inv.applyCountAction({ lines: [{ productId: cable.id, counted: '1', system: 5 }] })).toMatchObject({ ok: false })
    const { onHandQty } = await import('../sales/sales')
    expect((await onHandQty(db, a.cid, null, [cable.id])).get(cable.id)).toBe(5)
  })
})

describe('pages: /stock and /products/[id]', () => {
  it('cost and value columns only for profit-visibility holders; salesman gets NoAccess; other company product -> notFound', async () => {
    const { cable, as } = await seed()
    const { default: StockPage } = await import('@/app/(admin)/stock/page')
    const { default: ProductPage } = await import('@/app/(admin)/products/[id]/page')
    const NoAccess = (await import('@/components/ui/NoAccess')).default
    const sp = Promise.resolve({})

    // products.view without profit visibility: quantities yes, cost/value no
    as(['products.view'])
    const plain = strings(await StockPage({ searchParams: sp }))
    expect(plain).toContain('Cable')
    expect(plain).not.toContain('Avg unit cost')
    expect(plain).not.toContain('Stock value')
    expect(plain).not.toContain('206.85') // 5 x 41.37
    const prodPlain = strings(await ProductPage({ params: Promise.resolve({ id: cable.id }), searchParams: Promise.resolve({ tab: 'adjustments' }) }))
    expect(prodPlain).not.toContain('Avg net unit cost')
    expect(prodPlain).not.toContain('Stock value')
    expect(prodPlain).not.toContain('Purchase price') // list purchase price is cost data too

    // reports.view (PROFIT_PERMISSIONS) sees cost and value
    as(['products.view', 'reports.view'])
    const rich = strings(await StockPage({ searchParams: sp }))
    expect(rich).toContain('Avg unit cost')
    expect(rich).toContain('Stock value')
    expect(rich).toContain('206.85')
    expect(strings(await ProductPage({ params: Promise.resolve({ id: cable.id }), searchParams: Promise.resolve({}) }))).toContain('Purchase price')

    // default salesman role: no products.view -> NoAccess (no data loaded)
    const { DEFAULT_ROLE_PERMISSIONS } = await import('../rbac')
    as([...DEFAULT_ROLE_PERMISSIONS.salesman])
    const denied = (await StockPage({ searchParams: sp })) as { props: { children: ReactNode } }
    expect(JSON.stringify(strings(denied as unknown as ReactNode))).not.toContain('Cable')
    const kids = ([] as ReactNode[]).concat(denied.props.children)
    expect(kids.some((k) => isValidElement(k) && k.type === NoAccess)).toBe(true)

    // company B cannot open company A's product
    as(['products.view', 'reports.view'], 'b')
    await expect(ProductPage({ params: Promise.resolve({ id: cable.id }), searchParams: Promise.resolve({}) })).rejects.toThrow('notFound')
    const stockB = strings(await StockPage({ searchParams: sp }))
    expect(stockB).not.toContain('Cable')
  })
})
