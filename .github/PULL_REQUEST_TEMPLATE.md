## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` pass
- [ ] `npm run test:db` passes (required for anything touching `src/server` data access, serials or money)
- [ ] New or changed behaviour has tests
- [ ] Every server action / route handler calls `authorize()` first and scopes queries by the session's company
- [ ] Money uses the integer-minor-unit helpers (no floats); serial/stock writes follow the `FOR SHARE` then `FOR UPDATE` lock order
- [ ] Schema changes are a **new** migration (`npm run db:generate`); no committed migration was edited
- [ ] No secrets, `.env` files or customer data in the diff
- [ ] Docs updated (README / docs/) if behaviour or configuration changed
