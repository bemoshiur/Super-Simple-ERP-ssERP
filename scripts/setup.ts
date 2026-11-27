/**
 * Interactive CLI installer: `npm run setup`.
 *
 *   npm run setup                 interactive
 *   npm run setup -- --yes        non-interactive (CI / Docker), values from the environment:
 *                                 DATABASE_URL, SETUP_COMPANY_NAME, SETUP_ADMIN_NAME, SETUP_ADMIN_EMAIL,
 *                                 SETUP_ADMIN_PASSWORD, SETUP_CURRENCY (optional)
 *   --no-write-env                do not touch .env.local (e.g. when env vars come from the platform)
 *
 * Never prints the database password or the admin password.
 */
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import {
  checkEnv,
  generateAuthSecret,
  mergeEnv,
  parseEnv,
  redactDatabaseUrl,
  validateAuthSecret,
  validateDatabaseUrl,
  MIN_ADMIN_PASSWORD_LENGTH,
} from '../src/server/install-env'
import { safeErrorInfo } from '../src/server/errors'

const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const NON_INTERACTIVE = flag('--yes') || flag('-y')
const WRITE_ENV = !flag('--no-write-env')
const ENV_FILE = path.resolve(process.cwd(), '.env.local')

const log = (m = '') => console.log(m)
const fail = (m: string): never => {
  console.error(`\nError: ${m}`)
  process.exit(1)
}

if (flag('--help') || flag('-h')) {
  log('Usage: npm run setup [-- --yes] [-- --no-write-env]\nSee the header of scripts/setup.ts for the SETUP_* variables.')
  process.exit(0)
}

// ---- prompts ----
let muted = false
const out = new Writable({
  write(chunk, enc, cb) {
    if (!muted) process.stdout.write(chunk, enc)
    cb()
  },
})
const rl = NON_INTERACTIVE ? null : createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY === true })

async function ask(q: string, def?: string): Promise<string> {
  const a = (await rl!.question(def ? `${q} [${def}]: ` : `${q}: `)).trim()
  return a || def || ''
}
async function askHidden(q: string): Promise<string> {
  const p = rl!.question(`${q}: `)
  muted = true
  try {
    return await p
  } finally {
    muted = false
    process.stdout.write('\n')
  }
}
async function confirm(q: string, def = true): Promise<boolean> {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase()
  return a === '' ? def : a.startsWith('y')
}

// ---- main ----
async function main() {
  log('\nssERP setup\n===========\n')

  let fileText = ''
  try {
    fileText = await readFile(ENV_FILE, 'utf8')
  } catch {
    /* no .env.local yet */
  }
  const fileEnv = parseEnv(fileText)

  // 1. DATABASE_URL
  let dbUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL || ''
  const {
    testConnection,
    safeErrorMessage,
  } = await import('../src/server/install')
  if (dbUrl && validateDatabaseUrl(dbUrl).ok && !NON_INTERACTIVE) {
    if (!(await confirm(`Use the existing DATABASE_URL (${redactDatabaseUrl(dbUrl)})`))) dbUrl = ''
  }
  if (!dbUrl) {
    if (NON_INTERACTIVE) fail('DATABASE_URL is not set (environment or .env.local).')
    log('Create a free Postgres database at https://neon.tech and copy its connection string.')
  }
  for (;;) {
    if (!dbUrl) dbUrl = await askHidden('Neon DATABASE_URL (postgresql://...; input hidden)')
    const v = validateDatabaseUrl(dbUrl)
    if (!v.ok) {
      if (NON_INTERACTIVE) fail(v.error)
      log(`  ${v.error}`)
      dbUrl = ''
      continue
    }
    process.stdout.write(`Testing connection to ${redactDatabaseUrl(dbUrl)} ... `)
    const t = await testConnection(dbUrl)
    if (t.ok) {
      log('ok')
      break
    }
    log('failed')
    if (NON_INTERACTIVE) fail(t.error)
    log(`  ${t.error}`)
    dbUrl = ''
  }

  // 2. AUTH_SECRET: keep a valid existing one
  const existingSecret = process.env.AUTH_SECRET || fileEnv.AUTH_SECRET
  const keepSecret = validateAuthSecret(existingSecret).ok
  const authSecret = keepSecret ? (existingSecret as string) : generateAuthSecret()
  log(keepSecret ? 'AUTH_SECRET: keeping the existing value.' : 'AUTH_SECRET: generated a new random secret.')

  // 3. .env.local
  if (WRITE_ENV) {
    await writeFile(ENV_FILE, mergeEnv(fileText, { DATABASE_URL: dbUrl, AUTH_SECRET: authSecret }), { mode: 0o600 })
    await chmod(ENV_FILE, 0o600)
    log('Wrote .env.local (permissions 600).')
  } else {
    log('Skipped writing .env.local (--no-write-env). Make sure DATABASE_URL and AUTH_SECRET are set where the app runs.')
  }
  process.env.DATABASE_URL = dbUrl
  process.env.AUTH_SECRET = authSecret
  if (!checkEnv().ready) fail('Environment is not valid.') // defensive; should be unreachable

  // 4. migrations
  const { runMigrations, isInstalled, seedBase, installInputSchema, AlreadyInstalledError, DEFAULT_CURRENCY } = await import('../src/server/install')
  try {
    await stat(path.resolve(process.cwd(), 'drizzle'))
  } catch {
    fail('Run this from the project root: the drizzle/ migrations folder was not found.')
  }
  process.stdout.write('Running migrations ... ')
  try {
    const { total } = await runMigrations()
    log(`ok (${total} migrations)`)
  } catch (e) {
    log('failed')
    fail(safeErrorMessage(e, dbUrl))
  }

  const state = await isInstalled()
  if (state === 'unknown') fail('Could not determine whether ssERP is already installed (database error). Try again.')
  if (state === 'yes') {
    log('\nssERP is already installed in this database; nothing to seed. Migrations are up to date.')
    return finish()
  }

  // 5. company + admin
  let input: { companyName: string; adminName: string; adminEmail: string; adminPassword: string; currency: string }
  if (NON_INTERACTIVE) {
    input = {
      companyName: process.env.SETUP_COMPANY_NAME ?? '',
      adminName: process.env.SETUP_ADMIN_NAME ?? 'Administrator',
      adminEmail: process.env.SETUP_ADMIN_EMAIL ?? '',
      adminPassword: process.env.SETUP_ADMIN_PASSWORD ?? '',
      currency: process.env.SETUP_CURRENCY || DEFAULT_CURRENCY,
    }
    const r = installInputSchema.safeParse(input)
    if (!r.success) fail(`Invalid SETUP_* values: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  } else {
    log('\nCompany and admin account')
    const companyName = await ask('Company name')
    const adminName = await ask('Your name')
    const adminEmail = await ask('Admin email')
    const currency = await ask('Currency symbol', DEFAULT_CURRENCY)
    let adminPassword = ''
    for (;;) {
      adminPassword = await askHidden(`Admin password (min ${MIN_ADMIN_PASSWORD_LENGTH} chars; hidden)`)
      if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
        log(`  Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`)
        continue
      }
      if (adminPassword !== (await askHidden('Confirm password'))) {
        log('  Passwords do not match.')
        continue
      }
      break
    }
    input = { companyName, adminName, adminEmail, adminPassword, currency }
    const r = installInputSchema.safeParse(input)
    if (!r.success) fail(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  process.stdout.write('Creating company, roles, accounts and admin user ... ')
  try {
    await seedBase(input)
    log('ok')
  } catch (e) {
    log('failed')
    if (e instanceof AlreadyInstalledError) fail(e.message)
    fail(safeErrorMessage(e, dbUrl))
  }
  log(`\nAdmin login: ${input.adminEmail.trim().toLowerCase()} (the password you just entered).`)
  finish()
}

function finish() {
  log(`
Next steps
  1. Start the app:      npm run dev     (production: npm run build && npm start)
  2. Open:               http://localhost:3000/auth/login
  3. Deploying to Vercel? Add the same DATABASE_URL and AUTH_SECRET in the project's
     Environment Variables, then deploy. The database is already set up, so the
     /install wizard will report that ssERP is installed.
`)
}

main()
  .then(() => {
    rl?.close()
    process.exit(0)
  })
  .catch((e) => {
    rl?.close()
    console.error('\nUnexpected error:', safeErrorInfo(e))
    process.exit(1)
  })
