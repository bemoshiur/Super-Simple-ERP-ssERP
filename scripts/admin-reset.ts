/**
 * Emergency password reset: `npm run admin:reset -- --email you@example.com`
 *
 * Sets a new password for an existing user (hashed with the app's own bcrypt settings), re-activates nothing,
 * and bumps session_version so every session that user already holds is rejected. Needs DATABASE_URL (environment
 * or .env.local) and refuses to run without it. The new password is read from a hidden prompt, or from
 * ADMIN_RESET_PASSWORD for non-interactive use. It is never accepted as a command-line argument (shell history)
 * and never printed.
 */
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { loadEnvLocal } from './_env'
import { normalizeEmail, parseArgs, validateEmail, validateNewPassword } from './admin-reset-core'
import { safeErrorInfo } from '../src/server/errors'

loadEnvLocal()

const fail = (m: string): never => {
  console.error(`Error: ${m}`)
  process.exit(1)
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_RESET_PASSWORD
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) fail('No terminal available. Set ADMIN_RESET_PASSWORD for non-interactive use.')
  let muted = false
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output: out, terminal: true })
  try {
    const ask = async (q: string) => {
      const p = rl.question(q)
      muted = true
      try {
        return await p
      } finally {
        muted = false
        process.stdout.write('\n')
      }
    }
    const a = await ask('New password (hidden): ')
    const err = validateNewPassword(a)
    if (err) fail(err)
    if (a !== (await ask('Confirm new password: '))) fail('Passwords do not match.')
    return a
  } finally {
    rl.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: npm run admin:reset -- --email you@example.com\nOptional: ADMIN_RESET_PASSWORD=... for non-interactive use. Needs DATABASE_URL.')
    return
  }
  if (args.unknown.length) fail(`Unknown argument(s): ${args.unknown.join(' ')}. Passwords are never accepted as arguments.`)
  const email = normalizeEmail(args.email ?? '')
  const emailErr = validateEmail(email)
  if (emailErr) fail(emailErr)

  const { validateDatabaseUrl } = await import('../src/server/install-env')
  const v = validateDatabaseUrl(process.env.DATABASE_URL)
  if (!v.ok) fail(`${v.error} Set it in the environment or in .env.local.`)

  const password = await readPassword()
  const pwErr = validateNewPassword(password)
  if (pwErr) fail(pwErr)

  const { eq, sql } = await import('drizzle-orm')
  const { closeDb, getDb, schema } = await import('../src/server/db')
  const { hashPassword } = await import('../src/server/auth/password')
  const { safeErrorMessage } = await import('../src/server/install')

  try {
    const passwordHash = await hashPassword(password)
    const rows = await getDb()
      .update(schema.users)
      .set({ passwordHash, sessionVersion: sql`${schema.users.sessionVersion} + 1`, updatedAt: new Date() })
      .where(eq(schema.users.email, email))
      .returning({ id: schema.users.id, active: schema.users.active })
    if (rows.length === 0) fail(`No user with email ${email}.`)
    console.log(`Password updated for ${email}. All of that user's existing sessions were signed out.`)
    if (!rows[0].active) console.log('Note: this account is disabled and still cannot sign in. Re-enable it under Users & Roles first.')
    // Lift the "too many failed attempts" lockout for this email so the new password works right away.
    try {
      const { clearEmailLockout } = await import('../src/server/auth/login-throttle')
      if (await clearEmailLockout(email)) console.log('The sign-in lockout for this email was cleared.')
    } catch {
      console.log('Note: could not clear a sign-in lockout for this email (AUTH_SECRET must be the same as the app\'s); any lockout ends within 15 minutes.')
    }
  } catch (e) {
    fail(`Reset failed: ${safeErrorMessage(e)}`)
  } finally {
    await closeDb().catch(() => {})
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('Unexpected error:', safeErrorInfo(e))
    process.exit(1)
  },
)
