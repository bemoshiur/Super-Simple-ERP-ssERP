# Accounting and Reports

## Accounts

**Finance > Accounts** (`accounts.view`) lists money accounts of three types: **cash**, **bank** and **mobile**
(bKash, Nagad, ...). A fresh install has Cash, Bank and bKash. Each account has an opening balance; its balance is the
opening balance plus every payment in, minus every payment out.

Every movement of money is one row in the payments ledger: sale receipts, vendor payments, refunds, expenses, other
income and transfers. That single ledger is what the balances and the cash-flow report are built from.

| Action | Where | Permission |
| --- | --- | --- |
| Add, edit, deactivate accounts | Accounts | `accounts.create`, `accounts.edit`, `accounts.delete` |
| Transfer between accounts | Accounts | `accounts.create` |
| Record an expense or other income | Income / Expense | `accounts.create` |
| Edit an expense or income | Income / Expense | `accounts.edit` |
| Void an expense or income | Income / Expense | `accounts.delete` |
| Manage expense categories | Income / Expense | `accounts.create` / `accounts.edit` / `accounts.delete` |

A **void** never deletes: it records a reversing entry, so the original and the reversal both stay in the history.
Default expense categories: Rent, Salary, Utilities, Transport, Marketing, Maintenance, Miscellaneous.

**Finance > Payments** lists every payment with filters and totals in and out over the whole filtered set, and
exports it as CSV (outflows negative, so a spreadsheet sum is the net movement).

## Dues

**Finance > Dues** shows who owes you (customers) and whom you owe (vendors), from unpaid invoices, with aging buckets:
**0-29**, **30-59**, **60-89** and **90+** days since the invoice date. Party opening balances are not invoices, so
they appear on the party's ledger page rather than in the aging list.

## Reports

**Reports** (`reports.view`) is a hub of ten reports. Each has filters, an on-screen table (up to 1,000 rows; totals
always cover every row) and a **CSV export** (UTF-8 with BOM, opens in Excel).

| Report | What it shows | Extra requirement |
| --- | --- | --- |
| Sales report | Daily, weekly or monthly sales net of returns | |
| Purchase report | Daily, weekly or monthly purchases net of returns | |
| Stock report | Serial counts by status, quantity on hand, valuation at cost | |
| Low-stock alerts | Products at or below their low-stock threshold | |
| Product-wise profit | Revenue, cost and profit per product, net of returns | profit visibility |
| Customer-wise sales | What each customer bought, returned, paid and still owes | |
| Vendor-wise purchases | What you bought from each vendor, returned, paid and still owe | |
| Warranty expiry | Sold units whose warranty ends in the next 30, 60 or 90 days | |
| Profit & loss | Revenue, cost of goods sold, expenses and other income | profit visibility and `accounts.view` |
| Cash flow | Opening, inflows, outflows and closing per account | `accounts.view` |

Notes:

- **Dates** use the shop's time zone (`APP_TIMEZONE`). Weekly grouping starts on **Saturday**. A date range is
  limited to about ten years (3,660 days).
- **Cost and profit columns** are removed on the server for users without profit visibility (`reports.view` or
  `sales.edit`), on screen and in CSV.
- **CSV limit:** an export with more than 50,000 rows is refused (HTTP 413) rather than cut short; narrow the filters.
- **Branches:** every report follows the selected branch, and branch figures add up exactly to All branches.

## Profit and loss: definitions

The P&L is an **accrual** view: invoices count on their invoice date, returns on their return date.

```
Gross sales (invoice lines)
- Discounts
= Net sales
- Sales returns (refund credit of returned goods)
= Revenue

Cost of items sold (cost frozen on each sold line)
- Cost of returned goods restocked
= Cost of goods sold
+ Stock adjustments (write-offs net of found)
= Total cost of goods

Gross profit = Revenue - Total cost of goods
Net profit   = Gross profit - Operating expenses + Other income
```

- **Cost of items sold** uses the cost frozen on the line at sale time: the serial unit's own net purchase cost, or the
  average cost for quantity items.
- **Returns:** the cost comes back only for goods that went back into stock. Goods returned **damaged** keep their cost
  in COGS: that is a loss, not recovered stock.
- **Stock adjustments** are the net value of manual stock corrections in the period, valued at net cost: damage, loss
  and negative count corrections add cost; found stock and positive corrections reduce it. See
  [Stock Adjustments and Counts](Stock-Adjustments-and-Counts).
- **Purchases are not expenses.** Buying stock is an asset; it reaches the P&L as cost of goods sold when it is sold.
  Vendor payments, customer receipts and refunds, and transfers between accounts are cash movements, not income or
  expense.
- **Operating expenses** and **other income** are the manual entries of the period; voided entries are excluded.

## Cash flow: reconciliation

For each account: **opening** (balance at the start of the period) **+ inflows - outflows = closing**. Inflows and
outflows are grouped by cause: customer receipts, vendor payments, expense categories, other income, transfers and
voids.

In the All-branches view, each account's closing figure is reconciled against the account balance as of the period
end; they must be identical. Account opening balances belong to the **Main** branch, so a single-branch view of
another branch starts from zero, and the per-branch closings add up to the all-branches closing.

## Dashboard

The dashboard reuses the report functions, so it can never disagree with them: sales today, this month and the last
seven days (net of returns), top products over the last 30 days, low stock, dues, and stock value (only for users
with profit visibility).

Last verified against v0.1.0.
