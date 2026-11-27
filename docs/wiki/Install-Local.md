# Install locally (your computer or your own server)

## Requirements

- **Node.js 20.9 or newer** (the repository's `.nvmrc` says 22, which CI and the Docker image use) and npm.
- **git**.
- A **PostgreSQL** database: a free Neon database, or PostgreSQL installed on the machine.

## Install

```bash
git clone https://github.com/bemoshiur/Super-Simple-ERP-ssERP.git
cd Super-Simple-ERP-ssERP
./install.sh          # checks Node, runs npm ci, then npm run setup
npm run dev           # http://localhost:3000
```

`./install.sh` is the same as `npm ci && npm run setup`.

## What `npm run setup` asks

1. The database connection string (input hidden; the connection is tested first).
2. Company name, your name, admin email, currency symbol (default `৳`) and admin password (at least 10 characters).

It then:

- generates a random `AUTH_SECRET` (or keeps a valid one you already have),
- writes `DATABASE_URL` and `AUTH_SECRET` to **`.env.local`** (file mode 600, git-ignored),
- applies the migrations and creates the company, roles, accounts, the Main branch and the admin user.

Running it again is safe: migrations are idempotent and an installed database is never seeded twice.

### Non-interactive (scripts and CI)

```bash
DATABASE_URL='postgresql://...' \
SETUP_COMPANY_NAME='My Shop' SETUP_ADMIN_NAME='Owner' \
SETUP_ADMIN_EMAIL='owner@example.com' SETUP_ADMIN_PASSWORD='a-long-password' \
npm run setup -- --yes
```

Optional: `SETUP_CURRENCY` (default `৳`), and `--no-write-env` to skip writing `.env.local`.

## A local PostgreSQL

```bash
createdb sserp
echo 'DATABASE_URL=postgresql://localhost:5432/sserp' >> .env.local
npm run setup
```

A plain local PostgreSQL usually has no SSL: leave `sslmode` off (or use `sslmode=disable`). The driver is chosen
automatically (`pg` for non-Neon hosts); set `DB_DRIVER=pg` if needed.

## Production on your own server

```bash
npm run build
npm start             # port 3000; set PORT to change it
```

`npm run build` needs no database. For a shop server:

- Put it behind HTTPS (a reverse proxy such as nginx or Caddy). Session cookies are `Secure` in production.
- If the proxy **overwrites** `X-Forwarded-For` / `X-Real-IP` with the real client address, set `TRUSTED_PROXY=true`
  so login rate limiting sees real client IPs. Never set it when the app is reachable directly. See
  [Security Model](Security-Model).
- With HTTPS in front, build with `HSTS=1` to send `Strict-Transport-Security` (it includes subdomains).
- Run it under a process manager (systemd, pm2) so it restarts after a reboot.
- Back up the database: [Upgrading and Backups](Upgrading-and-Backups).

## Demo data

On a freshly installed company:

```bash
npm run seed:demo                  # add  -- --with-users  for a demo manager and salesman
```

The demo money lives in separate **Demo Cash / Demo Bank / Demo bKash** accounts. The seed refuses a company that
already has business data unless you pass `-- --force` (which still never edits existing rows), and asks for
`-- --yes` before writing to a remote database.

## Forgot the admin password

```bash
npm run admin:reset -- --email admin@yourshop.com
```

It asks for the new password (hidden, 10+ characters), signs that user out everywhere and clears the per-email
sign-in lockout. More in [Troubleshooting](Troubleshooting).

Last verified against v0.1.0.
