# First Steps After Install

A walk-through from an empty install to your first sale. Menu names are as they appear in the left navigation.

## 1. Company profile

Sign in with the admin account and open **Administration > Settings**. Fill in:

- company name, address and contact details (they print on invoices),
- logo,
- currency symbol,
- document number prefixes (invoice, purchase, return, ...).

## 2. Accounts

The installer created three money accounts: **Cash**, **Bank** and **bKash** (types cash, bank and mobile). Open
**Finance > Accounts** to rename them, set opening balances or add more (for example a second bank or Nagad).

## 3. Products

1. **Business > Inventory > Categories** and **Brands**: add the ones you need (optional but useful for reports).
2. **Business > Inventory > Products**: add each product with SKU, purchase price, sale price, warranty months and a
   low-stock threshold.
3. Turn on **serial tracking** for products whose units have a serial number or IMEI. Products without it are counted
   by quantity.

The product's warranty months are copied onto each unit when you buy it, and the warranty starts on the day the unit
is sold.

## 4. A vendor and your first purchase

1. **Business > Parties > Vendors**: add the supplier (name, phone, address, opening balance if you already owe them).
2. **Purchases > New**: pick the vendor and date, add product lines, and for serial-tracked products enter one serial
   per unit (type, paste or scan them; see [Barcode Scanning and Labels](Barcode-Scanning-and-Labels)).
3. Enter any invoice discount and what you paid now, from which account. The rest becomes the vendor's due.
4. Save. Stock is created in the same transaction as the invoice.

Moving existing stock in? Use **Purchases > Import serials (CSV)** instead: see
[Purchases and Bulk Import](Purchases-and-Bulk-Import).

## 5. A customer and your first sale

1. **Business > Parties > Customers**: add the customer, or sell to a walk-in customer.
2. **Business > Sales > Invoices > New** (`/sales/new`): scan or type the serial. Quantity products are picked from a
   list.
3. Adjust the price or discount if needed, take the payment (it can be split across up to five payments, for example
   part cash and part bKash), and save.
4. Print the invoice on A4 or as an 80 mm receipt, or "Save as PDF" from the browser's print dialog.

A walk-in sale must be paid in full; a registered customer may leave a due. Details:
[Sales and POS](Sales-and-POS).

## 6. Look the unit up

Open **Serial Lookup** and search the serial you just sold. You see the vendor and purchase, the customer and sale,
the warranty dates and the unit's full history. Users without profit visibility do not see the purchase cost. See
[Serial Tracking Guide](Serial-Tracking-Guide).

## 7. Staff accounts

**Administration > Users & Roles**:

- add staff with the **Manager** or **Salesman** role, or build a custom role on the **Roles** page,
- each user works in one branch (Main on a fresh install).

Read [Users, Roles and Permissions](Users-Roles-and-Permissions) before giving out `users.*` or `settings.*`
permissions.

## 8. Check the numbers

- **Dashboard**: today's sales, dues, stock value (for users who may see costs).
- **Finance > Dues**: who owes you and whom you owe.
- **Reports**: sales, stock, profit and loss, cash flow. See [Accounting and Reports](Accounting-and-Reports).

## 9. Before you rely on it

- Set up backups: [Upgrading and Backups](Upgrading-and-Backups).
- Read the [Security Model](Security-Model) if ssERP is reachable from the internet.
- Optional: add more branches ([Multi-Branch](Multi-Branch)) and print serial labels
  ([Barcode Scanning and Labels](Barcode-Scanning-and-Labels)).

Last verified against v0.1.0.
