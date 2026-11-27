# Roadmap

The authoritative roadmap is
[docs/ROADMAP.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/docs/ROADMAP.md) in the repository;
this page summarises it. The order is a rough priority, not a promise or a schedule. Issues for roadmap items carry
the `roadmap` label.

Have an idea or want to vote? Comment on (or thumbs-up) an existing issue, or open a
[feature request](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/issues/new/choose).

## Done in v0.1.0

- Serial/IMEI lifecycle: purchase, stock, sale, customer, warranty and service, with a per-unit timeline.
- Vendors and customers with ledgers and dues; products, categories and brands.
- Purchases with serial entry, vendor payments and purchase returns; bulk serial import from CSV with a dry run.
- Point of sale with scanning, split payments, due collection, returns, A4 and 80 mm printing.
- Accounts, income and expense, transfers, voids; ten reports with CSV export, including P&L and cash flow.
- Stock page, product pages, stock adjustments and stock counts.
- Camera and USB barcode/QR scanning; printable serial labels.
- Multiple branches with per-branch stock, reports and immediate transfers.
- Users, roles, permission matrix, session revocation, DB-backed login throttling.
- Security headers, report-only CSP, local icon bundle, demo data, Playwright end-to-end test with accessibility checks.

## Next (v0.2)

- **Branch follow-ups:** transfers with an in-transit / receive step, per-branch accounts (cash drawers), per-branch
  invoice number prefixes, a branch column in the activity log.
- **Enforced Content-Security-Policy by default** (today report-only; `CSP_ENFORCE=1` enforces), ideally nonce-based
  without `'unsafe-inline'`.
- **Serial search index** (trigram or functional index) for very large stores; deep links from a product to its
  serials.
- **More end-to-end coverage:** service tickets, purchase returns, restricted (single-branch) users, camera scanning
  and label printing on real devices.
- **Excel (.xlsx) import** next to CSV.

## Later

- **Purchase void / edit** with full history (today purchases are corrected with returns and payments).
- **Store credit** for customers (credit notes usable on later sales).
- **Repair module expansion:** parts used, estimates, technician assignment, repair charges invoiced to the customer,
  warranty claims against the vendor (RMA).
- **Public API keys and REST API** with scoped permissions, for integrations and a storefront.
- **Mobile app** or installable PWA for scanning and quick lookup.
- **Offline POS** that syncs safely afterwards without ever selling a serial twice.
- **Bengali UI (i18n):** translatable interface strings with Bengali first; Bengali invoices and numerals.
- **Multi-company / SaaS onboarding:** self-service sign-up, many companies in one database, plan limits and billing.
- **Better PDFs and printing:** server-side invoice PDF, custom invoice templates.
- **Notifications:** low-stock, warranty-expiry and due reminders by email or SMS.

## Verification still needed (help welcome)

These exist in the code but have not been run end to end by the maintainers:

- the Neon serverless driver path,
- the Vercel one-click deploy and the Neon Marketplace integration's variable names,
- `docker build`, Docker Compose and the bundled PostgreSQL profile,
- camera scanning on real phones and label printing on real label printers.

If you try one of them, please report the result in an issue, whether it worked or not.

## How items get picked up

Maintainers prioritise data integrity, security and the core serial workflow first. Anyone can pick up an item:
comment on its issue first so work is not duplicated, and see the [Contributing Guide](Contributing-Guide). Larger
items (API, multi-company, i18n) need a short design discussion in the issue before code.

Last verified against v0.1.0.
