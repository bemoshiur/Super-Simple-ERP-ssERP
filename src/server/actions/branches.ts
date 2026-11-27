'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { sessionCookieOptions } from '../auth/constants'
import { ALL_BRANCHES, BRANCH_COOKIE, activeBranches } from '../branch'
import { createBranch, setBranchActive, updateBranch } from '../branches/branches'
import { getDb } from '../db'
import { FieldErrors } from '../errors'
import { guarded, type ActionResult } from './guard'

const idSchema = z.uuid()

/** Create a branch (settings.edit). */
export async function createBranchAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('settings.edit', async (s) => {
    const row = await createBranch(getDb(), s.cid, s.uid, input)
    revalidatePath('/', 'layout')
    return { id: row.id }
  })
}

/** Edit name / code / address / phone (settings.edit). */
export async function updateBranchAction(id: string, input: unknown): Promise<ActionResult> {
  return guarded('settings.edit', async (s) => {
    await updateBranch(getDb(), s.cid, s.uid, idSchema.parse(id), input)
    revalidatePath('/', 'layout')
  })
}

/** Deactivate (settings.delete): refused for the main branch and while the branch still holds stock, tickets or users. */
export async function deactivateBranchAction(id: string): Promise<ActionResult> {
  return guarded('settings.delete', async (s) => {
    await setBranchActive(getDb(), s.cid, s.uid, idSchema.parse(id), false)
    revalidatePath('/', 'layout')
  })
}

/** Reactivate (settings.edit). */
export async function activateBranchAction(id: string): Promise<ActionResult> {
  return guarded('settings.edit', async (s) => {
    await setBranchActive(getDb(), s.cid, s.uid, idSchema.parse(id), true)
    revalidatePath('/', 'layout')
  })
}

/**
 * Top-bar branch selector (branches.all only). The value is validated against the company's ACTIVE branches before it
 * is stored, and branchScope() re-validates it on every request anyway (a forged or stale cookie falls back to the home branch).
 */
export async function setActiveBranchAction(value: string): Promise<ActionResult<{ value: string }>> {
  return guarded('branches.all', async (s) => {
    const v = String(value ?? '').trim().toLowerCase()
    const branches = await activeBranches(getDb(), s.cid)
    if (v !== ALL_BRANCHES && !branches.some((b) => b.id === v)) throw new FieldErrors({ branch: 'Branch not found' }, 'Branch not found')
    const jar = await cookies()
    jar.set(BRANCH_COOKIE, v, { ...sessionCookieOptions(), maxAge: 60 * 60 * 24 * 365 })
    revalidatePath('/', 'layout')
    return { value: v }
  })
}
