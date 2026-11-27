import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestDb, type TestDb } from '@/test/db-harness'

let t: TestDb
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.teardown()
})

describe('serial lookup index (migration 0017)', () => {
  it('case-insensitive exact and prefix lookups use product_units_company_serial_lower_idx', async () => {
    const { seedTwoCompanies, mainBranchId } = await import('@/test/seed')
    const { a } = await seedTwoCompanies()
    const { getDb, rowsOf } = await import('../db')
    const { createProduct } = await import('../catalog/products')
    const db = getDb()
    const p = await createProduct(db, a.cid, a.uid, { name: 'Phone', sku: 'PH-1', trackSerial: true })
    const branch = await mainBranchId(a.cid)
    await db.execute(
      sql`insert into product_units (company_id, branch_id, product_id, serial_no, purchase_price) select ${a.cid}, ${branch}, ${p.id}, 'SN-' || g, '1' from generate_series(1, 20000) g`,
    )
    await db.execute(sql`analyze product_units`)
    const plan = async (q: ReturnType<typeof sql>) => rowsOf<{ 'QUERY PLAN': string }>(await db.execute(sql`explain ${q}`)).map((r) => r['QUERY PLAN']).join('\n')
    const exactCi = await plan(sql`select id from product_units where company_id = ${a.cid} and lower(serial_no) = lower(${'sn-777'})`)
    expect(exactCi).toContain('product_units_company_serial_lower_idx')
    const prefix = await plan(sql`select id from product_units where company_id = ${a.cid} and lower(serial_no) like ${'sn-777%'}`)
    expect(prefix).toContain('product_units_company_serial_lower_idx')

    const { searchSerials } = await import('./lookup')
    const r = await searchSerials(db, a.cid, null, 'sn-777')
    expect(r).toMatchObject({ match: 'exact_ci', redirectUnitId: expect.any(String) })
  })
})
