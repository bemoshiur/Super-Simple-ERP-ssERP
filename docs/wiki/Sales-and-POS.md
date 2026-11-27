# Sales and POS

The point of sale is **Business > Sales > Invoices > New** (`/sales/new`, permission `sales.create`). It is built
for scanning: put the cursor in the serial box and scan.

## Making a sale

1. **Customer.** Pick a registered customer or leave it as a walk-in sale.
2. **Serial products.** Scan or type the serial. ssERP finds the unit, checks it is **in stock in your branch**, and
   adds it as a line with the product's sale price. Clear messages explain why a serial cannot be sold: unknown, already
   sold, in service, or "Serial X is in Dhaka; transfer it first".
3. **Quantity products** (no serial tracking) are picked from a product list that shows the on-hand quantity.
4. **Price and discount.** The line price is editable; an invoice discount is shared across the lines so the pieces
   always add back up to the total.
5. **Payment.** Add up to **five payments** across your accounts (for example cash plus bKash). The rest becomes the
   customer's due. A **walk-in** sale must be paid in full.
6. **Date.** A sale can be dated at most one day ahead of today in the shop's time zone (`APP_TIMEZONE`).
7. Save. Each unit moves to **sold** with warranty dates; quantity stock is reduced.

### What the server guarantees

- **It recomputes every amount.** The total you saw is sent along and must match the server's calculation; a mismatch
  is rejected rather than silently changed.
- **One transaction.** The invoice, units, stock movements, payments, activity log and history are saved together or
  not at all.
- **No double sale.** Unit rows are locked; two cashiers selling the same serial at once cannot both succeed. The last
  unit of a quantity product cannot be sold twice either.
- **No duplicates.** A double click or a retry after a network error returns the first invoice instead of creating a
  second one.

## Printing

From the invoice, **Print** opens the print view (`/sales/<id>/print`):

- **A4** invoice (default),
- **80 mm receipt** for thermal printers (`?paper=80mm`).

Use the browser's print dialog; choose "Save as PDF" for a PDF. Set scale to 100 %.

## Invoices list

**Business > Sales > Invoices** (`sales.view`) searches by invoice number, customer name or phone, or a sold serial,
and shows a totals row over the whole filtered list.

## Collecting dues

A customer's unpaid invoices appear on the customer page and on **Finance > Dues**.

- **Pay one invoice** from the invoice page (`sales.edit`).
- **Collect from a customer**: enter one amount and it is applied to their unpaid invoices **oldest first**. In a
  multi-branch company, collection covers the working branch's invoices only; choose a branch first ("All branches"
  cannot record payments).
- Payments can never exceed the amount due, even with two people paying at the same moment.

## Customer returns

From the sale invoice, **Return** (`sales.edit`) lets you pick what comes back:

- **Serial units:** each one goes back **in stock** (resellable; sale link and warranty cleared) or **damaged**.
- **Quantity items** always go back into stock.
- The refund for the returned goods first reduces what the customer still owes on that invoice. Anything beyond that
  is paid back to the customer from the account you choose.
- The goods go into the branch that takes the return.

Returns are listed on **Business > Sales > Returns** (`/sales/returns`). In the profit and loss report, a return
reduces revenue; the cost of goods comes back only for items restocked, so damaged returns stay a cost.

## Corrections

Invoices are never deleted or edited after saving. Corrections are made with returns and payments, so the original
document and its history stay intact. Every change is in the activity log with who and when.

## Who sees what

| Permission | Allows |
| --- | --- |
| `sales.view` | Invoices and returns lists, invoice pages |
| `sales.create` | The POS: new sales |
| `sales.edit` | Payments on invoices, customer due collection, returns |
| `reports.view` or `sales.edit` | Profit visibility: unit cost and profit on serial and report pages |

A Salesman (default role: view and create in sales, customers and serials) can sell and look up serials but does not
see costs.

## Tips

- USB and Bluetooth barcode scanners work like a keyboard: they type the serial and press Enter.
- On a phone, use the camera button next to the serial box (HTTPS required). See
  [Barcode Scanning and Labels](Barcode-Scanning-and-Labels).
- The POS works at 375 px width; tables scroll inside their cards.

Last verified against v0.1.0.
