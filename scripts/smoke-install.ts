/**
 * DB smoke test for the installer: migrate -> seed -> verify seeded data -> admin login check ->
 * second seed must be refused.
 *
 * WARNING: this really installs ssERP into DATABASE_URL (it marks the database as installed with a
 * throwaway admin). Run it ONLY against a scratch database or a disposable Neon branch, and opt in
 * with SMOKE_ALLOW=1. Without DATABASE_URL (or without the opt-in) it prints why and exits 0.
 *
 *   SMOKE_ALLOW=1 DATABASE_URL=postgresql://... npx tsx scripts/smoke-install.ts
 */
import { randomBytes } from 'node:crypto'
import { loadEnvLocal } from './_env'
import { safeErrorInfo } from '../src/server/errors'

loadEnvLocal()

let failures = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

async function main() {
  const { validateDatabaseUrl, generateAuthSecret } = await import('../src/server/install-env')
  if (!validateDatabaseUrl(process.env.DATABASE_URL).ok) {
    console.log('SKIPPED: DATABASE_URL is not set to a valid postgres URL. The install DB flow was NOT exercised.')
    return
  }
  if (process.env.SMOKE_ALLOW !== '1') {
    console.log('SKIPPED: this test installs into DATABASE_URL. Re-run with SMOKE_ALLOW=1 against a scratch database / Neon branch.')
    return
  }
  process.env.AUTH_SECRET ||= generateAuthSecret()

  const { eq, and } = await import('drizzle-orm')
  const { getDb, schema } = await import('../src/server/db')
  const { runMigrations, seedBase, isInstalled, AlreadyInstalledError } = await import('../src/server/install')
  const { verifyPassword } = await import('../src/server/auth/password')
  const { signSession, verifySession } = await import('../src/server/auth/session')
  const { DEFAULT_ROLE_PERMISSIONS, can } = await import('../src/server/rbac')

  const db = getDb()
  await runMigrations()
  check('migrations apply', true)
  await runMigrations()
  check('migrations are re-runnable', true)

  if ((await isInstalled()) === 'yes') {
    console.log('NOTE: database is already installed; only verifying that a second install is refused.')
    let refused = false
    try {
      await seedBase({ companyName: 'x', adminName: 'x', adminEmail: 'smoke2@example.test', adminPassword: randomBytes(12).toString('hex') })
    } catch (e) {
      refused = e instanceof AlreadyInstalledError
    }
    check('seed refused when installed', refused)
    return
  }

  check('not installed before seed', (await isInstalled()) === 'no')
  const email = `smoke-${randomBytes(4).toString('hex')}@example.test`
  const password = randomBytes(16).toString('base64url')
  const { companyId, adminUserId } = await seedBase({ companyName: 'Smoke Co', adminName: 'Smoke Admin', adminEmail: email, adminPassword: password })
  check('installed after seed', (await isInstalled()) === 'yes')

  const roles = await db.select().from(schema.roles).where(eq(schema.roles.companyId, companyId))
  check('3 system roles', roles.length === 3 && roles.every((r) => r.isSystem), roles.map((r) => r.name).join(','))
  const perms = await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.companyId, companyId))
  const count = (name: 'manager' | 'salesman') => perms.filter((p) => p.roleId === roles.find((r) => r.name === name)?.id).length
  check('manager perms match defaults', count('manager') === DEFAULT_ROLE_PERMISSIONS.manager.length)
  check('salesman perms match defaults', count('salesman') === DEFAULT_ROLE_PERMISSIONS.salesman.length)
  check('admin has no explicit perms', perms.filter((p) => p.roleId === roles.find((r) => r.name === 'admin')?.id).length === 0)
  const accts = await db.select().from(schema.accounts).where(eq(schema.accounts.companyId, companyId))
  check('accounts Cash/Bank/bKash', ['Cash', 'Bank', 'bKash'].every((n) => accts.some((a) => a.name === n)))
  const br = await db.select().from(schema.branches).where(and(eq(schema.branches.companyId, companyId), eq(schema.branches.name, 'Main')))
  check('Main branch', br.length === 1 && br[0].isDefault)
  const seqs = await db.select().from(schema.docSequences).where(eq(schema.docSequences.companyId, companyId))
  check('doc_sequences rows', seqs.length === 4)
  const st = Object.fromEntries((await db.select().from(schema.settings).where(eq(schema.settings.companyId, companyId))).map((s) => [s.key, s.value]))
  check('settings', st.installed === 'true' && st.currency_symbol === '৳' && !!st.invoice_prefix_sale && !!st.invoice_prefix_purchase)

  // Login check, same logic as loginAction (minus cookies/headers, which need a Next request).
  const [row] = await db
    .select({ user: schema.users, roleName: schema.roles.name, isSystem: schema.roles.isSystem })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .where(eq(schema.users.email, email))
  check('admin user found', !!row && row.user.id === adminUserId)
  check('password verifies', await verifyPassword(password, row.user.passwordHash))
  check('wrong password rejected', !(await verifyPassword(password + 'x', row.user.passwordHash)))
  const adm = row.isSystem && row.roleName === 'admin'
  const token = await signSession({ uid: row.user.id, cid: row.user.companyId, bid: row.user.branchId ?? null, role: row.roleName, adm, sv: row.user.sessionVersion, perms: [] })
  const session = await verifySession(token)
  check('session token round-trips with adm claim', !!session && session.adm && can(session, 'users.delete'))

  let refused = false
  try {
    await seedBase({ companyName: 'Again', adminName: 'x', adminEmail: 'again@example.test', adminPassword: randomBytes(12).toString('hex') })
  } catch (e) {
    refused = e instanceof AlreadyInstalledError
  }
  check('second seed refused', refused)

  console.log(`\nSmoke login (scratch DB only): ${email}`)
}

main()
  .catch((e) => {
    console.error('ERROR:', safeErrorInfo(e))
    failures++
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nDone')
    process.exit(failures ? 1 : 0)
  })
