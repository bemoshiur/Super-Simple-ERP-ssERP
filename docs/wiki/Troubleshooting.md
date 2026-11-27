# Troubleshooting

Find the symptom, then the fix. If nothing here helps, ask in
[Discussions](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/discussions) or open an
[issue](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/issues/new/choose). Remove secrets before pasting logs.

## Installing

**"Install disabled in production" / "Web install is disabled".**
In production and on Vercel the web installer stays off until `INSTALL_TOKEN` (16+ characters) is set. Add it to the
environment, redeploy, and enter the same token in the wizard. Or run `npm run setup` locally against the same
`DATABASE_URL`.

**403 on `/install`.**
ssERP is already installed; the installer is permanently locked by design. Sign in at `/auth/login`.

**"The database already contains users; refusing to install over it."**
The database is not empty (half-finished setup or another application's database). Use a fresh database.

**"AUTH_SECRET is too short".**
Use at least 32 characters: `openssl rand -base64 48`.

**Installer step shows `failed (code X). See server logs.`**
The real error is in the server log (Vercel: Logs tab; Docker: `docker compose logs app`). The log contains only the
error class and Postgres code, not the query.

## Connecting to the database

**Connection errors or `sslmode` errors.**
Neon needs `?sslmode=require` at the end of the connection string. A plain local PostgreSQL usually has no SSL:
leave `sslmode` off (or `sslmode=disable`) and use `DB_DRIVER=pg`.

**Password with special characters does not work.**
URL-encode it in the connection string (for example `@` becomes `%40`).

**`DB_DRIVER must be "neon" or "pg"`.**
Remove the variable or set exactly `neon` or `pg`.

**First request is slow or times out on Neon.**
Free Neon databases suspend when idle and take a moment to wake up. Retry. Use plain `/api/health` for uptime
monitors; `/api/health?db=1` wakes the database.

## Signing in

**"Too many failed attempts".**
The limit lasts 15 minutes (5 failures per email and IP, 20 per email from any IP). Wait, use another account, or
reset the password with `npm run admin:reset` (which also lifts the per-email lockout).

**Everyone shares one lockout behind my proxy.**
Without `TRUSTED_PROXY=true` all clients share one IP bucket. Set it only if your proxy overwrites
`X-Forwarded-For` / `X-Real-IP`. See [Security Model](Security-Model).

**Signed out unexpectedly.**
Expected after a role, permission, branch or password change, after deactivation, after 7 days, or when
`AUTH_SECRET` changed.

**Forgot the admin password.**
From a clone of the repository with `DATABASE_URL` in `.env.local` (or exported):

```bash
npm run admin:reset -- --email admin@yourshop.com
```

It asks for the new password (hidden, 10+ characters), signs that user out everywhere and clears the per-email
lockout (this needs the app's `AUTH_SECRET` in the environment). For automation set `ADMIN_RESET_PASSWORD`; the
password is never taken from command-line arguments. Docker users run it from a clone; see
[Install with Docker](Install-Docker).

## Using the app

**"Serial X is in <branch>; transfer it first".**
The unit is in another branch. Transfer it on **Inventory > Transfers**, or switch the working branch if you have
`branches.all`.

**"Unit X is sold and cannot be changed to ...".**
The serial's status does not allow that step. See the state diagram in the
[Serial Tracking Guide](Serial-Tracking-Guide).

**"The totals you saw do not match the items."**
The server recomputes every invoice total and refuses to save when it differs from what the form showed (for example
the form was edited in another tab or is stale). Review the lines, reload if needed, and save again.

**I cannot see costs or profit.**
Profit visibility needs `reports.view` or `sales.edit`. See
[Users, Roles and Permissions](Users-Roles-and-Permissions).

**My user sees nothing and is asked to contact an administrator.**
Their branch is missing or inactive. Assign an active branch on the Users page.

**A CSV export says "too many rows".**
Exports above 50,000 rows are refused. Narrow the date range or filters.

**Camera button does not start.**
Browsers allow the camera only on HTTPS or `localhost`. See
[Barcode Scanning and Labels](Barcode-Scanning-and-Labels).

**Wrong dates or "today" on reports.**
Set `APP_TIMEZONE` (for example `Asia/Dhaka`) and restart.

## Upgrading

**Banner "migrations pending" / `"migrations": "pending"`.**
Run `npm run db:migrate` from the new version against the same database. See
[Upgrading and Backups](Upgrading-and-Backups).

**The app errors right after deploying a new version.**
Usually migrations were not applied. Apply them; if it persists, restore your backup and open an issue.

## Development

**`npm run test:db` prints SKIPPED.**
Install the PostgreSQL server package so `initdb` and `pg_ctl` exist (`brew install postgresql@16`,
`apt install postgresql`).

**`npm test` fails about the icon bundle.**
Run `npm run icons` after using a new icon name.

**`npm run test:e2e` cannot start a browser.**
Run `npx playwright install chromium` once.

Last verified against v0.1.0.
