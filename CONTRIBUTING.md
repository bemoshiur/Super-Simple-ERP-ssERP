# Contributing to ssERP

Thanks for helping. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

```bash
git clone https://github.com/bemoshiur/Super-Simple-ERP-ssERP.git
cd Super-Simple-ERP-ssERP
npm install
npm run setup          # needs a Postgres (a free Neon database, or local Postgres); writes .env.local, migrates, creates an admin
npm run dev            # http://localhost:3000
```

Node.js 20.9 or newer. For a local Postgres see [docs/DATABASE.md](docs/DATABASE.md) (use `DB_DRIVER=pg`).

Optional: `npm run seed:demo` fills a freshly installed company with demo data through the real data layer (see the README); `-- --force` adds it to a non-empty company, `-- --with-users` creates demo users.

Before you push:

```bash
npm run lint
npm run check:theme    # licence guard: no copied theme code or theme/vendor names
npx tsc --noEmit
npm test               # unit tests, no database
npm run test:db        # database tests on a throwaway local PostgreSQL (needs initdb/pg_ctl installed)
npm run test:e2e       # Playwright smoke test (throwaway PostgreSQL + production build; npx playwright install chromium once)
npm run check:docs     # relative links and anchors in README, docs/ and docs/wiki/
npm run build
```

CI runs the same checks, plus CodeQL and a dependency review on pull requests.

To regenerate the README demo (`docs/screenshots/demo.gif`, `demo.webm`, `demo-poster.png`), run `npm run demo:gif`. It starts the same throwaway PostgreSQL and app as `npm run test:e2e`, fills it with `npm run seed:demo` data, records `e2e/demo-video.spec.ts` with Playwright video, and encodes the files with `ffmpeg` (a system tool; the script stops with a message if it is missing). Add `DEMO_SKIP_RECORD=1` to only re-encode the last recording. The GIF is sized to stay under 6 MB.

## Branches and commits

- Branch from `main`: `feat/short-name`, `fix/short-name`, `docs/short-name`, `chore/short-name`.
- Commit messages follow Conventional Commits: `feat(sales): ...`, `fix(serials): ...`, `docs: ...`, `test: ...`, `chore: ...`. Use the module as the scope.
- Keep commits and pull requests focused; one logical change each. Fill in the pull request template.

## Invariants every change must keep

These protect people's money and stock records. Reviewers will check them.

1. **Company scoping.** Every query on business data filters by the signed-in user's `companyId` (from the session), including joins and sub-queries. Never trust a company id from the client.
2. **Authorize first.** Every server action and route handler calls `authorize(...)` (or the page's equivalent) with the right permission key **before** reading input or touching the database. UI hiding is not a security control. Add the permission to `src/server/rbac.ts` if a new one is needed.
3. **Exact money.** Never use floating point for money. Parse with `src/server/money.ts`, calculate in integer minor units, store as `numeric(14,2)`. Totals are computed on the server; do not accept client-computed totals.
4. **Lock order.** Code that writes `product_units` or `stock_movements` must `SELECT ... FOR SHARE` the product row in the same transaction. The order is: parent document row (for example the sale) `FOR UPDATE`, then products `FOR SHARE`, then the document number allocation, then unit rows `FOR UPDATE` (batched, in a stable order). Follow the existing order in `src/server/sales` and `src/server/purchases` so concurrent requests cannot deadlock or sell a serial twice.
5. **State changes go through the unit state machine** in `src/server/serials.ts`; do not update `product_units.status` directly.
6. **Migrations are append-only.** Change `src/server/db/schema/*`, run `npm run db:generate`, and commit the **new** file in `drizzle/`. Never edit or delete a migration that has been committed. Review the generated SQL.
7. **Record history.** Create/update/void/payment operations write to the activity log and record history in the same transaction.
8. **Never log or return secrets**: password hashes, `AUTH_SECRET`, connection strings.
9. **Tests are required.** New logic needs unit tests (`*.test.ts`); anything touching the database, locking, money or serial state needs a `*.db.test.ts` that runs under `npm run test:db`. Bug fixes need a regression test.
10. **Public paths are an exact allow-list** in `src/server/auth/public-paths.ts`. Adding a path there needs a test and a reason.
11. **Branch scope (Task 14).** Branch-owned data (documents, payments, stock, units, tickets, reports) is scoped by `src/server/branch.ts`: reads take an explicit `BranchFilter` (from `branchScope(session).filter` for lists/reports, `.restrict` for detail pages), writes take a `WriteCtx` (`writeCtx(scope)` in actions via `guardedBranch`). Never read a branch id from the client. **Branch scope registry:** every exported function of the scoped data-layer modules must be classified in `src/server/branch-scope-registry.test.ts` (and every module under `src/server` must be in its `REGISTRY` or in `UNSCOPED_MODULES` with a reason) as `scoped` (its parameters must include `branch`, `restrict`, `branchId`, `scope` or `ctx`), `company: <reason>`, `pure` or `internal: <reason>`. A new export that is not listed fails `npm test`; add new branch-owned reads to the behavioural matrix in `src/server/branches/isolation.db.test.ts` too.

**Cost visibility.** Never send cost data to a client component unless the viewer may see it: profit visibility (`canSeeProfit`: `reports.view` or `sales.edit`) gates stock values, net costs, the product list purchase price, report cost/profit columns and the dashboard stock value; omit the field server-side (do not just hide the column). `purchases.view` implies seeing purchase costs on purchase documents, the purchase import and a vendor's supplied units.

## Documentation and the wiki

The GitHub wiki is generated from [docs/wiki/](docs/wiki/Home.md). Change wiki pages there, in the same pull request as
the behaviour they describe; a maintainer publishes them with `scripts/sync-wiki.sh` after merging. Wiki links use
the form `[Text](Page-Name)`. Add user-visible changes to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md).
Every factual statement in the docs must be true for the code: check environment variables, routes, permissions and
limits in the source before writing them down.

## Dependency updates

- Dependabot ([.github/dependabot.yml](.github/dependabot.yml)) opens grouped **minor and patch** updates weekly:
  `production-deps` and `dev-deps` for npm, one group for GitHub Actions, and the Docker base image. Commit messages
  use `build(deps)` / `ci(deps)`.
- **Major versions** of core frameworks (Next.js, React, TypeScript, Vitest, `@types/node`, Drizzle ORM and Kit,
  TanStack Table, Bootstrap, React-Bootstrap, Zod, Sass, the Node.js base image) are ignored by Dependabot. They are
  upgraded by maintainers in dedicated pull requests with migration notes, because they need code or data changes.
  Please do not send drive-by major upgrades; open an issue first if you need one.
- New dependencies need a licence on the dependency-review allow-list
  ([.github/workflows/dependency-review.yml](.github/workflows/dependency-review.yml)) and a line in
  [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).
- GitHub Actions are pinned to full commit SHAs with the version in a comment. Keep that form when adding a step.

## Pull requests

Describe what and why, note anything you could not test, and tick the checklist in the template. Be ready to adjust: small, well-tested changes merge fastest.

## Licensing

By contributing you agree your contribution is licensed under the [MIT License](LICENSE). Do not add code or assets you do not have the right to share, and never copy code, markup, styles or images from a commercial theme or template (see [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)). UI work goes into ssERP's own Sass layer (`src/assets/scss/`, design tokens in `_tokens.scss`) and components; `npm run check:theme` must stay green.
