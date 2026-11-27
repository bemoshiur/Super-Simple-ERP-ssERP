# Security Model

What ssERP does to protect a shop's data, and what the person running it must do. To report a vulnerability, use a
[private advisory](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/security/advisories/new), never a public issue.

## Installer and the install token

`/install` can create the first administrator, so on a public URL it must not be open to whoever finds it first.

- In production builds and on Vercel the web installer **refuses to run** unless `INSTALL_TOKEN` (16+ characters) is
  set, and every installer step requires the token. A token that is set but too short is refused.
- In local development (`npm run dev`) without a token, the installer is allowed.
- Once ssERP is installed, the installer is **permanently locked** (HTTP 403), with or without the token.
- The installer refuses to seed any database that already has users.
- Alternative: `npm run setup` from your own machine; no web installer involved.

## Sessions

- Signed tokens in an HTTP-only cookie: `SameSite=Lax`, `Secure` in production, valid 7 days.
- The proxy in front of every page checks only the signature and expiry (no database). The server then checks on each
  request that the user is active and that the session version is current.
- Changing a user's role or permissions, branch or password, or deactivating them, signs that user out everywhere.
- `AUTH_SECRET` (32+ characters) signs sessions; rotating it signs everyone out.

## Authorization and tenancy

- Every server action and data route checks the permission **first**, then scopes every query, including joins, by
  the company from the session. Company and branch ids never come from the browser.
- Branch scope is resolved on the server; a restricted user fails closed if their branch is missing or inactive.
- See [Users, Roles and Permissions](Users-Roles-and-Permissions) for the strict-subset rule that prevents privilege
  escalation and peer takeover.

## Login rate limiting and `TRUSTED_PROXY`

- 5 failed sign-ins per 15 minutes per email + IP, and 20 per 15 minutes per email from any IP.
- Counters live in the database (`login_attempts`), shared by every instance (important on serverless), keyed with an
  HMAC subkey of `AUTH_SECRET`. If the database is unreachable an in-memory fallback applies.
- The client IP comes from `X-Real-IP` or the **rightmost** `X-Forwarded-For` entry, and only when
  `TRUSTED_PROXY=true` or running on Vercel. This assumes exactly one trusted proxy that sets or appends the real peer
  address.
- **Do not** set `TRUSTED_PROXY=true` when the app is reachable directly: clients control those headers. Without it,
  all clients share one IP bucket and only the per-email limit protects an account.
- `npm run admin:reset` clears the per-email lockout for that email.

## HTTP security headers

Every response carries:

| Header | Value |
| --- | --- |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(self), microphone=(), geolocation=(), payment=(), usb=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, only on Vercel or with `HSTS=1` at build time |
| Content-Security-Policy | **Report-only** by default; enforcing with `CSP_ENFORCE=1` at build time |

The CSP is `default-src 'self'` with no third-party scripts, frames or connections, `frame-ancestors 'none'`,
`object-src 'none'`, `form-action 'self'` and `base-uri 'self'`. It still allows inline scripts (`'unsafe-inline'`)
because Next.js injects them; a nonce-based policy would make every page render dynamically. It is report-only by
default in v0.1.0 because camera scanning and label printing are not yet verified on real devices; the end-to-end
test runs with no violations either way. The exact policy is in `next.config.ts`.

No runtime requests go to third-party hosts: icons are bundled and fonts are self-hosted.

## Activity log redaction and error logging

- The activity log drops any field whose name looks like a secret: names containing `hash`, `passw`, `secret`,
  `token`, `otp`, `api_key` / `apikey`, `authorization`, `cookie` or `credential`, and names with the whole word `pin`,
  `session` or `pwd`.
- Logged server errors contain only the error class and Postgres code, constraint, table or routine, never a
  database error's message (which can contain query parameters such as password hashes). The web installer shows only
  `failed (code X). See server logs.`

## Cost visibility rule

- **Profit visibility** (`reports.view` or `sales.edit`) gates stock value and net costs, the product purchase price,
  report cost and profit columns and their CSVs, the dashboard stock value, and unit cost and profit on serial pages.
- `purchases.view` shows purchase costs on purchase documents, purchase returns, the import and a vendor's supplied
  units.
- Fields are **omitted on the server** for other users, so they never reach the browser.
- Labels never contain prices or costs.

## Data integrity

Exact money (integer minor units), locked serial units, one transaction per operation, idempotent saves and
append-only history are described in the [Architecture Overview](Architecture-Overview).

## Operator checklist

- [ ] Serve over **HTTPS** (Vercel does this). Behind your own proxy, consider `HSTS=1`.
- [ ] Use long random values for `AUTH_SECRET` and `INSTALL_TOKEN`; remove the token after installing if you like.
- [ ] Never commit `.env` / `.env.local` (both git-ignored); `npm run setup` writes `.env.local` with mode 600.
- [ ] Set `TRUSTED_PROXY=true` only behind a proxy that overwrites forwarded headers.
- [ ] Do not expose PostgreSQL to the internet; use `sslmode=require` for remote databases.
- [ ] Back up the database and test a restore ([Upgrading and Backups](Upgrading-and-Backups)).
- [ ] Give staff the smallest role that works; keep at least two people able to sign in as admin.
- [ ] Rotate `AUTH_SECRET` and the database password if either leaks.

## Dependency audit

At v0.1.0, `npm audit --omit=dev` reported no known vulnerabilities in production dependencies. A development-only
advisory in an old `esbuild` used by `drizzle-kit` is accepted (details in
[SECURITY.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/SECURITY.md)). CodeQL, dependency review
and OpenSSF Scorecard run in GitHub Actions.

Last verified against v0.1.0.
