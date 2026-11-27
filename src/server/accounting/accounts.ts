/**
 * Accounts (cash / bank / mobile) and transfers.
 *
 * SOURCE OF TRUTH FOR BALANCES: the `payments` table only.
 *   balance = opening_balance + sum(payments in) - sum(payments out)
 * Sales, purchases, refunds, manual income/expense, void reversals and transfers ALL write a payments row, so a balance is
 * never computed from expenses/incomes (that would double count). Payments are append-only: nothing is updated or deleted.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { logActivity } from '../audit'
import { resolveWriteBranch, type WriteCtx } from '../branch'
import { schema, rowsOf, type Db } from '../db'
import { FieldErrors, NotFoundError, isUniqueViolation, zodPathErrors } from '../errors'
import { diffFields, writeHistory } from '../history'
import { fromMinor, toMinor } from '../money'
import { assertDateAllowed } from '../sales/sales'
import { ACCOUNT_TRACKED, accountSchema, transferSchema } from './schemas'

const NAME_UQ = 'accounts_company_name_uq'
const DUP_NAME = 'An account with this name already exists (it may be deactivated).'

type Reader = Pick<Db, 'execute'>

/**
 * Negative-balance policy: balances are allowed to go below zero (cash drawers get overdrawn, bank accounts have overdrafts, payments
 * are often entered a day late). Nothing blocks a payment, transfer or expense because of the balance; the Accounts page flags
 * such accounts with an "Overdrawn" badge so the user can investigate. Deactivating an account still needs a zero balance.
 */
export type AccountBalance = { id: string; name: string; type: 'cash' | 'bank' | 'mobile'; active: boolean; opening: string; totalIn: string; totalOut: string; balance: string }

const money = (v: unknown): string => (v === null || v === undefined || v === '' ? '0.00' : fromMinor(toMinor(String(v))))

/**
 * Every account of the company with its live balance, one SQL aggregation (no per-account queries).
 * `asOf` (YYYY-MM-DD) limits the payments counted to date <= asOf (used by the cash-flow reconciliation).
 */
export async function listAccountBalances(db: Reader, companyId: string, opts: { asOf?: string; status?: 'active' | 'inactive' | 'all' } = {}): Promise<AccountBalance[]> {
  const a = schema.accounts
  const p = schema.payments
  const res = await db.execute(sql`
    select ${a.id} as id, ${a.name} as name, ${a.type} as type, ${a.active} as active, ${a.openingBalance}::text as opening,
      coalesce(sum(${p.amount}) filter (where ${p.direction} = 'in'), 0)::text as total_in,
      coalesce(sum(${p.amount}) filter (where ${p.direction} = 'out'), 0)::text as total_out,
      (${a.openingBalance} + coalesce(sum(case when ${p.direction} = 'in' then ${p.amount} else -${p.amount} end), 0))::text as balance
    from ${a}
    left join ${p} on ${p.accountId} = ${a.id} and ${p.companyId} = ${a.companyId} ${opts.asOf ? sql`and ${p.date} <= ${opts.asOf}` : sql``}
    where ${a.companyId} = ${companyId} ${opts.status === 'inactive' ? sql`and ${a.active} = false` : opts.status === 'all' ? sql`` : sql`and ${a.active} = true`}
    group by ${a.id}
    order by ${a.active} desc, ${a.name}`)
  return rowsOf<{ id: string; name: string; type: AccountBalance['type']; active: boolean; opening: string; total_in: string; total_out: string; balance: string }>(res).map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    active: r.active,
    opening: money(r.opening),
    totalIn: money(r.total_in),
    totalOut: money(r.total_out),
    balance: money(r.balance),
  }))
}

/** Sum of balances (exact, minor units). */
export function totalBalance(rows: readonly { balance: string }[]): string {
  return fromMinor(rows.reduce((acc, r) => acc + toMinor(r.balance), 0))
}

export async function getAccount(db: Db, companyId: string, id: string) {
  const [row] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.companyId, companyId)))
  if (!row) throw new NotFoundError('Account')
  return row
}

export async function createAccount(db: Db, companyId: string, userId: string, input: unknown) {
  const parsed = accountSchema.safeParse(input)
  if (!parsed.success) throw new FieldErrors(zodPathErrors(parsed.error))
  const d = parsed.data
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.accounts).values({ companyId, name: d.name, type: d.type, openingBalance: d.openingBalance }).returning()
      await logActivity({ companyId, userId, action: 'account.create', entity: 'account', entityId: row.id, after: { name: row.name, type: row.type, openingBalance: row.openingBalance } }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, NAME_UQ)) throw new FieldErrors({ name: DUP_NAME })
    throw e
  }
}

/** Edit name / type / opening balance (history-tracked). `active` is not editable here. */
export async function updateAccount(db: Db, companyId: string, userId: string, id: string, input: unknown) {
  const parsed = accountSchema.safeParse(input)
  if (!parsed.success) throw new FieldErrors(zodPathErrors(parsed.error))
  const d = parsed.data
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.companyId, companyId))).for('update')
      if (!before) throw new NotFoundError('Account')
      const [row] = await tx.update(schema.accounts).set({ name: d.name, type: d.type, openingBalance: d.openingBalance, updatedAt: new Date() }).where(and(eq(schema.accounts.id, id), eq(schema.accounts.companyId, companyId))).returning()
      await writeHistory(tx, { companyId, userId, entity: 'account', entityId: id, diff: diffFields(before, row, ACCOUNT_TRACKED) })
      await logActivity({ companyId, userId, action: 'account.update', entity: 'account', entityId: id, before: { name: before.name, type: before.type, openingBalance: before.openingBalance }, after: { name: row.name, type: row.type, openingBalance: row.openingBalance } }, tx)
      return row
    })
  } catch (e) {
    if (isUniqueViolation(e, NAME_UQ)) throw new FieldErrors({ name: DUP_NAME })
    throw e
  }
}

/**
 * Soft deactivate / reactivate (accounts are never hard-deleted: payments reference them). An account can be deactivated only
 * when its balance is exactly zero, so no money is hidden in an account nobody can select; transfer it out first.
 */
export async function setAccountActive(db: Db, companyId: string, userId: string, id: string, active: boolean) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.companyId, companyId))).for('update')
    if (!before) throw new NotFoundError('Account')
    if (before.active === active) return before
    if (!active) {
      const [bal] = await listAccountBalances(tx, companyId, { status: 'all' }).then((rows) => rows.filter((r) => r.id === id))
      if (bal && toMinor(bal.balance) !== 0) throw new FieldErrors({ _: `This account still holds ${bal.balance}. Transfer the balance to another account before deactivating it.` }, `This account still holds ${bal.balance}. Transfer the balance to another account before deactivating it.`)
    }
    const [row] = await tx.update(schema.accounts).set({ active, updatedAt: new Date() }).where(and(eq(schema.accounts.id, id), eq(schema.accounts.companyId, companyId))).returning()
    await logActivity({ companyId, userId, action: active ? 'account.activate' : 'account.deactivate', entity: 'account', entityId: id, before: { active: before.active }, after: { active } }, tx)
    return row
  })
}

/** Active accounts for selects. */
export async function listActiveAccountOptions(db: Db, companyId: string) {
  return db
    .select({ id: schema.accounts.id, name: schema.accounts.name, type: schema.accounts.type })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.active, true)))
    .orderBy(asc(schema.accounts.name))
}

/**
 * Move money between two active accounts of this company: TWO payments rows in ONE transaction, both ref_type 'transfer' and
 * sharing ref_id = the transfer id (out of the source, in to the destination). Net effect on the total of all accounts is zero.
 */
export async function createTransfer(db: Db, companyId: string, userId: string, input: unknown, ctx: WriteCtx) {
  const parsed = transferSchema.safeParse(input)
  if (!parsed.success) throw new FieldErrors(zodPathErrors(parsed.error))
  const d = parsed.data
  assertDateAllowed(d.date)
  return db.transaction(async (tx) => {
    const branchId = await resolveWriteBranch(tx, companyId, ctx.branchId)
    const ids = [d.fromAccountId, d.toAccountId].sort()
    const locked = await tx
      .select({ id: schema.accounts.id, name: schema.accounts.name, active: schema.accounts.active })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), sql`${schema.accounts.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`))
      .orderBy(asc(schema.accounts.id))
      .for('update')
    const from = locked.find((x) => x.id === d.fromAccountId)
    const to = locked.find((x) => x.id === d.toAccountId)
    if (!from || !from.active) throw new FieldErrors({ fromAccountId: 'Account not found' })
    if (!to || !to.active) throw new FieldErrors({ toAccountId: 'Account not found' })
    const transferId = randomUUID()
    const base = { companyId, branchId, refType: 'transfer' as const, refId: transferId, amount: d.amount, method: 'transfer', date: d.date, createdBy: userId }
    await tx.insert(schema.payments).values([
      { ...base, direction: 'out', accountId: from.id, note: d.note ?? `Transfer to ${to.name}` },
      { ...base, direction: 'in', accountId: to.id, note: d.note ?? `Transfer from ${from.name}` },
    ])
    await logActivity({ companyId, userId, action: 'account.transfer', entity: 'account', entityId: from.id, after: { transferId, from: from.id, to: to.id, amount: d.amount, date: d.date } }, tx)
    return { transferId }
  })
}
