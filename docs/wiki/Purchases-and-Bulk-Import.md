# Purchases and Bulk Import

## Recording a purchase

**Purchases > New** (`/purchases/new`, permission `purchases.create`):

1. Choose the **vendor** and the purchase date.
2. Add product lines (up to 200 per invoice) with the unit cost.
   - **Serial-tracked products:** enter one serial per unit. Type, paste a list, or scan with a USB scanner or the
     camera button. Serials must be new to the company; duplicates in the list are rejected.
   - **Quantity products:** enter the quantity.
3. Enter an **invoice discount** (optional). It is shared across the lines and units in exact minor units, so each
   unit's stored cost is its **net** cost after its share of the discount.
4. Enter what you **paid now** and from which account. The rest is the vendor's **due**.
5. Save. The invoice, its units (status **in stock**, one `purchased` event each), quantity stock movements and the
   payment are saved in one transaction, into your working branch.

A purchase may hold at most **5,000 serial units**. As with sales, the server recomputes the totals and rejects the
save if they differ from what the form showed, and a resubmitted form returns the first invoice instead of creating a
second one.

Print an A4 copy from the purchase page (`/purchases/<id>/print`).

## Paying the vendor

From the purchase invoice (`purchases.edit`), record a payment against that invoice's due. A payment can never exceed
the due, even with two people paying at once, and cannot be dated before the invoice. **Finance > Dues** lists open
vendor invoices oldest first with their age (0-29, 30-59, 60-89, 90+ days).

## Returning goods to the vendor

From the purchase invoice (`purchases.edit`):

- Pick serial units **of that purchase** that are **in stock** in your branch; each moves to **returned to vendor**.
- Quantity items can be returned up to what is left on the line.
- The credit equals the units' net costs (so returning every unit credits exactly the invoice total). It first
  reduces the invoice due; anything beyond the due is vendor credit, which you can take as a **cash refund** now (into
  an account) or leave as an advance on the vendor's ledger.

Damaged units cannot be returned through a purchase return yet (there is no vendor RMA flow; see
[Roadmap](Roadmap)).

## Correcting a purchase

Purchases cannot be voided or edited after saving in v0.1.0. Correct them with purchase returns and payments. A
controlled void/edit is on the [Roadmap](Roadmap).

## Bulk serial import (CSV)

For bringing existing stock in, or a vendor's serial list: **Purchases > Import serials (CSV)** (`/purchases/import`,
permission `purchases.create`). A good file becomes **one** purchase invoice.

### File format

The first row is a header. Required columns: `serial`, `product_sku`, `unit_cost`. Optional: `warranty_months`,
`note`.

```
serial,product_sku,unit_cost,warranty_months,note
HIK123456789,CAM-HIK-2MP,2000,12,
356789012345678,PHN-REDMI-13C,"12,500.00",12,Box opened
```

An example file is in the repository:
[docs/examples/serials-import.csv](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/docs/examples/serials-import.csv).

| Rule | Detail |
| --- | --- |
| Encoding | UTF-8, or Excel "Unicode Text" (UTF-16). Invalid UTF-8 falls back to Windows-1252. |
| Separator | Comma, semicolon or tab (detected automatically) |
| Size | Up to **5,000 rows** and **800 KB** |
| Amounts | Quote amounts that contain commas: `"12,50,000"`. A row with an unquoted grouped amount is rejected. |
| `serial` | Up to 64 characters; must not exist in the company or repeat in the file |
| `product_sku` | An existing, active, **serial-tracked** product |
| `unit_cost` | Not empty, not negative |
| `warranty_months` | Whole number 0 to 120. Empty means the product's warranty months. |
| `note` | Up to 200 characters, stored on the unit |

### Dry run first

1. Upload the file. ssERP checks every row without saving anything and lists each problem (unknown SKU, not
   serial-tracked, repeated or already recorded serial, bad amount) with its line number. You can download the
   problem rows as an **error CSV**.
2. **One bad row rejects the whole file.** Fix the file and upload it again.
3. When the file is clean, enter the vendor, date, discount and payment, and confirm. The import is saved as one
   purchase in one transaction; submitting the same import twice does not create two purchases.

On Vercel, a 5,000-serial import may need up to 60 seconds (`maxDuration = 60` on the page). If your plan caps
function duration lower, split very large files.

### Quantity stock

The CSV import is for serial-tracked products only. Enter quantity-only stock as a normal purchase or as a stock
adjustment ([Stock Adjustments and Counts](Stock-Adjustments-and-Counts)).

## Who sees purchase costs

`purchases.view` shows purchase documents with their costs (purchase invoices, purchase returns, the import, a
vendor's supplied units). Costs elsewhere (stock value, product purchase price, report cost columns) need profit
visibility (`reports.view` or `sales.edit`). See [Security Model](Security-Model).

Last verified against v0.1.0.
