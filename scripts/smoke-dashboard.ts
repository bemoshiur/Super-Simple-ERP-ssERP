/**
 * Read-only smoke test for the dashboard queries against a real database:
 *   npx tsx scripts/smoke-dashboard.ts      (DATABASE_URL from env or .env.local)
 * Runs every aggregate for the first company and prints the result. Writes nothing.
 */
import { loadEnvLocal } from './_env'
import { safeErrorInfo } from '../src/server/errors'

loadEnvLocal()

async function main() {
  const { getDb, schema } = await import('../src/server/db')
  const { loadDashboard } = await import('../src/server/dashboard')
  const [company] = await getDb().select().from(schema.companies).limit(1)
  if (!company) throw new Error('No company found: run the installer first.')
  const { data, failed } = await loadDashboard(company.id, null, { sales: true, inventory: true, accounts: true })
  console.log(JSON.stringify(data, null, 2))
  if (failed.length) throw new Error(`Dashboard groups failed: ${failed.join(', ')}`)
  console.log('OK')
  process.exit(0)
}

main().catch((e) => {
  console.error(safeErrorInfo(e))
  process.exit(1)
})
