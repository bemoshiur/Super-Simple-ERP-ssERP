/**
 * Branch scope (Task 14): the ONE place that decides which branch(es) a request may read and which branch it writes to.
 *
 * Rules
 *  - Every user has an assigned ("home") branch (users.branch_id; the company's default branch when unset or inactive).
 *  - A user WITHOUT the `branches.all` permission is restricted to the home branch for reading AND writing. Any branch the
 *    client sends (cookie, form field, URL) is ignored for such a user.
 *  - A user WITH `branches.all` (admin implicitly, the manager role by default) picks the active branch in the top bar.
 *    The choice lives in the `sserp_branch` cookie, which holds a branch id or "all". It is NOT trusted: it is re-validated
 *    on every request against the company's ACTIVE branches; anything else falls back to the home branch.
 *    "All branches" is a READ view only: writes need one concrete branch (`requireWriteBranch` refuses).
 *  - Lists and reports filter by `scope.filter` (one branch, or null = all branches).
 *    Detail pages check `scope.restrict` (null = any branch of the company; else documents of other branches are NotFound),
 *    so a link from the "All branches" list opens for a branches.all holder, but never for a restricted user.
 *
 * Data-layer functions take the branch explicitly (a `BranchFilter`, never optional) so a forgotten scope is a type error.
 * Nothing here imports Next at module level: `branchScope()` loads next/headers lazily, so scripts and tests can import the rest.
 */
import { and, asc, eq, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { cache } from 'react'
import { getDb, schema, type Db } from './db'
import { NotFoundError, PolicyError } from './errors'
import { can, type PermissionSubject } from './rbac'

export const BRANCH_COOKIE = 'sserp_branch'
/** Cookie / selector value meaning "every branch" (read views only). */
export const ALL_BRANCHES = 'all'
export const INACTIVE_BRANCH = 'Your branch is inactive or not assigned; ask an administrator.'

/** One branch id, or null = every branch of the company. Always required by branch-scoped data-layer reads. */
export type BranchFilter = string | null

export type BranchOption = { id: string; name: string; code: string; isDefault: boolean }

export type BranchScope = {
  /** Holds branches.all (may read every branch and switch the active branch). */
  all: boolean
  /** The user's own branch (validated active; the company's default branch as a fallback). */
  home: string
  /** List / report / export filter: one branch, or null = all branches ("All branches" selected by a branches.all holder). */
  filter: BranchFilter
  /** Detail-page restriction: null = documents of any branch may be opened (branches.all), else only this branch's. */
  restrict: BranchFilter
  /** Branch every new document is written to, or null while "All branches" is selected (writes are refused). */
  active: string | null
  /** The company's active branches, default first then by name. */
  branches: BranchOption[]
  /** More than one active branch: the multi-branch UI (selector, branch columns and filters) is shown only then. */
  multi: boolean
}

type Subject = NonNullable<PermissionSubject> & { uid: string; cid: string }
type Reader = Pick<Db, 'select'>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Active branches of a company, default first. */
export async function activeBranches(db: Reader, companyId: string): Promise<BranchOption[]> {
  const b = schema.branches
  const rows = await db
    .select({ id: b.id, name: b.name, code: b.code, isDefault: b.isDefault })
    .from(b)
    .where(and(eq(b.companyId, companyId), eq(b.active, true)))
    .orderBy(sql`${b.isDefault} desc`, asc(b.name), asc(b.id))
  return rows
}

/**
 * Resolve the branch scope of a request from the session subject and the (untrusted) requested branch (cookie value).
 * Pure DB reads; no Next. Throws PolicyError only when the company has no active branch at all (broken install).
 */
export async function resolveBranchScope(db: Reader, s: Subject, requested?: string | null): Promise<BranchScope> {
  const branches = await activeBranches(db, s.cid)
  if (!branches.length) throw new PolicyError('This company has no active branch. Ask an administrator to restore one.')
  const [me] = await db.select({ branchId: schema.users.branchId }).from(schema.users).where(and(eq(schema.users.id, s.uid), eq(schema.users.companyId, s.cid)))
  const ids = new Set(branches.map((b) => b.id))
  const all = can(s, 'branches.all')
  const own = me?.branchId && ids.has(me.branchId) ? me.branchId : null
  // Fail closed: a restricted user whose branch is unset or inactive sees nothing (never silently Main).
  if (!own && !all) throw new PolicyError(INACTIVE_BRANCH)
  const home = own ?? (branches.find((b) => b.isDefault) ?? branches[0]).id
  const multi = branches.length > 1
  if (!all) return { all, home, filter: home, restrict: home, active: home, branches, multi }
  const req = typeof requested === 'string' ? requested.trim() : ''
  if (req === ALL_BRANCHES && multi) return { all, home, filter: null, restrict: null, active: null, branches, multi }
  const chosen = UUID_RE.test(req) && ids.has(req.toLowerCase()) ? req.toLowerCase() : home
  return { all, home, filter: chosen, restrict: null, active: chosen, branches, multi }
}

const loadScope = cache(async (uid: string, cid: string, adm: boolean, perms: string, requested: string | null) =>
  resolveBranchScope(getDb(), { uid, cid, adm, perms: perms ? perms.split(',') : [] }, requested),
)

/** Request-scoped branch scope (reads the `sserp_branch` cookie). Server components / actions only. Cached per request. */
export async function branchScope(session: Subject): Promise<BranchScope> {
  let requested: string | null = null
  try {
    const { cookies } = await import('next/headers')
    requested = (await cookies()).get(BRANCH_COOKIE)?.value ?? null
  } catch {
    requested = null // outside a request (scripts/tests): the home branch
  }
  return loadScope(session.uid, session.cid, session.adm, [...session.perms].join(','), requested)
}

/** What the top bar needs (client-safe; ids and names of the company's active branches only). */
export function shellBranch(scope: BranchScope): { multi: boolean; canSwitch: boolean; value: string; homeName: string; options: { id: string; name: string; code: string }[] } {
  const home = scope.branches.find((b) => b.id === scope.home)
  return {
    multi: scope.multi,
    canSwitch: scope.all && scope.multi,
    value: scope.filter ?? ALL_BRANCHES,
    homeName: home?.name ?? '',
    options: scope.all ? scope.branches.map((b) => ({ id: b.id, name: b.name, code: b.code })) : home ? [{ id: home.id, name: home.name, code: home.code }] : [],
  }
}

/**
 * Company-wide data (activity log, history of shared records): in a multi-branch company it also needs branches.all,
 * because it spans every branch. Single-branch installs are unchanged.
 */
export function seesCompanyWide(scope: Pick<BranchScope, 'multi' | 'all'>): boolean {
  return !scope.multi || scope.all
}

/** The branch a write goes to. "All branches" is a read view: creating documents needs one concrete branch. */
export function requireWriteBranch(scope: Pick<BranchScope, 'active'>): string {
  if (!scope.active) throw new PolicyError('Choose a branch in the top bar first: "All branches" is for viewing only.')
  return scope.active
}

/** May this scope open a document of `branchId`? (detail pages, document-bound writes such as payments and returns) */
export function permits(scope: Pick<BranchScope, 'restrict'>, branchId: string | null | undefined): boolean {
  return scope.restrict === null || scope.restrict === branchId
}

/**
 * Data-layer write context, always built from the session scope (never from client input) or, in scripts/tests,
 * from defaultBranchId(). Both fields are REQUIRED: a write without a resolved branch does not compile.
 * branchId: the branch the write goes to; restrict: a restricted user's branch (documents of other branches are NotFound) or null.
 */
export type WriteCtx = { branchId: string; restrict: BranchFilter }

/** WriteCtx for an action: the concrete active branch (refuses "All branches") and the scope's restriction. */
export function writeCtx(scope: Pick<BranchScope, 'active' | 'restrict'>): WriteCtx {
  return { branchId: requireWriteBranch(scope), restrict: scope.restrict }
}

/** Throw NotFound-style when a document of another branch is touched by a restricted scope. */
export function assertPermits(restrict: BranchFilter | undefined, branchId: string | null | undefined, what: string): void {
  if (restrict && restrict !== branchId) throw new NotFoundError(what)
}

/** drizzle condition: `col = branch`, or nothing for all branches. */
export function branchCond(col: AnyPgColumn, branch: BranchFilter): SQL | undefined {
  return branch ? eq(col, branch) : undefined
}

/** Raw-SQL twin of branchCond: `and <col> = <branch>` or an empty fragment. */
export function andBranch(col: AnyPgColumn | SQL, branch: BranchFilter): SQL {
  return branch ? sql` and ${col} = ${branch}` : sql``
}

/**
 * Validate a branch for a write inside the caller's transaction: it must be an ACTIVE branch of the company, and its row is
 * taken FOR SHARE until commit, so a concurrent deactivation (FOR UPDATE, branches/branches.ts) waits for the write and then
 * sees its stock. LOCK ORDER: call this FIRST in the transaction (branch -> products -> doc number -> units). There is no
 * default: a missing branch throws. Never trusts a client value: callers pass
 * `requireWriteBranch(scope)` computed from the session.
 */
export async function resolveWriteBranch(tx: Reader, companyId: string, branchId: string): Promise<string> {
  const b = schema.branches
  if (!branchId) throw new PolicyError('No branch was chosen for this change.')
  const [row] = await tx.select({ id: b.id }).from(b).where(and(eq(b.id, branchId), eq(b.companyId, companyId), eq(b.active, true))).for('share')
  if (!row) throw new PolicyError('This branch is not available (it may have been deactivated). Choose another branch.')
  return row.id
}

/** The company's default (Main) branch id, for scripts, seeds and tests that write without a session. */
export async function defaultBranchId(db: Reader, companyId: string): Promise<string> {
  const b = schema.branches
  const [def] = await db.select({ id: b.id }).from(b).where(and(eq(b.companyId, companyId), eq(b.active, true))).orderBy(sql`${b.isDefault} desc`, asc(b.createdAt), asc(b.id)).limit(1)
  if (!def) throw new PolicyError('This company has no active branch.')
  return def.id
}

/** Branch name/code by id (company-scoped), for messages and print headers. */
export async function branchLabel(db: Reader, companyId: string, branchId: string | null | undefined): Promise<{ name: string; code: string } | null> {
  if (!branchId) return null
  const [row] = await db.select({ name: schema.branches.name, code: schema.branches.code }).from(schema.branches).where(and(eq(schema.branches.id, branchId), eq(schema.branches.companyId, companyId)))
  return row ?? null
}
