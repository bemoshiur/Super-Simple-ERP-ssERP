# ssERP (Super Simple ERP)

[বাংলা README](README.bn.md) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Open-source ERP, inventory and billing for shops that sell **serialised goods**: phones, CCTV, laptops, appliances, anything where every physical unit has a serial number or IMEI. ssERP tracks each unit from the vendor's invoice to the customer's hands, and on into warranty and service.

```
Vendor -> Purchase -> Inventory -> Sales -> Customer -> Warranty / Service
```

Built with Next.js 16, React 19, Drizzle ORM and PostgreSQL. [Neon](https://neon.tech) is the recommended database (free tier, serverless); any plain PostgreSQL also works. English UI, with Bengali-friendly money input (for example `1,00,000`) and an `Asia/Dhaka` default time zone.

> Status: **v0.1.0**, first public release. See [CHANGELOG.md](CHANGELOG.md) and the [roadmap](docs/ROADMAP.md) for what is not built yet.

## Screenshots

Captured from a demo install (`npm run screenshots` regenerates them: throwaway database, `npm run seed:demo`, Playwright).

| Dashboard | Point of sale (scan to sell) | Serial lookup (`HIK123456789`) |
| --- | --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Point of sale with two scanned cameras](docs/screenshots/pos.png) | ![Serial lookup: purchase, sale, warranty and timeline of one unit](docs/screenshots/serial-lookup.png) |

| Stock | Bulk serial import (dry run) | Profit & loss |
| --- | --- | --- |
| ![Stock by product](docs/screenshots/stock.png) | ![Serial import preview with row errors](docs/screenshots/purchase-import.png) | ![Profit and loss report](docs/screenshots/profit-loss.png) |

| Branches and transfers | Serial labels (QR) | Roles and permissions |
| --- | --- | --- |
| ![Stock transfer between branches](docs/screenshots/branches-transfer.png) | ![Label print preview](docs/screenshots/labels.png) | ![Role permission matrix](docs/screenshots/roles.png) |

Bengali names render with Noto Sans Bengali: ![Customer with a Bengali name](docs/screenshots/bengali-customer.png)

## Features

**Vendors and customers**
- Vendor and customer records with phone, address, opening balance, ledger, due and payment history.
- Per-party tabs: purchase or sales history, payments, serials supplied or sold, customer warranty and service history.

**Products and inventory**
- Products with categories and brands, SKU, purchase and sale price, warranty months and a low-stock threshold.
- Per-unit serial/IMEI tracking (or plain quantity tracking for non-serial products).
- Unit status machine: in stock, sold, returned, in service, damaged, returned to vendor, with a full event history per unit.
- Stock report with valuation at cost.

**Purchases**
- Purchase invoices with serial entry per line, discount, partial payment and automatic due.
- Stock is created in the same transaction as the invoice. Vendor payments and purchase returns (with optional cash refund).
- A4 print view.

**Sales and billing**
- Point of sale with a scan-the-serial box, editable price, discount and split payments (cash, bank, mobile account).
- Walk-in or registered customers, due collection (oldest invoice first), sale returns with automatic refund of any excess.
- Warranty start and end set per unit at the moment of sale.
- Print view for A4 and 80 mm receipts, with "Save as PDF" through the browser.

**Serial lookup and service**
- Type or scan a serial/IMEI to see vendor, purchase date and cost, customer, sale date and price, warranty status and the whole timeline.
- Service tickets per unit (open, in progress, closed with an outcome), linked back to the unit history.

**Accounts and reports**
- Cash, bank and mobile-money accounts, manual income and expense entries, transfers, and voids that keep the audit trail.
- Dues for customers and vendors.
- Reports with CSV export: sales, purchases, stock, low stock, product-wise profit, customer-wise sales, vendor-wise purchases, warranty expiry, profit and loss, cash flow.

**Administration**
- Users and roles with a permission matrix, forced sign-out when a user's permissions change.
- Company settings: name, address, contact, logo, currency symbol, document number prefixes.
- Activity log and per-record change history.
- DB-backed login throttling that works across serverless instances.

## Serial lookup example

You buy a Hikvision CCTV camera, serial `HIK123456789`, for 2,000 from **ABC Electronics**, and later sell it to **Rahim** for 2,800 with a one-year warranty. Searching `HIK123456789` on the Serial Lookup page shows:

| Fact | Value |
| --- | --- |
| Product | Hikvision CCTV Camera |
| Status | Sold |
| Vendor | ABC Electronics (purchase invoice and date) |
| Purchase cost | 2,000 (only for users allowed to see cost and profit) |
| Customer | Rahim (sale invoice and date) |
| Sale price | 2,800 |
| Warranty | start and end date, days left |
| History | purchased, sold, and any return, service or resale events, newest last |

If Rahim brings it back for repair, open a service ticket from the same page; the ticket and its outcome join the timeline.

## Install

Pick one. All three end at the same place: an empty database gets its tables, three default roles, default accounts (Cash, Bank, bKash) and your first admin user.

### A. One-click: Vercel + Neon

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbemoshiur%2FSuper-Simple-ERP-ssERP&env=DATABASE_URL,AUTH_SECRET,INSTALL_TOKEN&envDescription=DATABASE_URL%3A%20Postgres%20connection%20string%20%28Neon%20recommended%29.%20AUTH_SECRET%3A%20random%2032%2B%20character%20string.%20INSTALL_TOKEN%3A%20random%2016%2B%20character%20string%20you%20type%20into%20the%20web%20installer.&envLink=https%3A%2F%2Fgithub.com%2Fbemoshiur%2FSuper-Simple-ERP-ssERP%23configuration&project-name=sserp&repository-name=sserp)

1. Click the button and sign in to Vercel. Vercel copies the repository to your GitHub account.
2. Fill in the three prompts:
   - `DATABASE_URL`: your Postgres connection string. Easiest: add the **Neon integration** from the Vercel Marketplace to the project (Storage tab) and Vercel creates a Neon database and injects its connection string into the project's environment. Check that the variable it creates is named `DATABASE_URL`; if not, add `DATABASE_URL` yourself with the same value. Or create a database at neon.tech by hand (see [Getting a Neon connection string](#getting-a-neon-connection-string)).
   - `AUTH_SECRET`: at least 32 random characters. Generate one with `openssl rand -base64 48`.
   - `INSTALL_TOKEN`: at least 16 random characters, for example `openssl rand -hex 16`.
3. Deploy, then open `https://YOUR-APP.vercel.app/install`.
4. Enter the install token. The wizard checks the environment and database connection, runs the migrations, and asks for company name, admin name, email and password (at least 10 characters).
5. Sign in at `/auth/login`.

**What the install token is.** `/install` can create the first administrator, so on a public URL it must not be open to whoever finds it first. In production (and always on Vercel) the web installer refuses to run unless `INSTALL_TOKEN` is set, and every installer step requires that token. Once ssERP is installed the installer locks itself permanently (HTTP 403) whether or not the token is still set; you can delete `INSTALL_TOKEN` afterwards. If you would rather not use the web installer at all, run [`npm run setup`](#b-local-machine) from your computer against the same database before deploying.

### B. Local machine

Needs Node.js 20.9 or newer and a PostgreSQL database (Neon, or your own).

```bash
git clone https://github.com/bemoshiur/Super-Simple-ERP-ssERP.git
cd Super-Simple-ERP-ssERP
./install.sh          # checks Node, runs npm install, then npm run setup
# same thing by hand:
#   npm install && npm run setup
npm run dev           # http://localhost:3000
```

`npm run setup` is an interactive installer. It asks for:

1. Your database connection string (input is hidden; it tests the connection first).
2. Company name, your name, admin email, currency symbol (default `৳`) and admin password.

It then generates a random `AUTH_SECRET` (or keeps a valid one you already have), writes `DATABASE_URL` and `AUTH_SECRET` to **`.env.local`** in the project root (file mode 600, git-ignored), applies the migrations and creates the company, roles, accounts and admin user. Re-running it is safe: migrations are idempotent and it will not seed an installed database again.

For scripts and CI: `npm run setup -- --yes` reads `DATABASE_URL` and `SETUP_COMPANY_NAME`, `SETUP_ADMIN_NAME`, `SETUP_ADMIN_EMAIL`, `SETUP_ADMIN_PASSWORD`, optional `SETUP_CURRENCY` (default `৳`) from the environment. `--no-write-env` skips writing `.env.local`.

For a production build on your own machine or server: `npm run build && npm start` (listens on port 3000; set `PORT` to change it).

#### Getting a Neon connection string

1. Go to <https://neon.tech> and sign up (free tier is enough to start).
2. Create a project. Pick the region closest to where the app will run.
3. On the project dashboard click **Connect**.
4. Choose your database and role, and copy the connection string. It looks like `postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`.
5. Paste it when `npm run setup` asks, or into `DATABASE_URL` on Vercel.

Either the direct or the pooled (`-pooler`) string works. Keep `?sslmode=require` on the end.

### C. Docker

```bash
git clone https://github.com/bemoshiur/Super-Simple-ERP-ssERP.git
cd Super-Simple-ERP-ssERP
cp .env.example .env
# edit .env: set DATABASE_URL, AUTH_SECRET (openssl rand -base64 48) and INSTALL_TOKEN
docker compose up -d --build
```

Open <http://localhost:3000/install>, enter the install token and finish the wizard. (The container runs in production mode, so the token is mandatory.) The image uses Next.js standalone output (enabled only by the Dockerfile through `SSERP_STANDALONE=1`, so a normal `npm run build && npm start` is unaffected), runs as a non-root user and has a health check on `/api/health`. Use plain `/api/health` for Docker and uptime probes: `/api/health?db=1` also checks the database (result cached for 5 seconds, replies only `up`/`down`, plus `migrations: ok`/`pending` when up; see [Upgrading](#upgrading)) and, because it connects, can wake a suspended Neon database.

No external database? Use the bundled local Postgres profile. In `.env` set:

```
POSTGRES_PASSWORD=choose-a-password
DATABASE_URL=postgresql://sserp:choose-a-password@postgres:5432/sserp
DB_DRIVER=pg
```

and start with `docker compose --profile postgres up -d --build`. To reach that Postgres from your computer (for `npm run admin:reset`, backups), publish its port by adding this under the `postgres` service in `docker-compose.yml`: `ports: ['127.0.0.1:5432:5432']`. Data lives in the `sserp-pgdata` volume. You manage backups for it yourself.

> The Docker image has been written against the standalone build, which was built and started locally, but `docker build` itself has not been run by the maintainers yet. Please report any problems.

### First steps after installing

1. Sign in with the admin account, open **Settings** and fill in the company profile (it appears on invoices).
2. Add categories, brands and products. Turn on serial tracking for products whose units have serials or IMEIs, and set their warranty months.
3. Add a vendor and record a **Purchase**, entering one serial per unit.
4. Add a customer (or sell to a walk-in) from **Sales > New**: scan or type the serial, take payment, print.
5. Search the serial on **Serial Lookup** and read its history.
6. Under **Users & Roles**, add staff with the Manager or Salesman role, or build your own.

### Quick tour with demo data

On a freshly installed company you can load realistic sample data (12 products, 3 vendors including "ABC Electronics", 6 customers including "Rahim", purchases, sales with part payments, a customer return, a vendor return, a service ticket, expenses, other income and transfers):

```bash
npm run seed:demo                  # add  -- --with-users  for a demo manager and salesman (random passwords, printed once)
```

It goes through the app's own data layer, so the books are consistent (cash flow reconciles, no negative stock). The demo money lives in three new accounts, **Demo Cash / Demo Bank / Demo bKash**; your own accounts and records are never changed. It is idempotent (a second run does nothing) and refuses a company that already has any business data (products, parties, invoices, expenses, incomes, payments, service tickets, stock records, or an account with an opening balance) unless you pass `-- --force`, which still never edits existing rows. It prints the target database (host and name, no password) first, and for a remote database (anything but localhost) or `NODE_ENV=production` it needs `-- --yes` (asked interactively in a terminal, refused in CI). Then open **Serial Lookup** and scan `HIK123456789`: bought from ABC Electronics at 2,000, sold to Rahim at 2,800.

### Scanning, labels and bulk import

- **USB / Bluetooth barcode scanners** work out of the box: they type into the focused box and press Enter (POS, Serial Lookup, purchase serial box, stock count).
- **Camera scanning**: the camera button next to those boxes reads Code 128, Code 39, EAN-13/8, UPC-A, ITF, QR and Data Matrix. It uses the browser's built-in `BarcodeDetector` when present, otherwise a small decoder that is downloaded only when you tap the button. Decoding happens on the device; nothing is uploaded. **Browsers allow the camera only on `https://` or `localhost`**, so use your Vercel/HTTPS address (or a USB scanner) on a phone. If permission is denied, allow the camera for the site in the browser settings.
- **Labels**: `/serials/labels` (button "Print labels" on a purchase, a serial, or Serial Lookup). Pick units by purchase invoice, by ids, or all in stock (optionally one SKU). Sizes: A4 sheet 3 x 8 (63.5 x 34 mm), 50 x 25 mm labels, 58 mm thermal roll (58 x 40 mm). Each label has the product name, serial, shop name and a QR code holding the serial only; a Code 128 barcode is optional. Costs are never printed. At most 500 labels per print. In the print dialog set scale to 100%.
- **Bulk serial import**: Purchases > Import serials (CSV) (`/purchases/import`). Columns `serial,product_sku,unit_cost` and optionally `warranty_months,note`; UTF-8 or Excel "Unicode Text" (UTF-16), comma, semicolon or tab separated; up to 5,000 rows and 800 KB; quote amounts that contain commas (`"12,50,000"`; a row with an unquoted grouped amount is rejected). On Vercel, a 5,000-serial import runs in one transaction and may need up to 60 s (the page sets `maxDuration = 60`; if your Vercel plan or project settings cap function duration below that, split very large files). A dry run lists every problem (unknown SKU, not serial-tracked, repeated or already recorded serial, bad amount) and offers an error CSV; one bad row rejects the whole file; a good file becomes ONE purchase with the vendor, date, discount and payment you enter. See [docs/examples/serials-import.csv](docs/examples/serials-import.csv).

## Upgrading

A new version can include database migrations (new SQL files in `drizzle/`). Apply them to your database **before or while** the new version goes live; old code keeps working on a migrated database for the short overlap, but new code on an old schema fails. Migrations are append-only and drizzle records each applied one (in `drizzle.__drizzle_migrations`), so running them again is harmless.

1. **Back up first.** On Neon, create a branch of your production branch (console: Branches > Create branch) so you can restore it; for your own Postgres, take a `pg_dump`.
2. **Apply the migrations from a checkout of the new version** against the same database:

   ```bash
   git pull                          # or check out the release tag you are upgrading to
   npm install
   DATABASE_URL='postgresql://...' npm run db:migrate    # or keep DATABASE_URL in .env.local
   ```

   It prints `Migrations applied (N total).`
3. **Deploy the new version.**
   - **Vercel:** run step 2 on your computer with the production Neon connection string, then let Vercel deploy the new commit (push to the branch Vercel builds, or redeploy). Vercel does not run migrations for you.
   - **Docker:** after `git pull`, run the one-shot migration container, then rebuild and restart the app:

     ```bash
     docker compose --profile migrate run --rm --build migrate      # add --profile postgres when using the bundled Postgres
     docker compose up -d --build
     ```

     The `migrate` service builds a small stage of the Dockerfile (dependencies and source, no Next.js build) and runs the same `scripts/migrate.ts` with your `.env`. Running `npm run db:migrate` from a clone against the same database works too.
   - **Your own server:** `npm run db:migrate`, then `npm run build` and restart `npm start`.

**How you notice a missed migration.** `/api/health?db=1` reports `"migrations": "ok"` or `"pending"` (only that word, no details), and signed-in administrators see a warning banner at the top of every page while migrations are pending. Both compare the migrations shipped with the running code (`drizzle/meta/_journal.json`) with the ones recorded in the database, cached for 60 seconds. The check never blocks the app; if it cannot tell (for example the database is down) it shows nothing.

## Configuration

Set these in `.env.local` (local), `.env` (Docker) or your host's environment variables (Vercel). Copy `.env.example` to start. Only the variables below are read by the code.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | none | PostgreSQL connection string, `postgresql://user:password@host/db?sslmode=require`. |
| `AUTH_SECRET` | Yes | none | Signs login sessions. 32+ characters; the app refuses shorter values. Changing it signs everyone out. |
| `INSTALL_TOKEN` | For the web installer in production / on Vercel | none | 16+ characters. Typed into `/install`. Not needed for `npm run dev` or `npm run setup`. |
| `DB_DRIVER` | No | auto | `neon` or `pg`. Auto: hosts ending `.neon.tech` (pooler hosts included) use the Neon serverless driver, everything else uses node-postgres. Set `neon` for a Neon database reached through another hostname. |
| `TRUSTED_PROXY` | No | unset | Set to `true` only behind a reverse proxy that overwrites `x-forwarded-for`/`x-real-ip` with the real client address. Vercel is detected automatically. See [Security](#security-notes). |
| `APP_TIMEZONE` | No | `Asia/Dhaka` | IANA time zone used for "today", report ranges and shown dates. Invalid values fall back to the default. |
| `SSERP_MIGRATIONS_DIR` | No | `./drizzle` | Folder of SQL migrations. Only change it if you relocate the folder. |
| `SETUP_COMPANY_NAME`, `SETUP_ADMIN_NAME`, `SETUP_ADMIN_EMAIL`, `SETUP_ADMIN_PASSWORD`, `SETUP_CURRENCY` | Only for `npm run setup -- --yes` | currency `৳` | Non-interactive installer inputs. |
| `SMOKE_ALLOW` | Dev only | none | Safety switch read by the `scripts/smoke-*.ts` developer scripts; leave unset. |
| `ADMIN_RESET_PASSWORD` | Only for non-interactive `npm run admin:reset` | none | New password for [`admin:reset`](#troubleshooting). Prefer the hidden prompt. |
| `POSTGRES_PASSWORD` | Only for the Docker `postgres` profile | none | Password of the bundled Postgres container. |
| `HSTS` | No | unset | `1` at build time sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` (only when you serve over HTTPS behind your own proxy; Vercel builds send it automatically). `includeSubDomains` means every subdomain of your domain must serve HTTPS too, for a year after a browser saw the header. |
| `CSP_ENFORCE` | No | unset | `1` at build time sends the Content-Security-Policy as enforcing instead of report-only. See [Security](#security-notes). |

Also used by the platform and not set by you: `NODE_ENV` (production behaviour, secure cookies), `VERCEL` (set by Vercel). Build/dev-only: `SSERP_STANDALONE` (set by the Dockerfile), `PGHOST` (read by `seed:demo` only to name a socket-style target), and the `E2E_*` variables of `scripts/e2e.sh`.

## Security notes

- **Install token.** See [above](#a-one-click-vercel--neon). Use a long random value and remove it after installing if you like. The installer permanently refuses to run on an installed database, and refuses to seed any database that already has users.
- **Secrets.** Never commit `.env`, `.env.local` or your connection string; they are git-ignored. `npm run setup` writes `.env.local` with mode 600. Rotate `AUTH_SECRET` (this signs everyone out) and the database password if either leaks.
- **Rate limiting and `TRUSTED_PROXY`.** Login attempts are limited to 5 failures per 15 minutes per email and IP, and 20 per 15 minutes per email from any IP. The counters live in the database (`login_attempts`), so they are shared by all instances, with an in-memory fallback if the database is unreachable. The client IP comes from `x-real-ip` or the **rightmost** `x-forwarded-for` entry, and only when `TRUSTED_PROXY=true` or running on Vercel. This assumes exactly one trusted proxy that sets or appends the real peer address. Do not set `TRUSTED_PROXY=true` when the app is exposed directly to the internet: clients control those headers. With it unset, all clients share one IP bucket and only the per-email limit protects an account.
- **Sessions.** Sessions are signed cookies (HTTP-only, `SameSite=Lax`, `Secure` in production, 7 days). Each user has a `session_version`; changing a user's role or permissions, resetting or changing a password, or disabling the account bumps it and every existing session of that user stops working on the next request.
- **Permissions.** Every server action and data route re-checks the signed-in user's permission before doing anything and scopes every query by company. Cost and profit figures are hidden from roles without the right permissions (see the cost-visibility rule below and [Roles and permissions](#roles-and-permissions)).
- **Who sees costs.** *Profit visibility* (`reports.view` or `sales.edit`) gates: stock value and net costs on `/stock` and product pages, the purchase price column and field on `/products` (and its change history), cost/profit columns in reports and their CSVs, the dashboard stock value, and unit cost/profit on serial pages. Separately, `purchases.view` implies seeing purchase costs where they are the document itself: purchase invoices, purchase returns, the purchase import, and a vendor's supplied-units list.
- **Backups.** Your data lives in PostgreSQL, so back up the database. On Neon, use branching and point-in-time restore (history retention depends on your plan): create a branch from the past or restore a branch to an earlier time from the Neon console. See <https://neon.tech/docs/introduction/branching> and <https://neon.tech/docs/introduction/point-in-time-restore>. For self-hosted Postgres use `pg_dump` on a schedule and test restoring it.
- **Passwords.** bcrypt with cost 12. Hashes from older installs (cost 10) keep working and are upgraded on the next successful login. A non-admin with `users.edit` can only manage users whose permissions are a strict subset of their own, that is the same or fewer permissions and at least one fewer (no peer takeover), and changing your own sign-in email asks for your current password. The activity log drops any field whose name looks like a secret: names containing `hash`, `passw`, `secret`, `token`, `otp`, `api_key`/`apikey`, `authorization`, `cookie` or `credential`, and names with the whole word `pin`, `session` or `pwd`. Logged server errors never include database query text or parameters (only the error class and Postgres code).
- **HTTP security headers.** Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` that allows only this site's camera (for barcode scanning). `Strict-Transport-Security` is added on Vercel or with `HSTS=1`. A Content-Security-Policy (`default-src 'self'`, no third-party scripts or connections, no framing) is sent in **report-only** mode; it still allows inline scripts because Next.js injects them (a nonce policy would make every page dynamic). Build with `CSP_ENFORCE=1` to enforce it; the end-to-end test runs clean either way. Icons are bundled locally, so the app makes no requests to third-party hosts.
- **HTTPS.** Run behind HTTPS in production (Vercel does this for you). Cookies are marked `Secure` in production.
- Found a vulnerability? Please follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## Roles and permissions

Permissions are `module.action` keys: modules `vendors`, `customers`, `products`, `purchases`, `sales`, `serials`, `accounts`, `reports`, `users`, `settings` with actions `view`, `create`, `edit`, `delete`, plus `activity.view` and `branches.all` (see Multiple branches).

| Role | What it can do |
| --- | --- |
| **Admin** (system, cannot be edited) | Everything. At least one active admin must always remain. |
| **Manager** | Every permission except `users.delete` and `settings.delete` (includes `branches.all`). Editable. |
| **Salesman** | View and create in `sales`, `customers` and `serials`. Editable. |
| Custom roles | Build your own on the **Roles** page. |

Rules worth knowing: someone who is not an admin can only create, edit, clone or assign a role whose permissions are strictly fewer than their own (a subset of what they hold, missing at least one), cannot edit their own role, and cannot touch an admin account or a user with the same permissions. The role editor warns when a selection would equal your own permissions, and the Clone button only appears for roles whose copy you could create. Users are never deleted, only deactivated. Reports that read the accounts (profit and loss, cash flow) also need `accounts.view`.

## Multiple branches

A fresh install has one branch, **Main**, and looks exactly like a single-shop app: no branch selector, no branch columns. Add more under **Administration > Branches** (name, short code such as `DHK`, address, phone). From then on:

- **Everything belongs to a branch.** Every purchase, sale, return, payment, expense, income, stock adjustment, service ticket and stock movement is stamped with the branch it was made in. Serial units carry the branch they are in now; quantity stock is counted per branch. Data from before branches existed belongs to Main.
- **Who sees what.** A user works in their assigned branch (set on the Users page; changing it signs them out). Without the `branches.all` permission a user only sees and changes their own branch's data: lists, documents, stock, dues, reports, CSV exports and the dashboard. Serial lookup still tells them where a unit is (serial, status, branch) but nothing more. With `branches.all` (admins, and the Manager role by default) a selector in the top bar switches the working branch, or **All branches** for a combined, view-only picture; new documents always go to one concrete branch.
- **Selling and stock.** A serial unit can only be sold, adjusted or returned to the vendor from the branch it is in ("Serial X is in Dhaka; transfer it first"); quantity stock checks are per branch. Customer returns put the goods back into the branch that takes them.
- **Transfers.** **Inventory > Transfers** moves serial units (scan them) and quantities from one branch to another in one step, with a TRF number, a printable transfer note and a `transferred` event on each unit. A user without `branches.all` can only send stock out of their own branch (to any branch); pulling stock in from another branch needs `branches.all`.
- **Reports.** Every report and the dashboard follow the selected branch, and the branch figures add up exactly to All branches. Accounts are company-wide; account opening balances (and party opening balances) count under Main.
- **Company-wide views.** In a company with more than one branch, the **Activity log** and the change history of shared records (products, customers, vendors, accounts, settings, roles, branches) span every branch, so they need `branches.all` as well as their usual permission. A single-branch install is unchanged.
- **What a restricted user sees about money.** Customer and vendor dues and ledgers show only their branch's invoices and payments; party opening balances count under Main, so they appear only to Main and to All branches. Collecting a customer's due allocates over the working branch's invoices only (choose a branch first; "All branches" cannot record payments).
- **Service.** A user restricted to one branch can open warranty/service tickets only for units located in their branch, and sees only their branch's tickets; a unit sold elsewhere needs a `branches.all` user (or a transfer is not possible because sold units do not move).
- **Fail closed.** A restricted user whose branch is missing or inactive sees nothing and is asked to contact an administrator (never silently Main). A user cannot be reactivated into an inactive branch.
- **Limits.** Transfers are immediate (no "in transit" state). Invoice numbers stay one company-wide sequence (the printed invoice shows the branch). A branch can only be deactivated when it is empty (no stock, open tickets or users); Main can never be deactivated. The activity log stays company-wide.

## Money and serial integrity

In plain language, these are guarantees the code is built around (and tested for):

- **Money is exact.** Amounts are stored as PostgreSQL `numeric(14,2)` and calculated as whole integer minor units (paisa/cents), never floating point, so totals never drift by a fraction. Discounts are shared across lines so the pieces always add back to the invoice total. The server recomputes every invoice total itself; numbers sent by the browser are not trusted.
- **A serial can only be in one place.** A serial number is unique per company, and a unit moves only along allowed steps (for example it must be in stock to be sold, and sold to be returned by a customer). Two cashiers scanning the same serial at the same moment cannot both sell it: the unit row is locked and one of them is told it is already sold.
- **Stock and money change together.** A purchase or sale, its stock change, its payment and its history entries are written in a single database transaction. Either everything is saved or nothing is.
- **No overpaying.** Payments cannot exceed the amount due, even with two people paying at once.
- **Nothing is silently deleted.** Corrections are returns, voids and reversing entries; the original records and their history stay. Every change is recorded in the activity log with who and when.
- **Safe retries.** Saving a sale twice (double click, flaky network) does not create two invoices.
- **Stock adjustments and their limits.** Inventory > Stock lets a manager correct stock with a reason (count correction, damage, loss, found, other). Quantity items can never go below zero. A serial unit can only be taken out of stock: there is no separate "lost" status, so a lost unit is marked **damaged** with the reason "loss" in its history, and /stock counts lost and damaged units together under "Damaged". Adjustments are valued at net cost and appear in the profit & loss as "Stock adjustments (write-offs net of found)". A stock count only reports serial differences; it never changes units. There is no vendor RMA flow yet: only units that are **in stock** can be returned to the vendor, so a damaged unit cannot be sent back through a purchase return. Bringing a damaged unit back into stock does not reverse its write-off.

## Development

```bash
npm install
cp .env.example .env.local        # or: npm run setup
npm run dev                       # http://localhost:3000 (webpack)
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server. |
| `npm run build` / `npm start` | Production build and server (the Docker image alone uses standalone output). Build needs no database. |
| `npm run lint` | ESLint. |
| `npm run check:theme` | Licence guard: no theme/vendor names in the repository; with a local copy of a theme package (a git-ignored `<Name>_v<version>/` folder, or `THEME_REF_DIR`) also no file identical to or derived from it. `-- --identifiers` runs only the name check (CI). |
| `npx tsc --noEmit` | Type-check. |
| `npm test` | Fast unit tests (Vitest). No database needed. |
| `npm run test:db` | Integration tests against a throwaway local PostgreSQL. |
| `npm run test:e2e` | Playwright smoke test: throwaway PostgreSQL + production build, then install, purchase, scan-sell, serial lookup, return, reports, branch transfer and sign-out, with axe accessibility checks, security-header and clean-console checks and a 375 px layout check. Needs the PostgreSQL server binaries and `npx playwright install chromium`. `E2E_SKIP_BUILD=1` reuses the last build. |
| `npm run screenshots` | Regenerate `docs/screenshots/*.png` (throwaway install + demo seed). |
| `npm run icons` | Regenerate the local Lucide icon bundle (`src/assets/icons/lucide.json`) after using a new icon name; `npm test` fails while it is stale. |
| `npm run seed:demo` | Demo data for a fresh install (see above). |
| `npm run db:generate` | Generate a new SQL migration from schema changes (drizzle-kit). |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL`. |
| `npm run setup` | Interactive installer (see above). |
| `npm run admin:reset -- --email you@example.com` | Reset a user's password (see [Troubleshooting](#troubleshooting)). |

**How the database tests work.** `npm run test:db` runs `scripts/test-db.sh`, which looks for `initdb` and `pg_ctl` (PATH, Homebrew, Postgres.app, `/usr/lib/postgresql/*/bin`), starts a temporary PostgreSQL in a temp directory on a random local port (a Unix socket if TCP is unavailable), runs every `src/**/*.db.test.ts` with `DB_DRIVER=pg`, then stops and deletes it. No Docker and no cloud database needed. If PostgreSQL's server binaries are not installed it prints `SKIPPED` and exits 0, so install them (`brew install postgresql@16`, `apt install postgresql`) to actually run these tests. Each test file gets its own freshly migrated database. Automated tests use plain PostgreSQL; the Neon driver path is the same Drizzle code over Neon's pool but is not covered by automated tests.

**Project structure**

```
src/app/            Next.js routes: (admin) pages, (print) print views, auth, install, api/health
src/server/         All business logic and data access (no UI)
  auth/             sessions, login throttle, rate limit, public-path allow-list
  db/               drivers (neon / pg) and Drizzle schema
  purchases/ sales/ lookup/ service/ accounting/ reports/ parties/ catalog/
  iam/              users and roles
  rbac.ts           permission catalog and can()
src/proxy.ts        Next.js proxy: signature-only session check (no database)
src/components/ src/layouts/ src/assets/    UI shell, styles, fonts
drizzle/            committed SQL migrations
scripts/            setup, migrate, admin-reset, seed-demo, test-db.sh / e2e.sh (pg-throwaway.sh), icons, smoke scripts
e2e/                Playwright smoke test and README screenshot capture
docs/               SPEC, DATABASE, ROADMAP, THIRD_PARTY
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [docs/DATABASE.md](docs/DATABASE.md) for the driver details.

## Troubleshooting

- **"Install disabled in production" / "Web install is disabled".** The web installer is off in production and on Vercel until `INSTALL_TOKEN` (16+ characters) is set. Add it in your environment variables, redeploy, and enter the same token in the wizard. Or run `npm run setup` locally against the same `DATABASE_URL`.
- **403 on `/install`.** ssERP is already installed; the installer is permanently locked by design.
- **Connection errors / `sslmode`.** Neon needs `?sslmode=require` on the connection string. A plain local Postgres usually has no SSL: leave `sslmode` off (or use `sslmode=disable`), and use `DB_DRIVER=pg`. Connection strings that contain special characters in the password must be URL-encoded.
- **First request is slow or times out on Neon.** Free Neon databases suspend when idle and take a moment to wake up. Retry; the installer and `npm run setup` report "failed" rather than hang.
- **"AUTH_SECRET is too short".** Use at least 32 characters (`openssl rand -base64 48`).
- **Too many failed login attempts.** The limit lasts 15 minutes. Wait, sign in with another account, or reset the password with `npm run admin:reset` (which also lifts the per-email lockout).
- **Forgot the admin password.** From a clone of the project with `DATABASE_URL` in `.env.local` (or exported):

  ```bash
  npm run admin:reset -- --email admin@yourshop.com
  ```

  With Docker, run this from a clone of the repository (the image does not contain the script tooling) with `DATABASE_URL` pointing at the same database: your Neon string, or for the compose `postgres` profile `postgresql://sserp:YOUR_PASSWORD@127.0.0.1:5432/sserp` after publishing the port as described in the Docker section. It asks for the new password (hidden, 10+ characters), stores it with the app's own password hashing, signs that user out everywhere and clears the "too many failed attempts" lockout for that email (this needs the app's `AUTH_SECRET` in the environment; a lockout tied to one IP address still ends on its own within 15 minutes). It refuses to run without `DATABASE_URL`. The password is never taken from command-line arguments; for automation set `ADMIN_RESET_PASSWORD`.
- **Wrong times on reports.** Set `APP_TIMEZONE` (for example `Asia/Dhaka`).
- **`test:db` prints SKIPPED.** Install the PostgreSQL server package so `initdb` and `pg_ctl` exist.

## FAQ

**Is it free?** Yes. MIT licensed, including the UI shell (ssERP's own design on plain Bootstrap 5). Third-party components and their licences are listed in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).

**Do I need Neon?** No. Neon is recommended because it is serverless and free to start. Any PostgreSQL works; set `DB_DRIVER=pg` if auto-detection picks the wrong driver.

**Can it handle products without serial numbers?** Yes, such products are tracked by quantity. Serial tracking is per product.

**Multiple branches or companies?** Multiple branches are supported (see [Multiple branches](#multiple-branches)). Several companies in one install are not (the schema is ready for it). See the [roadmap](docs/ROADMAP.md).

**Is there a mobile app or API?** Not yet; both are on the roadmap. The web app works on phones.

**Bengali?** The interface is English. Currency input accepts Bengali-style grouping (`1,00,000`), the default time zone is Asia/Dhaka and the bundled fonts include Bengali glyphs. A Bengali UI is on the roadmap. There is a [Bengali README](README.bn.md).

**Can I import my existing stock?** Yes, for serial-tracked products: **Purchases > Import serials (CSV)** (`/purchases/import`) turns a CSV of serials, SKUs and unit costs into one purchase after a dry run (see [Scanning, labels and bulk import](#scanning-labels-and-bulk-import)). Quantity-only stock is entered as a normal purchase or a stock adjustment.

**Where do I get help?** Open an issue using the templates. For security problems see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) for the ssERP code. Third-party components and fonts are listed in [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
