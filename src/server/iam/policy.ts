/**
 * Pure identity & access rules (no DB). Used by the users/roles data layer and unit-tested directly.
 */
import { z } from 'zod'
import { PERMISSIONS, type Permission } from '../rbac'

// ---------- role names ----------

/** Display form: Unicode NFKC, invisible format characters removed, whitespace collapsed and trimmed. */
export function normalizeRoleName(raw: string): string {
  return raw.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()
}

/** Comparison key: names that differ only by case, whitespace or invisible characters share a key. */
export function roleNameKey(raw: string): string {
  return normalizeRoleName(raw).toLowerCase().replace(/\s+/g, '')
}

/** 'admin' (in any case/spacing/width) belongs to the system administrator role only. */
export const isReservedRoleName = (raw: string) => roleNameKey(raw) === 'admin'

export const roleNameField = z
  .string()
  .transform(normalizeRoleName)
  .pipe(z.string().min(2, 'Role name must be 2 to 40 characters').max(40, 'Role name must be 2 to 40 characters'))

// ---------- permissions ----------

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)
export const isPermission = (s: string): s is Permission => PERMISSION_SET.has(s)

/** Every key must exist in the catalog; duplicates removed; returned in catalog order. */
export const permissionsField = z
  .array(z.string().max(64))
  .max(PERMISSIONS.length * 2)
  .transform((list, ctx) => {
    const bad = list.filter((p) => !isPermission(p))
    if (bad.length) {
      ctx.addIssue({ code: 'custom', message: `Unknown permission: ${bad.slice(0, 3).join(', ')}` })
      return z.NEVER
    }
    const set = new Set(list)
    return PERMISSIONS.filter((p) => set.has(p))
  })

/** Permissions in `wanted` that `held` lacks. */
export function missingPermissions(held: Iterable<string>, wanted: Iterable<string>): string[] {
  const h = new Set(held)
  return [...new Set(wanted)].filter((p) => !h.has(p))
}

/** What an actor can do with permissions: admins anything; others only within what they hold themselves. */
export type ActorPerms = { adm: boolean; perms: ReadonlySet<string> }

/** True when `actor` may grant/hold-manage every permission in `perms` (no privilege escalation). */
export function canGrant(actor: ActorPerms, perms: Iterable<string>): boolean {
  return actor.adm || missingPermissions(actor.perms, perms).length === 0
}

/** True when `actor` holds every permission in `perms` AND at least one more (admins: always). */
export function isStrictlyBelow(actor: ActorPerms, perms: Iterable<string>): boolean {
  if (actor.adm) return true
  const target = new Set(perms)
  if (missingPermissions(actor.perms, target).length) return false
  for (const p of actor.perms) if (!target.has(p)) return true
  return false
}

/** Effective permissions of a role: the system admin role implicitly holds everything. */
export function effectivePermissions(role: { isSystem: boolean; name: string }, perms: readonly string[]): string[] {
  return isSystemAdminRole(role) ? [...PERMISSIONS] : [...perms]
}

export const isSystemAdminRole = (role: { isSystem: boolean; name: string }) => role.isSystem && role.name === 'admin'

/** Ruling: the system admin role is immutable; manager/salesman system roles keep their name but their permissions are editable. */
export function roleEditRules(role: { isSystem: boolean; name: string }) {
  if (isSystemAdminRole(role)) return { canRename: false, canEditPermissions: false, canDelete: false }
  if (role.isSystem) return { canRename: false, canEditPermissions: true, canDelete: false }
  return { canRename: true, canEditPermissions: true, canDelete: true }
}

// ---------- passwords ----------

export const PASSWORD_MIN = 10
/** bcrypt only uses the first 72 bytes; longer input would be silently truncated, so refuse it. */
export const PASSWORD_MAX_BYTES = 72

export const passwordField = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .refine((s) => new TextEncoder().encode(s).length <= PASSWORD_MAX_BYTES, `Password is too long (at most ${PASSWORD_MAX_BYTES} bytes)`)
