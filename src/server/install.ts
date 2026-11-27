/**
 * Installer core shared by the web wizard (/install) and the CLI (scripts/setup.ts).
 * Node-only, but intentionally free of `server-only` and `next/*` imports so tsx can run it.
 */
import { and, count, eq, sql } from 'drizzle-orm'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { logActivity } from './audit'
import { hashPassword } from './auth/password'
import { applyMigrations, getDb, pingDatabase, schema } from './db'
import { classifyInstalled, MIN_ADMIN_PASSWORD_LENGTH, redactDatabaseUrl, seedPreflight, validateDatabaseUrl, type InstalledState } from './install-env'
import { isDatabaseError, isUniqueViolation, pgCodeOf, redactMessage } from './errors'
import { DEFAULT_ROLE_PERMISSIONS } from './rbac'

export * from './install-env'

export class AlreadyInstalledError extends Error {
  constructor() {
    super('ssERP is already installed. The installer cannot be run again.')
    this.name = 'AlreadyInstalledError'
  }
}

/** Refused because users already exist although the installed flag is missing (half-set-up or foreign DB). */
export class DatabaseNotEmptyError extends AlreadyInstalledError {
  constructor() {
    super()
    this.message = 'The database already contains users; refusing to install over it.'
    this.name = 'DatabaseNotEmptyError'
  }
}

export const DEFAULT_CURRENCY = '৳'
const INSTALL_LOCK_KEY = 'sserp-install'

// ---------- connection / installed state ----------

/** Scrub anything that looks like the DB password from an error message before it is shown or logged. */
export function safeErrorMessage(e: unknown, url: string | undefined = process.env.DATABASE_URL): string {
  // A database error's message can carry the query and its parameters (password hashes): report only its code.
  if (isDatabaseError(e)) return `Database error (code ${pgCodeOf(e) ?? 'unknown'})`
  let msg: string
  if (e instanceof Error) msg = e.message
  else if (e && typeof e === 'object') {
    // WebSocket ErrorEvent and friends are plain objects, not Errors.
    const o = e as { message?: unknown; error?: { message?: unknown }; code?: unknown }
    msg = String(o.message || o.error?.message || (o.code ? `error code ${String(o.code)}` : 'connection error'))
  } else msg = String(e)
  if (url) {
    try {
      const pw = new URL(url).password
      if (pw) msg = msg.split(pw).join('***').split(encodeURIComponent(pw)).join('***')
    } catch {
      /* ignore */
    }
  }
  return redactMessage(msg, { ...process.env, DATABASE_URL: url })
}

/**
 * Map a failed install step to a message that is safe to show in the browser: friendly text for the cases we know,
 * otherwise only the Postgres error code. The full (log-safe) detail goes to the server log via safeLog.
 */
export function installErrorView(e: unknown, step: 'migrate' | 'seed'): { error?: string; fieldErrors?: Record<string, string> } {
  if (step === 'seed' && isUniqueViolation(e, 'users_email_uq')) return { fieldErrors: { adminEmail: 'This email is already in use' } }
  const code = pgCodeOf(e)
  if (code === '42P01') return { error: 'Database tables are missing. Go back and run the migrations first.' }
  const what = step === 'migrate' ? 'Migration failed' : 'Installation failed'
  if (code || isDatabaseError(e)) return { error: `${what} (code ${code ?? 'unknown'}). See server logs.` }
  return { error: `${what}. See server logs.` }
}

/** Live check with a throwaway pool (`select 1`). Never throws. */
export async function testConnection(url: string | undefined = process.env.DATABASE_URL): Promise<{ ok: true } | { ok: false; error: string }> {
  const v = validateDatabaseUrl(url)
  if (!v.ok) return v
  try {
    await pingDatabase(url as string)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: safeErrorMessage(e, url) }
  }
}

const g = globalThis as unknown as { __sserpInstalled?: boolean }

/**
 * Tri-state install check. 'no' only when the lookup succeeded with no installed row, the settings
 * table does not exist yet (42P01, fresh DB), or DATABASE_URL is unset/invalid. Any other failure is
 * 'unknown' so a flaky DB can never expose the wizard. Only 'yes' is cached.
 */
export async function isInstalled(): Promise<InstalledState> {
  if (g.__sserpInstalled) return 'yes'
  if (validateDatabaseUrl(process.env.DATABASE_URL).ok === false) return 'no'
  let state: InstalledState
  try {
    const rows = await getDb()
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(and(eq(schema.settings.key, 'installed'), eq(schema.settings.value, 'true')))
      .limit(1)
    state = classifyInstalled({ rows: rows.length })
  } catch (e) {
    state = classifyInstalled({ error: e })
  }
  if (state === 'yes') g.__sserpInstalled = true
  return state
}

// ---------- migrations ----------

export function migrationsFolder() {
  return process.env.SSERP_MIGRATIONS_DIR ?? path.join(process.cwd(), 'drizzle')
}

/** Apply committed drizzle migrations. Safe to re-run (drizzle tracks applied ones). Returns the migration count. */
export async function runMigrations(): Promise<{ total: number }> {
  const folder = migrationsFolder()
  await applyMigrations(folder)
  try {
    const journal = JSON.parse(await readFile(path.join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }
    return { total: journal.entries.length }
  } catch {
    return { total: 0 }
  }
}

// ---------- seed ----------

export const installInputSchema = z.object({
  companyName: z.string().trim().min(1, 'Company name is required').max(120),
  adminName: z.string().trim().min(1, 'Your name is required').max(120),
  adminEmail: z.string().trim().toLowerCase().max(254).email('Enter a valid email address'),
  adminPassword: z
    .string()
    .min(MIN_ADMIN_PASSWORD_LENGTH, `Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`)
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes'),
  currency: z.string().trim().min(1).max(8).default(DEFAULT_CURRENCY),
})
export type InstallInput = z.input<typeof installInputSchema>

const DEFAULT_ACCOUNTS = [
  { name: 'Cash', type: 'cash' },
  { name: 'Bank', type: 'bank' },
  { name: 'bKash', type: 'mobile' },
] as const

const DEFAULT_EXPENSE_CATEGORIES = ['Rent', 'Salary', 'Utilities', 'Transport', 'Marketing', 'Maintenance', 'Miscellaneous']
const DOC_KINDS = ['sale', 'purchase', 'sale_return', 'purchase_return'] as const

/**
 * Create the first company with everything it needs, in ONE transaction. Throws AlreadyInstalledError
 * if installed=true. A transaction-scoped advisory lock serialises concurrent installs, and every
 * insert is conflict-tolerant so a re-run after manual cleanup does not duplicate rows.
 */
export async function seedBase(input: InstallInput): Promise<{ companyId: string; adminUserId: string }> {
  const data = installInputSchema.parse(input)
  const passwordHash = await hashPassword(data.adminPassword)
  const db = getDb()

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${INSTALL_LOCK_KEY}))`)
    const done = await tx
      .select({ v: schema.settings.value })
      .from(schema.settings)
      .where(and(eq(schema.settings.key, 'installed'), eq(schema.settings.value, 'true')))
      .limit(1)
    const [{ n }] = await tx.select({ n: count() }).from(schema.users)
    const verdict = seedPreflight({ installedFlag: done.length > 0, userCount: Number(n) })
    if (verdict === 'installed') throw new AlreadyInstalledError()
    if (verdict === 'not-empty') throw new DatabaseNotEmptyError()

    // Company: reuse a leftover (not-installed) one, else create.
    let [company] = await tx.select().from(schema.companies).limit(1)
    if (company) {
      ;[company] = await tx.update(schema.companies).set({ name: data.companyName }).where(eq(schema.companies.id, company.id)).returning()
    } else {
      ;[company] = await tx.insert(schema.companies).values({ name: data.companyName }).returning()
    }
    const companyId = company.id

    await tx
      .insert(schema.branches)
      .values({ companyId, name: 'Main', code: 'MAIN', isDefault: true })
      .onConflictDoNothing({ target: [schema.branches.companyId, schema.branches.name] })
    const [branch] = await tx
      .select()
      .from(schema.branches)
      .where(and(eq(schema.branches.companyId, companyId), eq(schema.branches.name, 'Main')))

    // System roles + permissions. Admin carries no explicit perms: the `adm` claim comes from is_system && name='admin'.
    await tx
      .insert(schema.roles)
      .values((['admin', 'manager', 'salesman'] as const).map((name) => ({ companyId, name, isSystem: true })))
      .onConflictDoNothing({ target: [schema.roles.companyId, schema.roles.name] })
    const roleRows = await tx.select().from(schema.roles).where(eq(schema.roles.companyId, companyId))
    const roleId = (name: string) => {
      const r = roleRows.find((x) => x.name === name)
      if (!r) throw new Error(`role ${name} missing after seed`)
      return r.id
    }
    const permRows = (['manager', 'salesman'] as const).flatMap((name) =>
      DEFAULT_ROLE_PERMISSIONS[name].map((permission) => ({ companyId, roleId: roleId(name), permission })),
    )
    await tx.insert(schema.rolePermissions).values(permRows).onConflictDoNothing()
    // Make sure the system flag holds even for a leftover role row.
    await tx
      .update(schema.roles)
      .set({ isSystem: true })
      .where(and(eq(schema.roles.companyId, companyId), eq(schema.roles.id, roleId('admin'))))

    const [admin] = await tx
      .insert(schema.users)
      .values({
        companyId,
        branchId: branch.id,
        roleId: roleId('admin'),
        name: data.adminName,
        email: data.adminEmail,
        passwordHash,
      })
      .returning({ id: schema.users.id })

    await tx
      .insert(schema.accounts)
      .values(DEFAULT_ACCOUNTS.map((a) => ({ companyId, name: a.name, type: a.type })))
      .onConflictDoNothing({ target: [schema.accounts.companyId, schema.accounts.name] })
    await tx
      .insert(schema.expenseCategories)
      .values(DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ companyId, name })))
      .onConflictDoNothing({ target: [schema.expenseCategories.companyId, schema.expenseCategories.name] })
    await tx
      .insert(schema.docSequences)
      .values(DOC_KINDS.map((kind) => ({ companyId, kind })))
      .onConflictDoNothing()

    const settingValues: Record<string, string> = {
      currency_symbol: data.currency,
      invoice_prefix_sale: 'INV-',
      invoice_prefix_purchase: 'PUR-',
    }
    for (const [key, value] of Object.entries(settingValues)) {
      await tx
        .insert(schema.settings)
        .values({ companyId, key, value })
        .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value } })
    }
    // Written last: only a fully seeded database is ever "installed".
    await tx
      .insert(schema.settings)
      .values({ companyId, key: 'installed', value: 'true' })
      .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value: 'true' } })

    await logActivity({ companyId, userId: admin.id, action: 'install', entity: 'company', entityId: companyId, after: { company: data.companyName } }, tx)
    return { companyId, adminUserId: admin.id }
  })
  g.__sserpInstalled = true
  return result
}

export { redactDatabaseUrl }
