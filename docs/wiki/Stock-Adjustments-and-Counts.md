# Stock Adjustments and Counts

Stock normally changes only through purchases, sales, returns and transfers. When the system and the shelf disagree,
use an **adjustment** (one product) or a **stock count** (a stock-take). Both need the permission `products.edit`
(Managers have it; Salesmen do not).

## The Stock page

**Business > Inventory > Stock** (`/stock`) shows, per product in the working branch:

- serial units by status (in stock, sold, in service, damaged, returned to vendor),
- on-hand quantity for quantity products,
- stock value at net cost, only for users with profit visibility (`reports.view` or `sales.edit`).

Lost and damaged units are counted together under **Damaged**.

## Adjusting one product

Use the **Adjust** control on a product row of the Stock page.

Choose a **reason**:

| Reason | Typical use |
| --- | --- |
| Count correction | The shelf count differs from the system |
| Damage | Broken goods written off |
| Loss | Missing or stolen goods |
| Found | Goods turned up that were written off or never recorded |
| Other | Anything else (explain in the note) |

### Quantity products

Enter a positive or negative quantity change. **On-hand can never go below zero**, even if someone sells the same
product at the same moment (the product row is locked during the check).

### Serial units

A serial unit can only be taken **out** of stock: it moves from **in stock** to **damaged**, with the reason in its
history. There is no separate "lost" status, so a lost unit is recorded as damaged with the reason "loss". Only units
located in your working branch can be adjusted.

### Duplicate protection

Each adjustment form carries a one-time key: a double submit returns the first adjustment instead of applying it twice.

## How adjustments affect the books

- Adjustments are valued at **net cost** (a serial unit's own cost; the average cost for quantity products).
- They appear in the **Profit & loss** report as **"Stock adjustments (write-offs net of found)"**, by the local date
  they were recorded: damage, loss and negative count corrections are a cost; found stock and positive corrections
  reduce it. See [Accounting and Reports](Accounting-and-Reports).
- Every adjustment is in the activity log and the unit or product history.

## Stock count (stock-take)

**Stock > Stock count** (`/stock/count`):

1. Load a count sheet: active products (and inactive ones that still hold stock) by category, search or tracking type,
   up to 500 products. System quantities are shown; costs are not.
2. Enter counted quantities for quantity products, and scan or paste the serials you physically find (up to 5,000).
3. Compare. The server re-reads the system quantities at that moment (values from the browser are ignored) and shows
   the differences.
4. **Apply** writes count-correction adjustments for the **quantity** products that differ.

Serial differences are **reported, never changed** by the count: serials found that are unknown, belong to another
product or are not in stock, and in-stock serials that were not found. Resolve each one deliberately (for example an
adjustment to damaged with reason "loss", a missing purchase, or a transfer).

## Limits in v0.1.0

- There is no vendor RMA flow: only units that are **in stock** can be returned to the vendor, so a damaged unit cannot
  be sent back through a purchase return.
- No screen moves a damaged unit back into stock.
- The stock report shows the current position (as of now), not a past date.
- A single adjustment of a quantity product is limited to 1,000,000 units.

## Related

- [Serial Tracking Guide](Serial-Tracking-Guide) for unit statuses.
- [Multi-Branch](Multi-Branch): adjustments and counts apply to the working branch only.

Last verified against v0.1.0.
