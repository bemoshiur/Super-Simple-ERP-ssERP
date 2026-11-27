'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'
import { clientIpFrom } from '../auth/client-ip'
import { loginThrottle } from '../auth/login-throttle'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../db'
import { PolicyError } from '../errors'
import { cloneRole, createRole, deleteRole, updateRole } from '../iam/roles'
import { createUser, resetUserPassword, setUserActive, updateUser, WrongCurrentPasswordError } from '../iam/users'
import { guarded, type ActionResult } from './guard'
import type { SessionPayload } from '../auth/session'

const idSchema = z.uuid()
/** The data layer re-validates the actor (active, same session version, fresh permissions) inside its transaction. */
const actorOf = (s: SessionPayload, ip?: string) => ({ companyId: s.cid, userId: s.uid, sv: s.sv, ip: ip ?? null })
async function requestIp() {
  const h = await headers()
  return clientIpFrom((n) => h.get(n))
}

// ---- users ----
export async function createUserAction(input: unknown): Promise<ActionResult<{ id: string; generatedPassword?: string }>> {
  return guarded('users.create', async (s) => {
    const r = await createUser(getDb(), actorOf(s), input)
    revalidatePath('/users')
    return r
  })
}

export async function updateUserAction(id: string, input: unknown): Promise<ActionResult<{ id: string; signedOut: boolean }>> {
  return guarded('users.edit', async (s) => {
    const ip = await requestIp()
    const db = getDb()
    // Editing yourself may need your current password (email change): throttle it like a login (no brute force via a stolen session).
    const self = id === s.uid ? (await db.select({ email: schema.users.email }).from(schema.users).where(and(eq(schema.users.id, s.uid), eq(schema.users.companyId, s.cid))))[0] : undefined
    if (self && (await loginThrottle.isLimited(self.email, ip))) throw new PolicyError('Too many failed attempts. Please try again in 15 minutes.')
    try {
      const r = await updateUser(db, actorOf(s, ip), idSchema.parse(id), input)
      revalidatePath('/users')
      return r
    } catch (e) {
      if (self && e instanceof WrongCurrentPasswordError) await loginThrottle.recordFailure(self.email, ip)
      throw e
    }
  })
}

export async function resetUserPasswordAction(id: string, input: unknown): Promise<ActionResult<{ generatedPassword?: string }>> {
  return guarded('users.edit', async (s) => resetUserPassword(getDb(), actorOf(s, await requestIp()), idSchema.parse(id), input))
}

export async function deactivateUserAction(id: string): Promise<ActionResult> {
  return guarded('users.delete', async (s) => {
    await setUserActive(getDb(), actorOf(s, await requestIp()), idSchema.parse(id), false)
    revalidatePath('/users')
  })
}

export async function activateUserAction(id: string): Promise<ActionResult> {
  return guarded('users.edit', async (s) => {
    await setUserActive(getDb(), actorOf(s, await requestIp()), idSchema.parse(id), true)
    revalidatePath('/users')
  })
}

// ---- roles ----
export async function createRoleAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('users.create', async (s) => {
    const r = await createRole(getDb(), actorOf(s), input)
    revalidatePath('/roles')
    return r
  })
}

export async function cloneRoleAction(sourceId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return guarded('users.create', async (s) => {
    const r = await cloneRole(getDb(), actorOf(s), idSchema.parse(sourceId), input)
    revalidatePath('/roles')
    return r
  })
}

export async function updateRoleAction(id: string, input: unknown): Promise<ActionResult<{ id: string; signedOut: number }>> {
  return guarded('users.edit', async (s) => {
    const r = await updateRole(getDb(), actorOf(s), idSchema.parse(id), input)
    revalidatePath('/roles')
    return r
  })
}

export async function deleteRoleAction(id: string): Promise<ActionResult> {
  return guarded('users.delete', async (s) => {
    await deleteRole(getDb(), actorOf(s), idSchema.parse(id))
    revalidatePath('/roles')
  })
}
