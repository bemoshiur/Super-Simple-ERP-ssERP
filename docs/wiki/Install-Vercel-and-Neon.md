# Install on Vercel and Neon

Run ssERP in the cloud with no server to manage: Vercel hosts the app, Neon hosts PostgreSQL. Both have free tiers.

> **Status:** this path is written against the code but has **not yet been run end to end by the maintainers**
> (v0.1.0). The steps below follow the README. If something differs on your account, please
> [open an issue](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/issues/new/choose).

## 1. Create the Neon database

You can skip this if you will add Neon through the Vercel Marketplace in step 2.

1. Sign up at <https://neon.tech> and create a project in the region closest to where Vercel will run the app.
2. On the project dashboard click **Connect**, choose the database and role, and copy the connection string. It looks
   like `postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`.
3. Keep `?sslmode=require` at the end. Either the direct or the pooled (`-pooler`) string works.

ssERP picks the Neon serverless driver automatically for hosts ending in `.neon.tech`. For a Neon database behind
another hostname, set `DB_DRIVER=neon` (see [Configuration](Configuration)).

## 2. Deploy with the button

Use the **Deploy with Vercel** button in the
[README](https://github.com/bemoshiur/Super-Simple-ERP-ssERP#a-one-click-vercel--neon). Vercel copies the repository
to your GitHub account and asks for three variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | The Neon connection string from step 1. Or add the **Neon integration** from the Vercel Marketplace (project's Storage tab); it creates a database and injects its connection string. Check that the variable is named `DATABASE_URL`; if not, add `DATABASE_URL` with the same value. |
| `AUTH_SECRET` | At least 32 random characters: `openssl rand -base64 48` |
| `INSTALL_TOKEN` | At least 16 random characters: `openssl rand -hex 16`. You type it into the web installer. |

## 3. Run the web installer

1. Open `https://YOUR-APP.vercel.app/install`.
2. Enter the install token. The wizard checks the environment and the database connection and runs the migrations.
3. Enter the company name, your name, admin email and an admin password (at least 10 characters).
4. Sign in at `/auth/login`.

On Vercel (and in any production build) the web installer refuses to run unless `INSTALL_TOKEN` is set, and every
installer step requires it. Once installed, `/install` answers **403** forever, whether or not the token is still set.
You may delete `INSTALL_TOKEN` afterwards.

Prefer not to use the web installer? Run `npm run setup` from a local clone against the same `DATABASE_URL` before
deploying (see [Install locally](Install-Local)).

## 4. After installing

- Follow [First Steps After Install](First-Steps-After-Install).
- `TRUSTED_PROXY` is **not** needed on Vercel: ssERP detects Vercel and reads the client IP from its headers.
- HSTS is sent automatically on Vercel builds.
- Set `APP_TIMEZONE` if your shop is not in `Asia/Dhaka`.

## Function duration and large imports

The bulk serial import, the purchase form and the installer pages declare `maxDuration = 60` seconds. A 5,000-serial
import runs in one transaction and may need that long. If your Vercel plan or project settings cap function duration
below 60 seconds, split large CSV files.

## Cold starts on the free tier

Free Neon databases suspend when idle. The first request after a pause can be slow or fail once; retry. The installer
reports "failed" rather than hanging. Uptime monitors should call plain `/api/health` (no database); `/api/health?db=1`
connects to the database and therefore wakes it.

## Upgrading

Vercel does not run database migrations. Before deploying a new version, run `npm run db:migrate` from a checkout of
that version against the production `DATABASE_URL`. Full steps: [Upgrading and Backups](Upgrading-and-Backups).

Last verified against v0.1.0 (documentation and code; the deployment itself is unverified).
