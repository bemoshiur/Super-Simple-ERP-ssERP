/**
 * Cash flow from the payments table (the single source of truth for money movement, see accounting/accounts.ts).
 * Per account: opening (at the start of the period) + inflows - outflows = closing. Inflows/outflows are also grouped by what
 * caused them (customer receipts, vendor payments, expense categories, other income, transfers, voids).
 * The closing balances are reconciled against listAccountBalances(asOf = period end): they must be identical.
 *
 * Branches (Task 14): accounts are company-level; every payment carries the branch it was recorded at. A branch view counts
 * that branch's payments only, and the accounts' opening balances belong to the company's DEFAULT (Main) branch, so the
 * per-branch closings add up exactly to the all-branches closing. Reconciliation against the account balances is only
 * meaningful (and only run) for all branches.
 */
import { sql } from 'drizzle-orm'
import { listAccountBalances } from '../accounting/accounts'
import { andBranch, type BranchFilter } from '../branch'
import { schema, rowsOf } from '../db'
import { fromMinor, toMinor } from '../money'
import { computeCashFlow, groupMovements, reconcileCashFlow, type CashAccountInput, type MovementInput } from './pure'
import type { ReportContext, ReportParams, ReportResult, Reader } from './types'

const m = (v: unknown): string => fromMinor(toMinor(String(v ?? '0')))
const { accounts, payments } = schema

export async function loadCashFlow(db: Reader, companyId: string, branch: BranchFilter, p: { from: string; to: string }) {
  // Opening balances count in the all-branches view and in the default branch's view only.
  const withOpening = branch
    ? rowsOf<{ d: boolean }>(await db.execute(sql`select ${schema.branches.isDefault} as d from ${schema.branches} where ${schema.branches.id} = ${branch} and ${schema.branches.companyId} = ${companyId}`))[0]?.d === true
    : true
  const accRows = rowsOf<{ id: string; name: string; type: string; active: boolean; opening: string; before_in: string; before_out: string; period_in: string; period_out: string }>(
    await db.execute(sql`
      select ${accounts.id} as id, ${accounts.name} as name, ${accounts.type} as type, ${accounts.active} as active, ${withOpening ? sql`${accounts.openingBalance}` : sql`0`}::text as opening,
        coalesce(sum(${payments.amount}) filter (where ${payments.direction} = 'in' and ${payments.date} < ${p.from}), 0)::text as before_in,
        coalesce(sum(${payments.amount}) filter (where ${payments.direction} = 'out' and ${payments.date} < ${p.from}), 0)::text as before_out,
        coalesce(sum(${payments.amount}) filter (where ${payments.direction} = 'in' and ${payments.date} >= ${p.from}), 0)::text as period_in,
        coalesce(sum(${payments.amount}) filter (where ${payments.direction} = 'out' and ${payments.date} >= ${p.from}), 0)::text as period_out
      from ${accounts}
      left join ${payments} on ${payments.accountId} = ${accounts.id} and ${payments.companyId} = ${accounts.companyId} and ${payments.date} <= ${p.to}${andBranch(payments.branchId, branch)}
      where ${accounts.companyId} = ${companyId}
      group by ${accounts.id}
      order by ${accounts.name}`),
  )
  const input: CashAccountInput[] = accRows.map((a) => ({ id: a.id, name: a.active ? a.name : `${a.name} (inactive)`, type: a.type, openingBalance: m(a.opening), beforeIn: m(a.before_in), beforeOut: m(a.before_out), periodIn: m(a.period_in), periodOut: m(a.period_out) }))
  const flow = computeCashFlow(input)

  const moves = rowsOf<{ direction: 'in' | 'out'; ref_type: string; is_rev: boolean; category: string | null; amount: string }>(
    await db.execute(sql`
      select ${payments.direction} as direction, ${payments.refType} as ref_type, (${payments.reversesPaymentId} is not null) as is_rev,
        coalesce(${schema.expenseCategories.name}, ${schema.incomes.category}) as category, sum(${payments.amount})::text as amount
      from ${payments}
      left join ${schema.expenses} on ${payments.refType} = 'expense' and ${schema.expenses.id} = ${payments.refId} and ${schema.expenses.companyId} = ${companyId}
      left join ${schema.expenseCategories} on ${schema.expenseCategories.id} = ${schema.expenses.categoryId} and ${schema.expenseCategories.companyId} = ${companyId}
      left join ${schema.incomes} on ${payments.refType} = 'income' and ${schema.incomes.id} = ${payments.refId} and ${schema.incomes.companyId} = ${companyId}
      where ${payments.companyId} = ${companyId}${andBranch(payments.branchId, branch)} and ${payments.date} between ${p.from} and ${p.to}
      group by 1, 2, 3, 4`),
  )
  const movements: MovementInput[] = moves.map((r) => ({ direction: r.direction, refType: r.ref_type, isReversal: r.is_rev, category: r.category, amount: m(r.amount) }))
  const grouped = groupMovements(movements)

  const balances = await listAccountBalances(db, companyId, { asOf: p.to, status: 'all' })
  // A single branch's closing is its share, not the account balance: reconcile only the all-branches view.
  const recon = branch ? null : reconcileCashFlow(flow.accounts, balances)
  return { flow, grouped, balances, recon }
}

export async function cashFlowReport(ctx: ReportContext, p: ReportParams): Promise<ReportResult> {
  const { flow, grouped, recon } = await loadCashFlow(ctx.db, ctx.companyId, ctx.branch, p)
  const sumLines = (ls: { amount: string }[]) => fromMinor(ls.reduce((a, l) => a + toMinor(l.amount), 0))
  const notes = [
    'Opening = account opening balances + all payments dated before the period. Closing = opening + inflows - outflows.',
    'Every sale receipt, vendor payment, refund, expense, income, transfer and void is a payment row; this report reads nothing else, so it cannot double count.',
    recon === null
      ? 'Branch view: inflows and outflows recorded at this branch only. Account opening balances belong to the default (Main) branch. Reconciliation with the account balances runs on the all-branches view.'
      : recon.ok
        ? 'Reconciled: the closing balances equal the account balances as at the period end.'
        : `RECONCILIATION MISMATCH on ${recon.diffs.length} account(s): closing differs from the account balance. Please report this.`,
  ]
  return {
    key: 'cash-flow',
    title: 'Cash flow',
    from: p.from,
    to: p.to,
    truncated: false,
    notes: [...notes, 'Opening balance rule: each account\'s opening balance is counted from the very beginning (before every payment), so it is part of the opening of any period, whatever date the account was created.'],
    exportNotes: [notes[2]],
    tables: [
      {
        title: 'By account',
        columns: [
          { key: 'name', label: 'Account', kind: 'text' },
          { key: 'type', label: 'Type', kind: 'text' },
          { key: 'opening', label: 'Opening', kind: 'money' },
          { key: 'inflow', label: 'Inflows', kind: 'money' },
          { key: 'outflow', label: 'Outflows', kind: 'money' },
          { key: 'closing', label: 'Closing', kind: 'money' },
        ],
        rows: flow.accounts.map((a) => ({ name: a.name, type: a.type, opening: a.opening, inflow: a.inflow, outflow: a.outflow, closing: a.closing })),
        totals: { name: 'Total', type: null, opening: flow.totals.opening, inflow: flow.totals.inflow, outflow: flow.totals.outflow, closing: flow.totals.closing },
      },
      {
        title: 'Inflows by source',
        columns: [{ key: 'label', label: 'Source', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'money' }],
        rows: grouped.inflows.map((l) => ({ label: l.label, amount: l.amount })),
        totals: { label: 'Total inflows', amount: sumLines(grouped.inflows) },
      },
      {
        title: 'Outflows by destination',
        columns: [{ key: 'label', label: 'Destination', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'money' }],
        rows: grouped.outflows.map((l) => ({ label: l.label, amount: l.amount })),
        totals: { label: 'Total outflows', amount: sumLines(grouped.outflows) },
      },
    ],
  }
}
