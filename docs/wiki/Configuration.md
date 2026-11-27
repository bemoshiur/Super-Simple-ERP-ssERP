# Configuration

ssERP is configured only through environment variables. Set them in:

- `.env.local` for a local install (`npm run setup` writes it for you),
- `.env` for Docker Compose (start from `.env.example`),
- the project's **Environment Variables** on Vercel.

This table lists every variable the code reads (checked against the source for v0.1.0).

## Application

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | none | PostgreSQL connection string, `postgresql://user:password@host/db?sslmode=require`. Special characters in the password must be URL-encoded. |
| `AUTH_SECRET` | Yes | none | Signs login sessions. At least 32 characters; the app refuses shorter values. Changing it signs everyone out. Generate with `openssl rand -base64 48`. |
| `INSTALL_TOKEN` | For the web installer in production or on Vercel | none | At least 16 characters, typed into `/install`. Not needed for `npm run dev` or `npm run setup`. Can be removed after installing. |
| `DB_DRIVER` | No | auto | `neon` or `pg`. Auto: hosts ending in `.neon.tech` (pooler hosts included) use the Neon serverless driver, everything else node-postgres. Any other value is an error. |
| `TRUSTED_PROXY` | No | unset | `true` only behind a reverse proxy that overwrites `X-Forwarded-For` / `X-Real-IP` with the real client address. Vercel is detected automatically. See [Security Model](Security-Model). |
| `APP_TIMEZONE` | No | `Asia/Dhaka` | IANA time zone for "today", report ranges and displayed dates. Invalid values fall back to the default. |
| `SSERP_MIGRATIONS_DIR` | No | `./drizzle` | Folder of SQL migrations. Change only if you relocate it. |

## Build-time security switches

These are read when `next build` runs (headers are fixed in the build), not at runtime.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HSTS` | unset | `1` sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production builds. Only use it when you serve HTTPS; every subdomain must serve HTTPS too, for a year after a browser saw the header. Vercel builds send it automatically. |
| `CSP_ENFORCE` | unset | `1` sends the Content-Security-Policy as enforcing instead of report-only. |

## Installer, scripts and Docker

| Variable | Used by | Meaning |
| --- | --- | --- |
| `SETUP_COMPANY_NAME`, `SETUP_ADMIN_NAME`, `SETUP_ADMIN_EMAIL`, `SETUP_ADMIN_PASSWORD` | `npm run setup -- --yes` | Non-interactive installer inputs. |
| `SETUP_CURRENCY` | `npm run setup -- --yes` | Currency symbol, default `৳`. |
| `ADMIN_RESET_PASSWORD` | `npm run admin:reset` | New password for non-interactive use. Prefer the hidden prompt. |
| `POSTGRES_PASSWORD` | Docker Compose `postgres` profile | Password of the bundled PostgreSQL container. |
| `PORT` | `npm start`, Docker | Listening port, default 3000. |

## Set by the platform (do not set them yourself)

| Variable | Meaning |
| --- | --- |
| `NODE_ENV` | `production` enables production behaviour: secure cookies, the install-token requirement. |
| `VERCEL` | Set by Vercel. Enables Vercel IP detection, the install-token requirement and HSTS. |

## Developer-only

| Variable | Meaning |
| --- | --- |
| `SSERP_STANDALONE` | Set by the Dockerfile to build Next.js standalone output. |
| `PGHOST` | Read by `npm run seed:demo` only to describe a socket-style target. |
| `SMOKE_ALLOW` | Safety switch for the `scripts/smoke-*.ts` developer scripts; leave unset. |
| `E2E_*`, `SCREENSHOTS`, `CI` | Used by `scripts/e2e.sh` and the Playwright tests. |
| `THEME_REF_DIR` and other `THEME_*` | Options of the licence guard `npm run check:theme`. |

## Settings inside the app

Company name, address, contact details, logo, currency symbol and document number prefixes are edited on
**Administration > Settings** (`settings.edit` permission). The time zone is shown there but comes from
`APP_TIMEZONE`.

## Examples

Local development with Neon (`.env.local`):

```
DATABASE_URL=postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
AUTH_SECRET=<output of openssl rand -base64 48>
```

Docker with the bundled PostgreSQL (`.env`):

```
POSTGRES_PASSWORD=choose-a-password
DATABASE_URL=postgresql://sserp:choose-a-password@postgres:5432/sserp
DB_DRIVER=pg
AUTH_SECRET=<output of openssl rand -base64 48>
INSTALL_TOKEN=<output of openssl rand -hex 16>
```

Never commit `.env` or `.env.local`; both are git-ignored.

Last verified against v0.1.0.
