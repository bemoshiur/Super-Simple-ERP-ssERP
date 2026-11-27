# FAQ

## General

**Is ssERP free?**
Yes. It is MIT licensed, including the user interface (ssERP's own design on plain Bootstrap 5). Third-party
components and their licences are listed in
[docs/THIRD_PARTY.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/docs/THIRD_PARTY.md).

**Who is it for?**
Shops that sell serialised goods: mobile phones (IMEI), CCTV, routers, laptops, appliances. It also handles products
without serial numbers by quantity.

**Is it production-ready?**
It is v0.1.0, the first public release (alpha). The core flows are covered by unit, database and end-to-end tests,
but the Neon serverless driver path, the Vercel one-click deploy, Docker and camera scanning on real devices have not
been verified by the maintainers yet. Try it with your data on a test install first and keep backups.

**Can I try it without installing?**
There is no hosted demo. A local install with `npm run seed:demo` gives you realistic sample data in a few minutes;
see [Getting Started](Getting-Started).

## Setup

**Do I need Neon?**
No. Neon is recommended because it is serverless and free to start. Any PostgreSQL works; set `DB_DRIVER=pg` if
auto-detection picks the wrong driver.

**Does it run on Windows?**
Node.js and PostgreSQL run on Windows. The installer script `install.sh` needs a Bash shell; on Windows you can run
`npm ci` and `npm run setup` directly. CI tests on Linux; Windows is not tested.

**Can I run it on the shop's local network only?**
Yes, with a local install or Docker. Note that phone cameras need HTTPS for scanning; USB scanners work over plain
HTTP.

## Features

**Can it handle products without serial numbers?**
Yes. Serial tracking is chosen per product; other products are tracked by quantity.

**Can I import my existing stock?**
Yes, for serial-tracked products: **Purchases > Import serials (CSV)** turns a CSV of serials, SKUs and unit costs into
one purchase after a dry run. Quantity-only stock is entered as a normal purchase or a stock adjustment. See
[Purchases and Bulk Import](Purchases-and-Bulk-Import).

**Multiple branches or companies?**
Multiple branches are supported, with branch-scoped users and stock transfers ([Multi-Branch](Multi-Branch)).
Several companies in one install are not supported in the interface (the database schema is ready for it).

**Is there a mobile app or an API?**
Not yet; both are on the [Roadmap](Roadmap). The web app works on phones (layouts are tested at 375 px width).

**Bengali?**
The interface is English. Money input accepts Bengali-style grouping (`1,00,000`), the default time zone is
`Asia/Dhaka`, Bengali names and notes display correctly (Noto Sans Bengali is bundled) and serials may contain Bengali
characters. A Bengali interface is on the roadmap. There is a [Bengali README](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/README.bn.md)
and a [বাংলা গাইড](বাংলা-গাইড).

**Can it print receipts?**
Yes: A4 invoices and 80 mm thermal receipts through the browser's print dialog, and serial labels with QR codes. See
[Sales and POS](Sales-and-POS) and [Barcode Scanning and Labels](Barcode-Scanning-and-Labels).

**Does it do VAT / tax?**
There is no tax calculation in v0.1.0. Prices are entered as you charge them.

**Can I edit or delete an invoice?**
No. Corrections are returns, payments and voids, so the original records and their history stay intact.

**Does it work offline?**
No. It needs a connection to its database. Offline POS is on the [Roadmap](Roadmap).

## Data and privacy

**Where is my data?**
In your PostgreSQL database (Neon or your own server). ssERP makes no requests to third-party hosts at runtime and
sends no telemetry.

**How do I back up?**
Neon branches and point-in-time restore, or `pg_dump`. See [Upgrading and Backups](Upgrading-and-Backups).

**Can salespeople see my purchase costs?**
Not with the default Salesman role. Cost and profit need `reports.view` or `sales.edit`; see
[Users, Roles and Permissions](Users-Roles-and-Permissions).

## Project

**Where do I get help?**
[Discussions](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/discussions) for questions, issues for bugs. For
security problems use a private advisory ([SECURITY.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/SECURITY.md)).

**How can I help?**
Try it and report what breaks, improve the docs, or pick a `good first issue`. See the
[Contributing Guide](Contributing-Guide).

Last verified against v0.1.0.
