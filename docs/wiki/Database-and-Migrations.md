# Database and Migrations

ssERP stores everything in **PostgreSQL**. There are no files, caches or other services to back up.

## Drivers

Two drivers sit behind one `getDb()` (`src/server/db/index.ts`):

| Driver | Package | Use it for |
| --- | --- | --- |
| `neon` | `@neondatabase/serverless` (+ `ws`) | Neon (recommended), serverless / Vercel |
| `pg` | `pg` (node-postgres) | Plain PostgreSQL: self-hosted, Docker, RDS, local development, tests |

How the driver is chosen:

1. `DB_DRIVER=neon` or `DB_DRIVER=pg` always wins. Any other value stops the app with an error.
2. Otherwise a host ending in `.neon.tech` (Neon pooler hosts included) uses `neon`.
3. Everything else uses `pg`.

A Neon database reached through another hostname (a custom proxy or domain) needs `DB_DRIVER=neon`.

Transactions, `pg_advisory_xact_lock` and `SELECT ... FOR UPDATE` work on both drivers. Automated tests run on the
`pg` driver; the Neon path is the same Drizzle code over Neon's pool but is not covered by automated tests.

## Connection strings

- Neon: `postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`. Direct or pooled
  (`-pooler`) both work; keep `sslmode=require`.
- Local PostgreSQL: `postgresql://localhost:5432/sserp` (no SSL, usually).
- URL-encode special characters in the password.

## Migrations

The schema lives in `src/server/db/schema/*.ts`; the SQL migrations generated from it are committed in `drizzle/`
(18 files in v0.1.0, `0000_...` to `0017_serial_lower_idx.sql`), with `drizzle/meta/_journal.json` listing them.

### Applying migrations

Any of these applies all pending migrations to `DATABASE_URL`, using the migrator for the active driver:

| Way | When |
| --- | --- |
| `npm run db:migrate` | Upgrades; prints `Migrations applied (N total).` |
| `npm run setup` | First install from a terminal |
| The `/install` web wizard | First install on Vercel or Docker |
| `docker compose --profile migrate run --rm --build migrate` | Upgrades with Docker |

Drizzle records each applied migration in `drizzle.__drizzle_migrations`, so running them again is harmless.

### Forward only

- Migrations are **append-only**: a committed migration is never edited or deleted.
- There are **no down migrations**. To undo a change, a new migration is written; to recover from a bad upgrade,
  restore a backup (see [Upgrading and Backups](Upgrading-and-Backups)).
- Old code keeps working on a migrated database for the short overlap of a deployment, but new code on an old schema
  fails. That is why you migrate **before** (or while) the new version goes live.

### Pending-migration check

- `/api/health?db=1` reports `"migrations": "ok"` or `"pending"` (nothing more).
- Signed-in administrators see a warning banner at the top of every page while migrations are pending.
- Both compare the migrations shipped with the running code (`drizzle/meta/_journal.json`) with those recorded in the
  database, cached for 60 seconds. The check never blocks the app; if it cannot tell (for example, the database is
  down), it shows nothing.

## For contributors: changing the schema

1. Edit `src/server/db/schema/*`.
2. `npm run db:generate` (drizzle-kit) writes a **new** SQL file in `drizzle/`.
3. Review the SQL: it must work on a database that already has data (backfills, defaults before `NOT NULL`).
4. Avoid anything that needs superuser rights (for example `CREATE EXTENSION`): some hosts do not grant it, and a
   failing migration blocks every upgrade.
5. Add or update `*.db.test.ts` tests; `npm run test:db` runs every test file against its own freshly migrated
   database.
6. Commit the schema change and the new migration together.

## Reading raw query results

`db.execute()` results differ slightly between the two drivers. Always read them through `rowsOf()` from
`src/server/db`.

## Database tests without Docker

`npm run test:db` (`scripts/test-db.sh`) finds `initdb` and `pg_ctl` (PATH, Homebrew, Postgres.app,
`/usr/lib/postgresql/*/bin`), starts a temporary PostgreSQL on a random local port, runs the tests with
`DB_DRIVER=pg` and deletes it. Without the PostgreSQL server binaries it prints `SKIPPED` and exits 0; install them
with `brew install postgresql@16` or `apt install postgresql`.

## Multi-company

Every business table carries `company_id` and every query filters by it, so the schema is ready for several
companies in one database. The user interface runs one company per install in v0.1.0.

Last verified against v0.1.0.
