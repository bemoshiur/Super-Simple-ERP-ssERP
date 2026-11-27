/**
 * Manual income / expense entries and expense categories.
 *
 * Source of truth (see accounts.ts): every entry writes ONE payments row in the same transaction
 *   expense -> payments(direction out, ref_type 'expense', ref_id = expenses.id)
 *   income  -> payments(direction in,  ref_type 'income',  ref_id = incomes.id)
 * so account balances and the cash-flow report read payments only. The expenses/incomes tables carry the category and are what
 * the P&L and the category totals read, with voided rows excluded.
 *
 * VOID rules: an entry is never deleted and its cash row is never edited. Voiding (accounts.delete) writes a REVERSING payments
 * row (opposite direction, same amount, reverses_payment_id = the original, dated today in the shop's time zone) and stamps
 * voided_at/by/reason on the entry. The cash-flow report therefore shows the original and the reversal on their own dates, while
 * the P&L ignores the voided entry entirely. Only the category/note of an active entry can be edited (accounts.edit); to correct an
 * amount, date or account, void it and enter it again.
 *
 * Branches (Task 14): entries are written to the ACTIVE branch; the reversing row of a void keeps the ENTRY's branch (so a
 * branch's cash flow nets to zero), and restricted users can only edit / void their own branch's entries.
 */
import { and, asc, count, desc, eq, gte, ilike, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { logActivity } from '../audit'
import { assertPermits, branchCond, resolveWriteBranch, type BranchFilter, type WriteCtx } from '../branch'
import { appTimezone, localDate } from '../dates'
import { schema, rowsOf, type Db } from '../db'
import { FieldErrors, NotFoundError, isUniqueViolation, zodPathErrors } from '../errors'
import { diffFields, writeHistory } from '../history'
import { fromMinor, toMinor } from '../money'
import { likePattern } from '../pagination'
import { assertDateAllowed } from '../sales/sales'
import { expenseCategorySchema, expenseEditSchema, expenseSchema, incomeEditSchema, incomeSchema, voidSchema } from './schemas'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Ctx = WriteCtx
export type EntryKind = 'expense' | 'income'

const CAT_UQ = 'expense_categories_company_name_uq'

function parse<T>(s: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: import('zod').ZodError } }, input: unknown): T {
  const r = s.safeParse(input)
  if (!r.success) throw new FieldErrors(zodPathErrors(r.error))
  return r.data
}

async function assertActiveAccount(tx: Pick<Db, 'select'>, companyId: string, accountId: string) {
  const [acc] = await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true)))
  if (!acc) throw new FieldErrors({ accountId: 'Account not found' })
}

async function assertCategory(tx: Pick<Db, 'select'>, companyId: string, categoryId: string | null, allowInactiveId?: string | null) {
  if (!categoryId) return
  const [c] = await tx.select({ id: schema.expenseCategories.id, active: schema.expenseCategories.active }).from(schema.expenseCategories).where(and(eq(schema.expenseCategories.id, categoryId), eq(schema.expenseCategories.companyId, companyId)))
  if (!c || (!c.active && categoryId !== allowInactiveId)) throw new FieldErrors({ categoryId: 'Category not found' })
}

// ------------------------------------------------------------------ create

export async function createExpense(db: Db, companyId: string, userId: string, input: unknown, ctx: Ctx) {
  const d = parse(expenseSchema, input)
  assertDateAllowed(d.date)
  return db.transaction(async (tx) => {
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    await assertActiveAccount(tx, companyId, d.accountId)
    await assertCategory(tx, companyId, d.categoryId)
    const [row] = await tx.insert(schema.expenses).values({ companyId, branchId, categoryId: d.categoryId, accountId: d.accountId, amount: d.amount, date: d.date, note: d.note, createdBy: userId }).returning()
    await tx.insert(schema.payments).values({ companyId, branchId, direction: 'out', accountId: d.accountId, refType: 'expense', refId: row.id, amount: d.amount, method: 'expense', date: d.date, note: d.note, createdBy: userId })
    await logActivity({ companyId, userId, action: 'expense.create', entity: 'expense', entityId: row.id, after: { amount: d.amount, accountId: d.accountId, categoryId: d.categoryId, date: d.date } }, tx)
    return row
  })
}

export async function createIncome(db: Db, companyId: string, userId: string, input: unknown, ctx: Ctx) {
  const d = parse(incomeSchema, input)
  assertDateAllowed(d.date)
  return db.transaction(async (tx) => {
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    await assertActiveAccount(tx, companyId, d.accountId)
    const [row] = await tx.insert(schema.incomes).values({ companyId, branchId, category: d.category, accountId: d.accountId, amount: d.amount, date: d.date, note: d.note, createdBy: userId }).returning()
    await tx.insert(schema.payments).values({ companyId, branchId, direction: 'in', accountId: d.accountId, refType: 'income', refId: row.id, amount: d.amount, method: 'income', date: d.date, note: d.note, createdBy: userId })
    await logActivity({ companyId, userId, action: 'income.create', entity: 'income', entityId: row.id, after: { amount: d.amount, accountId: d.accountId, category: d.category, date: d.date } }, tx)
    return row
  })
}

// ------------------------------------------------------------------ edit (category / note only)

export async function updateExpense(db: Db, companyId: string, userId: string, id: string, input: unknown, ctx: Pick<Ctx, 'restrict'>) {
  const d = parse(expenseEditSchema, input)
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.expenses).where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId))).for('update')
    if (!before) throw new NotFoundError('Expense')
    assertPermits(ctx.restrict, before.branchId, 'Expense')
    if (before.voidedAt) throw new FieldErrors({ _: 'A voided expense cannot be edited.' }, 'A voided expense cannot be edited.')
    await assertCategory(tx, companyId, d.categoryId, before.categoryId)
    const [row] = await tx.update(schema.expenses).set({ categoryId: d.categoryId, note: d.note }).where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, companyId))).returning()
    await writeHistory(tx, { companyId, userId, entity: 'expense', entityId: id, diff: diffFields(before, row, ['categoryId', 'note']) })
    await logActivity({ companyId, userId, action: 'expense.update', entity: 'expense', entityId: id, before: { categoryId: before.categoryId, note: before.note }, after: { categoryId: row.categoryId, note: row.note } }, tx)
    return row
  })
}

export async function updateIncome(db: Db, companyId: string, userId: string, id: string, input: unknown, ctx: Pick<Ctx, 'restrict'>) {
  const d = parse(incomeEditSchema, input)
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.incomes).where(and(eq(schema.incomes.id, id), eq(schema.incomes.companyId, companyId))).for('update')
    if (!before) throw new NotFoundError('Income')
    assertPermits(ctx.restrict, before.branchId, 'Income')
    if (before.voidedAt) throw new FieldErrors({ _: 'A voided income cannot be edited.' }, 'A voided income cannot be edited.')
    const [row] = await tx.update(schema.incomes).set({ category: d.category, note: d.note }).where(and(eq(schema.incomes.id, id), eq(schema.incomes.companyId, companyId))).returning()
    await writeHistory(tx, { companyId, userId, entity: 'income', entityId: id, diff: diffFields(before, row, ['category', 'note']) })
    await logActivity({ companyId, userId, action: 'income.update', entity: 'income', entityId: id, before: { category: before.category, note: before.note }, after: { category: row.category, note: row.note } }, tx)
    return row
  })
}

// ------------------------------------------------------------------ void

/** Void an entry: reversing payments row + voided_* stamp, in one transaction. Idempotent-safe: a second void is rejected. */
export async function voidEntry(db: Db, companyId: string, userId: string, kind: EntryKind, id: string, input: unknown, ctx: Pick<Ctx, 'restrict'>, now: Date = new Date()) {
  const d = parse(voidSchema, input)
  const today = localDate(appTimezone(), now)
  return db.transaction(async (tx: Tx) => {
    const t = kind === 'expense' ? schema.expenses : schema.incomes
    const [entry] = await tx.select().from(t).where(and(eq(t.id, id), eq(t.companyId, companyId))).for('update')
    if (!entry) throw new NotFoundError(kind === 'expense' ? 'Expense' : 'Income')
    assertPermits(ctx.restrict, entry.branchId, kind === 'expense' ? 'Expense' : 'Income')
    if (entry.voidedAt) throw new FieldErrors({ _: 'This entry is already voided.' }, 'This entry is already voided.')
    const originals = await tx
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.refType, kind), eq(schema.payments.refId, id), isNull(schema.payments.reversesPaymentId)))
    if (originals.length !== 1) throw new Error(`Integrity: ${kind} ${id} has ${originals.length} cash rows`)
    const o = originals[0]
    const [acc] = await tx.select({ active: schema.accounts.active, name: schema.accounts.name }).from(schema.accounts).where(and(eq(schema.accounts.id, o.accountId), eq(schema.accounts.companyId, companyId)))
    if (!acc?.active) {
      const msg = `The account "${acc?.name ?? 'unknown'}" is deactivated. Reactivate it before voiding this entry, because the void posts a reversing payment to it.`
      throw new FieldErrors({ _: msg }, msg)
    }
    // The reversal can never be dated before the original.
    const date = today < o.date ? o.date : today
    await tx.insert(schema.payments).values({
      companyId,
      // The reversal belongs to the entry's branch (not the voider's), so that branch's cash flow nets to zero.
      branchId: o.branchId ?? entry.branchId,
      direction: o.direction === 'in' ? 'out' : 'in',
      accountId: o.accountId,
      refType: kind,
      refId: id,
      amount: o.amount,
      method: 'void',
      date,
      note: `Void: ${d.reason}`,
      reversesPaymentId: o.id,
      createdBy: userId,
    })
    await tx.update(t).set({ voidedAt: new Date(), voidedBy: userId, voidReason: d.reason }).where(and(eq(t.id, id), eq(t.companyId, companyId)))
    await writeHistory(tx, { companyId, userId, entity: kind, entityId: id, diff: { voided: { from: false, to: true }, reason: { from: null, to: d.reason } } })
    await logActivity({ companyId, userId, action: `${kind}.void`, entity: kind, entityId: id, before: { amount: entry.amount, date: entry.date }, after: { reason: d.reason, reversedOn: date } }, tx)
    return { reversedOn: date }
  })
}

// ------------------------------------------------------------------ lists

export type EntryFilter = { from?: string; to?: string; categoryId?: string; category?: string; accountId?: string; status?: 'active' | 'voided' | 'all'; q?: string; limit: number; offset: number }

export type EntryRow = { id: string; date: string; amount: string; note: string | null; accountId: string; accountName: string; category: string | null; categoryId: string | null; voidedAt: Date | null; voidReason: string | null; createdByName: string | null }

/** Expenses, newest first, with the total of ACTIVE (non-voided) entries over the whole filtered set. */
export async function listExpenses(db: Db, companyId: string, branch: BranchFilter, f: EntryFilter) {
  const e = schema.expenses
  const where = and(
    eq(e.companyId, companyId),
    branchCond(e.branchId, branch),
    f.from ? gte(e.date, f.from) : undefined,
    f.to ? lte(e.date, f.to) : undefined,
    f.categoryId ? eq(e.categoryId, f.categoryId) : undefined,
    f.accountId ? eq(e.accountId, f.accountId) : undefined,
    f.status === 'voided' ? isNotNull(e.voidedAt) : f.status === 'all' ? undefined : isNull(e.voidedAt),
    f.q ? sql`(${e.note} ilike ${likePattern(f.q)} or ${schema.expenseCategories.name} ilike ${likePattern(f.q)})` : undefined,
  )
  const [rows, [agg]] = await Promise.all([
    db
      .select({ id: e.id, date: e.date, amount: e.amount, note: e.note, accountId: e.accountId, accountName: schema.accounts.name, category: schema.expenseCategories.name, categoryId: e.categoryId, voidedAt: e.voidedAt, voidReason: e.voidReason, createdByName: schema.users.name })
      .from(e)
      .innerJoin(schema.accounts, and(eq(schema.accounts.id, e.accountId), eq(schema.accounts.companyId, companyId)))
      .leftJoin(schema.expenseCategories, and(eq(schema.expenseCategories.id, e.categoryId), eq(schema.expenseCategories.companyId, companyId)))
      .leftJoin(schema.users, and(eq(schema.users.id, e.createdBy), eq(schema.users.companyId, companyId)))
      .where(where)
      .orderBy(desc(e.date), desc(e.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db
      .select({ n: count(), total: sql<string>`coalesce(sum(${e.amount}) filter (where ${e.voidedAt} is null), 0)::text` })
      .from(e)
      .leftJoin(schema.expenseCategories, and(eq(schema.expenseCategories.id, e.categoryId), eq(schema.expenseCategories.companyId, companyId)))
      .where(where),
  ])
  return { rows: rows as EntryRow[], total: Number(agg.n), sum: fromMinor(toMinor(agg.total)) }
}

export async function listIncomes(db: Db, companyId: string, branch: BranchFilter, f: EntryFilter) {
  const i = schema.incomes
  const where = and(
    eq(i.companyId, companyId),
    branchCond(i.branchId, branch),
    f.from ? gte(i.date, f.from) : undefined,
    f.to ? lte(i.date, f.to) : undefined,
    f.category ? ilike(i.category, likePattern(f.category)) : undefined,
    f.accountId ? eq(i.accountId, f.accountId) : undefined,
    f.status === 'voided' ? isNotNull(i.voidedAt) : f.status === 'all' ? undefined : isNull(i.voidedAt),
    f.q ? sql`(${i.note} ilike ${likePattern(f.q)} or ${i.category} ilike ${likePattern(f.q)})` : undefined,
  )
  const [rows, [agg]] = await Promise.all([
    db
      .select({ id: i.id, date: i.date, amount: i.amount, note: i.note, accountId: i.accountId, accountName: schema.accounts.name, category: i.category, voidedAt: i.voidedAt, voidReason: i.voidReason, createdByName: schema.users.name })
      .from(i)
      .innerJoin(schema.accounts, and(eq(schema.accounts.id, i.accountId), eq(schema.accounts.companyId, companyId)))
      .leftJoin(schema.users, and(eq(schema.users.id, i.createdBy), eq(schema.users.companyId, companyId)))
      .where(where)
      .orderBy(desc(i.date), desc(i.createdAt))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ n: count(), total: sql<string>`coalesce(sum(${i.amount}) filter (where ${i.voidedAt} is null), 0)::text` }).from(i).where(where),
  ])
  return { rows: rows.map((r) => ({ ...r, categoryId: null })) as EntryRow[], total: Number(agg.n), sum: fromMinor(toMinor(agg.total)) }
}

/** Distinct income categories used so far (suggestions for the free-text field). */
export async function incomeCategorySuggestions(db: Db, companyId: string, limit = 50): Promise<string[]> {
  const res = await db.execute(sql`select distinct ${schema.incomes.category} as c from ${schema.incomes} where ${schema.incomes.companyId} = ${companyId} and ${schema.incomes.category} is not null order by 1 limit ${limit}`)
  return rowsOf<{ c: string }>(res).map((r) => r.c)
}

// ------------------------------------------------------------------ expense categories

export async function listExpenseCategories(db: Db, companyId: string, status: 'active' | 'inactive' | 'all' = 'active') {
  const c = schema.expenseCategories
  return db
    .select({ id: c.id, name: c.name, active: c.active })
    .from(c)
    .where(and(eq(c.companyId, companyId), status === 'all' ? undefined : eq(c.active, status === 'active')))
    .orderBy(asc(c.name))
}

export async function createExpenseCategory(db: Db, companyId: string, userId: string, input: unknown) {
  const d = parse(expenseCategorySchema, input)
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.expenseCategories).values({ companyId, name: d.name }).returning()
      await logActivity({ companyId, userId, action: 'expense_category.create', entity: 'expense_category', entityId: row.id, after: { name: row.name } }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, CAT_UQ)) throw new FieldErrors({ name: 'A category with this name already exists (it may be deactivated).' })
    throw e
  }
}

export async function renameExpenseCategory(db: Db, companyId: string, userId: string, id: string, input: unknown) {
  const d = parse(expenseCategorySchema, input)
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.expenseCategories).where(and(eq(schema.expenseCategories.id, id), eq(schema.expenseCategories.companyId, companyId))).for('update')
      if (!before) throw new NotFoundError('Category')
      const [row] = await tx.update(schema.expenseCategories).set({ name: d.name }).where(and(eq(schema.expenseCategories.id, id), eq(schema.expenseCategories.companyId, companyId))).returning()
      await logActivity({ companyId, userId, action: 'expense_category.update', entity: 'expense_category', entityId: id, before: { name: before.name }, after: { name: row.name } }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, CAT_UQ)) throw new FieldErrors({ name: 'A category with this name already exists (it may be deactivated).' })
    throw e
  }
}

/** Soft delete / restore (expenses reference categories, so rows are never removed). */
export async function setExpenseCategoryActive(db: Db, companyId: string, userId: string, id: string, active: boolean) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(schema.expenseCategories).set({ active }).where(and(eq(schema.expenseCategories.id, id), eq(schema.expenseCategories.companyId, companyId))).returning()
    if (!row) throw new NotFoundError('Category')
    await logActivity({ companyId, userId, action: `expense_category.${active ? 'activate' : 'deactivate'}`, entity: 'expense_category', entityId: id, after: { active } }, tx)
    return row
  })
}
