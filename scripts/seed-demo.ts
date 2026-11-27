/**
 * Demo data for a freshly installed company:  npm run seed:demo [-- --with-users] [-- --force]
 *
 * Creates ~12 products (serial and plain), 3 vendors, 6 customers, purchases, sales with part payments, a customer return,
 * a vendor return, a service ticket, expenses, other income and account transfers, ALL through the app's own data layer, so
 * the books stay consistent. Uses the FIRST company. Does nothing on a second run (company setting demo_seeded).
 * Refuses a company that already has products/vendors/customers/invoices unless --force. Never creates users unless
 * --with-users (a demo manager and a demo salesman with random passwords, printed once). Works with Neon and plain Postgres.
 */
import { loadEnvLocal } from './_env'
import { safeErrorInfo } from '../src/server/errors'

loadEnvLocal()

const HELP = `Usage: npm run seed:demo [-- --with-users] [-- --force]

  --with-users  also create demo users (manager, salesman) with random passwords, printed once
  --force       add the demo records even if the company already has data (existing records are never changed;
                stops if a demo SKU or demo account name already exists)
  --yes         required for a remote database (not localhost) or NODE_ENV=production; there is no prompt in CI/pipes
`

async function main() {
  const { parseDemoArgs, seedDemo, DemoRefusedError, BRIEF_SERIAL, describeTarget, evaluateTarget } = await import('../src/server/demo/seed')
  const args = parseDemoArgs(process.argv.slice(2))
  if (args.help) return console.log(HELP)
  if (args.unknown.length) {
    console.error(`Unknown option(s): ${args.unknown.join(' ')}\n\n${HELP}`)
    process.exit(2)
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Put it in .env.local (npm run setup writes it) or export it, then run again.')
    process.exit(1)
  }
  // Say where the data is going BEFORE touching anything (no credentials are printed).
  const target = describeTarget(process.env.DATABASE_URL)
  console.log(`Target database: ${target.host} / ${target.database}${process.env.NODE_ENV === 'production' ? ' (NODE_ENV=production)' : ''}`)
  const verdict = evaluateTarget(target, { nodeEnv: process.env.NODE_ENV, yes: args.yes, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY })
  if (verdict.action === 'refuse') {
    console.error(`\nRefused: ${verdict.message}`)
    process.exit(1)
  }
  if (verdict.action === 'confirm') {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`This is not a local development database. Write demo data into ${target.host}/${target.database}? Type "yes" to continue: `)).trim().toLowerCase()
    rl.close()
    if (answer !== 'yes') {
      console.error('Cancelled. Nothing was changed.')
      process.exit(1)
    }
  }
  const { getDb, schema, closeDb } = await import('../src/server/db')
  const { asc, eq, and } = await import('drizzle-orm')
  const db = getDb()
  try {
    const [company] = await db.select().from(schema.companies).orderBy(asc(schema.companies.createdAt)).limit(1)
    if (!company) {
      console.error('No company found: install ssERP first (npm run setup, or open /install), then run this again.')
      process.exit(1)
    }
    const installed = await db.select().from(schema.settings).where(and(eq(schema.settings.companyId, company.id), eq(schema.settings.key, 'installed')))
    if (installed[0]?.value !== 'true') {
      console.error('ssERP is not installed yet. Finish the installer first.')
      process.exit(1)
    }
    const admins = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .where(and(eq(schema.users.companyId, company.id), eq(schema.users.active, true), eq(schema.roles.name, 'admin'), eq(schema.roles.isSystem, true)))
      .orderBy(asc(schema.users.createdAt))
      .limit(1)
    const actor = admins[0]
    if (!actor) {
      console.error('The company has no active administrator to record the demo data under.')
      process.exit(1)
    }

    console.log(`Company: ${company.name}`)
    const res = await seedDemo(db, company.id, actor.id, { force: args.force, log: console.log })
    if (res.status === 'already_seeded') {
      console.log('Demo data was already created for this company. Nothing to do. (Use --force to add it again.)')
    } else {
      const s = res.summary
      console.log(`\nDone. ${s.products} products, ${s.vendors} vendors, ${s.customers} customers, ${s.purchases} purchases, ${s.sales} sales,`)
      console.log(`${s.customerReturns} customer return, ${s.vendorReturns} vendor return, ${s.serviceTickets} service ticket, ${s.expenses} expenses, ${s.incomes} other incomes, ${s.transfers} transfers.`)
      console.log(`\nTry it: open Serial Lookup and scan ${BRIEF_SERIAL} (bought on ${s.briefInvoices.purchase}, sold on ${s.briefInvoices.sale}).`)
    }

    if (args.withUsers) {
      const { createUser } = await import('../src/server/iam/users')
      const roles = await db.select({ id: schema.roles.id, name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.companyId, company.id))
      console.log('\nDemo users (passwords are shown ONCE; change or remove them before real use):')
      for (const [name, role, email] of [['Demo Manager', 'manager', 'demo.manager@example.com'], ['Demo Salesman', 'salesman', 'demo.salesman@example.com']] as const) {
        const roleId = roles.find((r) => r.name === role)?.id
        const exists = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))
        if (!roleId || exists.length) {
          console.log(`  ${email}: skipped (${roleId ? 'already exists' : `no ${role} role`})`)
          continue
        }
        const u = await createUser(db, { companyId: company.id, userId: actor.id }, { name, email, roleId, generate: true })
        console.log(`  ${role.padEnd(9)} ${email}  password: ${u.generatedPassword}`)
      }
    }
  } catch (e) {
    if (e instanceof DemoRefusedError) {
      console.error(`\nRefused: ${e.message}`) // log-ok: DemoRefusedError text is written by seed.ts, never a driver error
      process.exitCode = 1
    } else throw e
  } finally {
    await closeDb()
  }
}

main().catch((e) => {
  console.error(safeErrorInfo(e))
  process.exit(1)
})
