/**
 * Branch management (Task 14). Settings area: create / edit need settings.edit, deactivate needs settings.delete,
 * reactivate settings.edit (the same split as products and parties). The default (Main) branch exists from install and
 * can never be deactivated; any branch can be renamed but never to an empty name.
 *
 * Deactivation refuses (with the full list of reasons) while the branch still holds anything: units in stock or in service,
 * positive quantity stock, open service tickets, or users assigned to it. The branch row is taken FOR UPDATE, and every
 * write into a branch holds it FOR SHARE (resolveWriteBranch / users.resolveBranch), so a concurrent sale, purchase,
 * transfer or user assignment either finishes first (and is counted) or fails cleanly afterwards.
 */
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { logActivity } from '../audit'
import { rowsOf, schema, type Db } from '../db'
import { FieldErrors, NotFoundError, PolicyError, isUniqueViolation, zodFieldErrors } from '../errors'
import { diffFields, writeHistory } from '../history'

const NAME_UQ = 'branches_company_name_uq'
const CODE_UQ = 'branches_company_code_uq'
const optText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional())

export const branchSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Must be at most 80 characters'),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{0,9}$/, 'Code: 1-10 letters, digits or dashes (e.g. DHK, CTG-2)'),
  address: optText(300),
  phone: optText(40),
})
export type BranchInput = z.input<typeof branchSchema>

const TRACKED = ['name', 'code', 'address', 'phone'] as const

export type BranchRow = typeof schema.branches.$inferSelect & { users: number; unitsInStock: number }

function parse(input: unknown) {
  const r = branchSchema.safeParse(input)
  if (!r.success) throw new FieldErrors(zodFieldErrors(r.error))
  return r.data
}

const mapUnique = (e: unknown): never => {
  if (isUniqueViolation(e, NAME_UQ)) throw new FieldErrors({ name: 'Another branch already has this name.' })
  if (isUniqueViolation(e, CODE_UQ)) throw new FieldErrors({ code: 'Another branch already uses this code.' })
  throw e
}

/** Every branch of the company (active first, default first), with user and in-stock unit counts. */
export async function listBranchesAdmin(db: Pick<Db, 'select'>, companyId: string): Promise<BranchRow[]> {
  const b = schema.branches
  const rows = await db.select().from(b).where(eq(b.companyId, companyId)).orderBy(sql`${b.active} desc`, sql`${b.isDefault} desc`, asc(b.name))
  const ids = rows.map((r) => r.id)
  if (!ids.length) return []
  const [users, units] = await Promise.all([
    db.select({ id: schema.users.branchId, n: count() }).from(schema.users).where(and(eq(schema.users.companyId, companyId), eq(schema.users.active, true), inArray(schema.users.branchId, ids))).groupBy(schema.users.branchId),
    db.select({ id: schema.productUnits.branchId, n: count() }).from(schema.productUnits).where(and(eq(schema.productUnits.companyId, companyId), eq(schema.productUnits.status, 'in_stock'), inArray(schema.productUnits.branchId, ids))).groupBy(schema.productUnits.branchId),
  ])
  const u = new Map(users.map((r) => [r.id, Number(r.n)]))
  const s = new Map(units.map((r) => [r.id, Number(r.n)]))
  return rows.map((r) => ({ ...r, users: u.get(r.id) ?? 0, unitsInStock: s.get(r.id) ?? 0 }))
}

export async function createBranch(db: Db, companyId: string, userId: string, input: unknown) {
  const d = parse(input)
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.branches).values({ companyId, name: d.name, code: d.code, address: d.address ?? null, phone: d.phone ?? null, isDefault: false, active: true }).returning()
      await logActivity({ companyId, userId, action: 'branch.create', entity: 'branch', entityId: row.id, after: { name: row.name, code: row.code, address: row.address, phone: row.phone } }, tx)
      return row
    })
  } catch (e) {
    return mapUnique(e)
  }
}

export async function updateBranch(db: Db, companyId: string, userId: string, id: string, input: unknown) {
  const d = parse(input)
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.branches).where(and(eq(schema.branches.id, id), eq(schema.branches.companyId, companyId))).for('update')
      if (!before) throw new NotFoundError('Branch')
      const [row] = await tx
        .update(schema.branches)
        .set({ name: d.name, code: d.code, address: d.address ?? null, phone: d.phone ?? null, updatedAt: new Date() })
        .where(and(eq(schema.branches.id, id), eq(schema.branches.companyId, companyId)))
        .returning()
      const diff = diffFields(before, row, TRACKED)
      await writeHistory(tx, { companyId, userId, entity: 'branch', entityId: id, diff })
      await logActivity({ companyId, userId, action: 'branch.update', entity: 'branch', entityId: id, before: { name: before.name, code: before.code, address: before.address, phone: before.phone }, after: { name: row.name, code: row.code, address: row.address, phone: row.phone } }, tx)
      return row
    })
  } catch (e) {
    return mapUnique(e)
  }
}

/** What still lives in a branch (each item is a human sentence). Empty = it may be deactivated. */
export async function branchBlockers(tx: Pick<Db, 'select' | 'execute'>, companyId: string, branchId: string): Promise<string[]> {
  const out: string[] = []
  const u = schema.productUnits
  const units = await tx.select({ status: u.status, n: count() }).from(u).where(and(eq(u.companyId, companyId), eq(u.branchId, branchId), inArray(u.status, ['in_stock', 'in_service']))).groupBy(u.status)
  for (const r of units) out.push(r.status === 'in_stock' ? `${r.n} serial unit${Number(r.n) === 1 ? ' is' : 's are'} in stock here (transfer or sell them first)` : `${r.n} unit${Number(r.n) === 1 ? ' is' : 's are'} in service here`)
  const m = schema.stockMovements
  const plain = rowsOf<{ name: string; qty: string }>(
    await tx.execute(sql`select ${schema.products.name} as name, sum(${m.qtyChange})::text as qty from ${m} join ${schema.products} on ${schema.products.id} = ${m.productId} and ${schema.products.companyId} = ${companyId}
      where ${m.companyId} = ${companyId} and ${m.branchId} = ${branchId} group by ${schema.products.id}, ${schema.products.name} having sum(${m.qtyChange}) > 0 order by ${schema.products.name} limit 6`),
  )
  if (plain.length) out.push(`quantity stock is held here: ${plain.slice(0, 5).map((p) => `${p.name} (${p.qty})`).join(', ')}${plain.length > 5 ? ', ...' : ''} (transfer it first)`)
  const t = schema.serviceTickets
  const [tk] = await tx.select({ n: count() }).from(t).where(and(eq(t.companyId, companyId), eq(t.branchId, branchId), inArray(t.status, ['open', 'in_progress'])))
  if (Number(tk.n) > 0) out.push(`${tk.n} service ticket${Number(tk.n) === 1 ? ' is' : 's are'} still open`)
  const [us] = await tx.select({ n: count() }).from(schema.users).where(and(eq(schema.users.companyId, companyId), eq(schema.users.branchId, branchId), eq(schema.users.active, true)))
  if (Number(us.n) > 0) out.push(`${us.n} user${Number(us.n) === 1 ? ' is' : 's are'} assigned to it (move them to another branch first)`)
  return out
}

/** Deactivate (settings.delete) or reactivate (settings.edit) a branch. The default branch can never be deactivated. */
export async function setBranchActive(db: Db, companyId: string, userId: string, id: string, active: boolean) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.branches).where(and(eq(schema.branches.id, id), eq(schema.branches.companyId, companyId))).for('update')
    if (!before) throw new NotFoundError('Branch')
    if (before.active === active) return before
    if (!active) {
      if (before.isDefault) throw new PolicyError(`${before.name} is the main branch and cannot be deactivated.`)
      const blockers = await branchBlockers(tx, companyId, id)
      if (blockers.length) throw new PolicyError(`${before.name} cannot be deactivated yet: ${blockers.join('; ')}.`)
    }
    const [row] = await tx.update(schema.branches).set({ active, updatedAt: new Date() }).where(and(eq(schema.branches.id, id), eq(schema.branches.companyId, companyId))).returning()
    await writeHistory(tx, { companyId, userId, entity: 'branch', entityId: id, diff: { active: { from: before.active, to: active } } })
    await logActivity({ companyId, userId, action: active ? 'branch.reactivate' : 'branch.deactivate', entity: 'branch', entityId: id, before: { active: before.active }, after: { active } }, tx)
    return row
  })
}
