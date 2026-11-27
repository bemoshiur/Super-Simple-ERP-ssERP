import { ZodError } from 'zod'
import { authorize } from '../auth/current'
import { branchScope, type BranchScope } from '../branch'
import type { SessionPayload } from '../auth/session'
import { FieldErrors, NotFoundError, PolicyError, safeLog, zodFieldErrors } from '../errors'
import { ForbiddenError, UnauthorizedError, type Permission } from '../rbac'

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string> }

/** Map a thrown error to a friendly failure result (unexpected errors are logged and replaced by a generic message). */
export function failureOf(e: unknown): { ok: false; error: string; fieldErrors?: Record<string, string> } {
  if (e instanceof UnauthorizedError) return { ok: false, error: 'Your session has expired. Please sign in again.' }
  if (e instanceof ForbiddenError) return { ok: false, error: 'You do not have permission to do that.' }
  if (e instanceof NotFoundError) return { ok: false, error: `${e.message}. It may have been removed.` }
  if (e instanceof PolicyError) return { ok: false, error: e.message }
  if (e instanceof FieldErrors) return { ok: false, error: e.message, fieldErrors: e.fields }
  if (e instanceof ZodError) return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors: zodFieldErrors(e) }
  safeLog('[action] unexpected error', e)
  return { ok: false, error: 'Something went wrong. Please try again.' }
}

/**
 * Run a server-action body after `authorize(permission)`. companyId/userId come ONLY from the session passed to `fn`.
 * Expected failures become friendly results; anything unexpected is logged server-side and replaced by a generic message (no SQL leaks).
 */
export async function guarded<T>(permission: Permission, fn: (s: SessionPayload) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const session = await authorize(permission)
    return { ok: true, data: await fn(session) }
  } catch (e) {
    return failureOf(e)
  }
}

/**
 * guarded() plus the request's branch scope (Task 14), resolved server-side AFTER authorize(): the session's own branch for a
 * restricted user, the validated `sserp_branch` selection for a branches.all holder. Never a client-sent branch id.
 */
export async function guardedBranch<T>(permission: Permission, fn: (s: SessionPayload, b: BranchScope) => Promise<T>): Promise<ActionResult<T>> {
  return guarded(permission, async (s) => fn(s, await branchScope(s)))
}
