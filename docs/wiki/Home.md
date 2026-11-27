# ssERP wiki

**ssERP (Super Simple ERP)** is open-source ERP, inventory and billing for shops that sell **serialised goods**:
phones, CCTV cameras, laptops, appliances, anything where every physical unit has a serial number or IMEI. It tracks
each unit from the vendor's invoice to the customer's hands, and on into warranty and service.

```
Vendor -> Purchase -> Inventory -> Sales -> Customer -> Warranty / Service
```

Built with Next.js 16, React 19, Drizzle ORM and PostgreSQL ([Neon](https://neon.tech) recommended). MIT licensed.
Current version: **v0.1.0** (alpha, the 0.1.x series).

## Start here

| I want to... | Read |
| --- | --- |
| Understand what ssERP does and pick an install path | [Getting Started](Getting-Started) |
| Deploy to the cloud for free | [Install on Vercel and Neon](Install-Vercel-and-Neon) |
| Run it on my computer or my own server | [Install locally](Install-Local) |
| Run it in containers | [Install with Docker](Install-Docker) |
| Set environment variables | [Configuration](Configuration) |
| Record my first purchase and sale | [First Steps After Install](First-Steps-After-Install) |
| Fix a problem | [Troubleshooting](Troubleshooting) and [FAQ](FAQ) |
| বাংলায় পড়তে চাই | [বাংলা গাইড](বাংলা-গাইড) |

## Using ssERP

- [Serial Tracking Guide](Serial-Tracking-Guide): unit statuses, lookup, returns, warranty, service tickets.
- [Sales and POS](Sales-and-POS): scan to sell, split payments, due collection, returns, printing.
- [Purchases and Bulk Import](Purchases-and-Bulk-Import): purchase invoices, vendor payments, CSV serial import.
- [Barcode Scanning and Labels](Barcode-Scanning-and-Labels): USB and camera scanning, printable QR labels.
- [Stock Adjustments and Counts](Stock-Adjustments-and-Counts): corrections, write-offs, stock-takes.
- [Accounting and Reports](Accounting-and-Reports): accounts, dues, profit and loss, cash flow.
- [Users, Roles and Permissions](Users-Roles-and-Permissions): permission catalog, default roles, sign-out rules.
- [Multi-Branch](Multi-Branch): branches, branch scope, transfers.

## Running ssERP

- [Security Model](Security-Model): install token, proxies, rate limits, headers, who sees costs.
- [Database and Migrations](Database-and-Migrations): drivers, forward-only migrations.
- [Upgrading and Backups](Upgrading-and-Backups): safe upgrade steps, Neon branches, `pg_dump`.

## Developing ssERP

- [Architecture Overview](Architecture-Overview)
- [Contributing Guide](Contributing-Guide)
- [Release Process](Release-Process)
- [Roadmap](Roadmap)

## Project status

ssERP v0.1.0 is the first public release. Unit tests, database tests on plain PostgreSQL and a Playwright end-to-end
test on a production build run in CI. **Not yet verified by the maintainers:** the Neon serverless driver path, the
Vercel one-click deploy, `docker build` / Docker Compose, and camera scanning and label printing on real devices.
Reports from people who try these are very welcome.

## Getting help

- Questions: [GitHub Discussions](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/discussions).
- Bugs and feature requests: [issues](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/issues/new/choose).
- Security problems: a [private advisory](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/security/advisories/new),
  never a public issue.

This wiki is generated from
[docs/wiki/](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/tree/main/docs/wiki) in the repository. To improve a
page, edit that file in a pull request; edits made directly in the wiki are overwritten by the next sync.
