# Getting Started

## Is ssERP right for my shop?

ssERP is built for shops where **each physical unit matters**: mobile phones (IMEI), CCTV cameras, routers, laptops,
appliances. For every unit it answers: who did we buy it from, at what cost, who bought it, when does its warranty
end, and what happened to it since.

It also handles products without serial numbers (cables, accessories) by quantity, so one system covers the whole
shop.

What it includes today:

- Vendors and customers with ledgers, dues and payment history.
- Products, categories, brands; per-unit serial/IMEI tracking or quantity tracking per product.
- Purchases with serial entry or CSV import, vendor payments, purchase returns.
- Point of sale with serial scanning, split payments, due collection, returns, A4 and 80 mm receipts.
- Serial lookup, warranty dates, service tickets.
- Cash, bank and mobile-money accounts, income and expense, transfers.
- Reports with CSV export, including profit and loss and cash flow.
- Users, roles and a permission matrix; multiple branches with stock transfers.

What it does **not** have yet (see [Roadmap](Roadmap)): a Bengali user interface, a public API or mobile app, offline
POS, multi-company sign-up, and "in transit" stock transfers.

## What you need

- A **PostgreSQL database**. The easiest is a free [Neon](https://neon.tech) database; any PostgreSQL works.
- One of:
  - a Vercel account (cloud, no server to manage), or
  - a computer or server with **Node.js 20.9 or newer**, or
  - a machine with Docker.

## Pick an install path

| Path | Good for | Guide |
| --- | --- | --- |
| Vercel + Neon | A shop that wants a URL it can open from any device, without running a server | [Install on Vercel and Neon](Install-Vercel-and-Neon) |
| Local / own server | Trying ssERP on a laptop, or a shop server on the local network | [Install locally](Install-Local) |
| Docker | People already running containers | [Install with Docker](Install-Docker) |

All three end at the same place: an empty database receives its tables, three default roles (Admin, Manager,
Salesman), default accounts (Cash, Bank, bKash), one branch called **Main** and your first administrator.

## The five-minute tour

1. Install with any path above.
2. Load demo data on the fresh install: `npm run seed:demo` (from a clone, with `DATABASE_URL` set). It adds 12
   products, 3 vendors, 6 customers, purchases, sales, a return and a service ticket, in separate **Demo** accounts.
3. Open **Serial Lookup** and search `HIK123456789`: bought from ABC Electronics at 2,000, sold to Rahim at 2,800.
4. Open **Reports > Profit & loss** and **Cash flow**.

Details of the demo seed (it refuses a company that already has business data unless forced) are in the
[README](https://github.com/bemoshiur/Super-Simple-ERP-ssERP#quick-tour-with-demo-data).

## Next steps

- [First Steps After Install](First-Steps-After-Install): set up the company and record real stock.
- [Configuration](Configuration): every environment variable.
- [Security Model](Security-Model): read this before exposing ssERP on the internet.

Last verified against v0.1.0.
