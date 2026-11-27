'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAccount, createTransfer, setAccountActive, updateAccount } from '../accounting/accounts'
import { createExpense, createExpenseCategory, createIncome, renameExpenseCategory, setExpenseCategoryActive, updateExpense, updateIncome, voidEntry } from '../accounting/entries'
import { writeCtx } from '../branch'
import { getDb } from '../db'
import { guarded, guardedBranch, type ActionResult } from './guard'

const idSchema = z.uuid()
const refresh = () => {
  revalidatePath('/accounts')
  revalidatePath('/payments')
  revalidatePath('/income-expense')
  revalidatePath('/dues')
  revalidatePath('/reports')
  revalidatePath('/dashboard')
}

// ---- accounts (accounts.create / .edit / .delete) ----
export async function createAccountAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('accounts.create', async (s) => {
    const row = await createAccount(getDb(), s.cid, s.uid, input)
    refresh()
    return { id: row.id }
  })
}

export async function updateAccountAction(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('accounts.edit', async (s) => {
    const row = await updateAccount(getDb(), s.cid, s.uid, idSchema.parse(id), input)
    refresh()
    return { id: row.id }
  })
}

/** Soft deactivate (never deletes). Needs accounts.delete; refused while the account holds money. */
export async function deactivateAccountAction(id: string): Promise<ActionResult> {
  return guarded('accounts.delete', async (s) => {
    await setAccountActive(getDb(), s.cid, s.uid, idSchema.parse(id), false)
    refresh()
  })
}

export async function activateAccountAction(id: string): Promise<ActionResult> {
  return guarded('accounts.edit', async (s) => {
    await setAccountActive(getDb(), s.cid, s.uid, idSchema.parse(id), true)
    refresh()
  })
}

/** Move money between two accounts: two payments rows in one transaction. */
export async function createTransferAction(input: unknown): Promise<ActionResult<{ transferId: string }>> {
  return guardedBranch('accounts.create', async (s, b) => {
    const r = await createTransfer(getDb(), s.cid, s.uid, input, writeCtx(b))
    refresh()
    return r
  })
}

// ---- manual expenses / incomes ----
export async function createExpenseAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guardedBranch('accounts.create', async (s, b) => {
    const row = await createExpense(getDb(), s.cid, s.uid, input, writeCtx(b))
    refresh()
    return { id: row.id }
  })
}

export async function createIncomeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guardedBranch('accounts.create', async (s, b) => {
    const row = await createIncome(getDb(), s.cid, s.uid, input, writeCtx(b))
    refresh()
    return { id: row.id }
  })
}

/** Category / note only; the cash effect never changes (void and re-enter to correct amount, date or account). */
export async function updateExpenseAction(id: string, input: unknown): Promise<ActionResult> {
  return guardedBranch('accounts.edit', async (s, b) => {
    await updateExpense(getDb(), s.cid, s.uid, idSchema.parse(id), input, { restrict: b.restrict })
    refresh()
  })
}

export async function updateIncomeAction(id: string, input: unknown): Promise<ActionResult> {
  return guardedBranch('accounts.edit', async (s, b) => {
    await updateIncome(getDb(), s.cid, s.uid, idSchema.parse(id), input, { restrict: b.restrict })
    refresh()
  })
}

/** Void = reversing payment + voided stamp, never a delete. Needs accounts.delete. */
export async function voidExpenseAction(id: string, input: unknown): Promise<ActionResult<{ reversedOn: string }>> {
  return guardedBranch('accounts.delete', async (s, b) => {
    const r = await voidEntry(getDb(), s.cid, s.uid, 'expense', idSchema.parse(id), input, { restrict: b.restrict })
    refresh()
    return r
  })
}

export async function voidIncomeAction(id: string, input: unknown): Promise<ActionResult<{ reversedOn: string }>> {
  return guardedBranch('accounts.delete', async (s, b) => {
    const r = await voidEntry(getDb(), s.cid, s.uid, 'income', idSchema.parse(id), input, { restrict: b.restrict })
    refresh()
    return r
  })
}

// ---- expense categories ----
export async function createExpenseCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('accounts.create', async (s) => {
    const row = await createExpenseCategory(getDb(), s.cid, s.uid, input)
    refresh()
    return { id: row.id }
  })
}

export async function renameExpenseCategoryAction(id: string, input: unknown): Promise<ActionResult> {
  return guarded('accounts.edit', async (s) => {
    await renameExpenseCategory(getDb(), s.cid, s.uid, idSchema.parse(id), input)
    refresh()
  })
}

export async function deactivateExpenseCategoryAction(id: string): Promise<ActionResult> {
  return guarded('accounts.delete', async (s) => {
    await setExpenseCategoryActive(getDb(), s.cid, s.uid, idSchema.parse(id), false)
    refresh()
  })
}

export async function activateExpenseCategoryAction(id: string): Promise<ActionResult> {
  return guarded('accounts.edit', async (s) => {
    await setExpenseCategoryActive(getDb(), s.cid, s.uid, idSchema.parse(id), true)
    refresh()
  })
}
