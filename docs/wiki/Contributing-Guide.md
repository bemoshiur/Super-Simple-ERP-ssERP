# Contributing Guide

Thank you for helping. The full, authoritative guide is
[CONTRIBUTING.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/CONTRIBUTING.md); this page is the
short version. Please also read the
[Code of Conduct](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/CODE_OF_CONDUCT.md).

## Ways to help without code

- Install ssERP and report what breaks, especially on the unverified paths (Neon, Vercel, Docker, phone cameras,
  label printers).
- Improve this wiki: edit the sources in
  [docs/wiki/](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/tree/main/docs/wiki) in a pull request.
- Answer questions in [Discussions](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/discussions).
- Help with Bengali wording for the [বাংলা গাইড](বাংলা-গাইড) and the future Bengali interface.

## Development setup

```bash
git clone https://github.com/bemoshiur/Super-Simple-ERP-ssERP.git
cd Super-Simple-ERP-ssERP
npm install
npm run setup          # needs a PostgreSQL (free Neon database or local)
npm run dev            # http://localhost:3000
npm run seed:demo      # optional demo data on a fresh install
```

Node.js 20.9 or newer (`.nvmrc`: 22).

## Before you push

```bash
npm run lint
npm run check:theme -- --identifiers
npm run check:docs
npx tsc --noEmit
npm test
npm run test:db        # needs initdb/pg_ctl installed
npm run test:e2e       # npx playwright install chromium once
npm run build
```

CI runs the same checks on every pull request, plus CodeQL and a dependency review.

## Branches and commits

- Branch from `main`: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Conventional Commits with the module as scope: `feat(sales): ...`, `fix(serials): ...`, `docs: ...`.
- One logical change per pull request; fill in the template's checklist.

## The rules every change must keep

1. Company scoping on every query and join; never trust a company id from the client.
2. Authorize first in every server action and route handler.
3. Exact money: integer minor units via `src/server/money.ts`; server-side totals.
4. Lock order for anything that writes units or stock.
5. Unit status changes only through `src/server/serials.ts`.
6. Migrations are append-only: generate a new one, never edit a committed one.
7. Activity log and history in the same transaction.
8. Never log or return secrets.
9. Tests are required; database tests for locking, money and serial state.
10. Public paths are an exact allow-list.
11. Branch scope via `BranchFilter` / `WriteCtx`, registered in the branch-scope registry test.

And the cost-visibility rule. Each is explained in CONTRIBUTING.md and the
[Architecture Overview](Architecture-Overview).

## Dependency updates

Dependabot proposes grouped minor and patch updates weekly. Major upgrades of core frameworks (Next.js, React,
TypeScript, Vitest, Drizzle, Zod, Bootstrap and others) are done by maintainers in dedicated pull requests, because
they need migration work. Please do not send drive-by major upgrades.

## Licensing

Contributions are licensed under MIT. Never copy code, markup, styles or images from a commercial theme or template;
`npm run check:theme` guards against it.

## Good first steps

Look for issues labelled `good first issue` or `help wanted`. Comment on the issue before starting so work is not
duplicated. Small, well-tested pull requests merge fastest.

Last verified against v0.1.0.
