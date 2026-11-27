# Database options

ssERP stores everything in PostgreSQL. Two drivers sit behind one `getDb()` (`src/server/db/index.ts`):

| Driver | Package | Use it for |
| --- | --- | --- |
| `neon` | `@neondatabase/serverless` (+ `ws`) | **Recommended.** Neon (https://neon.tech), serverless/Vercel. |
| `pg` | `pg` (node-postgres) | Plain PostgreSQL: self-hosted, Docker, RDS, local development, tests. |

Set `DATABASE_URL` to any `postgresql://` URL. The driver is chosen automatically:

1. `DB_DRIVER=neon` or `DB_DRIVER=pg` always wins.
2. Otherwise a host ending in `.neon.tech` (Neon pooler hosts included) uses `neon`.
3. Everything else uses `pg`.

A Neon database reached through another hostname (a custom proxy) needs `DB_DRIVER=neon`.

Transactions, `pg_advisory_xact_lock` and `SELECT ... FOR UPDATE` work on both drivers, and migrations
(`npm run db:migrate`, the `/install` wizard, `npm run setup`) use the migrator matching the active driver.
Raw `db.execute()` results differ slightly between drivers; always read them through `rowsOf()` from `src/server/db`.

## Self-hosting on plain Postgres

```bash
createdb sserp
echo 'DATABASE_URL=postgresql://localhost:5432/sserp' >> .env.local
npm run setup        # migrations + first admin
```

## Integration tests

`npm test` runs pure unit tests only. `npm run test:db` starts a throwaway PostgreSQL (`initdb`/`pg_ctl` from your
PostgreSQL install; no Docker), runs `src/**/*.db.test.ts` against it with `DB_DRIVER=pg`, then removes it. If
`initdb`/`pg_ctl` are not installed it prints a SKIPPED message and exits 0. Each test file gets its own freshly
migrated database and truncates data before every test, so tests are order-independent.
The Neon path is not exercised by CI-style tests (it needs a Neon database); it is identical apart from the pool.
