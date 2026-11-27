# ssERP Product Spec (summary of original Bengali brief)

ERP + Inventory + Billing for businesses selling serialized goods (electronics, CCTV, phones). Core promise: every physical unit is tracked by Serial/IMEI from vendor to customer to warranty/service.

Lifecycle: Vendor -> Purchase -> Inventory -> Sales -> Customer -> Warranty/Service

1. Vendor management: details, purchase history, products bought, due/payments, serials bought.
2. Customer management: details, purchase history with serials, due/payments, warranty and service history.
3. Product & inventory: products, categories, brands; per-unit serial/IMEI; vendor per unit; stock/sold/returned status; purchase price, selling price, profit; full serial history.
4. Purchases: invoices, serial capture, automatic stock update, payment and due.
5. Sales & billing: invoices, scan-serial-to-sell, automatic stock update, cash/bank/mobile/due, returns & refunds, print & PDF.
6. Serial tracking: vendor, purchase date/price, status/location, customer, sale date/price, warranty, return/service.
7. Accounting: daily/weekly/monthly income-expense, customer & vendor due, cash & bank accounts, payment history, P&L, cash flow.
8. Reports: sales, purchase, stock, low-stock alert, product-wise profit, customer-wise sales, vendor-wise purchase, serial history, warranty expiry.
9. Users & roles: admin/manager/salesman, permissions, activity log, change history.
10. Future: multi-branch, multi-company, barcode/QR, bulk serial import, warranty mgmt, repair/service, SaaS multi-tenant, mobile app, API.

Example: buy Hikvision CCTV Camera, serial HIK123456789, cost 2,000 from ABC Electronics; sell to Rahim at 2,800. Searching the serial shows vendor, buy date, cost, customer, sale date, sale price, warranty, full history.

Deployment: Neon Postgres; open source on GitHub; installer collects the Neon connection string.
