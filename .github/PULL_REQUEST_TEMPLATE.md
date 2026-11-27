## What and why

<!-- What does this change, and why? Link the issue ("Closes #123") if there is one. -->

## How it was tested

<!-- Commands you ran, screens you checked, anything you could NOT test (for example Neon, Vercel, Docker, a phone camera). -->

## Checklist

- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` pass
- [ ] `npm run test:db` passes (required for anything touching `src/server` data access, serials or money)
- [ ] `npm run check:theme -- --identifiers` and `npm run check:docs` pass
- [ ] New or changed behaviour has tests; bug fixes have a regression test
- [ ] Every server action / route handler calls `authorize()` (or `guarded*`) **before** reading input, and scopes every query (joins too) by the session's `companyId`
- [ ] Branch-owned reads take a `BranchFilter`, writes a `WriteCtx`; new exports are classified in `src/server/branch-scope-registry.test.ts`
- [ ] Money uses `src/server/money.ts` integer minor units (no floats); totals are recomputed on the server
- [ ] Serial/stock writes follow the lock order (document `FOR UPDATE` -> products `FOR SHARE` -> doc number -> units `FOR UPDATE`) and unit status changes go through `src/server/serials.ts`
- [ ] Writes record activity log / history in the same transaction; no secrets are logged or returned
- [ ] Cost and profit fields are omitted server-side for viewers without profit visibility
- [ ] Schema changes are a **new** migration (`npm run db:generate`); no committed migration was edited
- [ ] New public paths (if any) are in `src/server/auth/public-paths.ts` with a test and a reason
- [ ] No secrets, `.env` files or customer data in the diff
- [ ] Docs updated (README, docs/, docs/wiki/, CHANGELOG `[Unreleased]`) if behaviour or configuration changed
