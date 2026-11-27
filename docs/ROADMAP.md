# Roadmap

What ssERP does today is in the [README](../README.md). This is what is planned. Order is a rough priority, not a promise.
Ideas and votes welcome via issues.

## Next (v0.2)

- **Branch follow-ups**: transfers with an in-transit / receive step, per-branch accounts (cash drawers), per-branch invoice number prefixes, branch column in the activity log.
- **Enforced Content-Security-Policy by default** (today report-only; `CSP_ENFORCE=1` enforces), ideally nonce-based without `'unsafe-inline'`.
- **Serial search index** (trigram / functional index) for very large tenants; product Serials tab deep links.
- **More end-to-end coverage**: service tickets, purchase returns, restricted (single-branch) users, camera scanning and label printing on real devices (both are verified only in desktop browsers so far).
- **Excel (.xlsx) import** next to CSV.

## Later

- **Purchase void / edit**: today purchases are corrected with returns and payments; a controlled void or edit with full history.
- **Store credit** for customers (credit notes usable on later sales).
- **Repair module expansion**: parts used, estimates, technician assignment, repair charges invoiced to the customer, warranty claims against the vendor (RMA).
- **Public API keys and REST API** with scoped permissions, for integrations and a storefront.
- **Mobile app** (or installable PWA) for scanning and quick lookup.
- **Offline POS**: keep selling when the connection drops and sync safely afterwards, without ever selling a serial twice.
- **Bengali UI (i18n)**: translatable interface strings, with Bengali as the first additional language; Bengali invoices and numerals.
- **Multi-company / SaaS onboarding**: self-service sign-up, one database serving many companies with the existing company scoping, plan limits and billing.
- **Better PDFs and printing**: server-side invoice PDF, custom invoice templates.
- **Notifications**: low-stock, warranty-expiry and due reminders by email or SMS.

## Already done (for context)

- v0.1.0: stock and product detail pages; camera/USB barcode and QR scanning; printable serial labels; bulk serial import from CSV with a dry run; demo data (`npm run seed:demo`); multiple branches with per-branch stock, reports and transfers; Playwright end-to-end smoke test with accessibility checks; security headers; local icon bundle.

- Shared-store login rate limiting: login throttling is DB-backed (`login_attempts`) and shared across serverless instances, with an in-memory fallback.
- Session revocation on permission, role and password changes.
