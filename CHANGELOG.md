# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Open-source project setup: `SUPPORT.md`, `GOVERNANCE.md`, `CITATION.cff`, `.editorconfig`, `.gitattributes`, `.nvmrc`, and `repository` / `bugs` / `homepage` / `keywords` / `author` metadata in `package.json`.
- GitHub issue forms (bug report, feature request, question) with contact links to private security advisories, Discussions and the wiki; `CODEOWNERS`; a pull request checklist that mirrors the contribution invariants.
- `.github/labels.yml` and `scripts/sync-labels.sh` (type, status, priority, area and community labels).
- Workflows: CodeQL (JavaScript/TypeScript), dependency review (fails on high-severity advisories, licence allow-list), OpenSSF Scorecard, release on `v*` tags (tag must match `package.json`, checks and build, GitHub Release with generated notes, pre-release below 1.0.0), stale issues and pull requests (60 + 14 days, with exemptions), first-interaction greetings.
- Dependabot: grouped weekly minor/patch updates for npm, GitHub Actions and the Docker base image; major upgrades of core frameworks are left to maintainers.
- `npm run check:docs` (`scripts/check-links.mjs`): relative link and anchor check for README, docs and wiki sources, run in a new CI `docs` job.
- Documentation: `docs/ARCHITECTURE.md`, `docs/RELEASING.md`, `docs/MAINTAINING.md`, `docs/SOCIAL_PREVIEW.md` and `docs/social-preview.png` (rendered by `scripts/make-social-preview.mjs`); wiki sources in `docs/wiki/` published with `scripts/sync-wiki.sh`.
- README: badges, table of contents, "Why ssERP", "Project status" (what is and is not verified), "Community and support"; matching sections in the Bengali README.

### Changed
- CI: every GitHub Action is pinned to a full commit SHA (behaviour unchanged).
- README: the unit status list now matches the state machine (there is no separate "returned" status), and the stock-adjustment limits say that no screen moves a damaged unit back into stock.

## [0.1.0] - YYYY-MM-DD (unreleased; set the date when tagging)

First public release.

### Added
- Serial/IMEI lifecycle tracking: vendor, purchase, inventory, sale, customer, warranty and service, with a per-unit event timeline.
- Vendors, customers (ledgers, dues, payment history), products, categories and brands.
- Purchases with serial intake, vendor payments and purchase returns.
- Point of sale with serial scanning, split payments, due collection, sale returns and A4 / 80 mm print views.
- Serial lookup, warranty tracking and service tickets.
- Accounts (cash, bank, mobile), income and expense, transfers and voids, and dues.
- Reports with CSV export: sales, purchases, stock, low stock, product profit, customer and vendor summaries, warranty expiry, profit and loss, cash flow.
- Users, roles and a permission matrix, company settings, activity log and record history, change-password and profile pages.
- Installation: Vercel one-click with a web installer protected by `INSTALL_TOKEN`, `npm run setup` / `install.sh`, and Docker.
- Neon (serverless) and plain PostgreSQL drivers.
- DB-backed login throttling, session revocation, `npm run admin:reset` for forgotten admin passwords.
- `/api/health` liveness endpoint (`?db=1` adds a database check).
- Camera barcode/QR scanning (BarcodeDetector with a lazy-loaded ZXing fallback) in the POS, Serial Lookup, purchase serial box and stock count; USB scanners unchanged.
- Printable serial labels (A4 3 x 8, 50 x 25 mm, 58 mm roll) with QR and optional Code 128, at `/serials/labels`.
- Bulk serial import from CSV with a dry run, error report and idempotent one-transaction purchase; purchases accept an idempotency key (migration 0013); per-invoice unit cap raised to 5,000.
- `npm run seed:demo`: consistent demo data through the real data layer, in its own Demo accounts (idempotent; refuses a company with data; `--force` never edits existing rows; remote databases need `--yes`; `--with-users`).
- Multiple branches: branch management (Administration > Branches), user branch assignment, `branches.all` permission (Manager by default), top-bar branch selector with an All-branches view, branch-scoped lists, documents, stock, dues, reports, CSV exports and dashboard, and immediate inter-branch stock transfers (`/stock/transfers`, TRF numbers, printable note). Migrations 0014 (enum values), 0015 (branch codes, backfill of existing rows to Main, indexes, transfer tables, `branches.all` for the system Manager role) and 0016 (transfer idempotency hash; signs managers out once so they pick up `branches.all`). Custom roles cloned from Manager do NOT get `branches.all` automatically: grant it on the Roles page if those users should switch branches.
- CI (lint, typecheck, unit tests, build, database tests, Playwright end-to-end smoke test), Docker image and compose file, MIT license, contribution and security docs.
- `npm run test:e2e`: one serial flow in a real browser (install wizard, purchase with serials, scan-sell with a partial payment, serial lookup, customer return, sales report and P&L, second branch + transfer, sign out) against a throwaway PostgreSQL, with axe-core accessibility checks, a 375 px layout check, security-header and clean-console checks.
- README screenshots (`npm run screenshots`), including a Bengali-name screen.
- Migration 0017: index on `product_units (company_id, lower(serial_no) text_pattern_ops)` for case-insensitive and prefix serial lookups on large stores. (No trigram index: `CREATE EXTENSION pg_trgm` needs a privilege some hosts do not grant, and a failing migration would block upgrades; substring search stays a scan within the company.)
- Upgrade path: README "Upgrading" section (back up, `npm run db:migrate` from the new version, Vercel and Docker steps), a one-shot `migrate` Docker Compose service (`docker compose --profile migrate run --rm --build migrate`), and a pending-migration check (`migrations: ok|pending` on `/api/health?db=1`, warning banner for administrators; cached 60 s, never blocks).

### Security
- HTTP security headers (nosniff, `X-Frame-Options: DENY`, referrer policy, permissions policy, HSTS on HTTPS deployments) and a report-only Content-Security-Policy (`CSP_ENFORCE=1` enforces it).
- Icons bundled locally (Iconify offline mode): no runtime requests to third-party hosts.
- bcrypt cost 12 with transparent rehash of older hashes on login; login-throttle keys use an HMAC subkey of `AUTH_SECRET`.
- Permission checks for user/role management only count keys in the current permission catalog (a retired key stored on a role never counts as an extra permission); the roles page hides Clone when the copy would not be strictly below your permissions and the role editor blocks saving a selection equal to your own, with an inline hint; `revokeUserSessions` is company-scoped; `npm run admin:reset` also clears the per-email sign-in lockout.
- Non-admin user managers can only act on users whose permissions are a strict subset of their own; changing your own sign-in email needs your current password; password reset/change and (de)activation record the client IP; secret-looking fields are stripped from the activity log.
- Product list purchase prices are no longer sent to users without profit visibility (and their edits keep the stored price).
- Every Drizzle join on a company-owned table carries its own `company_id` predicate (defence in depth against a row that references another company's record through a single-column foreign key).
- Caught errors are logged through `safeLog`: only the error class and Postgres code/constraint/table/routine, never a database error's message (drizzle puts the query and its parameters, such as password hashes, there); the web installer shows only `failed (code X). See server logs.` instead of echoing the error.
- Next.js 16.4.6: `npm audit --omit=dev` reports no known vulnerabilities (see SECURITY.md for the accepted dev-only advisory).

### Changed
- **Original UI shell** (licence clean-up): the admin shell adapted from a commercial theme (UBold by Coderthemes) is gone. ssERP now has its own design (calm blue-teal on cool greys, deep "ink" navigation column, white cards, Nunito + Noto Sans Bengali) built as a small Sass layer on upstream Bootstrap 5 from `node_modules`, and its own layout components: navigation column with collapsible groups (disclosure buttons, `aria-current`, Up/Down/Home/End keys) and a remembered icon-rail mode, an off-canvas drawer below 992 px, top bar with branch selector and account menu, page header with breadcrumb and a single `h1`, sign-in/installer/error pages on one `AuthShell`, SVG logo mark and favicon drawn in code. Routes, permissions and behaviour are unchanged. See docs/THIRD_PARTY.md.
- Raw SQL joins in the invoice serial search and the branch blocker check carry their own company predicate (with tests).

### Added (tooling)
- `npm run check:theme` (`scripts/theme-inventory.mjs`): fails on theme/vendor names in the repository and, when the local theme package is present, on any file identical to or derived from (70 %+ shared lines) a theme file. CI runs the name check.
- The raw-error-log scanner also catches errors interpolated into template literals or concatenated strings, and scans `e2e/`; a reviewed exception is marked inline with `// log-ok: <reason>`.
- E2E: axe also on stock, reports, users and roles; navigation disclosure, icon-rail persistence and the mobile drawer are exercised.

### Removed
- The theme's customizer, ten colour skins, horizontal layout, theme images, its forked Bootstrap Sass copy (about 19,000 lines of SCSS) and the `simplebar-react` dependency (native scrolling).
- The theme's unlinked demo error pages (`/error/400` ... `/error/maintenance`); ssERP now has its own minimal `not-found` and `error` pages (the error page shows no details, only the digest to match the server log). Unused float formatting helpers (`formatBytes`, `abbreviatedNumber`, demo chart data, `getFont`) were removed, and `lodash` is imported per method (`lodash/get`, `lodash/merge`).

### Documentation
- Code of Conduct reports go through GitHub (private report from the Security tab, or the repository owner's profile); README FAQ now points to the bulk serial import; `.env.example` driver auto-detection wording matches the code (`.neon.tech` hosts, `DB_DRIVER=neon` for other hostnames); README wording for the strict-subset user/role rule and the current secret-field redaction list.

### Accessibility
- WCAG 2.1 AA colour contrast on core screens, labelled icon buttons, skip link and `main` landmark, visible keyboard focus; POS and lists usable at 375 px (tables scroll inside their cards, side menu off-canvas from the first paint).

### Known limitations
- One company per install in the UI (the schema is multi-company ready). Branch transfers are immediate (no in-transit state).
- No public API or mobile app yet. See [docs/ROADMAP.md](docs/ROADMAP.md).
- English UI only.

[Unreleased]: https://github.com/bemoshiur/Super-Simple-ERP-ssERP/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bemoshiur/Super-Simple-ERP-ssERP/releases/tag/v0.1.0
