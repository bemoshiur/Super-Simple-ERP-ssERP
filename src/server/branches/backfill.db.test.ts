/**
 * Task 14 backfill migration (0015) on PRE-EXISTING data: a database migrated up to 0013 (before branches were used),
 * with legacy rows whose branch_id is NULL, then the remaining migrations applied (0014 enum values, 0015 backfill, 0016 manager sign-out). Every branch-scoped row must end up
 * in its company's default (Main) branch; a company without any branch gets one; codes are assigned; the manager role
 * gets branches.all.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setupTestDb, type TestDb } from '@/test/db-harness'

let t: TestDb
let url: string
let admin: string
let dir: string
beforeAll(async () => {
  t = await setupTestDb() // provides the server (and AUTH_SECRET); this test uses its own extra database
  admin = (() => {
    const u = new URL(t.url)
    u.pathname = '/postgres'
    return u.toString()
  })()
  const name = `sserp_bf_${randomBytes(4).toString('hex')}`
  const c = new pg.Client({ connectionString: admin })
  await c.connect()
  await c.query(`create database ${name}`)
  await c.end()
  const u = new URL(t.url)
  u.pathname = `/${name}`
  url = u.toString()
  dir = await mkdtemp(path.join(tmpdir(), 'sserp-mig-'))
})
afterAll(async () => {
  const c = new pg.Client({ connectionString: admin })
  await c.connect()
  await c.query(`drop database if exists ${new URL(url).pathname.slice(1)} with (force)`)
  await c.end()
  await rm(dir, { recursive: true, force: true })
  await t?.teardown()
})

async function migrateUpTo(lastIdx: number | null) {
  const src = path.join(process.cwd(), 'drizzle')
  const target = path.join(dir, String(lastIdx ?? 'all'))
  await cp(src, target, { recursive: true })
  if (lastIdx !== null) {
    const jp = path.join(target, 'meta', '_journal.json')
    const j = JSON.parse(await readFile(jp, 'utf8')) as { entries: { idx: number }[] }
    j.entries = j.entries.filter((e) => e.idx <= lastIdx)
    await writeFile(jp, JSON.stringify(j))
  }
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: target })
  } finally {
    await pool.end()
  }
}

describe('0015 backfill on legacy rows', () => {
  it('stamps every NULL branch_id with the company default branch, creates Main where missing, codes branches, grants managers branches.all', async () => {
    await migrateUpTo(13)
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    try {
      const q = async <T = Record<string, unknown>>(s: string, p: unknown[] = []) => (await c.query(s, p)).rows as T[]
      const one = async (s: string, p: unknown[] = []) => (await q<{ id: string }>(s, p))[0].id
      // company A: a Main (no code column yet) + an extra branch; company B: no branch at all
      const A = await one(`insert into companies (name) values ('A') returning id`)
      const B = await one(`insert into companies (name) values ('B') returning id`)
      await one(`insert into branches (company_id, name, is_default) values ($1, 'Main', true) returning id`, [A])
      await one(`insert into branches (company_id, name, is_default) values ($1, 'Second', false) returning id`, [A])
      const roleA = await one(`insert into roles (company_id, name, is_system) values ($1, 'manager', true) returning id`, [A])
      const roleB = await one(`insert into roles (company_id, name, is_system) values ($1, 'salesman', true) returning id`, [B])
      await one(`insert into users (company_id, role_id, name, email, password_hash) values ($1, $2, 'u', 'u@a', 'x') returning id`, [A, roleA])
      await one(`insert into users (company_id, role_id, name, email, password_hash) values ($1, $2, 'v', 'v@b', 'x') returning id`, [B, roleB])
      for (const co of [A, B]) {
        const prod = await one(`insert into products (company_id, name, sku) values ($1, 'P', 'P') returning id`, [co])
        const vend = await one(`insert into vendors (company_id, name) values ($1, 'V') returning id`, [co])
        const acc = await one(`insert into accounts (company_id, type, name) values ($1, 'cash', 'Cash') returning id`, [co])
        const pu = await one(`insert into purchases (company_id, invoice_no, vendor_id, date) values ($1, 'P1', $2, '2026-01-01') returning id`, [co, vend])
        const unit = await one(`insert into product_units (company_id, product_id, serial_no, purchase_price) values ($1, $2, 'S1', 1) returning id`, [co, prod])
        await q(`insert into stock_movements (company_id, product_id, type, qty_change) values ($1, $2, 'purchase', 5)`, [co, prod])
        const sa = await one(`insert into sales (company_id, invoice_no, date) values ($1, 'I1', '2026-01-02') returning id`, [co])
        await q(`insert into payments (company_id, direction, account_id, ref_type, amount, date) values ($1, 'in', $2, 'manual', 1, '2026-01-02')`, [co, acc])
        await q(`insert into expenses (company_id, account_id, amount, date) values ($1, $2, 1, '2026-01-02')`, [co, acc])
        await q(`insert into incomes (company_id, account_id, amount, date) values ($1, $2, 1, '2026-01-02')`, [co, acc])
        await q(`insert into sale_returns (company_id, return_no, sale_id, date) values ($1, 'SR1', $2, '2026-01-03')`, [co, sa])
        await q(`insert into purchase_returns (company_id, return_no, purchase_id, vendor_id, date) values ($1, 'PR1', $2, $3, '2026-01-03')`, [co, pu, vend])
        await q(`insert into service_tickets (company_id, unit_id, issue) values ($1, $2, 'x')`, [co, unit])
        await q(`insert into stock_adjustments (company_id, product_id, qty_change, reason) values ($1, $2, 1, 'found')`, [co, prod])
      }
      expect((await q(`select count(*)::int as n from sales where branch_id is null`))[0]).toEqual({ n: 2 })
    } finally {
      await c.end()
    }

    await migrateUpTo(null) // the rest: 0014 (enum values) + 0015 (codes, backfill, indexes, transfers)

    const d = new pg.Client({ connectionString: url })
    await d.connect()
    try {
      const q = async <T = Record<string, unknown>>(s: string) => (await d.query(s)).rows as T[]
      const branches = await q<{ company_id: string; name: string; code: string; is_default: boolean }>(`select b.company_id, b.name, b.code, b.is_default from branches b join companies c on c.id = b.company_id order by c.name, b.is_default desc, b.name`)
      expect(branches.map((b) => [b.name, b.code, b.is_default])).toEqual([
        ['Main', 'MAIN', true],
        ['Second', 'BR01', false],
        ['Main', 'MAIN', true], // company B got a Main branch
      ])
      for (const tbl of ['purchases', 'sales', 'payments', 'expenses', 'incomes', 'product_units', 'stock_movements', 'stock_adjustments', 'sale_returns', 'purchase_returns', 'service_tickets', 'users']) {
        const rows = await q<{ ok: boolean; n: number }>(`select count(*)::int as n, bool_and(t.branch_id = b.id) as ok from ${tbl} t join branches b on b.company_id = t.company_id and b.is_default`)
        expect(rows[0], tbl).toEqual({ n: 2, ok: true })
        expect((await q(`select count(*)::int as n from ${tbl} where branch_id is null`))[0], tbl).toEqual({ n: 0 })
      }
      expect(await q(`select permission from role_permissions where permission = 'branches.all'`)).toEqual([{ permission: 'branches.all' }])
      // 0016: managers are signed out once (session_version bumped) so they pick up branches.all; other users untouched
      expect(await q(`select u.email, u.session_version from users u order by u.email`)).toEqual([{ email: 'u@a', session_version: 1 }, { email: 'v@b', session_version: 0 }])
      // the new enum values exist
      expect((await q(`select 'transfer'::stock_movement_type::text as v`))[0]).toEqual({ v: 'transfer' })
      expect((await q(`select 'transferred'::unit_event_type::text as v`))[0]).toEqual({ v: 'transferred' })
    } finally {
      await d.end()
    }
  })
})
