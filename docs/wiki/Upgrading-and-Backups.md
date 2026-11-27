# Upgrading and Backups

All of a shop's data lives in PostgreSQL. Back it up, and back it up again before every upgrade.

## Backups

### Neon

Neon keeps history for your project, so you can go back in time without your own backup files:

- **Branches:** create a branch of your production branch (console: **Branches > Create branch**) before an upgrade
  or a risky change. It is an instant copy you can restore from.
- **Point-in-time restore:** restore a branch to an earlier moment, or create a branch from a past point in time.
  How far back you can go depends on your Neon plan's history retention.
- Neon docs: <https://neon.tech/docs/introduction/branching> and
  <https://neon.tech/docs/introduction/point-in-time-restore>.

For an independent copy (recommended for important data), also take a `pg_dump` from time to time.

### Self-hosted PostgreSQL and Docker

Run `pg_dump` on a schedule and **test restoring it**:

```bash
pg_dump --format=custom --file=sserp-$(date +%F).dump "$DATABASE_URL"
# restore into an EMPTY database:
pg_restore --no-owner --dbname="$RESTORE_DATABASE_URL" sserp-YYYY-MM-DD.dump
```

With the Docker Compose `postgres` profile, publish the port to `127.0.0.1` first (see
[Install with Docker](Install-Docker)) or run `pg_dump` inside the container. Keep copies off the machine.

## Upgrading

A new version can include database migrations (new SQL files in `drizzle/`). Apply them **before or while** the new
version goes live. Migrations are forward-only and append-only; running them again is harmless.

### 1. Read the release notes

Check the [CHANGELOG](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/CHANGELOG.md) for migrations,
configuration changes and breaking changes. Before 1.0.0, a minor version (0.1 to 0.2) may contain breaking changes.

### 2. Back up

Create a Neon branch, or take a `pg_dump`.

### 3. Apply the migrations from the new version

```bash
git fetch --tags
git checkout vX.Y.Z               # or git pull for the latest main
npm ci
DATABASE_URL='postgresql://...' npm run db:migrate    # or keep DATABASE_URL in .env.local
```

It prints `Migrations applied (N total).`

### 4. Deploy the new version

| Where | How |
| --- | --- |
| **Vercel** | After step 3 (run on your computer with the production connection string), let Vercel deploy the new commit: push to the branch Vercel builds, or redeploy. Vercel does not run migrations for you. |
| **Docker** | `git pull`, then `docker compose --profile migrate run --rm --build migrate` (add `--profile postgres` with the bundled database), then `docker compose up -d --build`. |
| **Own server** | `npm run db:migrate`, `npm run build`, restart `npm start`. |

### 5. Check

- `/api/health?db=1` reports `"migrations": "ok"`.
- The administrators' "migrations pending" banner is gone.
- Sign in, open a recent invoice and run Serial Lookup on a known serial.

## If an upgrade goes wrong

- **The new version fails but the migrations applied:** fix forward with the next patch release if possible. Old code
  keeps working on a migrated database for a short overlap, so rolling the app back to the previous version is usually
  possible for a while; report the problem in an issue.
- **A migration failed or data looks wrong:** stop, restore the Neon branch or the `pg_dump` you made in step 2, and
  open an issue with the version, the error code and what you ran. There are no down migrations.

## How you notice a missed migration

`/api/health?db=1` reports `"pending"` and administrators see a banner while the database is behind the code. The check
compares `drizzle/meta/_journal.json` with `drizzle.__drizzle_migrations`, is cached for 60 seconds and never blocks
the app. See [Database and Migrations](Database-and-Migrations).

## Moving to another database

1. Put the app in a quiet period (no sales).
2. `pg_dump` the old database; `pg_restore` into the new, empty one.
3. Point `DATABASE_URL` at the new database (and set `DB_DRIVER` if the host is not detected correctly).
4. Redeploy and check as in step 5.

`AUTH_SECRET` can stay the same; changing it signs everyone out.

Last verified against v0.1.0.
