# Multi-Branch

A fresh install has one branch, **Main**, and looks exactly like a single-shop app: no branch selector and no branch
columns. Branch features appear once you add a second branch.

## Managing branches

**Administration > Branches** (`/settings/branches`):

| Action | Permission |
| --- | --- |
| Add or edit a branch (name, short code such as `DHK`, address, phone) | `settings.edit` |
| Reactivate a branch | `settings.edit` |
| Deactivate a branch | `settings.delete` |

A branch can only be deactivated when it is **empty**: no stock, no open service tickets and no users. **Main** can
never be deactivated.

## Everything belongs to a branch

Every purchase, sale, return, payment, expense, income, stock adjustment, service ticket and stock movement is stamped
with the branch it was made in. Serial units carry the branch they are in now; quantity stock is counted per branch.
Data from before branches existed belongs to Main.

**Accounts are company-wide.** Account opening balances and party opening balances count under Main.

## Who sees what

Each user has an assigned branch (set on the Users page; changing it signs the user out).

| User | Sees and changes |
| --- | --- |
| Without `branches.all` | Only their own branch: lists, documents, stock, dues, reports, CSV exports, dashboard |
| With `branches.all` (Admin; Manager by default) | A selector in the top bar switches the working branch, or **All branches** for a combined, view-only picture |

- New documents always go to **one concrete branch**. In **All branches** you can look but not record (for example,
  due collection asks you to pick a branch first).
- **Serial Lookup** still tells a restricted user where a unit is (serial, status and branch), but nothing more; its
  detail page is refused.
- **Customer and vendor dues and ledgers** show only the branch's invoices and payments for a restricted user.
  Opening balances appear only in Main and All branches.
- **Service tickets:** a restricted user can open tickets only for units located in their branch and sees only their
  branch's tickets.
- **Company-wide views:** in a company with more than one branch, the Activity log and the change history of shared
  records (products, customers, vendors, accounts, settings, roles, branches) need `branches.all` in addition to their
  usual permission.

### Fail closed

A restricted user whose branch is missing or inactive sees nothing and is asked to contact an administrator. ssERP
never silently falls back to Main.

## Selling and stock rules

- A serial unit can only be sold, adjusted or returned to the vendor from the branch it is in: "Serial X is in Dhaka;
  transfer it first".
- Quantity stock checks are per branch.
- A customer return puts the goods into the branch that takes the return.

## Transfers

**Business > Inventory > Transfers** (`/stock/transfers`, permission `products.edit` to create) moves stock between
branches in one step:

1. Choose the source and destination branches.
2. Scan serial units (they must be **in stock** at the source) and add quantity lines.
3. Save. ssERP gives the transfer a number (`TRF-00001`), moves the units' branch, writes paired quantity movements
   (out at the source, in at the destination) and records a `transferred` event on each unit.
4. Print a transfer note from the transfer page.

Rules:

- A user **without** `branches.all` can only **send** stock out of their own branch (to any active branch). Pulling
  stock in from another branch needs `branches.all`.
- Error messages shown to a restricted user never reveal another branch's quantities or unit statuses.
- Limits per transfer: 2,000 serial units and 200 quantity lines.
- Transfers are **immediate**: there is no "in transit" or "receive" step yet.

## Reports and numbers

- Every report and the dashboard follow the selected branch.
- Branch figures add up exactly to **All branches**: sales by the invoice's branch, returns by the return's branch,
  adjustments, expenses and incomes by their own branch.
- **Invoice numbers** remain one company-wide sequence; the printed invoice shows the branch.

## Limits in v0.1.0

- No in-transit state for transfers.
- No per-branch accounts (cash drawers) or per-branch invoice prefixes.
- The activity log stays company-wide (no branch column).

These are listed under "Branch follow-ups" on the [Roadmap](Roadmap).

## Upgrading an existing install to branches

Migrations 0014 to 0016 (part of v0.1.0) created Main, moved existing data into it, gave the system Manager role
`branches.all` and signed managers out once so they pick it up. Custom roles cloned from Manager before that do not get
`branches.all` automatically: grant it on the Roles page if those users should switch branches.

Last verified against v0.1.0.
