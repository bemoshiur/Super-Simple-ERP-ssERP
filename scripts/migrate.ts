/** `npm run db:migrate`: apply the committed migrations to DATABASE_URL (from env or .env.local). */
import { loadEnvLocal } from './_env'

loadEnvLocal()

async function main() {
  const { runMigrations, validateDatabaseUrl, safeErrorMessage } = await import('../src/server/install')
  const v = validateDatabaseUrl(process.env.DATABASE_URL)
  if (!v.ok) {
    console.error(`Error: ${v.error}`)
    process.exit(1)
  }
  try {
    const { total } = await runMigrations()
    console.log(`Migrations applied (${total} total).`)
    process.exit(0)
  } catch (e) {
    console.error(`Migration failed: ${safeErrorMessage(e)}`)
    process.exit(1)
  }
}
void main()
