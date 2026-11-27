# Copilot instructions for ssERP

Follow `AGENTS.md` at the repository root (commands, structure, invariants, deploy playbook). Short version:

- Next.js 16 App Router, TypeScript strict, Drizzle ORM, PostgreSQL. Use npm. Validate input with zod.
- Every query on business data is scoped by the session's `companyId` (and branch via `src/server/branch.ts`). Never trust ids from the client.
- Server actions/route handlers call `authorize(...)` first (use `guarded()`/`guardedBranch()`), then read input.
- Money: never floats. Use `src/server/money.ts`, integer minor units, `numeric(14,2)`, server-side totals.
- Unit status changes only via the state machine in `src/server/serials.ts`; keep the documented lock order.
- Migrations are append-only: edit schema, run `npm run db:generate`, commit the new SQL.
- Never log caught errors directly (use `safeLog`); never log or return secrets or password hashes.
- Add tests: `*.test.ts` for logic, `*.db.test.ts` for DB/locking/money/serial changes. Run `npm run lint`, `npx tsc --noEmit`, `npm test` (and `npm run test:db` when relevant).
- Do not copy code from paid UI templates; the UI shell is original (`npm run check:theme`).
